import type { R2Bucket, R2Object } from '@cloudflare/workers-types';
import { logger } from '@/shared/utils/logger.util';

/**
 * Cache Strategy Service
 *
 * Smart Caching with TTL and Invalidation
 *
 * Strategy:
 * - LIGHT/DEEP: 24h TTL
 *
 * Invalidation Triggers:
 * - TTL expired (automatic)
 * - Follower count changed >10%
 * - Bio changed significantly (>30% different)
 * - Profile went private/public
 * - Verification status changed
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
  analysis_type: 'light' | 'deep';
  version: number;
}

export interface InvalidationReason {
  reason: 'ttl_expired' | 'follower_change' | 'bio_change' | 'privacy_change' | 'verification_change' | 'manual';
  details: string;
}

export class CacheStrategyService {
  private bucket: R2Bucket;
  private readonly CACHE_VERSION = 1;
  private readonly TTL_CONFIG: Record<'light' | 'deep', number> = {
    light: 24 * 60 * 60,
    deep: 24 * 60 * 60
  };

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  /** Get cached profile with TTL check */
  async get(
    username: string,
    analysisType: 'light' | 'deep'
  ): Promise<CachedProfile | null> {
    const key = this.buildCacheKey(username);

    try {
      const object = await this.bucket.get(key);

      if (!object) {
        logger.debug('Cache miss', { username });
        return null;
      }

      const profile = await object.json<CachedProfile>();
      const metadata = this.parseMetadata(object);

      const ageSeconds = this.getAge(metadata);
      const ttlSeconds = this.TTL_CONFIG[analysisType];
      const remainingSeconds = ttlSeconds - ageSeconds;

      if (this.isTTLExpired(metadata, analysisType)) {
        logger.info('Cache expired', {
          username,
          analysisType,
          age: this.formatDuration(ageSeconds)
        });
        await this.delete(username);
        return null;
      }

      const ageHours = ageSeconds / 3600;
      const remainingHours = remainingSeconds / 3600;

      logger.info('Cache hit', {
        username,
        age: `${ageHours.toFixed(1)}h`,
        remaining: `${remainingHours.toFixed(1)}h`,
        type: analysisType,
        followerCount: profile.follower_count
      });

      if (ageSeconds > 72000) {
        logger.warn('Stale cache data', {
          username,
          age: `${ageHours.toFixed(1)}h`
        });
      }

      return profile;
    } catch (error: unknown) {
      logger.error('Cache get error', {
        username,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /** Set cached profile with TTL */
  async set(
    username: string,
    profile: CachedProfile,
    analysisType: 'light' | 'deep'
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

      logger.info('Cache set', { username, ttl, analysisType });
    } catch (error: unknown) {
      logger.error('Cache set error', {
        username,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Check if cached profile should be invalidated */
  async shouldInvalidate(
    username: string,
    newProfile: CachedProfile,
    analysisType: 'light' | 'deep'
  ): Promise<InvalidationReason | null> {
    const cachedProfile = await this.get(username, analysisType);

    if (!cachedProfile) {
      return null;
    }

    const followerDelta = newProfile.follower_count - cachedProfile.follower_count;
    const cachedAt = new Date(cachedProfile.cached_at).getTime();
    const timeElapsedMs = Date.now() - cachedAt;
    const timeElapsedHours = timeElapsedMs / 3600000;
    const growthRatePerHour = timeElapsedHours > 0 ? followerDelta / timeElapsedHours : 0;

    logger.info('Follower growth tracking', {
      username,
      previous: cachedProfile.follower_count,
      current: newProfile.follower_count,
      delta: followerDelta > 0 ? `+${followerDelta}` : `${followerDelta}`,
      timeElapsed: `${timeElapsedHours.toFixed(1)}h`,
      growthRate: `${growthRatePerHour.toFixed(0)}/hour`
    });

    const followerChange = Math.abs(followerDelta);
    const followerChangePercent = (followerChange / cachedProfile.follower_count) * 100;

    if (followerChangePercent > 10) {
      return {
        reason: 'follower_change',
        details: `Follower count changed by ${followerChangePercent.toFixed(1)}% (${cachedProfile.follower_count} → ${newProfile.follower_count})`
      };
    }

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

    if (cachedProfile.is_private !== newProfile.is_private) {
      return {
        reason: 'privacy_change',
        details: `Profile went ${newProfile.is_private ? 'private' : 'public'}`
      };
    }

    if (cachedProfile.is_verified !== newProfile.is_verified) {
      return {
        reason: 'verification_change',
        details: `Verification status changed to ${newProfile.is_verified ? 'verified' : 'unverified'}`
      };
    }

    return null;
  }

  /** Invalidate (delete) cached profile */
  async invalidate(username: string, reason: InvalidationReason): Promise<void> {
    logger.info('Cache invalidate', {
      username,
      reason: reason.reason,
      details: reason.details
    });
    await this.delete(username);
  }

  /** Delete cached profile */
  async delete(username: string): Promise<void> {
    const key = this.buildCacheKey(username);

    try {
      await this.bucket.delete(key);
      logger.debug('Cache delete', { username });
    } catch (error: unknown) {
      logger.error('Cache delete error', {
        username,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Get cache statistics */
  async getStatistics(): Promise<{
    total_cached: number;
    by_type: Record<string, number>;
    avg_age_seconds: number;
  }> {
    const objects = await this.bucket.list({ prefix: 'instagram:' });

    const byType: Record<string, number> = {
      light: 0
    };

    let totalAge = 0;

    for (const object of objects.objects) {
      const metadata = this.parseMetadataFromListObject(object);
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

  private buildCacheKey(username: string): string {
    return `instagram:${username.toLowerCase()}:v${this.CACHE_VERSION}`;
  }

  private parseMetadata(object: R2Object): CacheMetadata {
    const customMetadata = object.customMetadata || {};

    return {
      cached_at: parseInt(customMetadata.cached_at || '0'),
      ttl_seconds: parseInt(customMetadata.ttl_seconds || '0'),
      analysis_type: (customMetadata.analysis_type as 'light' | 'deep') || 'light',
      version: parseInt(customMetadata.version || '1')
    };
  }

  private parseMetadataFromListObject(object: { customMetadata?: Record<string, string> }): CacheMetadata {
    const customMetadata = object.customMetadata || {};

    return {
      cached_at: parseInt(customMetadata.cached_at || '0'),
      ttl_seconds: parseInt(customMetadata.ttl_seconds || '0'),
      analysis_type: (customMetadata.analysis_type as 'light' | 'deep') || 'light',
      version: parseInt(customMetadata.version || '1')
    };
  }

  private isTTLExpired(metadata: CacheMetadata, requestedType: 'light' | 'deep'): boolean {
    const age = this.getAge(metadata);
    const requiredTTL = this.TTL_CONFIG[requestedType];
    const effectiveTTL = Math.min(metadata.ttl_seconds, requiredTTL);

    return age > effectiveTTL;
  }

  private getAge(metadata: CacheMetadata): number {
    return Math.floor((Date.now() - metadata.cached_at) / 1000);
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const maxLength = Math.max(str1.length, str2.length);
    const distance = this.levenshteinDistance(str1, str2);

    return 1 - (distance / maxLength);
  }

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
