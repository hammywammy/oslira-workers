// shared/types/profile.types.ts

/**
 * UNIFIED PROFILE DATA TYPES
 *
 * Single source of truth for Instagram profile data structures.
 * Uses camelCase naming convention (scraper format).
 */

export interface PostData {
  id: string;
  caption: string;
  likeCount: number;
  commentCount: number;
  timestamp: string;
  mediaType: 'photo' | 'video' | 'carousel';
  mediaUrl: string;
}

export interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  isVerified: boolean;
  isPrivate: boolean;
  profilePicUrl: string;
  externalUrl: string | null;
  isBusinessAccount: boolean;
  latestPosts: PostData[];
  scraperUsed: string;
  dataQuality: 'high' | 'medium' | 'low';
}

/**
 * AI Service Format (snake_case)
 * Used by prompt-builder and AI analysis service
 */
export interface AIProfileData {
  username: string;
  display_name: string;
  follower_count: number;
  following_count: number;
  post_count: number;
  bio: string;
  external_url: string | null;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  profile_pic_url: string;
  posts: AIPostData[];
}

export interface AIPostData {
  id: string;
  caption: string;
  like_count: number;
  comment_count: number;
  timestamp: string;
  media_type: 'photo' | 'video' | 'carousel';
  media_url: string;
}

/**
 * Transform scraper ProfileData to AI format
 */
export function toAIProfile(profile: ProfileData): AIProfileData {
  return {
    username: profile.username,
    display_name: profile.displayName,
    follower_count: profile.followersCount,
    following_count: profile.followingCount,
    post_count: profile.postsCount,
    bio: profile.bio,
    external_url: profile.externalUrl,
    is_verified: profile.isVerified,
    is_private: profile.isPrivate,
    is_business_account: profile.isBusinessAccount,
    profile_pic_url: profile.profilePicUrl,
    posts: profile.latestPosts.map(post => ({
      id: post.id,
      caption: post.caption,
      like_count: post.likeCount,
      comment_count: post.commentCount,
      timestamp: post.timestamp,
      media_type: post.mediaType,
      media_url: post.mediaUrl
    }))
  };
}
