// infrastructure/cache/r2-cache.service.ts

import type { R2Bucket } from '@cloudflare/workers-types';
import { CacheStrategyService, type CachedProfile } from './cache-strategy.service';

/**
 * R2 CACHE SERVICE (Facade)
 *
 * Wrapper around CacheStrategyService for backward compatibility
 * Now includes Phase 7 smart caching with TTL and invalidation
 */

export interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  isVerified: boolean;
  isPrivate: boolean;
  profilePicUrl: string;
  externalUrl: string | null;
  isBusinessAccount: boolean;
  latestPosts: Array<{
    id: string;
    caption: string;
    likeCount: number;
    commentCount: number;
    timestamp: string;
    mediaType: 'photo' | 'video' | 'carousel';
    mediaUrl: string;
  }>;
  scraperUsed: string;
  dataQuality: 'high' | 'medium' | 'low';
}

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

    // Transform CachedProfile to ProfileData format
    return {
      username: cached.username,
      displayName: cached.display_name,
      bio: cached.bio,
      followersCount: cached.follower_count,
      followingCount: cached.following_count,
      postsCount: cached.post_count,
      isVerified: cached.is_verified,
      isPrivate: cached.is_private,
      profilePicUrl: cached.profile_pic_url,
      externalUrl: cached.external_url || null,
      isBusinessAccount: cached.is_business_account,
      latestPosts: cached.latest_posts.map(post => ({
        id: post.id,
        caption: post.caption,
        likeCount: post.like_count,
        commentCount: post.comment_count,
        timestamp: post.timestamp,
        mediaType: 'photo' as const,
        mediaUrl: ''
      })),
      scraperUsed: cached.scraper_used,
      dataQuality: cached.data_quality
    };
  }

  /**
   * Set cached profile (Phase 7: with TTL)
   */
  async set(username: string, profile: ProfileData, analysisType: 'light' | 'deep' | 'xray' = 'light'): Promise<void> {
    const cachedProfile: CachedProfile = {
      username: profile.username,
      display_name: profile.displayName,
      bio: profile.bio,
      follower_count: profile.followersCount,
      following_count: profile.followingCount,
      post_count: profile.postsCount,
      is_verified: profile.isVerified,
      is_private: profile.isPrivate,
      profile_pic_url: profile.profilePicUrl,
      external_url: profile.externalUrl || null,
      is_business_account: profile.isBusinessAccount,
      latest_posts: (profile.latestPosts || []).map(post => ({
        id: post.id,
        caption: post.caption,
        like_count: post.likeCount,
        comment_count: post.commentCount,
        timestamp: post.timestamp
      })),
      cached_at: new Date().toISOString(),
      scraper_used: profile.scraperUsed,
      data_quality: profile.dataQuality
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
      display_name: newProfile.displayName,
      bio: newProfile.bio,
      follower_count: newProfile.followersCount,
      following_count: newProfile.followingCount,
      post_count: newProfile.postsCount,
      is_verified: newProfile.isVerified,
      is_private: newProfile.isPrivate,
      profile_pic_url: newProfile.profilePicUrl,
      external_url: newProfile.externalUrl || null,
      is_business_account: newProfile.isBusinessAccount,
      latest_posts: [],
      cached_at: new Date().toISOString(),
      scraper_used: newProfile.scraperUsed,
      data_quality: newProfile.dataQuality
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
