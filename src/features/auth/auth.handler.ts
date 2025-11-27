// src/features/auth/auth.handler.ts

/**
 * AUTH HANDLERS - INDUSTRY STANDARD (2025)
 *
 * ENDPOINTS:
 * - POST /api/auth/google/callback - Complete OAuth flow, issue tokens
 * - POST /api/auth/refresh           - Rotate tokens, extend session
 * - POST /api/auth/logout            - Revoke refresh token
 * - GET  /api/auth/session          - Fetch current user data (requires auth)
 * - GET  /api/auth/bootstrap        - Single source for all init data (requires auth)
 *
 * TOKEN STRATEGY:
 * - Access Token: JWT, 15min expiry, contains user/account claims
 * - Refresh Token: Opaque UUID, 30 days expiry, stored hashed in DB
 * - Token Rotation: Each refresh creates NEW token, invalidates old one
 * 
 * USER CREATION:
 * - Uses deterministic UUID generation from Google ID
 * - Calls create_account_atomic() Postgres function
 * - Atomic user + account creation (no race conditions)
 * - Creates Stripe customer for ALL users (free and paid)
 * 
 * INITIALIZATION FLOW (Frontend):
 * 1. App loads → Frontend checks localStorage for refresh token
 * 2. If exists → Frontend calls /api/auth/refresh
 * 3. Backend validates refresh token → Issues new tokens
 * 4. Frontend stores new tokens → Fetches user data via /session
 */

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type {
  GoogleCallbackRequest,
  AuthResponse,
  RefreshRequest,
  RefreshResponse,
  LogoutRequest,
  SessionResponse,
  BootstrapResponse,
} from './auth.types';

import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { JWTService } from '@/infrastructure/auth/jwt.service';
import { TokenService } from '@/infrastructure/auth/token.service';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { successResponse, errorResponse } from '@/shared/utils/response.util';

/**
 * Convert Google User ID (string number) to deterministic UUID v5
 * 
 * Google IDs: "112093094941937129431" (not UUID format)
 * Solution: Hash to UUID using namespace UUID
 * 
 * This ensures:
 * - Same Google ID always produces same UUID
 * - UUID is valid for PostgreSQL uuid type
 * - Consistent across sessions
 */
async function googleIdToUUID(googleId: string): Promise<string> {
  // Use a fixed namespace UUID for Google IDs
  const GOOGLE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  
  // Create deterministic UUID from Google ID
  const encoder = new TextEncoder();
  const data = encoder.encode(GOOGLE_NAMESPACE + googleId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  
  // Take first 16 bytes and format as UUID v5
  const uuid = [
    hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(4, 6).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(6, 8).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(8, 10).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(10, 16).map(b => b.toString(16).padStart(2, '0')).join('')
  ].join('-');
  
  // Set version to 5 (SHA-1 name-based) and variant bits
  const chars = uuid.split('');
  chars[14] = '5'; // Version 5
  chars[19] = '8'; // Variant 10xx
  
  return chars.join('');
}

/**
 * POST /api/auth/google/callback
 * Complete Google OAuth flow and issue tokens
 * 
 * Flow:
 * 1. Exchange auth code with Google for access token
 * 2. Fetch user profile from Google
 * 3. Convert Google ID to deterministic UUID
 * 4. Create or update user/account in database (atomic function)
 * 5. Create Stripe customer (for new users only)
 * 6. Issue JWT access token
 * 7. Create refresh token (stored hashed in DB)
 * 8. Return tokens + user data to frontend
 */
export async function handleGoogleCallback(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as GoogleCallbackRequest;

    if (!body.code) {
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    // ===========================================================================
    // STEP 1: Exchange code with Google
    // ===========================================================================

    const googleOAuth = new GoogleOAuthService(c.env);
    const googleUser = await googleOAuth.completeOAuthFlow(body.code);

    // ===========================================================================
    // STEP 2: Convert Google ID to UUID
    // ===========================================================================

    const userId = await googleIdToUUID(googleUser.id);

    // ===========================================================================
    // STEP 3: Create/update user atomically
    // ===========================================================================

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    const { data: accountData, error: accountError } = await supabase
      .rpc('create_account_atomic', {
        p_user_id: userId,
        p_email: googleUser.email,
        p_full_name: googleUser.name,
        p_avatar_url: googleUser.picture
      });

    if (accountError || !accountData) {
      console.error('[GoogleCallback] Account creation failed', {
        error_code: accountError?.code,
        error_message: accountError?.message,
        error_details: accountError?.details
      });
      return c.json({
        error: 'Failed to create account',
        details: accountError?.message
      }, 500);
    }

    // Ensure is_new_user has a default value if undefined
    const isNewUser = accountData.is_new_user ?? false;

    // ===========================================================================
    // STEP 4: Create Stripe customer (NEW USERS ONLY)
    // ===========================================================================

    if (isNewUser) {
      try {
        console.log('[GoogleCallback] Creating Stripe customer (new user)');
        
        const { StripeService } = await import('@/infrastructure/billing/stripe.service');
        const stripeService = new StripeService(c.env);
        
        const stripeCustomerId = await stripeService.createCustomer({
          email: googleUser.email,
          name: googleUser.name,
          account_id: accountData.account_id,
          user_id: accountData.user_id,
          metadata: {
            signup_method: 'google_oauth',
            environment: c.env.APP_ENV
          }
        });

        console.log('[GoogleCallback] ✓ Stripe customer created', {
          stripe_customer_id: stripeCustomerId,
          account_id: accountData.account_id
        });

        // Save stripe_customer_id to accounts table (environment-specific column)
        const isProduction = c.env.APP_ENV === 'production';
        const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

        const { error: updateError } = await supabase
          .from('accounts')
          .update({ [columnName]: stripeCustomerId })
          .eq('id', accountData.account_id);

        if (updateError) {
          console.error('[GoogleCallback] ✗ Failed to save stripe_customer_id to database', {
            error_code: updateError.code,
            error_message: updateError.message,
            account_id: accountData.account_id,
            stripe_customer_id: stripeCustomerId
          });
          
          // DON'T fail OAuth flow - customer exists in Stripe
          // Recovery strategy: Search Stripe by metadata['account_id']
          console.warn('[GoogleCallback] ⚠ OAuth flow continuing despite DB save failure');
          console.warn('[GoogleCallback] ⚠ Recovery: Use StripeService.searchCustomersByMetadata("account_id", "...")');
          
        } else {
          console.log('[GoogleCallback] ✓ stripe_customer_id saved to database');
        }

      } catch (error: any) {
        // Log error but DON'T fail entire OAuth flow
        console.error('[GoogleCallback] ⚠ Stripe customer creation failed (NON-FATAL)', {
          error_name: error.name,
          error_message: error.message,
          error_stack: error.stack?.split('\n')[0],
          account_id: accountData.account_id,
          email: googleUser.email
        });
        
        // User can still sign up and use 25 free credits
        // Stripe customer will be created on first purchase attempt
        // Recovery strategy: Queue job to create missing customers nightly
        console.warn('[GoogleCallback] ⚠ User can still complete OAuth');
        console.warn('[GoogleCallback] ⚠ Stripe customer will be created on first purchase');
      }
    } else {
      console.log('[GoogleCallback] Existing user login - skipping Stripe customer creation');
    }

    // ===========================================================================
    // STEP 5: Issue JWT access token
    // ===========================================================================

    const jwtService = new JWTService(c.env);
    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });

    // ===========================================================================
    // STEP 6: Create refresh token
    // ===========================================================================

    const tokenService = new TokenService(supabase);
    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );

    // ===========================================================================
    // STEP 7: Return response
    // ===========================================================================

    const response: AuthResponse = {
      accessToken,
      refreshToken,
      expiresAt: jwtService.getExpiryTime(),
      user: {
        id: accountData.user_id,
        email: accountData.email,
        full_name: accountData.full_name,
        avatar_url: googleUser.picture,
        onboarding_completed: accountData.onboarding_completed
      },
      account: {
        id: accountData.account_id,
        name: accountData.full_name + "'s Account",
        credit_balance: accountData.credit_balance
      },
      isNewUser: isNewUser
    };

    return successResponse(c, response);

  } catch (error: any) {
    console.error('[GoogleCallback] ========== FATAL ERROR ==========', {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack
    });
    
    return c.json({ 
      error: 'Authentication failed',
      message: error.message 
    }, 500);
  }
}

/**
 * POST /api/auth/refresh
 * Rotate refresh token and issue new access token
 * 
 * Flow:
 * 1. Validate refresh token (check DB, expiry, revoked status)
 * 2. Create NEW refresh token (token rotation)
 * 3. Invalidate old refresh token in DB
 * 4. Issue new JWT access token
 * 5. Return new tokens
 */
export async function handleRefresh(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as RefreshRequest;

    if (!body.refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const tokenService = new TokenService(supabase);
    const jwtService = new JWTService(c.env);

    // Validate refresh token
    const tokenData = await tokenService.validate(body.refreshToken);

    if (!tokenData) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    // Rotate token (create new, invalidate old)
    const newRefreshToken = await tokenService.rotate(
      body.refreshToken,
      tokenData.user_id,
      tokenData.account_id
    );

    // Fetch user's email
    const { data: user } = await supabase
      .from('users')
      .select('email')
      .eq('id', tokenData.user_id)
      .single();

    // Check if user has any completed business profiles
    const { data: businesses } = await supabase
      .from('business_profiles')
      .select('onboarding_completed')
      .eq('account_id', tokenData.account_id);

    const hasCompletedBusiness = businesses?.some(b => b.onboarding_completed) || false;

    // Issue new access token
    const newAccessToken = await jwtService.sign({
      userId: tokenData.user_id,
      accountId: tokenData.account_id,
      email: user?.email || tokenData.user_id,
      onboardingCompleted: hasCompletedBusiness
    });

    const response: RefreshResponse = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: jwtService.getExpiryTime()
    };

    return c.json(response, 200);

  } catch (error: any) {
    console.error('[Refresh] Error:', error);
    return c.json({ 
      error: 'Token refresh failed',
      message: error.message 
    }, 500);
  }
}

/**
 * POST /api/auth/logout
 * Revoke refresh token
 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as LogoutRequest;
    
    if (!body.refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const tokenService = new TokenService(supabase);

    await tokenService.revoke(body.refreshToken);

    return c.json({ success: true }, 200);

  } catch (error: any) {
    console.error('[Logout] Error:', error);
    return c.json({ 
      error: 'Logout failed',
      message: error.message 
    }, 500);
  }
}

/**
 * GET /api/auth/session
 * Get current user session info
 */
export async function handleGetSession(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

   // Fetch user data
const { data: user, error: userError } = await supabase
  .from('users')
  .select('id, email, full_name, avatar_url')
  .eq('id', auth.userId)
  .single();

if (userError || !user) {
  console.error('[GetSession] User not found:', auth.userId, userError);
  return c.json({ error: 'User not found' }, 404);
}

// Fetch account data
const { data: account, error: accountError } = await supabase
  .from('accounts')
  .select('id, name')
  .eq('id', auth.accountId)
  .single();

if (accountError || !account) {
  console.error('[GetSession] Account not found:', auth.accountId, accountError);
  return c.json({ error: 'Account not found' }, 404);
}

// Check if user has any completed business profiles
const { data: businesses } = await supabase
  .from('business_profiles')
  .select('onboarding_completed')
  .eq('account_id', auth.accountId);

const hasCompletedBusiness = businesses?.some(b => b.onboarding_completed) || false;

// Issue fresh JWT if onboarding status changed (JWT claims are stale)
let newAccessToken: string | undefined;
if (hasCompletedBusiness !== auth.onboardingCompleted) {
  console.log('[GetSession] Onboarding status changed, issuing fresh JWT', {
    jwt_claim: auth.onboardingCompleted,
    actual_status: hasCompletedBusiness
  });
  const jwtService = new JWTService(c.env);
  newAccessToken = await jwtService.sign({
    userId: auth.userId,
    accountId: auth.accountId,
    email: user.email,
    onboardingCompleted: hasCompletedBusiness
  });
}

// Fetch credit balance and light analyses balance
const { data: balances } = await supabase
  .from('balances')
  .select('credit_balance, light_analyses_balance')
  .eq('account_id', auth.accountId)
  .single();

const response: SessionResponse & { newAccessToken?: string } = {
  user: {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    onboarding_completed: hasCompletedBusiness
  },
  account: {
    id: account.id,
    name: account.name,
    credit_balance: balances?.credit_balance || 0,
    light_analyses_balance: balances?.light_analyses_balance || 0
  }
};

// Include fresh JWT if onboarding status changed
if (newAccessToken) {
  response.newAccessToken = newAccessToken;
}

    return successResponse(c, response);

  } catch (error: any) {
    console.error('[GetSession] Error:', error);
    return c.json({
      error: 'Failed to fetch session',
      message: error.message
    }, 500);
  }
}

/**
 * GET /api/auth/bootstrap
 * Single endpoint for all user initialization data
 *
 * Purpose: Replace multiple API calls (/session, /subscription, /balance)
 * with a single bootstrap call on app initialization.
 *
 * Uses JOIN query for single database round-trip.
 * Handles missing subscription/balances gracefully.
 */
export async function handleBootstrap(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    // Single JOIN query to fetch all initialization data
    // Use explicit FK syntax (fk_accounts_owner) to avoid PGRST201 ambiguity error
    // (accounts table has two FKs to users: owner_id and suspended_by)
    const { data, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        full_name,
        avatar_url,
        accounts!fk_accounts_owner (
          id,
          name
        ),
        account:accounts!fk_accounts_owner (
          subscriptions (
            id,
            plan_type,
            status,
            current_period_start,
            current_period_end,
            stripe_subscription_id_live,
            stripe_subscription_id_test,
            stripe_customer_id_live,
            stripe_customer_id_test
          )
        )
      `)
      .eq('id', auth.userId)
      .single();

    if (error || !data) {
      console.error('[Bootstrap] User not found:', auth.userId, error);
      return errorResponse(c, 'Bootstrap failed', 'NOT_FOUND', 404);
    }

    // Extract nested data
    const user = data;
    const account = Array.isArray(data.accounts) ? data.accounts[0] : data.accounts;
    const accountData = Array.isArray(data.account) ? data.account[0] : data.account;
    const subscription = accountData?.subscriptions?.[0] || null;

    // Fetch balances directly - nested joins through reverse FKs can be unreliable
    const { data: balance, error: balanceError } = await supabase
      .from('balances')
      .select('account_id, credit_balance, light_analyses_balance, last_transaction_at, created_at, updated_at')
      .eq('account_id', account.id)
      .single();

    if (balanceError && balanceError.code !== 'PGRST116') {
      // PGRST116 = "not found" which is acceptable (we have defaults)
      console.error('[Bootstrap] Balance query error:', balanceError);
    }

    // Determine environment-specific Stripe IDs
    const isProduction = c.env.APP_ENV === 'production';

    // Build response
    const response: BootstrapResponse = {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        onboarding_completed: auth.onboardingCompleted // From JWT claims
      },
      account: {
        id: account.id,
        name: account.name
      },
      subscription: subscription ? {
        id: subscription.id,
        tier: subscription.plan_type as 'free' | 'growth' | 'pro' | 'agency' | 'enterprise',
        status: subscription.status as 'active' | 'canceled' | 'past_due',
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        stripe_subscription_id: isProduction
          ? subscription.stripe_subscription_id_live
          : subscription.stripe_subscription_id_test,
        stripe_customer_id: isProduction
          ? subscription.stripe_customer_id_live
          : subscription.stripe_customer_id_test
      } : null,
      balances: balance ? {
        account_id: balance.account_id,
        credit_balance: balance.credit_balance,
        light_analyses_balance: balance.light_analyses_balance,
        last_transaction_at: balance.last_transaction_at,
        created_at: balance.created_at,
        updated_at: balance.updated_at
      } : {
        // Default balances if not found
        account_id: account.id,
        credit_balance: 0,
        light_analyses_balance: 0,
        last_transaction_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    };

    return successResponse(c, response);

  } catch (error) {
    logger.error('Bootstrap failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: auth.userId,
      accountId: auth.accountId
    });
    return errorResponse(c, 'Bootstrap failed', 'INTERNAL_ERROR', 500);
  }
}
