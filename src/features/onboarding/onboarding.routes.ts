// features/onboarding/onboarding.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import {
  generateBusinessContext,
  getGenerationProgress,
  getGenerationResult
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
  
  // All onboarding routes require authentication
  app.use('/api/business/generate-context', authMiddleware);
  app.use('/api/business/generate-context/*', authMiddleware);

  // Rate limiting (5 generations per hour per user)
  app.use('/api/business/generate-context', rateLimitMiddleware({
    requests: 50,
    window: 3600
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
}
