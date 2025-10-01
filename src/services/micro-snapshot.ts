import type { ProfileData } from '../types/interfaces.js';

export interface MicroSnapshot {
  username: string;
  followers: number;
  verified: boolean;
  private: boolean;
  bio_short: string;
  external_domains: string[];
  posts_30d: number;
  top_captions: string[];
  engagement_signals: {
    avg_likes: number;
    avg_comments: number;
    posts_analyzed: number;
  } | null;
}

export function createMicroSnapshot(profile: ProfileData): MicroSnapshot {
  // Extract domains from external URL
  const domains: string[] = [];
  if (profile.externalUrl) {
    try {
      const url = new URL(profile.externalUrl);
      domains.push(url.hostname.replace('www.', ''));
    } catch {
      // Invalid URL, skip
    }
  }

  // Get top 3 captions, truncated to 50 chars each
  const topCaptions = (profile.latestPosts || [])
    .slice(0, 3)
    .map(post => (post.caption || '').slice(0, 50).trim())
    .filter(caption => caption.length > 0);

  // Estimate posts in last 30 days based on account age and total posts
  // Simplified: assume recent activity if posts > followers/100
  const estimatedRecentPosts = profile.followersCount > 0 
    ? Math.min(profile.postsCount, Math.max(1, Math.floor(profile.postsCount / 12))) // Rough monthly estimate
    : Math.min(profile.postsCount, 10);

  return {
    username: profile.username,
    followers: profile.followersCount,
    verified: profile.isVerified,
    private: profile.isPrivate,
    bio_short: (profile.bio || '').slice(0, 120).trim(), // Truncate to 120 chars
    external_domains: domains,
    posts_30d: estimatedRecentPosts,
    top_captions: topCaptions,
    engagement_signals: profile.engagement ? {
      avg_likes: profile.engagement.avgLikes,
      avg_comments: profile.engagement.avgComments,
      posts_analyzed: profile.engagement.postsAnalyzed
    } : null
  };
}

export function getSnapshotTokenCount(snapshot: MicroSnapshot): number {
  // Rough token estimation for budget control
  const bioTokens = Math.ceil(snapshot.bio_short.length / 4);
  const captionTokens = snapshot.top_captions.reduce((sum, cap) => sum + Math.ceil(cap.length / 4), 0);
  const structureTokens = 50; // JSON structure overhead
  
  return bioTokens + captionTokens + structureTokens;
}
