// features/leads/profile-refresh.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { 
  checkProfileRefresh, 
  forceProfileRefresh,
  getCacheStatistics
} from './profile-refresh.handler';

/**
 * PROFILE REFRESH ROUTES
 * 
 * Phase 7: Smart cache invalidation and profile refresh detection
 * 
 * Endpoints:
 * - POST /api/leads/:leadId/refresh-check → Check if profile needs refresh
 * - POST /api/leads/:leadId/force-refresh → Force cache invalidation
 * - GET /api/cache/statistics → Get cache stats (admin/debug)
 * 
 * Cache Invalidation Triggers:
 * - Follower count changed >10%
 * - Bio changed significantly (>30% different)
 * - Privacy status changed
 * - Verification status changed
 * - Manual force refresh
 */

export function registerProfileRefreshRoutes(app: Hono<{ Bindings: Env }>) {
  
  // All profile refresh routes require authentication
  app.use('/api/leads/:leadId/refresh-check', authMiddleware);
  app.use('/api/leads/:leadId/force-refresh', authMiddleware);
  app.use('/api/cache/statistics', authMiddleware);
  
  // Apply general API rate limiting
  app.use('/api/leads/:leadId/refresh-check', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));
  app.use('/api/leads/:leadId/force-refresh', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));
  app.use('/api/cache/statistics', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));

  /**
   * POST /api/leads/:leadId/refresh-check
   * Check if profile should be refreshed based on significant changes
   * 
   * Does a lightweight scrape (no posts) and compares:
   * - Follower count (>10% change triggers refresh)
   * - Bio text (>30% different triggers refresh)
   * - Privacy status (any change triggers refresh)
   * - Verification status (any change triggers refresh)
   * 
   * Returns:
   * - needs_refresh: boolean
   * - changes: { follower_count, bio_changed, privacy_changed, verification_changed }
   * - invalidation_reason: string | null
   * - recommendation: string
   */
  app.post('/api/leads/:leadId/refresh-check', checkProfileRefresh);

  /**
   * POST /api/leads/:leadId/force-refresh
   * Force profile cache invalidation (manual refresh)
   * 
   * Immediately invalidates the R2 cache for this profile.
   * Next analysis will scrape fresh data from Instagram.
   * 
   * Use cases:
   * - User knows profile changed significantly
   * - Debugging stale cache issues
   * - Admin override
   * 
   * Returns:
   * - cache_invalidated: true
   * - message: "Cache invalidated. Next analysis will use fresh data."
   * - next_steps: instructions
   */
  app.post('/api/leads/:leadId/force-refresh', forceProfileRefresh);

  /**
   * GET /api/cache/statistics
   * Get cache statistics (admin/debug endpoint)
   *
   * Returns:
   * - total_cached: number
   * - by_type: { light }  (extensible for more types)
   * - avg_age_seconds: number
   * - ttl_config: { light: "24h" }
   * - invalidation_triggers: string[]
   *
   * Useful for:
   * - Monitoring cache hit rates
   * - Debugging cache issues
   * - Optimizing TTL settings
   */
  app.get('/api/cache/statistics', getCacheStatistics);
}
