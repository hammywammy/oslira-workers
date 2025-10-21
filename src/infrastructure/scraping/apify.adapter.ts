// infrastructure/scraping/apify.adapter.ts

import type { ProfileData, AnalysisType } from '@/shared/types/analysis.types';
import { APIFY_SCRAPERS, getScrapersForAnalysis, calculateApifyCost, type ApifyScraperConfig } from './apify.config';

const APIFY_BASE_URL = 'https://api.apify.com/v2/acts';
const APIFY_RUN_SYNC_ENDPOINT = '/run-sync-get-dataset-items';

export interface ApifyResponse {
  profile: ProfileData;
  posts: any[];
  scraper_used: string;
  duration_ms: number;
  cost: number;
}

export class ApifyAdapter {
  constructor(private apiToken: string) {}

  /**
   * Scrape Instagram profile with automatic fallback
   */
  async scrapeProfile(username: string, analysisType: AnalysisType): Promise<ApifyResponse> {
    const scrapers = getScrapersForAnalysis(analysisType);
    
    let lastError: Error | null = null;

    // Try each scraper in priority order
    for (const scraper of scrapers) {
      try {
        console.log(`[Apify] Attempting scraper: ${scraper.name}`);
        const startTime = Date.now();
        
        const response = await this.callScraper(scraper, username);
        
        const duration = Date.now() - startTime;
        const cost = calculateApifyCost(duration);

        // Validate response
        if (!response || !Array.isArray(response) || response.length === 0) {
          throw new Error(`${scraper.name} returned no data`);
        }

        const rawProfile = response[0];

        // Check for Apify error response
        if (rawProfile.error || rawProfile.errorDescription) {
          const errorType = rawProfile.error || 'unknown_error';
          const errorDesc = rawProfile.errorDescription || 'An error occurred';
          
          if (this.isPermanentError(errorType, errorDesc)) {
            throw new Error(this.transformError(errorType, errorDesc, username));
          }
          
          throw new Error(`Scraper error: ${errorDesc}`);
        }

        // Validate username exists
        if (!rawProfile.username && !rawProfile.handle) {
          throw new Error('No valid profile data returned');
        }

        // Extract posts
        const posts = this.extractPosts(response, analysisType);

        // Transform profile data
        const profile = this.transformProfileData(rawProfile, scraper);

        console.log(`[Apify] Success with ${scraper.name}`, {
          username: profile.username,
          posts: posts.length,
          duration_ms: duration,
          cost: cost
        });

        return {
          profile,
          posts,
          scraper_used: scraper.name,
          duration_ms: duration,
          cost
        };

      } catch (error: any) {
        console.warn(`[Apify] ${scraper.name} failed:`, error.message);
        lastError = error;
        
        // Don't retry permanent errors
        if (this.isPermanentError(error.message, error.message)) {
          throw error;
        }
      }
    }

    // All scrapers failed
    throw lastError || new Error('All scrapers failed');
  }

  /**
   * Call Apify scraper with retries
   */
  private async callScraper(scraper: ApifyScraperConfig, username: string): Promise<any[]> {
    const url = this.buildScraperUrl(scraper.actor_id);
    const body = JSON.stringify(scraper.input(username));

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < scraper.max_retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), scraper.timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Oslira/3.0'
          },
          body,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();

      } catch (error: any) {
        lastError = error;
        
        if (attempt < scraper.max_retries - 1) {
          console.log(`[Apify] Retry ${attempt + 1}/${scraper.max_retries} after ${scraper.retry_delay}ms`);
          await this.sleep(scraper.retry_delay);
        }
      }
    }

    throw lastError || new Error('Scraper failed after retries');
  }

  /**
   * Extract posts from Apify response
   */
  private extractPosts(response: any[], analysisType: AnalysisType): any[] {
    const rawProfile = response[0];

    // Option A: Posts nested in profile object (dS_basic)
    if (rawProfile.latestPosts && Array.isArray(rawProfile.latestPosts)) {
      console.log(`[Apify] Posts found in latestPosts: ${rawProfile.latestPosts.length}`);
      return rawProfile.latestPosts;
    }

    // Option B: Posts are array items after profile (shu scrapers)
    if (response.length > 1) {
      console.log(`[Apify] Posts found in response array: ${response.length - 1}`);
      return response.slice(1);
    }

    console.warn('[Apify] No posts found in response');
    return [];
  }

  /**
   * Transform Apify response to ProfileData
   */
  private transformProfileData(rawData: any, scraper: ApifyScraperConfig): ProfileData {
    const mapping = scraper.field_mapping;

    return {
      username: this.extractField(rawData, mapping.username) || '',
      displayName: this.extractField(rawData, mapping.displayName) || '',
      bio: this.extractField(rawData, mapping.bio) || '',
      followersCount: parseInt(this.extractField(rawData, mapping.followersCount)?.toString() || '0') || 0,
      followingCount: parseInt(this.extractField(rawData, mapping.followingCount)?.toString() || '0') || 0,
      postsCount: parseInt(this.extractField(rawData, mapping.postsCount)?.toString() || '0') || 0,
      isVerified: Boolean(this.extractField(rawData, mapping.isVerified)),
      isPrivate: Boolean(this.extractField(rawData, mapping.isPrivate)),
      profilePicUrl: this.extractField(rawData, mapping.profilePicUrl) || '',
      externalUrl: this.extractField(rawData, mapping.externalUrl) || '',
      isBusinessAccount: Boolean(this.extractField(rawData, mapping.isBusinessAccount)),
      latestPosts: [],  // Added later
      scraperUsed: scraper.name,
      dataQuality: 'medium'
    };
  }

  /**
   * Extract field value using mapping fallbacks
   */
  private extractField(data: any, fieldMapping: readonly string[]): any {
    for (const field of fieldMapping) {
      if (data[field] !== undefined && data[field] !== null) {
        return data[field];
      }
    }
    return null;
  }

  /**
   * Build Apify API URL
   */
  private buildScraperUrl(actorId: string): string {
    return `${APIFY_BASE_URL}/${actorId}${APIFY_RUN_SYNC_ENDPOINT}?token=${this.apiToken}`;
  }

  /**
   * Check if error is permanent (don't retry)
   */
  private isPermanentError(errorType: string, errorDesc: string): boolean {
    const permanent = [
      'not_found',
      'not found',
      'does not exist',
      'private',
      '403'
    ];

    const combined = `${errorType} ${errorDesc}`.toLowerCase();
    return permanent.some(term => combined.includes(term));
  }

  /**
   * Transform error to user-friendly message
   */
  private transformError(errorType: string, errorDesc: string, username: string): string {
    const combined = `${errorType} ${errorDesc}`.toLowerCase();

    if (combined.includes('not found') || combined.includes('does not exist')) {
      return `Instagram profile @${username} not found`;
    }
    if (combined.includes('private') || combined.includes('403')) {
      return `Instagram profile @${username} is private`;
    }
    if (combined.includes('rate limit') || combined.includes('429')) {
      return 'Instagram is temporarily limiting requests. Try again in a few minutes.';
    }
    if (combined.includes('timeout')) {
      return 'Profile scraping timed out. Please try again.';
    }

    return 'Failed to retrieve profile data';
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
