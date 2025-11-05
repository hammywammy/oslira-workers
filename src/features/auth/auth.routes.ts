// features/auth/auth.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import {
  handleGoogleCallback,
  handleRefresh,
  handleLogout,
  handleGetSession
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
    rateLimitMiddleware(RATE_LIMITS.API_GENERAL),
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
    rateLimitMiddleware({
      requests: 10,
      windowSeconds: 600 // 10 requests per 10 minutes
    }),
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
    rateLimitMiddleware({
      requests: 30,
      windowSeconds: 3600 // 30 requests per hour
    }),
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
    rateLimitMiddleware(RATE_LIMITS.API_GENERAL),
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
    rateLimitMiddleware(RATE_LIMITS.API_GENERAL),
    handleGetSession
  );
  
  console.log('[Routes] Auth routes registered successfully');
}
