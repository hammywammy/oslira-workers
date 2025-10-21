// infrastructure/cache/r2-cache.service.ts

import type { AnalysisType, ProfileData } from '@/shared/types/analysis.types';

interface CachedProfile {
  profile: ProfileData;
  cached_at: string;
}

export class R2CacheService {
  constructor(private bucket: R2Bucket) {}

  /**
   * Get cached profile if valid for analysis type
   * Returns null if cache miss or expired
   */
  async get(username: string, analysisType: AnalysisType): Promise<ProfileData | null> {
    const key = this.buildCacheKey(username);
    
    try {
      const cached = await this.bucket.get(key);
      if (!cached) return null;
      
      const data = await cached.json() as CachedProfile;
      
      // Validate cache structure
      if (!data.profile?.username || !data.cached_at) {
        console.warn('Invalid cache structure', { username, key });
        return null;
      }
      
      // Check TTL based on analysis type
      if (this.isCacheExpired(data.cached_at, analysisType)) {
        return null;
      }
      
      return data.profile;
      
    } catch (error: any) {
      console.warn('Cache read failed', { username, error: error.message });
      return null;
    }
  }

  /**
   * Store profile in cache
   * Global cache (any account can benefit)
   */
  async set(username: string, profile: ProfileData): Promise<void> {
    const key = this.buildCacheKey(username);
    
    try {
      const cacheData: CachedProfile = {
        profile,
        cached_at: new Date().toISOString()
      };
      
      await this.bucket.put(key, JSON.stringify(cacheData));
      
      console.log('Profile cached', { 
        username: profile.username,
        key,
        posts_count: profile.latestPosts?.length || 0
      });
      
    } catch (error: any) {
      console.warn('Cache write failed', { username, error: error.message });
      // Don't throw - caching is optional optimization
    }
  }

  /**
   * Invalidate cache for username
   * Used when profile data is stale (follower change >10%)
   */
  async invalidate(username: string): Promise<void> {
    const key = this.buildCacheKey(username);
    
    try {
      await this.bucket.delete(key);
      console.log('Cache invalidated', { username, key });
    } catch (error: any) {
      console.warn('Cache delete failed', { username, error: error.message });
    }
  }

  /**
   * Check if cache expired based on analysis type TTL
   */
  private isCacheExpired(cachedAt: string, analysisType: AnalysisType): boolean {
    const age = Date.now() - new Date(cachedAt).getTime();
    
    const ttls: Record<AnalysisType, number> = {
      light: 24 * 60 * 60 * 1000,  // 24 hours
      deep: 12 * 60 * 60 * 1000,   // 12 hours
      xray: 6 * 60 * 60 * 1000     // 6 hours
    };
    
    return age > ttls[analysisType];
  }

  /**
   * Build global cache key
   */
  private buildCacheKey(username: string): string {
    return `instagram:${username.toLowerCase()}:v1`;
  }
}
