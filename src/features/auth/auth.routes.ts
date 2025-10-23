// src/features/auth/auth.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import {
  handleGoogleCallback,
  handleRefresh,
  handleLogout,
  handleGetSession
} from './auth.handler';

/**
 * AUTH ROUTES
 * 
 * Endpoints:
 * - POST /api/auth/google/callback → Exchange Google code for tokens
 * - POST /api/auth/refresh → Rotate refresh token
 * - POST /api/auth/logout → Revoke refresh token
 * - GET /api/auth/session → Get user session info (requires auth)
 */

export function registerAuthRoutes(app: Hono<{ Bindings: Env }>) {

  // ===============================================================================
  // PUBLIC ENDPOINTS (No auth required)
  // ===============================================================================

  /**
   * POST /api/auth/google/callback
   * Exchange Google authorization code for tokens
   * 
   * Body: { code: string }
   * Returns: { accessToken, refreshToken, expiresAt, user, account, isNewUser }
   * 
   * Rate limit: Strict (prevent OAuth abuse)
   */
  app.post(
    '/api/auth/google/callback',
    rateLimitMiddleware({
      requests: 10,
      window: 600 // 10 requests per 10 minutes
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
      window: 3600 // 30 requests per hour
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
}
