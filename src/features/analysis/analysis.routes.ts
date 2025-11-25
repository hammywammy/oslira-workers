// features/analysis/analysis.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import { ANALYSIS_RATE_LIMITS, API_RATE_LIMITS } from '@/config/rate-limits.config';
import {
  analyzeInstagramLead,
  getAnalysisProgress,
  streamAnalysisProgress,
  streamAnalysisProgressWS,
  cancelAnalysis,
  getAnalysisResult,
  getActiveAnalyses
} from './analysis.handler';

/**
 * ANALYSIS ROUTES
 *
 * Phase 4B: Async workflows
 * - POST /api/leads/analyze → Start analysis (returns immediately)
 * - GET /api/analysis/:runId/progress → Track progress (HTTP polling fallback)
 * - GET /api/analysis/:runId/ws → WebSocket real-time progress (recommended)
 * - GET /api/analysis/:runId/stream → SSE progress (deprecated, use WebSocket)
 * - POST /api/analysis/:runId/cancel → Cancel analysis
 * - GET /api/analysis/:runId/result → Get final result
 */

export function registerAnalysisRoutes(app: Hono<{ Bindings: Env }>) {

  // WebSocket endpoint - MUST be registered BEFORE auth middleware
  // (runId serves as implicit authentication)
  app.get('/api/analysis/:runId/ws', streamAnalysisProgressWS);

  // SSE stream endpoint (deprecated - kept for backwards compatibility)
  // MUST be registered BEFORE auth middleware (runId serves as implicit authentication)
  app.get('/api/analysis/:runId/stream', streamAnalysisProgress);

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

  /**
   * GET /api/analysis/:runId/progress
   * Get current progress (0-100%)
   * Poll this endpoint to track analysis progress
   */
  app.get('/api/analysis/:runId/progress', getAnalysisProgress);

  /**
   * POST /api/analysis/:runId/cancel
   * Cancel running analysis
   * Credits will be refunded if analysis hasn't completed
   */
  app.post('/api/analysis/:runId/cancel', cancelAnalysis);

  /**
   * GET /api/analysis/:runId/result
   * Get final analysis result (once complete)
   * Returns 425 Too Early if analysis still processing
   */
  app.get('/api/analysis/:runId/result', getAnalysisResult);
}
