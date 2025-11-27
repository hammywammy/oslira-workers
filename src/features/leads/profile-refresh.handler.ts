// features/leads/profile-refresh.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { CacheStrategyService } from '@/infrastructure/cache/cache-strategy.service';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { getSecret } from '@/infrastructure/config/secrets';
import { z } from 'zod';
import { logger } from '@/shared/utils/logger.util';

/**
 * PROFILE REFRESH HANDLER
 * 
 * Phase 7: Smart profile refresh detection
 * 
 * Endpoints:
 * - POST /api/leads/:leadId/refresh-check → Check if profile needs refresh
 * - POST /api/leads/:leadId/force-refresh → Force profile refresh (invalidate cache)
 * 
 * Refresh triggers:
 * - Follower count changed >10%
 * - Bio changed significantly
 * - Privacy status changed
 * - Verification status changed
 * - Manual force refresh
 */

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

const RefreshCheckSchema = z.object({
  leadId: z.string().uuid()
});

// ===============================================================================
// HANDLERS
// ===============================================================================

/**
 * POST /api/leads/:leadId/refresh-check
 * Check if profile should be refreshed
 */
export async function checkProfileRefresh(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const leadId = c.req.param('leadId');

    validateBody(RefreshCheckSchema, { leadId });

    // Get lead from database
    const supabase = await c.env.createUserClient(c.req);
    const { data: lead, error } = await supabase
      .from('leads')
      .select('username, follower_count, bio, is_private, is_verified, last_analyzed_at')
      .eq('id', leadId)
      .eq('account_id', auth.primaryAccountId)
      .is('deleted_at', null)
      .single();

    if (error || !lead) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Scrape fresh data (lightweight, just basic profile)
    const apifyKey = await getSecret('APIFY_API_TOKEN', c.env, c.env.APP_ENV);
    const apify = new ApifyAdapter(apifyKey);

    const scrapeResult = await apify.scrapeProfileWithMeta(lead.username, { postsLimit: 0 });
    const freshProfile = scrapeResult.profile;

    // Compare with cached/stored data
    const cacheStrategy = new CacheStrategyService(c.env.R2_CACHE_BUCKET);
    const invalidationReason = await cacheStrategy.shouldInvalidate(
      lead.username,
      {
        username: lead.username,
        display_name: freshProfile.displayName || lead.username,
        follower_count: freshProfile.followersCount,
        following_count: freshProfile.followingCount || 0,
        post_count: freshProfile.postsCount || 0,
        bio: freshProfile.bio || '',
        external_url: freshProfile.externalUrl || null,
        profile_pic_url: freshProfile.profilePicUrl || '',
        is_verified: freshProfile.isVerified || false,
        is_private: freshProfile.isPrivate || false,
        is_business_account: freshProfile.isBusinessAccount || false,
        latest_posts: [],
        cached_at: new Date().toISOString(),
        scraper_used: 'apify',
        data_quality: 'high'
      },
      'light'
    );

    // Calculate changes
    const followerChange = freshProfile.followersCount - lead.follower_count;
    const followerChangePercent = lead.follower_count > 0
      ? (followerChange / lead.follower_count) * 100
      : 0;

    const needsRefresh = invalidationReason !== null;

    return successResponse(c, {
      lead_id: leadId,
      username: lead.username,
      needs_refresh: needsRefresh,
      changes: {
        follower_count: {
          old: lead.follower_count,
          new: freshProfile.followersCount,
          change: followerChange,
          change_percent: parseFloat(followerChangePercent.toFixed(2))
        },
        bio_changed: lead.bio !== (freshProfile.bio || ''),
        privacy_changed: lead.is_private !== freshProfile.isPrivate,
        verification_changed: lead.is_verified !== freshProfile.isVerified
      },
      invalidation_reason: invalidationReason,
      last_analyzed: lead.last_analyzed_at,
      recommendation: needsRefresh 
        ? 'Profile has changed significantly. Recommend re-analysis.'
        : 'Profile is up-to-date. No refresh needed.'
    });

  } catch (error) {
    logger.error('Failed to check profile refresh', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      leadId: c.req.param('leadId')
    });
    return errorResponse(c, 'Failed to check profile refresh', 'REFRESH_CHECK_ERROR', 500);
  }
}

/**
 * POST /api/leads/:leadId/force-refresh
 * Force profile refresh (invalidate cache)
 */
export async function forceProfileRefresh(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const leadId = c.req.param('leadId');

    validateBody(RefreshCheckSchema, { leadId });

    // Get lead from database
    const supabase = await c.env.createUserClient(c.req);
    const { data: lead, error } = await supabase
      .from('leads')
      .select('username')
      .eq('id', leadId)
      .eq('account_id', auth.primaryAccountId)
      .is('deleted_at', null)
      .single();

    if (error || !lead) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Invalidate cache
    const cacheStrategy = new CacheStrategyService(c.env.R2_CACHE_BUCKET);
    await cacheStrategy.invalidate(lead.username, {
      reason: 'manual',
      details: 'Forced refresh by user'
    });

    return successResponse(c, {
      lead_id: leadId,
      username: lead.username,
      cache_invalidated: true,
      message: 'Cache invalidated. Next analysis will use fresh data.',
      next_steps: 'Run a new analysis to get updated profile data.'
    });

  } catch (error) {
    logger.error('Failed to force refresh profile', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      leadId: c.req.param('leadId')
    });
    return errorResponse(c, 'Failed to force refresh', 'FORCE_REFRESH_ERROR', 500);
  }
}

/**
 * GET /api/cache/statistics
 * Get cache statistics (admin/debug endpoint)
 */
export async function getCacheStatistics(c: Context<{ Bindings: Env }>) {
  try {
    const cacheStrategy = new CacheStrategyService(c.env.R2_CACHE_BUCKET);
    const stats = await cacheStrategy.getStatistics();

    return successResponse(c, {
      cache_statistics: stats,
      ttl_config: {
        light: '24 hours'
        // Add more TTL tiers here when implementing additional analysis types
      },
      invalidation_triggers: [
        'Follower count changed >10%',
        'Bio changed significantly (>30% different)',
        'Privacy status changed',
        'Verification status changed',
        'Manual force refresh'
      ]
    });

  } catch (error) {
    logger.error('Failed to get cache statistics', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return errorResponse(c, 'Failed to get cache statistics', 'CACHE_STATS_ERROR', 500);
  }
}
