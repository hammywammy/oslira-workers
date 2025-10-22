// features/business/business.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { 
  listBusinessProfiles, 
  getBusinessProfile, 
  createBusinessProfile, 
  updateBusinessProfile 
} from './business.handler';

export function registerBusinessRoutes(app: Hono<{ Bindings: Env }>) {
  
  // All business profile routes require authentication
  app.use('/api/business-profiles/*', authMiddleware);
  
  // Apply general API rate limiting
  app.use('/api/business-profiles/*', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));

  /**
   * GET /api/business-profiles
   * List all business profiles with pagination
   * Query params: ?page=1&pageSize=20
   */
  app.get('/api/business-profiles', listBusinessProfiles);

  /**
   * GET /api/business-profiles/:profileId
   * Get single business profile details
   */
  app.get('/api/business-profiles/:profileId', getBusinessProfile);

  /**
   * POST /api/business-profiles
   * Create new business profile
   */
  app.post('/api/business-profiles', createBusinessProfile);

  /**
   * PUT /api/business-profiles/:profileId
   * Update business profile
   */
  app.put('/api/business-profiles/:profileId', updateBusinessProfile);
}
