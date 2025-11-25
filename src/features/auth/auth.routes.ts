// features/auth/auth.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import { AUTH_RATE_LIMITS, API_RATE_LIMITS } from '@/config/rate-limits.config';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import {
  handleGoogleCallback,
  handleRefresh,
  handleLogout,
  handleGetSession,
  handleBootstrap
} from './auth.handler';

/**
 * AUTH ROUTES
 *
 * Public endpoints:
 * - GET  /api/auth/google-client-id → Get Google OAuth client ID
 * - POST /api/auth/google/callback  → Exchange Google code for tokens
 * - POST /api/auth/refresh          → Rotate refresh token
 * - POST /api/auth/logout           → Revoke refresh token
 *
 * Protected endpoints:
 * - GET  /api/auth/session          → Get user session info (requires auth)
 * - GET  /api/auth/bootstrap        → Single source for all initialization data (requires auth)
 */

export function registerAuthRoutes(app: Hono<{ Bindings: Env }>) {
  
  console.log('[Routes] Registering auth routes');

  // ===============================================================================
  // PUBLIC ENDPOINTS (No auth required)
  // ===============================================================================

  /**
   * GET /api/auth/google-client-id
   * Returns Google OAuth client ID for frontend to initiate OAuth flow
   * 
   * Returns: { clientId: string }
   * Rate limit: Lenient (needed on every login page load)
   */
  app.get(
    '/api/auth/google-client-id',
    rateLimitMiddleware(API_RATE_LIMITS.GENERAL),
    async (c) => {
      try {
        console.log('[GoogleClientId] Fetching Google OAuth client ID');
        
        const oauthService = new GoogleOAuthService(c.env);
        
        // Access private getCredentials() method
        // We only expose the clientId, NOT the clientSecret
        const credentials = await (oauthService as any).getCredentials();
        
        console.log('[GoogleClientId] ✓ Client ID retrieved successfully');
        
        return c.json({ 
          clientId: credentials.clientId 
        }, 200, {
          'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        });
      } catch (error: any) {
        console.error('[GoogleClientId] Failed to fetch client ID:', {
          error_name: error.name,
          error_message: error.message,
          error_stack: error.stack?.split('\n')[0]
        });
        
        return c.json({ 
          error: 'Failed to fetch Google client ID',
          message: error.message 
        }, 500);
      }
    }
  );

  /**
   * POST /api/auth/google/callback
   * Complete Google OAuth flow
   * 
   * Body: { code: string }
   * Returns: { accessToken, refreshToken, user, account }
   * 
   * Rate limit: Moderate (prevent OAuth abuse)
   */
  app.post(
    '/api/auth/google/callback',
    rateLimitMiddleware(AUTH_RATE_LIMITS.OAUTH_CALLBACK),
    handleGoogleCallback
  );

  /**
   * POST /api/auth/refresh
   * Rotate refresh token and get new access token
   * 
   * Body: { refreshToken: string }
   * Returns: { accessToken, refreshToken, expiresAt }
   * 
   * Rate limit: Moderate (prevent token abuse)
   */
  app.post(
    '/api/auth/refresh',
    rateLimitMiddleware(AUTH_RATE_LIMITS.TOKEN_REFRESH),
    handleRefresh
  );

  /**
   * POST /api/auth/logout
   * Revoke refresh token (logout)
   * 
   * Body: { refreshToken: string }
   * Returns: { success: true }
   * 
   * Rate limit: Lenient (logout should always work)
   */
  app.post(
    '/api/auth/logout',
    rateLimitMiddleware(AUTH_RATE_LIMITS.LOGOUT),
    handleLogout
  );

  // ===============================================================================
  // PROTECTED ENDPOINTS (Auth required)
  // ===============================================================================

  /**
   * GET /api/auth/session
   * Get current user session information
   *
   * Headers: Authorization: Bearer <accessToken>
   * Returns: { user, account }
   *
   * Rate limit: General API rate limit
   */
  app.get(
    '/api/auth/session',
    authMiddleware,
    rateLimitMiddleware(AUTH_RATE_LIMITS.SESSION),
    handleGetSession
  );

  /**
   * GET /api/auth/bootstrap
   * Single source of truth for all user initialization data
   *
   * Headers: Authorization: Bearer <accessToken>
   * Returns: { user, account, subscription, balances }
   *
   * Purpose: Replace multiple initialization API calls with a single request.
   * Uses JOIN query for single database round-trip.
   * Rate limit: Same as session (called on app init)
   */
  app.get(
    '/api/auth/bootstrap',
    authMiddleware,
    rateLimitMiddleware(AUTH_RATE_LIMITS.SESSION),
    handleBootstrap
  );

  console.log('[Routes] Auth routes registered successfully');
}
