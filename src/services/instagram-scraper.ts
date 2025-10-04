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
      
      // ✅ VALIDATE CACHE DATA BEFORE USING
      if (cacheData.expires > Date.now() && 
          cacheData.profile?.username && 
          cacheData.profile.username !== 'undefined') {
        
        logger('info', 'Profile cache hit (validated)', { 
          username: cacheData.profile.username, 
          analysisType 
        });
        return cacheData.profile;
      } else {
        logger('warn', 'Cache data invalid or expired, re-scraping', { 
          cached_username: cacheData.profile?.username,
          requested_username: username,
          expired: cacheData.expires <= Date.now()
        });
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

// EXTENSIVE LOGGING: Raw response structure
logger('info', '📦 RAW SCRAPER RESPONSE RECEIVED', {
  scraper: config.name,
  username,
  analysisType,
  responseType: Array.isArray(response) ? 'array' : typeof response,
  responseLength: Array.isArray(response) ? response.length : 'N/A',
  firstItemKeys: response && response[0] ? Object.keys(response[0]).slice(0, 20) : [],
  hasLatestPosts: response && response[0] && response[0].latestPosts ? true : false,
  latestPostsCount: response && response[0] && response[0].latestPosts ? response[0].latestPosts.length : 0,
  postsCount: response && response[0] && response[0].postsCount ? response[0].postsCount : 0
});

// Check for error response from Apify
if (!response || !Array.isArray(response) || response.length === 0) {
  throw new Error(`${config.name} returned no usable data`);
}

const firstItem = response[0];

// Detect Apify error responses
if (firstItem.error || firstItem.errorDescription) {
  const errorType = firstItem.error || 'unknown_error';
  const errorDesc = firstItem.errorDescription || 'An error occurred';
  
  logger('warn', 'Apify returned error response', { 
    username, 
    error: errorType, 
    description: errorDesc 
  });
  
  if (errorType === 'not_found' || errorDesc.toLowerCase().includes('does not exist') || errorDesc.toLowerCase().includes('not found')) {
    throw new Error('Instagram profile not found');
  }
  
  throw new Error(`Scraper error: ${errorDesc}`);
}

// Validate username exists
if (!firstItem.username && !firstItem.handle) {
  throw new Error('No valid profile data returned');
}

// CRITICAL: Extract posts BEFORE transformation
const rawData = response[0];
const posts = extractPostsFromResponse(response, analysisType);

logger('info', '🔍 POST EXTRACTION CHECKPOINT', {
  scraper: config.name,
  username,
  analysisType,
  postsExtractedCount: posts.length,
  rawDataHasLatestPosts: !!rawData.latestPosts,
  rawDataLatestPostsCount: rawData.latestPosts ? rawData.latestPosts.length : 0,
  extractedPostsSample: posts.length > 0 ? {
    firstPostId: posts[0].id || posts[0].shortCode,
    firstPostType: posts[0].type,
    firstPostHasEngagement: !!(posts[0].likesCount || posts[0].commentsCount)
  } : null
});

// Transform using scraper-specific field mapping
const transformedData = validateAndTransformScraperData(rawData, config);

logger('info', '🔄 SCRAPER DATA TRANSFORMATION COMPLETE', {
  scraper: config.name,
  username: transformedData.username,
  followers: transformedData.followersCount,
  following: transformedData.followingCount,
  postsCount: transformedData.postsCount,
  originalFollowing: rawData.followsCount || rawData.followingCount,
  transformedFollowing: transformedData.followingCount,
  transformedDataHasLatestPosts: !!(transformedData as any).latestPosts,
  transformedDataKeys: Object.keys(transformedData)
});

// Enhanced profile building for deep/xray analysis
let profileData: ProfileData;

if (analysisType === 'light') {
  logger('info', '🏃 BUILDING LIGHT PROFILE', {
    username: transformedData.username,
    analysisType
  });
  profileData = buildLightProfile(transformedData, config.name);
} else {
  logger('info', '🔬 BUILDING ENHANCED PROFILE', {
    username: transformedData.username,
    analysisType,
    postsToProcess: posts.length,
    hasRawData: !!rawData
  });
  profileData = buildEnhancedProfile(transformedData, posts, rawData, config.name, analysisType);
}

logger('info', '✅ PROFILE BUILD COMPLETE', {
  username: profileData.username,
  analysisType,
  hasLatestPosts: !!(profileData.latestPosts && profileData.latestPosts.length > 0),
  latestPostsCount: profileData.latestPosts?.length || 0,
  hasEngagement: !!profileData.engagement,
  dataQuality: profileData.dataQuality
});
      
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
  rawData: any,  // ADD THIS PARAMETER
  scraperUsed: string, 
  analysisType: AnalysisType
): ProfileData {
  logger('info', '🏗️ BUILD ENHANCED PROFILE START', {
    username: data.username,
    analysisType,
    postsProvided: posts.length,
    rawDataHasLatestPosts: !!rawData.latestPosts,
    rawDataLatestPostsCount: rawData.latestPosts?.length || 0
  });
  
  // Build base profile
  const profile = validateProfileData(data, analysisType);
  
  // CRITICAL FIX: Fallback to rawData.latestPosts if posts array is empty
  let finalPosts = posts;
  if ((!finalPosts || finalPosts.length === 0) && rawData.latestPosts && Array.isArray(rawData.latestPosts)) {
    logger('info', '🔄 USING RAWDATA.LATESTPOSTS FALLBACK', { 
      rawLatestPostsCount: rawData.latestPosts.length,
      username: data.username 
    });
    finalPosts = rawData.latestPosts;
  }
  
  logger('info', '📊 POSTS PROCESSING DECISION', {
    username: data.username,
    postsProvidedCount: posts.length,
    finalPostsCount: finalPosts.length,
    usedFallback: finalPosts !== posts,
    willProcessPosts: finalPosts && finalPosts.length > 0
  });
  
  // Add posts if available
  if (finalPosts && finalPosts.length > 0) {
    const sliceLimit = analysisType === 'xray' ? 50 : 12;
    profile.latestPosts = finalPosts.slice(0, sliceLimit);
    
    logger('info', '✂️ POSTS SLICED FOR PROFILE', {
      username: data.username,
      originalCount: finalPosts.length,
      slicedCount: profile.latestPosts.length,
      sliceLimit,
      analysisType
    });
    
    // Calculate real engagement if we have posts
    if (profile.latestPosts.length > 0) {
      logger('info', '🧮 CALCULATING ENGAGEMENT', {
        username: data.username,
        postsToAnalyze: profile.latestPosts.length,
        followers: profile.followersCount
      });
      profile.engagement = calculateRealEngagement(profile.latestPosts, profile.followersCount);
      
      logger('info', '✅ ENGAGEMENT CALCULATED', {
        username: data.username,
        hasEngagement: !!profile.engagement,
        avgLikes: profile.engagement?.avgLikes,
        avgComments: profile.engagement?.avgComments,
        engagementRate: profile.engagement?.engagementRate
      });
    }
  } else {
    logger('warn', '⚠️ NO POSTS AVAILABLE FOR ENHANCED PROFILE', {
      username: data.username,
      postsProvidedCount: posts.length,
      rawDataHasLatestPosts: !!rawData.latestPosts,
      analysisType
    });
  }
  
  profile.scraperUsed = scraperUsed;
  profile.dataQuality = determineDataQuality(profile, analysisType);
  
  // NEW: Run pre-processing for deep/xray analysis
  if ((analysisType === 'deep' || analysisType === 'xray') && profile.latestPosts.length > 0) {
    const { runPreProcessing } = require('./pre-processor.js');
    const preProcessed = runPreProcessing(profile);
    
    // Attach pre-processed data to profile
    (profile as any).preProcessed = preProcessed;
    
    logger('info', 'Pre-processing attached to profile', {
      username: profile.username,
      hasSummary: !!preProcessed.summary
    });
  }
  
  return profile;
}

function extractPostsFromResponse(response: any[], analysisType: AnalysisType): any[] {
  logger('info', '🎯 EXTRACT POSTS FROM RESPONSE START', {
    analysisType,
    responseLength: response.length,
    responseIsArray: Array.isArray(response)
  });
  
  const rawProfile = response[0];
  
  logger('info', '🔍 CHECKING RAW PROFILE FOR POSTS', {
    analysisType,
    hasLatestPosts: !!rawProfile.latestPosts,
    latestPostsIsArray: Array.isArray(rawProfile.latestPosts),
    latestPostsCount: rawProfile.latestPosts?.length || 0,
    rawProfileKeys: Object.keys(rawProfile).slice(0, 30)
  });
  
  // CRITICAL: Check for latestPosts in raw response FIRST
  if (rawProfile.latestPosts && Array.isArray(rawProfile.latestPosts)) {
    logger('info', '✅ POSTS EXTRACTED FROM LATESTPOSTS', { 
      count: rawProfile.latestPosts.length,
      analysisType,
      firstPostSample: rawProfile.latestPosts[0] ? {
        id: rawProfile.latestPosts[0].id,
        type: rawProfile.latestPosts[0].type,
        hasLikes: !!rawProfile.latestPosts[0].likesCount
      } : null
    });
    return rawProfile.latestPosts;
  }
  
  // For shu scraper, posts might be in array after profile
  if (response.length > 1) {
    logger('info', '✅ POSTS EXTRACTED FROM RESPONSE ARRAY', { 
      count: response.length - 1,
      analysisType,
      secondItemSample: response[1] ? {
        id: response[1].id,
        type: response[1].type
      } : null
    });
    return response.slice(1);
  }
  
  logger('warn', '❌ NO POSTS FOUND IN SCRAPER RESPONSE', { 
    responseLength: response.length,
    hasLatestPosts: !!rawProfile.latestPosts,
    latestPostsType: rawProfile.latestPosts ? typeof rawProfile.latestPosts : 'undefined',
    analysisType,
    availableFields: Object.keys(rawProfile).filter(k => k.toLowerCase().includes('post'))
  });
  
  return [];
}

function calculateRealEngagement(posts: any[], followersCount: number): any {
  const validPosts = posts.filter(post => 
    (post.likesCount || post.likes || 0) > 0 || 
    (post.commentsCount || post.comments || 0) > 0
  );
  
  if (validPosts.length === 0) return undefined;
  
  // Standard engagement metrics
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

  // NEW: Video performance metrics
  const videoPosts = validPosts.filter(post => 
    post.type === 'Video' && post.videoViewCount && post.videoViewCount > 0
  );
  
  let videoMetrics = null;
  if (videoPosts.length > 0) {
    const totalVideoViews = videoPosts.reduce((sum, post) => sum + post.videoViewCount, 0);
    const avgVideoViews = Math.round(totalVideoViews / videoPosts.length);
    const avgVideoEngagement = Math.round(
      videoPosts.reduce((sum, post) => 
        sum + (post.likesCount || 0) + (post.commentsCount || 0), 0
      ) / videoPosts.length
    );
    
    videoMetrics = {
      avgViews: avgVideoViews,
      avgEngagement: avgVideoEngagement,
      videoCount: videoPosts.length,
      viewToEngagementRatio: avgVideoViews > 0 ? parseFloat((avgVideoEngagement / avgVideoViews * 100).toFixed(2)) : 0
    };
  }

  // NEW: Content format distribution
  const formatDistribution = {
    imageCount: validPosts.filter(p => p.type === 'Image').length,
    videoCount: validPosts.filter(p => p.type === 'Video').length,
    sidecarCount: validPosts.filter(p => p.type === 'Sidecar').length
  };
  
  const totalFormats = formatDistribution.imageCount + formatDistribution.videoCount + formatDistribution.sidecarCount;
  const primaryFormat = 
    formatDistribution.sidecarCount / totalFormats > 0.4 ? 'carousels' :
    formatDistribution.videoCount / totalFormats > 0.4 ? 'videos' :
    formatDistribution.imageCount / totalFormats > 0.4 ? 'images' : 'mixed';

  return {
    avgLikes,
    avgComments,
    engagementRate,
    totalEngagement,
    postsAnalyzed: validPosts.length,
    qualityScore: calculateEngagementQuality(engagementRate, followersCount),
    
    // NEW FIELDS
    videoPerformance: videoMetrics,
    formatDistribution: {
      ...formatDistribution,
      primaryFormat,
      usesVideo: formatDistribution.videoCount > 0,
      usesCarousel: formatDistribution.sidecarCount > 0,
      formatDiversity: [
        formatDistribution.imageCount > 0,
        formatDistribution.videoCount > 0,
        formatDistribution.sidecarCount > 0
      ].filter(Boolean).length
    }
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
