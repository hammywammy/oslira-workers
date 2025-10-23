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
 * POST /api/auth/google/callback
 * Exchange Google authorization code for tokens
 * 
 * Flow:
 * 1. Exchange code with Google → get user info
 * 2. Create/update user in database (atomic)
 * 3. Issue JWT + refresh token
 * 4. Return tokens + user info to frontend
 */
export async function handleGoogleCallback(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as GoogleCallbackRequest;
    
    if (!body.code) {
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    // Step 1: Exchange code with Google
    const oauthService = new GoogleOAuthService(c.env);
    const googleUser = await oauthService.completeOAuthFlow(body.code);

    // Step 2: Create/update user atomically
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    
    const { data: accountData, error: accountError } = await supabase
      .rpc('create_account_atomic', {
        p_user_id: googleUser.id,
        p_email: googleUser.email,
        p_full_name: googleUser.name,
        p_avatar_url: googleUser.picture
      });

    if (accountError || !accountData) {
      console.error('[GoogleCallback] Account creation failed:', accountError);
      return c.json({ error: 'Failed to create account' }, 500);
    }

    // Step 3: Issue tokens
    const jwtService = new JWTService(c.env);
    const tokenService = new TokenService(supabase);

    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });

    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );

    // Step 4: Return response
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

    return c.json(response, 200);

  } catch (error: any) {
    console.error('[GoogleCallback] Error:', error);
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

    // Validate old token
    const tokenRecord = await tokenService.validate(body.refreshToken);
    if (!tokenRecord) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    // Get user info (for JWT payload)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, onboarding_completed')
      .eq('id', tokenRecord.user_id)
      .single();

    if (userError || !user) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Rotate tokens
    const newRefreshToken = await tokenService.rotate(body.refreshToken);

    const jwtService = new JWTService(c.env);
    const newAccessToken = await jwtService.sign({
      userId: tokenRecord.user_id,
      accountId: tokenRecord.account_id,
      email: user.email,
      onboardingCompleted: user.onboarding_completed
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
    }, 401);
  }
}

/**
 * POST /api/auth/logout
 * Revoke refresh token (logout)
 * 
 * Flow:
 * 1. Validate refresh token
 * 2. Mark token as revoked
 * 3. Return success
 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json() as LogoutRequest;
    
    if (!body.refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const tokenService = new TokenService(supabase);

    // Revoke token
    await tokenService.revoke(body.refreshToken);

    return c.json({ 
      success: true,
      message: 'Logged out successfully' 
    }, 200);

  } catch (error: any) {
    console.error('[Logout] Error:', error);
    // Still return success (best effort logout)
    return c.json({ 
      success: true,
      message: 'Logged out' 
    }, 200);
  }
}

/**
 * GET /api/auth/session
 * Get current user session info
 * Requires valid JWT in Authorization header
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
