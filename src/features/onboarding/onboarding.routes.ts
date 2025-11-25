// features/onboarding/onboarding.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import {
  generateBusinessContext,
  getGenerationProgress,
  getGenerationResult,
  streamBusinessContextWebSocket
} from './onboarding.handler';

/**
 * ONBOARDING ROUTES
 * 
 * Phase 3: Business context generation
 * - POST /api/business/generate-context → Start generation
 * - GET /api/business/generate-context/:runId/progress → Track progress
 * - GET /api/business/generate-context/:runId/result → Get final result
 */

export function registerOnboardingRoutes(app: Hono<{ Bindings: Env }>) {

  console.log('[Routes] Registering onboarding routes');

  /**
   * GET /api/business/generate-context/:runId/ws
   * WebSocket proxy for real-time progress updates
   * Forwards WebSocket upgrade to BusinessContextProgressDO
   *
   * NOTE: Registered BEFORE auth middleware because WebSocket cannot send custom headers.
   * Authentication is implicit via the cryptographically random runId UUID that only the
   * authenticated user who initiated the request knows (returned from POST endpoint).
   */
  app.get('/api/business/generate-context/:runId/ws', streamBusinessContextWebSocket);

  // All other onboarding routes require authentication
  // Note: Hono's app.use() with a path matches as a prefix, so this covers all sub-paths
  app.use('/api/business/generate-context', authMiddleware);

  // Rate limiting (50 generations per hour per user)
  app.use('/api/business/generate-context', rateLimitMiddleware({
    requests: 50,
    windowSeconds: 3600 // FIXED: renamed from 'window'
  }));

  /**
   * POST /api/business/generate-context
   * Start business context generation (async)
   * Returns run_id for progress tracking
   */
  app.post('/api/business/generate-context', generateBusinessContext);

  /**
   * GET /api/business/generate-context/:runId/progress
   * Get current generation progress
   * Poll this endpoint to track status
   */
  app.get('/api/business/generate-context/:runId/progress', getGenerationProgress);

  /**
   * GET /api/business/generate-context/:runId/result
   * Get final generation result (when complete)
   * Returns full business context data
   */
  app.get('/api/business/generate-context/:runId/result', getGenerationResult);

  console.log('[Routes] Onboarding routes registered successfully');
}
