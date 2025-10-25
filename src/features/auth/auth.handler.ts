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
 * 
 * SECURITY:
 * - Refresh tokens hashed in DB (never stored plaintext)
 * - Token rotation prevents reuse attacks
 * - Tokens can be revoked via database
 * - Short-lived access tokens limit exposure window
 * 
 * REFERENCES:
 * - https://auth0.com/docs/secure/tokens/refresh-tokens
 * - https://workos.com/blog/why-your-app-needs-refresh-tokens
 * - https://www.rfc-editor.org/rfc/rfc6749#section-1.5
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
import { UserAccountService } from '@/infrastructure/auth/user-account.service';

/**
 * POST /api/auth/google/callback
 * Complete Google OAuth flow and issue tokens
 * 
 * Flow:
 * 1. Exchange auth code with Google for access token
 * 2. Fetch user profile from Google
 * 3. Create or update user/account in database
 * 4. Issue JWT access token
 * 5. Create refresh token (stored hashed in DB)
 * 6. Return tokens + user data to frontend
 * 
 * Frontend then:
 * - Stores tokens in localStorage
 * - Redirects to /dashboard or /onboarding
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
    const tokens = await googleOAuth.exchangeCode(body.code);
    console.log('[GoogleCallback] Google tokens received');

    const googleUser = await googleOAuth.getUserInfo(tokens.access_token);
    console.log('[GoogleCallback] Google user info received:', {
      id: googleUser.id,
      email: googleUser.email,
      verified: googleUser.verified_email
    });

    // Step 2: Create or update user/account
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const userAccountService = new UserAccountService(supabase);
    
    const accountData = await userAccountService.findOrCreateFromGoogle(googleUser);
    console.log('[GoogleCallback] User/account created:', {
      userId: accountData.user_id,
      accountId: accountData.account_id,
      isNewUser: accountData.is_new_user
    });

    // Step 3: Issue JWT access token
    const jwtService = new JWTService(c.env);
    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });
    console.log('[GoogleCallback] JWT access token issued');

    // Step 4: Create refresh token
    const tokenService = new TokenService(supabase);
    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );
    console.log('[GoogleCallback] Refresh token created');

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
 * 
 * Why token rotation?
 * - If token is stolen, attacker gets at most one use
 * - Legitimate user's next refresh invalidates stolen token
 * - Enables detection of token theft (multiple refresh attempts)
 * 
 * Frontend flow after receiving response:
 * - Stores new tokens in localStorage
 * - Can now make authenticated API calls
 * - May fetch user data via /session endpoint
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
 * 
 * Flow:
 * 1. Mark refresh token as revoked in database
 * 2. Token can no longer be used for /refresh calls
 * 3. Access token remains valid until expiry (15min max)
 * 
 * Note: Access tokens are stateless JWTs - cannot be revoked
 * They expire naturally after 15 minutes
 * For instant revocation, would need token blacklist (not implemented)
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
 * 
 * USE CASES:
 * - Fetch latest user data after profile update
 * - Verify current onboarding status
 * - Get updated credit balance
 * 
 * NOT USED FOR:
 * - Initial app load (use /refresh instead)
 * - Session validation (JWT middleware handles this)
 * 
 * Flow:
 * 1. Middleware validates JWT from Authorization header
 * 2. Extract userId/accountId from JWT claims
 * 3. Fetch user + account data from database
 * 4. Return current session info
 * 
 * Frontend should call this:
 * - After completing onboarding
 * - After updating profile
 * - When explicitly needing fresh data
 * 
 * Frontend should NOT call this:
 * - On app initialization (use /refresh)
 * - Before every API call (unnecessary)
 */
export async function handleGetSession(c: Context<{ Bindings: Env }>) {
  try {
    // Auth context attached by middleware
    const auth = c.get('auth');

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
      return c.json({ error: 'User not found' }, 404);
    }

    // Fetch account data
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, credit_balance')
      .eq('id', auth.accountId)
      .single();

    if (accountError || !account) {
      return c.json({ error: 'Account not found' }, 404);
    }

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
        credit_balance: account.credit_balance
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
