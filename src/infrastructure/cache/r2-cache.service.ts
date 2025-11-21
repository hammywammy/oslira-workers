// infrastructure/cache/r2-cache.service.ts

import type { R2Bucket } from '@cloudflare/workers-types';
import { CacheStrategyService, type CachedProfile } from './cache-strategy.service';
import type { ProfileData } from '@/infrastructure/ai/prompt-builder.service';

/**
 * R2 CACHE SERVICE (Facade)
 *
 * Wrapper around CacheStrategyService for backward compatibility
 * Now includes Phase 7 smart caching with TTL and invalidation
 *
 * Uses canonical ProfileData from prompt-builder.service.ts
 */

export class R2CacheService {
  private strategy: CacheStrategyService;

  constructor(bucket: R2Bucket) {
    this.strategy = new CacheStrategyService(bucket);
  }

  /**
   * Get cached profile (Phase 7: with TTL check)
   */
  async get(username: string, analysisType: 'light' | 'deep' | 'xray'): Promise<ProfileData | null> {
    const cached = await this.strategy.get(username, analysisType);

    if (!cached) {
      return null;
    }

    // Transform CachedProfile to canonical ProfileData format
    return {
      username: cached.username,
      display_name: cached.display_name,
      bio: cached.bio,
      follower_count: cached.follower_count,
      following_count: cached.following_count,
      post_count: cached.post_count,
      is_verified: cached.is_verified,
      is_private: cached.is_private,
      profile_pic_url: cached.profile_pic_url,
      external_url: cached.external_url || null,
      is_business_account: cached.is_business_account,
      posts: cached.latest_posts.map(post => ({
        id: post.id,
        caption: post.caption,
        like_count: post.like_count,
        comment_count: post.comment_count,
        timestamp: post.timestamp,
        media_type: 'photo' as const,
        media_url: ''
      }))
    };
  }

  /**
   * Set cached profile (Phase 7: with TTL)
   */
  async set(username: string, profile: ProfileData, analysisType: 'light' | 'deep' | 'xray' = 'light'): Promise<void> {
    const cachedProfile: CachedProfile = {
      username: profile.username,
      display_name: profile.display_name,
      bio: profile.bio,
      follower_count: profile.follower_count,
      following_count: profile.following_count,
      post_count: profile.post_count,
      is_verified: profile.is_verified,
      is_private: profile.is_private,
      profile_pic_url: profile.profile_pic_url,
      external_url: profile.external_url || null,
      is_business_account: profile.is_business_account,
      latest_posts: (profile.posts || []).map(post => ({
        id: post.id,
        caption: post.caption,
        like_count: post.like_count,
        comment_count: post.comment_count,
        timestamp: post.timestamp
      })),
      cached_at: new Date().toISOString(),
      scraper_used: 'apify',  // Default scraper identifier
      data_quality: 'high'     // Default quality
    };

    await this.strategy.set(username, cachedProfile, analysisType);
  }

  /**
   * Delete cached profile
   */
  async delete(username: string): Promise<void> {
    await this.strategy.delete(username);
  }

  /**
   * Check if should invalidate
   */
  async shouldInvalidate(username: string, newProfile: ProfileData, analysisType: 'light' | 'deep' | 'xray') {
    const cachedProfile: CachedProfile = {
      username: newProfile.username,
      display_name: newProfile.display_name,
      bio: newProfile.bio,
      follower_count: newProfile.follower_count,
      following_count: newProfile.following_count,
      post_count: newProfile.post_count,
      is_verified: newProfile.is_verified,
      is_private: newProfile.is_private,
      profile_pic_url: newProfile.profile_pic_url,
      external_url: newProfile.external_url || null,
      is_business_account: newProfile.is_business_account,
      latest_posts: [],
      cached_at: new Date().toISOString(),
      scraper_used: 'apify',
      data_quality: 'high'
    };

    return await this.strategy.shouldInvalidate(username, cachedProfile, analysisType);
  }

  /**
   * Get cache statistics
   */
  async getStatistics() {
    return await this.strategy.getStatistics();
  }
}
