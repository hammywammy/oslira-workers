import { logger } from '../utils/logger.js';
import type { PostData, EngagementData, AnalysisType } from '../types/interfaces.js';

export function validateAnalysisResult(result: any): any {
  return {
    score: Math.round(parseFloat(result.score) || 0),
    engagement_score: Math.round(parseFloat(result.engagement_score) || 0),
    niche_fit: Math.round(parseFloat(result.niche_fit) || 0),
    audience_quality: result.audience_quality || 'Unknown',
    engagement_insights: result.engagement_insights || 'No insights available',
    selling_points: Array.isArray(result.selling_points) ? result.selling_points : [],
    reasons: Array.isArray(result.reasons) ? result.reasons : (Array.isArray(result.selling_points) ? result.selling_points : [])
  };
}

export function extractUsername(input: string): string {
  try {
    const cleaned = input.trim().replace(/^@/, '').toLowerCase();
    if (cleaned.includes('instagram.com')) {
      const url = new URL(cleaned);
      const pathSegments = url.pathname.split('/').filter(Boolean);
      return pathSegments[0] || '';
    }
    return cleaned.replace(/[^a-z0-9._]/g, '');
  } catch {
    return '';
  }
}

export function extractHashtags(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/#[\w\u0590-\u05ff]+/g);
  return matches ? matches.map(tag => tag.toLowerCase()) : [];
}

export function extractMentions(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/@[\w.]+/g);
  return matches ? matches.map(mention => mention.toLowerCase()) : [];
}

export function normalizeRequest(body: any) {
  const errors: string[] = [];
  
  let profile_url = body.profile_url;
  if (!profile_url && body.username) {
    const username = extractUsername(body.username);
    profile_url = username ? `https://instagram.com/${username}` : '';
  }
  
  const analysis_type = body.analysis_type || body.type;
  const business_id = body.business_id;
  const user_id = body.user_id;

  if (!profile_url) errors.push('profile_url or username is required');
  if (!analysis_type || !['light', 'deep', 'xray'].includes(analysis_type)) {
    errors.push('analysis_type must be "light", "deep", or "xray"');
  }
  if (!business_id) errors.push('business_id is required');
  if (!user_id) errors.push('user_id is required');

  if (errors.length > 0) {
    throw new Error(errors.join(', '));
  }

  return {
    profile_url: profile_url!,
    username: extractUsername(profile_url!),
    analysis_type: analysis_type as AnalysisType,
    business_id,
    user_id
  };
}

export function validateProfileData(responseData: any, analysisType?: string): any {
  if (!responseData) {
    throw new Error('No response data received from scraper');
  }
  
  if (typeof responseData !== 'object') {
    throw new Error(`Invalid response data type: ${typeof responseData}`);
  }

  // Handle array response (typical scraper format)
  const profileData = Array.isArray(responseData) ? responseData[0] : responseData;
  
  // Check for profile not found
  if (!profileData || !profileData.username) {
    throw new Error('PROFILE_NOT_FOUND');
  }

  // Quick validation for light analysis
  if (analysisType === 'light') {
    return buildBasicProfile(profileData);
  }

  // Enhanced validation for deep/xray analysis
  return buildEnhancedProfile(profileData);
}

function buildBasicProfile(profile: any): any {
  return {
    username: profile.username,
    displayName: profile.fullName || profile.displayName || '',
    bio: profile.biography || profile.bio || '',
followersCount: parseInt(profile.followersCount?.toString() || '0') || 0,
followingCount: parseInt(profile.followsCount?.toString() || profile.followingCount?.toString() || '0') || 0,
postsCount: parseInt(profile.postsCount?.toString() || '0') || 0,
    isVerified: Boolean(profile.verified || profile.isVerified),
    isPrivate: Boolean(profile.private || profile.isPrivate),
    profilePicUrl: profile.profilePicUrl || profile.profilePicture || '',
    externalUrl: profile.externalUrl || profile.website || '',
    isBusinessAccount: Boolean(profile.isBusinessAccount),
    latestPosts: [],
    engagement: undefined
  };
}

function buildEnhancedProfile(profileData: any): any {
  const profile = buildBasicProfile(profileData);
  
  // Extract posts from various possible locations
  let posts = [];
  if (profileData.latestPosts && Array.isArray(profileData.latestPosts)) {
    posts = profileData.latestPosts;
  } else if (Array.isArray(profileData) && profileData.length > 1) {
    posts = profileData.slice(1); // Skip first item (profile), rest are posts
  }

  // Process posts
  const processedPosts: PostData[] = posts.slice(0, 12).map(post => ({
    id: post.id || post.shortCode || post.code || post.pk || '',
    shortCode: post.shortCode || post.code || post.pk || '',
    caption: post.caption || post.edge_media_to_caption?.edges?.[0]?.node?.text || '',
    likesCount: parseInt(String(post.likesCount || post.likes || post.like_count || 0)) || 0,
    commentsCount: parseInt(String(post.commentsCount || post.comments || post.comment_count || 0)) || 0,
    timestamp: post.timestamp || post.taken_at || post.created_time || new Date().toISOString(),
    url: post.url || `https://instagram.com/p/${post.shortCode || post.code}/`,
    type: post.type || post.__typename || (post.isVideo ? 'video' : 'photo'),
    hashtags: extractHashtags(post.caption || ''),
    mentions: extractMentions(post.caption || ''),
    viewCount: parseInt(String(post.viewCount || post.views || 0)) || undefined,
    isVideo: Boolean(post.isVideo || post.type === 'video')
  }));

  // Calculate engagement if we have posts
  let engagement: EngagementData | undefined;
  if (processedPosts.length > 0) {
    const validPosts = processedPosts.filter(p => p.likesCount > 0 || p.commentsCount > 0);
    
    if (validPosts.length > 0) {
      const totalLikes = validPosts.reduce((sum, post) => sum + post.likesCount, 0);
      const totalComments = validPosts.reduce((sum, post) => sum + post.commentsCount, 0);
      const avgLikes = Math.round(totalLikes / validPosts.length);
      const avgComments = Math.round(totalComments / validPosts.length);
      const totalEngagement = totalLikes + totalComments;
      const engagementRate = profile.followersCount > 0 
        ? parseFloat(((totalEngagement / validPosts.length) / profile.followersCount * 100).toFixed(2))
        : 0;

      engagement = {
        avgLikes,
        avgComments,
        engagementRate,
        totalEngagement,
        postsAnalyzed: validPosts.length
      };
    }
  }

  return {
    ...profile,
    latestPosts: processedPosts,
    engagement
  };
}

export function calculateConfidenceLevel(profile: any, analysisType: string): number {
  let confidence = 50;
  
  if (profile.isVerified) confidence += 10;
  if ((profile.engagement?.postsAnalyzed || 0) > 0) confidence += 20;
  if ((profile.engagement?.postsAnalyzed || 0) >= 5) confidence += 10;
  if (analysisType === 'deep') confidence += 10;
  if (profile.isPrivate) confidence -= 15;
  
  return Math.min(95, Math.max(20, confidence));
}

export function extractPostThemes(posts: PostData[]): string {
  if (!posts || posts.length === 0) return 'content themes not available';
  
  const allHashtags = posts.flatMap(post => post.hashtags || []);
  const hashtagCounts = allHashtags.reduce((acc, tag) => {
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const topHashtags = Object.entries(hashtagCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 3)
    .map(([tag]) => tag.replace('#', ''));
    
  return topHashtags.length > 0 ? topHashtags.join(', ') : 'content themes not available';
}
