// infrastructure/cache/avatar-cache.service.ts

import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * AVATAR CACHE SERVICE
 *
 * Caches Instagram profile pictures to R2 for permanent, CORS-free access.
 * Uses per-lead storage keys (avatars/{lead_id}.jpg) for isolation.
 *
 * Why R2?
 * - Instagram scontent URLs expire and have CORS restrictions
 * - R2 URLs are permanent and served from your domain
 * - No reference counting needed with per-lead keys
 */

const CDN_BASE_URL = 'https://cdn.oslira.com';
const AVATAR_PREFIX = 'avatars';

export class AvatarCacheService {
  constructor(private bucket: R2Bucket) {}

  /**
   * Cache avatar to R2 for a specific lead
   *
   * @param leadId - Unique lead ID (used as storage key)
   * @param instagramUrl - Instagram scontent URL to fetch from
   * @returns R2 public URL or null on failure
   *
   * Behavior:
   * - Fetches image bytes from Instagram
   * - Uploads to R2 at avatars/{leadId}.jpg
   * - Overwrites if exists (handles re-analysis)
   * - Returns null on any failure (non-critical operation)
   */
  async cacheAvatar(leadId: string, instagramUrl: string): Promise<string | null> {
    if (!instagramUrl || !leadId) {
      console.log('[AvatarCache] Missing leadId or instagramUrl, skipping');
      return null;
    }

    const startTime = performance.now();

    try {
      // Fetch image from Instagram
      console.log(`[AvatarCache] Fetching avatar for lead ${leadId}`);
      const response = await fetch(instagramUrl, {
        headers: {
          // Some CDNs check user-agent
          'User-Agent': 'Mozilla/5.0 (compatible; OsliraBot/1.0)'
        }
      });

      if (!response.ok) {
        console.warn(`[AvatarCache] Failed to fetch avatar: HTTP ${response.status}`);
        return null;
      }

      // Verify it's actually an image
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.warn(`[AvatarCache] Invalid content-type: ${contentType}`);
        return null;
      }

      // Get image bytes
      const imageBytes = await response.arrayBuffer();

      // Validate size (skip if too small - likely error page)
      if (imageBytes.byteLength < 1000) {
        console.warn(`[AvatarCache] Image too small (${imageBytes.byteLength} bytes), skipping`);
        return null;
      }

      // Upload to R2
      const key = `${AVATAR_PREFIX}/${leadId}.jpg`;
      await this.bucket.put(key, imageBytes, {
        httpMetadata: {
          contentType: contentType.startsWith('image/') ? contentType : 'image/jpeg'
        }
      });

      const r2Url = `${CDN_BASE_URL}/${key}`;
      const durationMs = Math.round(performance.now() - startTime);
      const sizeKB = Math.round(imageBytes.byteLength / 1024);

      console.log(`[AvatarCache] Cached avatar`, {
        leadId,
        url: r2Url,
        durationMs,
        sizeKB: `${sizeKB}KB`
      });

      return r2Url;

    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);
      console.error(`[AvatarCache] Error caching avatar for lead ${leadId} (after ${durationMs}ms):`, error);
      return null;
    }
  }

  /**
   * Delete avatar from R2
   *
   * @param leadId - Lead ID whose avatar should be deleted
   *
   * Safe to call even if avatar doesn't exist.
   * Failures are logged but don't throw.
   */
  async deleteAvatar(leadId: string): Promise<void> {
    if (!leadId) return;

    try {
      const key = `${AVATAR_PREFIX}/${leadId}.jpg`;
      await this.bucket.delete(key);
      console.log(`[AvatarCache] Deleted avatar for lead ${leadId}`);
    } catch (error) {
      // Log but don't throw - deletion is best-effort
      console.error(`[AvatarCache] Error deleting avatar for lead ${leadId}:`, error);
    }
  }

  /**
   * Get the R2 URL for a lead's avatar
   * Does NOT check if avatar exists - just returns the URL pattern
   */
  getAvatarUrl(leadId: string): string {
    return `${CDN_BASE_URL}/${AVATAR_PREFIX}/${leadId}.jpg`;
  }

  /**
   * Check if avatar exists in R2
   */
  async avatarExists(leadId: string): Promise<boolean> {
    try {
      const key = `${AVATAR_PREFIX}/${leadId}.jpg`;
      const object = await this.bucket.head(key);
      return object !== null;
    } catch {
      return false;
    }
  }
}
