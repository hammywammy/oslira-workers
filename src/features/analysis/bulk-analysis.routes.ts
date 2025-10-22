// features/analysis/bulk-analysis.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { 
  bulkAnalyzeLeads,
  getBatchProgress,
  cancelBatch
} from './bulk-analysis.handler';

/**
 * BULK ANALYSIS ROUTES
 * 
 * Phase 5: Bulk operations
 * - POST /api/leads/analyze/bulk → Queue multiple analyses
 * - GET /api/leads/analyze/bulk/:batchId/progress → Track batch
 * - POST /api/leads/analyze/bulk/:batchId/cancel → Cancel batch
 */

export function registerBulkAnalysisRoutes(app: Hono<{ Bindings: Env }>) {
  
  // All bulk analysis routes require authentication
  app.use('/api/leads/analyze/bulk', authMiddleware);
  app.use('/api/leads/analyze/bulk/*', authMiddleware);
  
  // Stricter rate limiting for bulk operations
  app.use('/api/leads/analyze/bulk', rateLimitMiddleware({
    requests: 5,
    window: 3600 // 5 requests per hour
  }));

  /**
   * POST /api/leads/analyze/bulk
   * Queue multiple analyses (max 50 usernames)
   * Returns batch ID for tracking
   */
  app.post('/api/leads/analyze/bulk', bulkAnalyzeLeads);

  /**
   * GET /api/leads/analyze/bulk/:batchId/progress
   * Get batch progress and individual analysis statuses
   */
  app.get('/api/leads/analyze/bulk/:batchId/progress', getBatchProgress);

  /**
   * POST /api/leads/analyze/bulk/:batchId/cancel
   * Cancel all in-progress analyses in batch
   */
  app.post('/api/leads/analyze/bulk/:batchId/cancel', cancelBatch);
}
