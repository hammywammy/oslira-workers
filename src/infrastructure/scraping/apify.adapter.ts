// infrastructure/scraping/apify.adapter.ts

import type { ProfileData } from '@/infrastructure/cache/r2-cache.service';
import { SCRAPER_CONFIG } from '@/config/operations-pricing.config';

/**
 * APIFY ADAPTER
 *
 * Scrapes Instagram profiles using configured Apify actor
 *
 * Features:
 * - Configurable actor ID (no hardcoded values)
 * - Automatic retry on infrastructure failures
 * - Response transformation to ProfileData format
 * - Error handling for private/deleted profiles
 * - Cost tracking per scrape
 *
 * Future: Extensible for multi-channel support (Brightdata, etc)
 */

export interface ApifyScraperInput {
  usernames: string[];
  resultsLimit?: number;  // Number of posts to scrape
}

export interface ApifyRawPost {
  id: string;
  caption?: string;
  likesCount: number;
  commentsCount: number;
  timestamp: string;
  type: 'Image' | 'Video' | 'Sidecar';
  displayUrl: string;
  // Extended metadata from Apify
  videoUrl?: string;
  videoViewCount?: number;
  productType?: 'feed' | 'clips' | 'igtv';  // 'clips' = Reels
  hashtags?: string[];
  mentions?: string[];
  locationName?: string | null;
  locationId?: string | null;
}

export interface ApifyRawProfile {
  id: string;
  username: string;
  fullName: string;
  biography: string;
  externalUrl: string | null;
  followersCount: number;
  followsCount: number;
  postsCount: number;
  verified: boolean;
  private: boolean;
  businessCategoryName: string | null;
  profilePicUrl: string;
  latestPosts: ApifyRawPost[];
}

export interface ApifyRunResult {
  id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  defaultDatasetId: string;
}

/**
 * Apify error response when profile cannot be found/accessed
 */
export interface ApifyErrorItem {
  url?: string;
  username?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Result from scrapeProfileWithMeta - includes both data and error info
 * for pre-analysis checks to process
 */
export interface ScrapeResult {
  /** Whether the scrape succeeded */
  success: boolean;
  /** Profile data if successful */
  profile?: ProfileData;
  /** Error information if failed */
  error?: ApifyErrorItem;
  /** Raw items from Apify (for debugging) */
  rawItemCount?: number;
}

export class ApifyAdapter {
  private apiToken: string;
  private baseURL = 'https://api.apify.com/v2';
  private actorId: string;

  constructor(apiToken: string, actorId?: string) {
    this.apiToken = apiToken;
    this.actorId = actorId || SCRAPER_CONFIG.actor_id;
  }


  /**
   * Scrape Instagram profile with metadata about errors
   * Returns a result object that includes error info for pre-analysis checks
   *
   * Use this method when you need to handle not-found or error profiles gracefully
   * instead of throwing exceptions.
   */
  async scrapeProfileWithMeta(
    username: string,
    postsLimit: number = 12
  ): Promise<ScrapeResult> {
    const maxRetries = SCRAPER_CONFIG.max_retries;
    let lastError: Error | null = null;
    let lastErrorItem: ApifyErrorItem | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Apify] Attempt ${attempt}/${maxRetries} for @${username} (actor: ${this.actorId})`);

        const result = await this.executeScrapeWithMeta(username, postsLimit);

        // Check if Apify returned an error item instead of profile data
        if (result.error) {
          console.log(`[Apify] Profile @${username} returned error:`, result.error);
          return result; // Return the error result - don't retry user errors
        }

        console.log(`[Apify] Success on attempt ${attempt} for @${username}`);
        return result;

      } catch (error: any) {
        lastError = error;

        // Don't retry on user errors (profile not found, private, etc)
        if (this.isUserError(error)) {
          return {
            success: false,
            error: {
              username,
              error: 'not_found',
              errorDescription: error.message
            }
          };
        }

        // Retry on infrastructure errors
        if (attempt < maxRetries) {
          const backoffMs = attempt * SCRAPER_CONFIG.retry_delay_ms;
          console.warn(
            `[Apify] Attempt ${attempt} failed for @${username}, retrying in ${backoffMs}ms...`,
            error.message
          );
          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted - return as infrastructure error
    return {
      success: false,
      error: lastErrorItem || {
        username,
        error: 'scrape_failed',
        errorDescription: `Apify scraping failed after ${maxRetries} attempts: ${lastError?.message}`
      }
    };
  }

  /**
   * Execute single scrape attempt
   */
  private async executeScrape(username: string, postsLimit: number): Promise<ProfileData> {
    // Step 1: Start actor run
    const runResult = await this.startActorRun(username, postsLimit);

    // Step 2: Wait for completion (with timeout)
    await this.waitForCompletion(runResult.id, SCRAPER_CONFIG.timeout_ms);

    // Step 3: Fetch results from dataset
    const rawProfile = await this.fetchDatasetResults(runResult.defaultDatasetId);

    // Step 4: Transform to ProfileData format
    return this.transformProfile(rawProfile);
  }

  /**
   * Execute single scrape attempt with metadata (for pre-analysis checks)
   */
  private async executeScrapeWithMeta(username: string, postsLimit: number): Promise<ScrapeResult> {
    // Step 1: Start actor run
    const runResult = await this.startActorRun(username, postsLimit);

    // Step 2: Wait for completion (with timeout)
    await this.waitForCompletion(runResult.id, SCRAPER_CONFIG.timeout_ms);

    // Step 3: Fetch raw results from dataset
    const rawItems = await this.fetchDatasetItems(runResult.defaultDatasetId);

    // Step 4: Check if we got any results
    if (!rawItems || rawItems.length === 0) {
      return {
        success: false,
        rawItemCount: 0,
        error: {
          username,
          error: 'not_found',
          errorDescription: 'No data returned from scraper'
        }
      };
    }

    const firstItem = rawItems[0];

    // Step 5: Check if the result is an error item (not_found, etc)
    if (this.isErrorItem(firstItem)) {
      return {
        success: false,
        rawItemCount: rawItems.length,
        error: firstItem as ApifyErrorItem
      };
    }

    // Step 6: Transform to ProfileData format
    const profile = this.transformProfile(firstItem as ApifyRawProfile);

    return {
      success: true,
      profile,
      rawItemCount: rawItems.length
    };
  }

  /**
   * Check if an Apify result item is an error (not a profile)
   */
  private isErrorItem(item: any): boolean {
    // Error items have 'error' or 'errorDescription' fields
    // and typically lack profile data like 'fullName', 'followersCount'
    return (
      item.error !== undefined ||
      item.errorDescription !== undefined ||
      (item.username && !item.fullName && !item.followersCount)
    );
  }

  /**
   * Start Apify actor run
   */
  private async startActorRun(username: string, postsLimit: number): Promise<ApifyRunResult> {
    const input: ApifyScraperInput = {
      usernames: [username]
    };

    const response = await fetch(`${this.baseURL}/acts/${this.actorId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiToken}`
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Apify API error (${response.status}): ${error}`);
    }

    const result = await response.json();
    return result.data as ApifyRunResult;
  }

  /**
   * Wait for actor run to complete
   */
  private async waitForCompletion(runId: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000; // Check every 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      const run = await this.getRunStatus(runId);

      if (run.status === 'SUCCEEDED') {
        return;
      }

      if (run.status === 'FAILED') {
        throw new Error('Apify actor run failed');
      }

      // Still running, wait and check again
      await this.sleep(pollInterval);
    }

    throw new Error(`Apify run timed out after ${timeoutMs}ms`);
  }

  /**
   * Get actor run status
   */
  private async getRunStatus(runId: string): Promise<ApifyRunResult> {
    const response = await fetch(`${this.baseURL}/actor-runs/${runId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get run status: ${response.status}`);
    }

    const result = await response.json();
    return result.data as ApifyRunResult;
  }

  /**
   * Fetch results from dataset
   */
  private async fetchDatasetResults(datasetId: string): Promise<ApifyRawProfile> {
    const response = await fetch(
      `${this.baseURL}/datasets/${datasetId}/items?format=json`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset: ${response.status}`);
    }

    const items = await response.json();

    if (!items || items.length === 0) {
      throw new Error('Profile not found or is private');
    }

    return items[0] as ApifyRawProfile;
  }

  /**
   * Fetch raw items from dataset (for pre-analysis checks)
   */
  private async fetchDatasetItems(datasetId: string): Promise<any[]> {
    const response = await fetch(
      `${this.baseURL}/datasets/${datasetId}/items?format=json`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Transform Apify response to ProfileData format (camelCase for R2CacheService)
   */
  private transformProfile(raw: ApifyRawProfile): ProfileData {
    const latestPosts = this.transformPosts(raw.latestPosts || []);

    return {
      username: raw.username,
      displayName: raw.fullName || raw.username,
      followersCount: raw.followersCount,
      followingCount: raw.followsCount,
      postsCount: raw.postsCount,
      bio: raw.biography || '',
      externalUrl: raw.externalUrl,
      isVerified: raw.verified,
      isPrivate: raw.private,
      isBusinessAccount: !!raw.businessCategoryName,
      profilePicUrl: raw.profilePicUrl,
      latestPosts: latestPosts,
      scraperUsed: this.actorId,
      dataQuality: this.determineDataQuality(latestPosts.length)
    };
  }

  /**
   * Transform posts array (camelCase for R2CacheService)
   * Preserves rich metadata for format detection and content analysis
   */
  private transformPosts(rawPosts: ApifyRawPost[]): ProfileData['latestPosts'] {
    return rawPosts.map(post => ({
      id: post.id,
      caption: post.caption || '',
      likeCount: post.likesCount,
      commentCount: post.commentsCount,
      timestamp: post.timestamp,
      mediaType: this.mapMediaType(post.type),
      mediaUrl: post.displayUrl,
      // Extended metadata for rich analysis
      videoUrl: post.videoUrl || null,
      videoViewCount: post.videoViewCount || null,
      productType: post.productType || null,
      hashtags: post.hashtags || [],
      mentions: post.mentions || [],
      locationName: post.locationName || null
    }));
  }

  /**
   * Map Apify media type to our format
   */
  private mapMediaType(apifyType: string): 'photo' | 'video' | 'carousel' {
    switch (apifyType) {
      case 'Image':
        return 'photo';
      case 'Video':
        return 'video';
      case 'Sidecar':
        return 'carousel';
      default:
        return 'photo';
    }
  }

  /**
   * Determine data quality based on posts count
   */
  private determineDataQuality(postsCount: number): 'high' | 'medium' | 'low' {
    if (postsCount > 3) return 'high';
    if (postsCount >= 1) return 'medium';
    return 'low';
  }

  /**
   * Check if error is user error (don't retry) vs infrastructure error (retry)
   */
  private isUserError(error: Error): boolean {
    const message = error.message.toLowerCase();

    const userErrorPatterns = [
      'profile not found',
      'is private',
      'user not found',
      'account deleted',
      'invalid username',
      'does not exist'
    ];

    return userErrorPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // NOTE: Cost estimation moved to centralized config
  // Use getScrapingCost() from '@/config/operations-pricing.config'
}
