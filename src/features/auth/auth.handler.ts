// src/features/auth/auth.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { 
  GoogleCallbackRequest, 
  RefreshRequest, 
  LogoutRequest,
  AuthResponse,
  SessionResponse,
  RefreshResponse
} from './auth.types';
import { JWTService } from '@/infrastructure/auth/jwt.service';
import { TokenService } from '@/infrastructure/auth/token.service';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
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
  // Use a fixed namespace UUID for Google IDs (generated once)
  const GOOGLE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // Standard DNS namespace
  
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
 * Exchange Google authorization code for tokens
 * 
 * Flow:
 * 1. Exchange code with Google → get user info
 * 2. Convert Google ID to UUID (deterministic hash)
 * 3. Create/update user in database (atomic)
 * 4. Issue JWT + refresh token
 * 5. Return tokens + user info to frontend
 */
export async function handleGoogleCallback(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as GoogleCallbackRequest;
    
    if (!body.code) {
      console.error('[GoogleCallback] Missing authorization code');
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    console.log('[GoogleCallback] Starting OAuth flow');

    // Step 1: Exchange code with Google
    const oauthService = new GoogleOAuthService(c.env);
    const googleUser = await oauthService.completeOAuthFlow(body.code);

    console.log('[GoogleCallback] Google user received', {
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
        p_user_id: userId, // ← Now a valid UUID
        p_email: googleUser.email,
        p_full_name: googleUser.name,
        p_avatar_url: googleUser.picture
      });

    if (accountError || !accountData) {
      console.error('[GoogleCallback] Account creation failed:', {
        error: accountError,
        code: accountError?.code,
        message: accountError?.message,
        details: accountError?.details
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

    // Step 4: Issue tokens
    const jwtService = new JWTService(c.env);
    const tokenService = new TokenService(supabase);

    console.log('[GoogleCallback] Generating JWT');
    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });

    console.log('[GoogleCallback] Creating refresh token');
    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );

    console.log('[GoogleCallback] Tokens created successfully');

    // Step 5: Return response
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
 * Flow:
 * 1. Validate refresh token
 * 2. Create new refresh token (rotate)
 * 3. Issue new access token
 * 4. Return new tokens
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

    // Validate and rotate token
    const tokenData = await tokenService.validate(body.refreshToken);
    
    if (!tokenData) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    // Create new refresh token
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
 * 
 * Flow:
 * 1. Revoke refresh token in database
 * 2. Return success
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
 * 
 * Requires: JWT authentication (via middleware)
 * 
 * Flow:
 * 1. Extract auth context (from middleware)
 * 2. Fetch user + account info
 * 3. Return session data
 */
export async function handleGetSession(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);

    const supabase = await SupabaseClientFactory.createUserClient(c.env);

    // Get user info
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, full_name, avatar_url, onboarding_completed')
      .eq('id', auth.userId)
      .single();

    if (userError || !user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Get account info
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('id', auth.accountId)
      .single();

    if (accountError || !account) {
      return c.json({ error: 'Account not found' }, 404);
    }

    // Get credit balance
    const { data: credits, error: creditsError } = await supabase
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
        credit_balance: credits?.current_balance || 0
      }
    };

    return c.json(response, 200);

  } catch (error: any) {
    console.error('[GetSession] Error:', error);
    return c.json({ 
      error: 'Failed to get session',
      message: error.message 
    }, 500);
  }
}
