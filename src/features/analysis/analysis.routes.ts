// features/analysis/analysis.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import { ANALYSIS_RATE_LIMITS, API_RATE_LIMITS } from '@/config/rate-limits.config';
import {
  analyzeInstagramLead,
  getActiveAnalyses,
  internalBroadcast,
  globalWebSocketUpgrade
} from './analysis.handler';

/**
 * ANALYSIS ROUTES
 *
 * Phase 4B: Async workflows
 * - POST /api/leads/analyze → Start analysis (returns immediately)
 * - GET /api/analysis/:runId/progress → Track progress (HTTP polling fallback)
 * - GET /api/analysis/:runId/ws → WebSocket real-time progress (recommended)
 * - POST /api/analysis/:runId/cancel → Cancel analysis
 * - GET /api/analysis/:runId/result → Get final result
 */

export function registerAnalysisRoutes(app: Hono<{ Bindings: Env }>) {

  // Internal broadcast endpoint - called by Workflows
  // TODO: Add IP whitelist or internal auth token for production
  app.post('/api/internal/broadcast', internalBroadcast);

  // Global WebSocket endpoint - authenticated via query parameter token
  // Frontend connects once to receive ALL analysis progress updates
  app.get('/api/analysis/ws', globalWebSocketUpgrade);

  // All analysis routes require authentication
  app.use('/api/leads/analyze', authMiddleware);
  app.use('/api/analysis/*', authMiddleware);

  // Strict rate limiting on analysis creation (prevent spam)
  app.use('/api/leads/analyze', rateLimitMiddleware(ANALYSIS_RATE_LIMITS.CREATE));

  // General rate limiting on other analysis endpoints
  app.use('/api/analysis/*', rateLimitMiddleware(API_RATE_LIMITS.GENERAL));

  /**
   * POST /api/leads/analyze
   * Trigger async analysis workflow
   * Returns immediately with run_id for tracking
   */
  app.post('/api/leads/analyze', analyzeInstagramLead);

  /**
   * GET /api/analysis/active
   * Get all active analyses for the authenticated user
   * Returns aggregated progress for all pending/processing analyses
   */
  app.get('/api/analysis/active', getActiveAnalyses);
}
