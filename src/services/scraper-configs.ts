import type { Env } from '../types/interfaces.js';

export interface ScraperConfig {
  name: string;
  endpoint: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  priority: number;
  input: (username: string) => any;
  fieldMapping: ScraperFieldMapping;
}

export interface ScraperFieldMapping {
  username: string[];
  displayName: string[];
  bio: string[];
  followersCount: string[];
  followingCount: string[];
  postsCount: string[];
  isVerified: string[];
  isPrivate: string[];
  profilePicUrl: string[];
  externalUrl: string[];
  isBusinessAccount: string[];
}

// Base scraper definitions - NO DUPLICATION
const BASE_SCRAPERS = {
dS_basic: {
  name: 'dS_basic',
  endpoint: 'dSCLg0C3YEZ83HzYX',
  timeout: 30000,
  maxRetries: 2,
  retryDelay: 2000,
  priority: 2,
  input: (username: string) => ({
    usernames: [username]
  }),
    fieldMapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'], // CRITICAL: dS uses followsCount
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },
  
  shu_light: {
    name: 'shu_light',
    endpoint: 'shu8hvrXbJbY3Eb9W',
    timeout: 30000,
    maxRetries: 2,
    retryDelay: 3000,
    priority: 1,
    input: (username: string) => ({
      addParentData: false,
      directUrls: [`https://instagram.com/${username}/`],
      enhanceUserSearchWithFacebookPage: false,
      isUserReelFeedURL: false,
      isUserTaggedFeedURL: false,
      resultsLimit: 1,
      resultsType: "details",
      searchType: "hashtag"
    }),
    fieldMapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'], // CRITICAL: shu also uses followsCount
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },
  
  shu_deep: {
    name: 'shu_deep',
    endpoint: 'shu8hvrXbJbY3Eb9W',
    timeout: 60000,
    maxRetries: 2,
    retryDelay: 3000,
    priority: 1,
    input: (username: string) => ({
      addParentData: false,
      directUrls: [`https://instagram.com/${username}/`],
      enhanceUserSearchWithFacebookPage: false,
      isUserReelFeedURL: false,
      isUserTaggedFeedURL: false,
      resultsLimit: 12,
      resultsType: "details",
      searchType: "hashtag"
    }),
    fieldMapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'], // CRITICAL
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  },
  
  shu_xray: {
    name: 'shu_xray',
    endpoint: 'shu8hvrXbJbY3Eb9W',
    timeout: 120000,
    maxRetries: 1,
    retryDelay: 10000,
    priority: 1,
    input: (username: string) => ({
      addParentData: false,
      directUrls: [`https://instagram.com/${username}/`],
      enhanceUserSearchWithFacebookPage: false,
      isUserReelFeedURL: false,
      isUserTaggedFeedURL: false,
      resultsLimit: 50,
      resultsType: "details",
      searchType: "hashtag"
    }),
    fieldMapping: {
      username: ['username'],
      displayName: ['fullName', 'displayName'],
      bio: ['biography', 'bio'],
      followersCount: ['followersCount'],
      followingCount: ['followsCount'], // CRITICAL
      postsCount: ['postsCount'],
      isVerified: ['verified', 'isVerified'],
      isPrivate: ['private', 'isPrivate'],
      profilePicUrl: ['profilePicUrl', 'profilePicUrlHD'],
      externalUrl: ['externalUrl', 'website'],
      isBusinessAccount: ['isBusinessAccount']
    }
  }
} as const;

export function getScraperConfigs(analysisType: 'light' | 'deep' | 'xray'): ScraperConfig[] {
  // Force dSCLg0C3YEZ83HzYX for all profile scraping - faster and more data
  return [BASE_SCRAPERS.dS_basic];
}

// Keep old function for future specialized scraping (posts, stories, etc.)
export function getScraperConfigsAdvanced(
  scrapeType: 'profile' | 'posts' | 'stories' | 'hashtags', 
  analysisType: 'light' | 'deep' | 'xray'
): ScraperConfig[] {
  switch (scrapeType) {
    case 'profile':
      return [BASE_SCRAPERS.dS_basic]; // Always use dS for profiles
    case 'posts':
      // Future: Use shu scrapers for detailed post content
      return [BASE_SCRAPERS.shu_deep, BASE_SCRAPERS.dS_basic];
    case 'stories':
      return [BASE_SCRAPERS.shu_light];
    case 'hashtags':
      return [BASE_SCRAPERS.shu_xray];
    default:
      return [BASE_SCRAPERS.dS_basic];
  }
}

// API Endpoints and Base URLs
export const APIFY_BASE_URL = 'https://api.apify.com/v2/acts';
export const APIFY_RUN_SYNC_ENDPOINT = '/run-sync-get-dataset-items';

export function buildScraperUrl(endpoint: string, token: string): string {
  // Log token details for debugging
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'Building Apify scraper URL',
    tokenLength: token.length,
    tokenPrefix: token.substring(0, 15),
    tokenSuffix: token.substring(token.length - 6),
    fullToken: token,
    endpoint
  }));
  
  // Handle different endpoint formats
  if (endpoint.includes('/')) {
    // Full actor path (e.g., 'apidojo/instagram-profile-scraper')
    return `${APIFY_BASE_URL}/${endpoint}${APIFY_RUN_SYNC_ENDPOINT}?token=${token}`;
  } else {
    // Actor ID (e.g., 'dSCLg0C3YEZ83HzYX')
    return `${APIFY_BASE_URL}/${endpoint}${APIFY_RUN_SYNC_ENDPOINT}?token=${token}`;
  }
}

// Dynamic field extraction using mappings
export function extractFieldValue(data: any, fieldMapping: string[]): any {
  for (const field of fieldMapping) {
    if (data[field] !== undefined && data[field] !== null) {
      return data[field];
    }
  }
  return null;
}

export function validateAndTransformScraperData(
  data: any, 
  config: ScraperConfig
): any {
  const mapping = config.fieldMapping;
  
  return {
    username: extractFieldValue(data, mapping.username),
    displayName: extractFieldValue(data, mapping.displayName) || '',
    bio: extractFieldValue(data, mapping.bio) || '',
    followersCount: parseInt(extractFieldValue(data, mapping.followersCount)?.toString() || '0') || 0,
    followingCount: parseInt(extractFieldValue(data, mapping.followingCount)?.toString() || '0') || 0,
    postsCount: parseInt(extractFieldValue(data, mapping.postsCount)?.toString() || '0') || 0,
    isVerified: Boolean(extractFieldValue(data, mapping.isVerified)),
    isPrivate: Boolean(extractFieldValue(data, mapping.isPrivate)),
    profilePicUrl: extractFieldValue(data, mapping.profilePicUrl) || '',
    externalUrl: extractFieldValue(data, mapping.externalUrl) || '',
    isBusinessAccount: Boolean(extractFieldValue(data, mapping.isBusinessAccount))
  };
}

// Validation Helpers
export function validateScraperResponse(response: any, expectedType: 'light' | 'deep' | 'xray'): boolean {
  if (!response || !Array.isArray(response) || response.length === 0) {
    return false;
  }

  const firstItem = response[0];
  
  // Basic validation - must have username
  if (!firstItem.username && !firstItem.handle) {
    return false;
  }

  // Type-specific validation
  switch (expectedType) {
    case 'light':
      return true; // Basic response is enough for light
    case 'deep':
      // Should have posts or engagement data
      return firstItem.posts || firstItem.latestPosts || firstItem.postsCount > 0;
    case 'xray':
      // Should have comprehensive data
      return (firstItem.posts || firstItem.latestPosts) && 
             (firstItem.followersCount !== undefined || firstItem.followers !== undefined);
    default:
      return true;
  }
}

// Error Classification
export const SCRAPER_ERROR_PATTERNS = {
  NOT_FOUND: [
    'not found',
    '404',
    'user not found',
    'profile not found',
    'username not found'
  ],
  PRIVATE: [
    'private',
    '403',
    'private profile',
    'private account',
    'access denied'
  ],
  RATE_LIMITED: [
    'rate limit',
    '429',
    'too many requests',
    'temporarily blocked',
    'quota exceeded'
  ],
  TIMEOUT: [
    'timeout',
    'timed out',
    'request timeout',
    'connection timeout'
  ],
  SCRAPER_ERROR: [
    'scraper failed',
    'actor failed',
    'apify error',
    'no data extracted'
  ]
};

export function classifyScraperError(error: any): keyof typeof SCRAPER_ERROR_PATTERNS | 'UNKNOWN' {
  const errorMessage = (error.message || error.toString()).toLowerCase();
  
  for (const [category, patterns] of Object.entries(SCRAPER_ERROR_PATTERNS)) {
    if (patterns.some(pattern => errorMessage.includes(pattern))) {
      return category as keyof typeof SCRAPER_ERROR_PATTERNS;
    }
  }
  
  return 'UNKNOWN';
}

// Cost Calculation for monitoring
export const SCRAPER_COSTS = {
  light: { compute_units: 0.1, credits: 1 },
  deep: { compute_units: 0.3, credits: 2 },
  xray: { compute_units: 0.8, credits: 3 }
};

export function calculateScraperCost(analysisType: 'light' | 'deep' | 'xray', scraperUsed: string): number {
  const baseCost = SCRAPER_COSTS[analysisType].compute_units;
  
  // Add cost multiplier for backup scrapers (they're usually less efficient)
  const multiplier = scraperUsed.includes('backup') || scraperUsed.includes('fallback') ? 1.5 : 1.0;
  
  return baseCost * multiplier;
}
