// features/leads/leads.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import { API_RATE_LIMITS } from '@/config/rate-limits.config';
import { listLeads, getLead, getLeadAnalyses, deleteLead } from './leads.handler';

export function registerLeadRoutes(app: Hono<{ Bindings: Env }>) {
  
  // All lead routes require authentication
  app.use('/api/leads/*', authMiddleware);
  
  // Apply general API rate limiting
  app.use('/api/leads/*', rateLimitMiddleware(API_RATE_LIMITS.GENERAL));

  /**
   * GET /api/leads
   * List all leads with pagination
   * Query params: ?businessProfileId=uuid&page=1&pageSize=50&sortBy=last_analyzed_at&sortOrder=desc&search=nike
   */
  app.get('/api/leads', listLeads);

  /**
   * GET /api/leads/:leadId
   * Get single lead details
   */
  app.get('/api/leads/:leadId', getLead);

  /**
   * GET /api/leads/:leadId/analyses
   * Get analysis history for lead
   * Query params: ?limit=10&analysisType=light
   */
  app.get('/api/leads/:leadId/analyses', getLeadAnalyses);

  /**
   * DELETE /api/leads/:leadId
   * Soft delete lead (30-day recovery window)
   */
  app.delete('/api/leads/:leadId', deleteLead);
}
