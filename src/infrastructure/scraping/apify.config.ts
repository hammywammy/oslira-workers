// infrastructure/scraping/apify.config.ts

/**
 * CENTRALIZED APIFY SCRAPER CONFIGURATION
 * Edit actor IDs and settings here - changes apply everywhere
 */

export interface ApifyScraperConfig {
  name: string;
  actor_id: string;  // Apify Actor ID
  timeout: number;
  max_retries: number;
  retry_delay: number;
  priority: number;  // 1 = fallback, 2 = primary
  input: (username: string) => any;
  field_mapping: ApifyFieldMapping;
}

export interface ApifyFieldMapping {
  username: readonly string[];
  displayName: readonly string[];
  bio: readonly string[];
  followersCount: readonly string[];
  followingCount: readonly string[];
  postsCount: readonly string[];
  isVerified: readonly string[];
  isPrivate: readonly string[];
  profilePicUrl: readonly string[];
  externalUrl: readonly string[];
  isBusinessAccount: readonly string[];
}

/**
 * ALL APIFY SCRAPERS
 * Last updated: 2025-01-20
 */
export const APIFY_SCRAPERS: Record<string, ApifyScraperConfig> = {
  // PRIMARY SCRAPER
  'ds_basic': {
    name: 'dS_basic',
    actor_id: 'dSCLg0C3YEZ83HzYX',
    timeout: 30000,
    max_retries: 2,
    retry_delay: 2000,
    priority: 2,  // Primary
    input: (username: string) => ({
      usernames: [username]
    }),
    field_mapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'],  // CRITICAL: Not 'followingCount'
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },

  // SECONDARY SCRAPERS (FALLBACK)
  'shu_light': {
    name: 'shu_light',
    actor_id: 'shu8hvrXbJbY3Eb9W',
    timeout: 30000,
    max_retries: 2,
    retry_delay: 3000,
    priority: 1,  // Fallback
    input: (username: string) => ({
      directUrls: [`https://instagram.com/${username}/`],
      resultsLimit: 1,
      resultsType: 'details',
      searchType: 'hashtag',
      addParentData: false,
      enhanceUserSearchWithFacebookPage: false
    }),
    field_mapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'],
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },

  'shu_deep': {
    name: 'shu_deep',
    actor_id: 'shu8hvrXbJbY3Eb9W',
    timeout: 30000,
    max_retries: 2,
    retry_delay: 3000,
    priority: 1,
    input: (username: string) => ({
      directUrls: [`https://instagram.com/${username}/`],
      resultsLimit: 12,
      resultsType: 'details',
      searchType: 'hashtag'
    }),
    field_mapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'],
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },

  'shu_xray': {
    name: 'shu_xray',
    actor_id: 'shu8hvrXbJbY3Eb9W',
    timeout: 120000,  // 2 minutes
    max_retries: 1,
    retry_delay: 3000,
    priority: 1,
    input: (username: string) => ({
      directUrls: [`https://instagram.com/${username}/`],
      resultsLimit: 50,
      resultsType: 'details',
      searchType: 'hashtag'
    }),
    field_mapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'],
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  }
};

/**
 * Get scrapers for analysis type (ordered by priority)
 */
export function getScrapersForAnalysis(analysisType: 'light' | 'deep' | 'xray'): ApifyScraperConfig[] {
  const scraperMap = {
    light: ['ds_basic', 'shu_light'],
    deep: ['ds_basic', 'shu_deep'],
    xray: ['ds_basic', 'shu_xray']
  };

  return scraperMap[analysisType]
    .map(key => APIFY_SCRAPERS[key])
    .sort((a, b) => b.priority - a.priority);  // Primary first
}

/**
 * Calculate Apify cost from duration
 * Apify charges $0.25 per compute unit (1 CU = 1 hour)
 */
export function calculateApifyCost(durationMs: number): number {
  const computeUnits = durationMs / (1000 * 60 * 60);  // ms to hours
  const cost = computeUnits * 0.25;
  return parseFloat(cost.toFixed(6));
}
