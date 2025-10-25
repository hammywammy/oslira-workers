// src/features/auth/auth.handler.ts

/**
 * AUTH HANDLERS - INDUSTRY STANDARD (2025)
 * 
 * ENDPOINTS:
 * - POST /api/auth/google/callback - Complete OAuth flow, issue tokens
 * - POST /api/auth/refresh           - Rotate tokens, extend session
 * - POST /api/auth/logout            - Revoke refresh token
 * - GET  /api/auth/session          - Fetch current user data (requires auth)
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
 * 
 * INITIALIZATION FLOW (Frontend):
 * 1. App loads → Frontend checks localStorage for refresh token
 * 2. If exists → Frontend calls /api/auth/refresh
 * 3. Backend validates refresh token → Issues new tokens
 * 4. Frontend stores new tokens → Fetches user data via /session
 * 
 * WHY /refresh vs /session FOR INIT:
 * - /refresh: Takes refresh token in body, no Bearer header needed
 * - /session: Requires valid Bearer token in header
 * - On init, access token might be expired → /refresh is safer
 * - Industry standard: Auth0, Clerk, WorkOS all use this pattern
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
} from './auth.types';

import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { JWTService } from '@/infrastructure/auth/jwt.service';
import { TokenService } from '@/infrastructure/auth/token.service';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import { getAuthContext } from '@/shared/middleware/auth.middleware';

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
 * 5. Issue JWT access token
 * 6. Create refresh token (stored hashed in DB)
 * 7. Return tokens + user data to frontend
 */
export async function handleGoogleCallback(c: Context<{ Bindings: Env }>) {
  try {
    console.log('[GoogleCallback] Request received');
    
    const body = await c.req.json() as GoogleCallbackRequest;
    
    if (!body.code) {
      console.error('[GoogleCallback] Missing authorization code');
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    console.log('[GoogleCallback] Authorization code received, length:', body.code.length);

    // Step 1: Exchange code with Google
    const googleOAuth = new GoogleOAuthService(c.env);
    const googleUser = await googleOAuth.completeOAuthFlow(body.code);
    
    console.log('[GoogleCallback] Google user info received:', {
      googleId: googleUser.id,
      email: googleUser.email,
      name: googleUser.name
    });

    // Step 2: Convert Google ID to UUID
    const userId = await googleIdToUUID(googleUser.id);
    
    console.log('[GoogleCallback] Converted Google ID to UUID', {
      googleId: googleUser.id,
      uuid: userId
    });

    // Step 3: Create/update user atomically
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    
    console.log('[GoogleCallback] Calling create_account_atomic');
    
    const { data: accountData, error: accountError } = await supabase
      .rpc('create_account_atomic', {
        p_user_id: userId,
        p_email: googleUser.email,
        p_full_name: googleUser.name,
        p_avatar_url: googleUser.picture
      });

    if (accountError || !accountData) {
      console.error('[GoogleCallback] Account creation failed:', {
        error: accountError,
        code: accountError?.code,
        message: accountError?.message
      });
      return c.json({ 
        error: 'Failed to create account',
        details: accountError?.message 
      }, 500);
    }

    console.log('[GoogleCallback] Account created successfully', {
      userId: accountData.user_id,
      accountId: accountData.account_id,
      isNewUser: accountData.is_new_user
    });

    // Step 4: Issue JWT access token
    const jwtService = new JWTService(c.env);
    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });

    console.log('[GoogleCallback] JWT access token issued');

    // Step 5: Create refresh token
    const tokenService = new TokenService(supabase);
    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );

    console.log('[GoogleCallback] Refresh token created');

    // Step 6: Return response
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
      isNewUser: accountData.is_new_user
    };

    console.log('[GoogleCallback] Returning success response');
    return c.json(response, 200);

  } catch (error: any) {
    console.error('[GoogleCallback] Unexpected error:', {
      message: error.message,
      stack: error.stack,
      name: error.name
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
 * THIS IS THE KEY ENDPOINT FOR SESSION PERSISTENCE
 * 
 * Called by:
 * - Frontend on app load (to rehydrate session)
 * - auth-manager when access token expires
 * - Never requires Bearer header (takes refresh token in body)
 * 
 * Flow:
 * 1. Validate refresh token (check DB, expiry, revoked status)
 * 2. Create NEW refresh token (token rotation)
 * 3. Invalidate old refresh token in DB
 * 4. Issue new JWT access token
 * 5. Return new tokens to frontend
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
      console.warn('[Refresh] Invalid or expired refresh token');
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    // Rotate token (create new, invalidate old)
    const newRefreshToken = await tokenService.rotate(
      body.refreshToken,
      tokenData.user_id,
      tokenData.account_id
    );

    // Fetch user's current onboarding status
    const { data: user } = await supabase
      .from('users')
      .select('email, onboarding_completed')
      .eq('id', tokenData.user_id)
      .single();

    // Issue new access token
    const newAccessToken = await jwtService.sign({
      userId: tokenData.user_id,
      accountId: tokenData.account_id,
      email: user?.email || tokenData.user_id,
      onboardingCompleted: user?.onboarding_completed || false
    });

    const response: RefreshResponse = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: jwtService.getExpiryTime()
    };

    console.log('[Refresh] Token rotation successful', {
      userId: tokenData.user_id
    });

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

    console.log('[Logout] Refresh token revoked');
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
 * Get current user session information
 * 
 * REQUIRES: JWT authentication (via middleware)
 */
export async function handleGetSession(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);

    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    // Fetch user data
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, full_name, avatar_url, onboarding_completed')
      .eq('id', auth.userId)
      .single();

    if (userError || !user) {
      console.error('[GetSession] User not found:', auth.userId, userError);
      return c.json({ error: 'User not found' }, 404);
    }

    // Fetch account data (WITHOUT credit_balance)
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('id', auth.accountId)
      .single();

    if (accountError || !account) {
      console.error('[GetSession] Account not found:', auth.accountId, accountError);
      return c.json({ error: 'Account not found' }, 404);
    }

    // Fetch credit balance separately
    const { data: creditBalance } = await supabase
      .from('credit_balances')
      .select('current_balance')
      .eq('account_id', auth.accountId)
      .single();

    const response: SessionResponse = {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        onboarding_completed: user.onboarding_completed
      },
      account: {
        id: account.id,
        name: account.name,
        credit_balance: creditBalance?.current_balance || 0
      }
    };

    return c.json(response, 200);

  } catch (error: any) {
    console.error('[GetSession] Error:', error);
    return c.json({ 
      error: 'Failed to fetch session',
      message: error.message 
    }, 500);
  }
}
