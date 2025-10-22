// infrastructure/cache/cache-strategy.service.ts

import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * CACHE STRATEGY SERVICE
 * 
 * Phase 7: Smart Caching with TTL and Invalidation
 * 
 * Strategy:
 * - LIGHT: 24h TTL (less critical, cost-optimized)
 * - DEEP: 12h TTL (balanced freshness vs cost)
 * - XRAY: 6h TTL (most critical, freshest data)
 * 
 * Invalidation Triggers:
 * - TTL expired (automatic)
 * - Follower count changed >10%
 * - Bio changed significantly (>30% different)
 * - Profile went private/public
 * - Verification status changed
 * 
 * Cache Key Format: `instagram:${username}:v1`
 */

export interface CachedProfile {
  username: string;
  display_name: string;
  follower_count: number;
  following_count: number;
  post_count: number;
  bio: string;
  external_url: string | null;
  profile_pic_url: string;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  latest_posts: Array<{
    id: string;
    caption: string;
    like_count: number;
    comment_count: number;
    timestamp: string;
  }>;
  cached_at: string;
  scraper_used: string;
  data_quality: 'high' | 'medium' | 'low';
}

export interface CacheMetadata {
  cached_at: number;
  ttl_seconds: number;
  analysis_type: 'light' | 'deep' | 'xray';
  version: number;
}

export interface InvalidationReason {
  reason: 'ttl_expired' | 'follower_change' | 'bio_change' | 'privacy_change' | 'verification_change' | 'manual';
  details: string;
}

export class CacheStrategyService {
  private bucket: R2Bucket;
  private readonly CACHE_VERSION = 1;
  private readonly TTL_CONFIG = {
    light: 24 * 60 * 60,  // 24 hours
    deep: 12 * 60 * 60,   // 12 hours
    xray: 6 * 60 * 60     // 6 hours
  };

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  /**
   * Get cached profile with TTL check
   */
  async get(
    username: string,
    analysisType: 'light' | 'deep' | 'xray'
  ): Promise<CachedProfile | null> {
    const key = this.buildCacheKey(username);
    
    try {
      const object = await this.bucket.get(key);
      
      if (!object) {
        console.log(`[Cache] MISS: ${username}`);
        return null;
      }

      const profile = await object.json<CachedProfile>();
      const metadata = this.parseMetadata(object);

      // Check if TTL expired
      if (this.isTTLExpired(metadata, analysisType)) {
        console.log(`[Cache] EXPIRED: ${username} (${analysisType}, age: ${this.getAge(metadata)}s)`);
        await this.delete(username);
        return null;
      }

      console.log(`[Cache] HIT: ${username} (age: ${this.getAge(metadata)}s, ttl: ${this.TTL_CONFIG[analysisType]}s)`);
      return profile;
    } catch (error) {
      console.error('[Cache] Get error:', error);
      return null;
    }
  }

  /**
   * Set cached profile with TTL
   */
  async set(
    username: string,
    profile: CachedProfile,
    analysisType: 'light' | 'deep' | 'xray'
  ): Promise<void> {
    const key = this.buildCacheKey(username);
    const ttl = this.TTL_CONFIG[analysisType];
    
    const metadata: CacheMetadata = {
      cached_at: Date.now(),
      ttl_seconds: ttl,
      analysis_type: analysisType,
      version: this.CACHE_VERSION
    };

    try {
      await this.bucket.put(key, JSON.stringify(profile), {
        customMetadata: {
          cached_at: metadata.cached_at.toString(),
          ttl_seconds: metadata.ttl_seconds.toString(),
          analysis_type: metadata.analysis_type,
          version: metadata.version.toString()
        }
      });

      console.log(`[Cache] SET: ${username} (ttl: ${ttl}s, type: ${analysisType})`);
    } catch (error) {
      console.error('[Cache] Set error:', error);
    }
  }

  /**
   * Check if cached profile should be invalidated
   */
  async shouldInvalidate(
    username: string,
    newProfile: CachedProfile,
    analysisType: 'light' | 'deep' | 'xray'
  ): Promise<InvalidationReason | null> {
    const cachedProfile = await this.get(username, analysisType);
    
    if (!cachedProfile) {
      return null; // No cache to invalidate
    }

    // Check follower count change (>10%)
    const followerChange = Math.abs(
      newProfile.follower_count - cachedProfile.follower_count
    );
    const followerChangePercent = (followerChange / cachedProfile.follower_count) * 100;

    if (followerChangePercent > 10) {
      return {
        reason: 'follower_change',
        details: `Follower count changed by ${followerChangePercent.toFixed(1)}% (${cachedProfile.follower_count} → ${newProfile.follower_count})`
      };
    }

    // Check bio change (>30% different)
    const bioSimilarity = this.calculateStringSimilarity(
      cachedProfile.bio,
      newProfile.bio
    );

    if (bioSimilarity < 0.7) {
      return {
        reason: 'bio_change',
        details: `Bio changed significantly (${Math.round((1 - bioSimilarity) * 100)}% different)`
      };
    }

    // Check privacy status change
    if (cachedProfile.is_private !== newProfile.is_private) {
      return {
        reason: 'privacy_change',
        details: `Profile went ${newProfile.is_private ? 'private' : 'public'}`
      };
    }

    // Check verification status change
    if (cachedProfile.is_verified !== newProfile.is_verified) {
      return {
        reason: 'verification_change',
        details: `Verification status changed to ${newProfile.is_verified ? 'verified' : 'unverified'}`
      };
    }

    return null; // Cache is still valid
  }

  /**
   * Invalidate (delete) cached profile
   */
  async invalidate(username: string, reason: InvalidationReason): Promise<void> {
    console.log(`[Cache] INVALIDATE: ${username} - ${reason.reason}: ${reason.details}`);
    await this.delete(username);
  }

  /**
   * Delete cached profile
   */
  async delete(username: string): Promise<void> {
    const key = this.buildCacheKey(username);
    
    try {
      await this.bucket.delete(key);
      console.log(`[Cache] DELETE: ${username}`);
    } catch (error) {
      console.error('[Cache] Delete error:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStatistics(): Promise<{
    total_cached: number;
    by_type: Record<string, number>;
    avg_age_seconds: number;
  }> {
    const objects = await this.bucket.list({ prefix: 'instagram:' });
    
    const byType: Record<string, number> = {
      light: 0,
      deep: 0,
      xray: 0
    };

    let totalAge = 0;

    for (const object of objects.objects) {
      const metadata = this.parseMetadata(object);
      if (metadata.analysis_type) {
        byType[metadata.analysis_type]++;
      }
      totalAge += this.getAge(metadata);
    }

    return {
      total_cached: objects.objects.length,
      by_type: byType,
      avg_age_seconds: objects.objects.length > 0 
        ? Math.round(totalAge / objects.objects.length) 
        : 0
    };
  }

  /**
   * Build cache key
   */
  private buildCacheKey(username: string): string {
    return `instagram:${username.toLowerCase()}:v${this.CACHE_VERSION}`;
  }

  /**
   * Parse metadata from R2 object
   */
  private parseMetadata(object: any): CacheMetadata {
    const customMetadata = object.customMetadata || {};
    
    return {
      cached_at: parseInt(customMetadata.cached_at || '0'),
      ttl_seconds: parseInt(customMetadata.ttl_seconds || '0'),
      analysis_type: customMetadata.analysis_type || 'light',
      version: parseInt(customMetadata.version || '1')
    };
  }

  /**
   * Check if TTL expired
   */
  private isTTLExpired(metadata: CacheMetadata, requestedType: 'light' | 'deep' | 'xray'): boolean {
    const age = this.getAge(metadata);
    const requiredTTL = this.TTL_CONFIG[requestedType];
    
    // Use the stricter TTL (requested vs cached)
    const effectiveTTL = Math.min(metadata.ttl_seconds, requiredTTL);
    
    return age > effectiveTTL;
  }

  /**
   * Get age of cached object in seconds
   */
  private getAge(metadata: CacheMetadata): number {
    return Math.floor((Date.now() - metadata.cached_at) / 1000);
  }

  /**
   * Calculate string similarity (Levenshtein distance-based)
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const maxLength = Math.max(str1.length, str2.length);
    const distance = this.levenshteinDistance(str1, str2);
    
    return 1 - (distance / maxLength);
  }

  /**
   * Levenshtein distance algorithm
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }
}

/**
 * Usage Example:
 * 
 * const cacheStrategy = new CacheStrategyService(env.R2_CACHE_BUCKET);
 * 
 * // Get with TTL check
 * const cached = await cacheStrategy.get('nike', 'deep');
 * 
 * if (!cached) {
 *   // Scrape fresh data
 *   const profile = await scrapeProfile('nike');
 *   
 *   // Check if should invalidate existing cache
 *   const invalidation = await cacheStrategy.shouldInvalidate('nike', profile, 'deep');
 *   if (invalidation) {
 *     await cacheStrategy.invalidate('nike', invalidation);
 *   }
 *   
 *   // Set new cache
 *   await cacheStrategy.set('nike', profile, 'deep');
 * }
 * 
 * // Get statistics
 * const stats = await cacheStrategy.getStatistics();
 * // { total_cached: 150, by_type: { light: 50, deep: 75, xray: 25 }, avg_age_seconds: 18000 }
 */
