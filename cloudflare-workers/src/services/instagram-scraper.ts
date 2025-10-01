import { ScraperErrorHandler, withScraperRetry } from '../utils/scraper-error-handler.js';
import { getScraperConfigs, buildScraperUrl, validateAndTransformScraperData, type ScraperConfig } from './scraper-configs.js';
import { callWithRetry } from '../utils/helpers.js';
import { validateProfileData } from '../utils/validation.js';
import { getApiKey } from './enhanced-config-manager.js';
import { logger } from '../utils/logger.js';
import type { AnalysisType, Env, ProfileData } from '../types/interfaces.js';

export async function scrapeInstagramProfile(username: string, analysisType: AnalysisType, env: Env): Promise<ProfileData> {
  // Check R2 cache first for profile data
  const cacheKey = `profile:${username}`;
  
  try {
    if (env.R2_CACHE_BUCKET) {
      const cached = await env.R2_CACHE_BUCKET.get(cacheKey);
      if (cached) {
        const cacheData = await cached.json();
        if (cacheData.expires > Date.now()) {
          logger('info', 'Profile cache hit', { username, analysisType });
          return cacheData.profile;
        }
      }
    }
  } catch (error: any) {
    logger('warn', 'Cache read failed, continuing with scraping', { error: error.message });
  }

const apifyToken = await getApiKey('APIFY_API_TOKEN', env, env.APP_ENV);
if (!apifyToken) {
  throw new Error('Profile scraping service not configured');
}

logger('info', 'Apify token retrieved for scraping', { 
  username, 
  analysisType,
  tokenLength: apifyToken.length,
  tokenPrefix: apifyToken.substring(0, 15),
  tokenSuffix: apifyToken.substring(apifyToken.length - 6),
  fullTokenForDebugging: apifyToken
});

logger('info', 'Starting profile scraping', { username, analysisType });
  try {
    // Get dynamic scraper configs based on analysis type
    const scraperConfigs = getScraperConfigs(analysisType);
    const profileData = await scrapeWithConfigs(username, apifyToken, scraperConfigs, analysisType);

    // Cache profile data
    await cacheProfileData(cacheKey, profileData, analysisType, env);

    return profileData;

  } catch (error: any) {
    const transformedError = ScraperErrorHandler.transformError(error, username);
    logger('error', 'All scraping methods failed', { username, error: transformedError.message });
    throw transformedError;
  }
}

async function scrapeWithConfigs(
  username: string, 
  token: string, 
  configs: ScraperConfig[], 
  analysisType: AnalysisType
): Promise<ProfileData> {
  
  const scraperAttempts = configs.map(config => 
    async () => {
      logger('info', 'Attempting scraper', { 
        scraper: config.name, 
        endpoint: config.endpoint,
        analysisType 
      });

      const url = buildScraperUrl(config.endpoint, token);
      const response = await callWithRetry(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'InstagramAnalyzer/3.0'
        },
        body: JSON.stringify(config.input(username))
      }, config.maxRetries, config.retryDelay, config.timeout);

      if (!response || !Array.isArray(response) || response.length === 0) {
        throw new Error(`${config.name} returned no usable data`);
      }

      // Transform using scraper-specific field mapping
      const rawData = response[0];
      const transformedData = validateAndTransformScraperData(rawData, config);
      
      logger('info', 'Scraper data transformation', {
        scraper: config.name,
        username: transformedData.username,
        followers: transformedData.followersCount,
        following: transformedData.followingCount,
        originalFollowing: rawData.followsCount || rawData.followingCount,
        transformedFollowing: transformedData.followingCount
      });

      // Enhanced profile building for deep/xray analysis
      let profileData: ProfileData;
      
      if (analysisType === 'light') {
        profileData = buildLightProfile(transformedData, config.name);
      } else {
        // For deep/xray, process posts if available
        const posts = extractPostsFromResponse(response, analysisType);
        profileData = buildEnhancedProfile(transformedData, posts, config.name, analysisType);
      }
      
      return profileData;
    }
  );

  return await withScraperRetry(scraperAttempts, username);
}

function buildLightProfile(data: any, scraperUsed: string): ProfileData {
  const profile = validateProfileData(data, 'light');
  profile.scraperUsed = scraperUsed;
  profile.dataQuality = 'medium';
  
  return profile;
}

function buildEnhancedProfile(
  data: any, 
  posts: any[], 
  scraperUsed: string, 
  analysisType: AnalysisType
): ProfileData {
  // Build base profile
  const profile = validateProfileData(data, analysisType);
  
  // Add posts if available
  if (posts && posts.length > 0) {
    profile.latestPosts = posts.slice(0, analysisType === 'xray' ? 50 : 12);
    
    // Calculate real engagement if we have posts
    if (profile.latestPosts.length > 0) {
      profile.engagement = calculateRealEngagement(profile.latestPosts, profile.followersCount);
    }
  }
  
  profile.scraperUsed = scraperUsed;
  profile.dataQuality = determineDataQuality(profile, analysisType);
  
  return profile;
}

function extractPostsFromResponse(response: any[], analysisType: AnalysisType): any[] {
  // For shu scraper, posts might be in the response array after profile data
  if (response.length > 1) {
    return response.slice(1); // Skip first item (profile), rest are posts
  }
  
  // For dS scraper or if posts are embedded in profile
  const profile = response[0];
  if (profile.latestPosts && Array.isArray(profile.latestPosts)) {
    return profile.latestPosts;
  }
  
  return [];
}

function calculateRealEngagement(posts: any[], followersCount: number): any {
  const validPosts = posts.filter(post => 
    (post.likesCount || post.likes || 0) > 0 || 
    (post.commentsCount || post.comments || 0) > 0
  );
  
  if (validPosts.length === 0) return undefined;
  
  const totalLikes = validPosts.reduce((sum, post) => 
    sum + (post.likesCount || post.likes || 0), 0
  );
  
  const totalComments = validPosts.reduce((sum, post) => 
    sum + (post.commentsCount || post.comments || 0), 0
  );
  
  const avgLikes = Math.round(totalLikes / validPosts.length);
  const avgComments = Math.round(totalComments / validPosts.length);
  const totalEngagement = totalLikes + totalComments;
  
  const engagementRate = followersCount > 0 
    ? parseFloat(((totalEngagement / validPosts.length) / followersCount * 100).toFixed(2))
    : 0;

  return {
    avgLikes,
    avgComments,
    engagementRate,
    totalEngagement,
    postsAnalyzed: validPosts.length,
    qualityScore: calculateEngagementQuality(engagementRate, followersCount)
  };
}

function calculateEngagementQuality(engagementRate: number, followersCount: number): number {
  // Industry benchmarks by follower tier
  const benchmarks = {
    nano: { min: 1000, max: 10000, expectedER: 5.0 },     // 1K-10K
    micro: { min: 10000, max: 100000, expectedER: 3.0 },  // 10K-100K  
    mid: { min: 100000, max: 1000000, expectedER: 1.5 },  // 100K-1M
    macro: { min: 1000000, max: Infinity, expectedER: 1.0 } // 1M+
  };
  
  let tier = 'macro';
  if (followersCount < 10000) tier = 'nano';
  else if (followersCount < 100000) tier = 'micro';
  else if (followersCount < 1000000) tier = 'mid';
  
  const expectedER = benchmarks[tier].expectedER;
  const performance = engagementRate / expectedER;
  
  return Math.min(100, Math.max(0, Math.round(performance * 50))); // 0-100 score
}

function determineDataQuality(profile: ProfileData, analysisType: AnalysisType): 'high' | 'medium' | 'low' {
  let score = 0;
  
  // Base scoring
  if (profile.isVerified) score += 20;
  if (!profile.isPrivate) score += 20;
  if (profile.bio && profile.bio.length > 10) score += 15;
  if (profile.externalUrl) score += 10;
  
  // Posts and engagement scoring
  const postsCount = profile.latestPosts?.length || 0;
  if (postsCount >= 5) score += 20;
  else if (postsCount >= 2) score += 10;
  
  if (profile.engagement?.postsAnalyzed > 0) score += 15;
  
  // Analysis type requirements
  if (analysisType === 'light' && score >= 40) return 'high';
  if (analysisType === 'deep' && score >= 60 && postsCount >= 3) return 'high';
  if (analysisType === 'xray' && score >= 70 && postsCount >= 5) return 'high';
  
  if (score >= 40) return 'medium';
  return 'low';
}

async function cacheProfileData(
  cacheKey: string, 
  profileData: ProfileData, 
  analysisType: AnalysisType, 
  env: Env
): Promise<void> {
  try {
    if (!env.R2_CACHE_BUCKET) return;
    
    // Fixed 24-hour TTL for all profiles
    const cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
    
    const cacheData = {
      profile: profileData,
      expires: Date.now() + cacheTTL,
      cached_at: new Date().toISOString(),
      analysis_type: analysisType,
      username: profileData.username,
      followers: profileData.followersCount,
      data_quality: profileData.dataQuality,
      scraper_used: profileData.scraperUsed,
      posts_count: profileData.latestPosts?.length || 0,
      has_engagement_data: !!profileData.engagement
    };

    await env.R2_CACHE_BUCKET.put(cacheKey, JSON.stringify(cacheData));
    
    logger('info', 'Profile cached successfully', { 
      username: profileData.username, 
      analysisType, 
      ttl_hours: Math.round(cacheTTL / (60 * 60 * 1000)),
      cache_key: cacheKey,
      data_quality: profileData.dataQuality,
      posts_cached: profileData.latestPosts?.length || 0
    });
    
  } catch (cacheError: any) {
    logger('warn', 'Profile caching failed', { 
      username: profileData.username,
      analysisType,
      error: cacheError.message 
    });
  }
}

export async function checkProfileCache(username: string, env: Env): Promise<{data: ProfileData, expires: number} | null> {
  const cacheKey = `profile:${username}`;
  
  try {
    if (!env.R2_CACHE_BUCKET) {
      logger('warn', 'R2_CACHE_BUCKET not available for cache check');
      return null;
    }
    
    logger('info', 'Checking profile cache', { username, cacheKey });
    const cached = await env.R2_CACHE_BUCKET.get(cacheKey);
    
    if (!cached) {
      logger('info', 'No cached profile found', { username });
      return null;
    }
    
    const cacheData = await cached.json();
    
    if (cacheData.expires > Date.now()) {
      logger('info', 'Profile cache hit', { 
        username, 
        expires: new Date(cacheData.expires).toISOString(),
        quality: cacheData.profile?.dataQuality 
      });
      
      return {
        data: cacheData.profile,
        expires: cacheData.expires
      };
    }
    
    logger('info', 'Profile cache expired', { 
      username, 
      expired_at: new Date(cacheData.expires).toISOString() 
    });
    return null;
    
  } catch (error: any) {
    logger('error', 'Profile cache check failed', { 
      username, 
      error: error.message 
    });
    return null;
  }
}
