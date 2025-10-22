// infrastructure/scraping/apify.adapter.ts

import type { Env } from '@/shared/types/env.types';
import type { ProfileData, PostData } from '@/infrastructure/ai/prompt-builder.service';

/**
 * APIFY ADAPTER
 * 
 * Scrapes Instagram profiles using Apify's Instagram Profile Scraper
 * Actor ID: apify/instagram-profile-scraper
 * 
 * Features:
 * - Automatic retry on infrastructure failures (3 attempts)
 * - Response transformation to ProfileData format
 * - Error handling for private/deleted profiles
 * - Cost tracking per scrape
 */

export interface ApifyScraperInput {
  username: string[];
  resultsLimit: number;  // Number of posts to scrape
}

export interface ApifyRawPost {
  id: string;
  caption?: string;
  likesCount: number;
  commentsCount: number;
  timestamp: string;
  type: 'Image' | 'Video' | 'Sidecar';
  displayUrl: string;
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

export class ApifyAdapter {
  private apiToken: string;
  private baseURL = 'https://api.apify.com/v2';
  private actorId = 'apify/instagram-profile-scraper';

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  /**
   * Scrape Instagram profile with retry logic
   */
  async scrapeProfile(
    username: string,
    postsLimit: number = 12,
    maxRetries: number = 3
  ): Promise<ProfileData> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Apify] Attempt ${attempt}/${maxRetries} for @${username}`);
        
        const profile = await this.executeScrape(username, postsLimit);
        
        console.log(`[Apify] Success on attempt ${attempt} for @${username}`);
        return profile;

      } catch (error: any) {
        lastError = error;

        // Don't retry on user errors (profile not found, private, etc)
        if (this.isUserError(error)) {
          throw error;
        }

        // Retry on infrastructure errors
        if (attempt < maxRetries) {
          const backoffMs = attempt * 2000; // 2s, 4s, 6s
          console.warn(
            `[Apify] Attempt ${attempt} failed for @${username}, retrying in ${backoffMs}ms...`,
            error.message
          );
          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    throw new Error(
      `Apify scraping failed after ${maxRetries} attempts for @${username}: ${lastError?.message}`
    );
  }

  /**
   * Execute single scrape attempt
   */
  private async executeScrape(username: string, postsLimit: number): Promise<ProfileData> {
    // Step 1: Start actor run
    const runResult = await this.startActorRun(username, postsLimit);

    // Step 2: Wait for completion (with timeout)
    await this.waitForCompletion(runResult.id, 60000); // 60s timeout

    // Step 3: Fetch results from dataset
    const rawProfile = await this.fetchDatasetResults(runResult.defaultDatasetId);

    // Step 4: Transform to ProfileData format
    return this.transformProfile(rawProfile);
  }

  /**
   * Start Apify actor run
   */
  private async startActorRun(username: string, postsLimit: number): Promise<ApifyRunResult> {
    const input: ApifyScraperInput = {
      username: [username],
      resultsLimit: postsLimit
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
   * Transform Apify response to ProfileData format
   */
  private transformProfile(raw: ApifyRawProfile): ProfileData {
    return {
      username: raw.username,
      display_name: raw.fullName || raw.username,
      follower_count: raw.followersCount,
      following_count: raw.followsCount,
      post_count: raw.postsCount,
      bio: raw.biography || '',
      external_url: raw.externalUrl,
      is_verified: raw.verified,
      is_private: raw.private,
      is_business_account: !!raw.businessCategoryName,
      profile_pic_url: raw.profilePicUrl,
      posts: this.transformPosts(raw.latestPosts || [])
    };
  }

  /**
   * Transform posts array
   */
  private transformPosts(rawPosts: ApifyRawPost[]): PostData[] {
    return rawPosts.map(post => ({
      id: post.id,
      caption: post.caption || '',
      like_count: post.likesCount,
      comment_count: post.commentsCount,
      timestamp: post.timestamp,
      media_type: this.mapMediaType(post.type),
      media_url: post.displayUrl
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

  /**
   * Estimate cost of scrape
   * Based on Apify pricing: ~$0.001 per profile scrape
   */
  static estimateCost(postsLimit: number): number {
    // Base cost: $0.001
    // Additional cost for more posts: $0.0001 per post over 12
    const baseCost = 0.001;
    const extraPosts = Math.max(0, postsLimit - 12);
    const extraCost = extraPosts * 0.0001;
    
    return baseCost + extraCost;
  }
}
