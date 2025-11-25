// infrastructure/ai/prompt-builder.service.ts

import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';

/**
 * PROMPT BUILDER SERVICE
 *
 * Constructs prompts with proper caching structure:
 * - Business context: CACHED (800 tokens, reused across analyses)
 * - Profile data: DYNAMIC (changes per request, never cached)
 *
 * Cache savings: 90% on business context (30-40% total cost reduction)
 */

export interface ProfileData {
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
  posts: PostData[];
}

export interface PostData {
  id: string;
  caption: string;
  like_count: number;
  comment_count: number;
  timestamp: string;
  media_type: 'photo' | 'video' | 'carousel';
  media_url: string;
}

export class PromptBuilder {

  /**
   * Build business context (CACHED - 800 tokens)
   * This section is reused across all analyses for the same business profile
   */
  buildBusinessContext(business: BusinessProfile): string {
    const contextPack = business.business_context_pack || {};

    return `# BUSINESS CONTEXT (Your Client)

**Company:** ${business.business_name}
**Website:** ${business.website || 'Not provided'}
**One-Liner:** ${business.business_one_liner || 'Not provided'}

## Target Audience
${contextPack.target_audience || 'Not specified'}

## Industry & Offering
- **Industry:** ${contextPack.industry || 'Not specified'}
- **What We Offer:** ${contextPack.offering || 'Not specified'}

## Ideal Customer Profile (ICP)
- **Follower Range:** ${contextPack.icp_min_followers || 0} - ${contextPack.icp_max_followers || 'unlimited'}
- **Min Engagement Rate:** ${contextPack.icp_min_engagement_rate || 0}%
- **Content Themes:** ${contextPack.icp_content_themes?.join(', ') || 'Any'}
- **Geographic Focus:** ${contextPack.icp_geographic_focus || 'Global'}
- **Industry Niche:** ${contextPack.icp_industry_niche || 'Any'}

## Key Selling Points
${contextPack.selling_points?.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n') || 'Not specified'}

## Brand Voice
${contextPack.brand_voice || 'Professional and engaging'}

## Outreach Goals
${contextPack.outreach_goals || 'Build partnerships and drive conversions'}

---`;
  }

  /**
   * Build profile summary (DYNAMIC - never cached)
   * DEFENSIVE: All numeric fields have fallbacks to prevent toLocaleString crashes
   */
  buildProfileSummary(profile: ProfileData): string {
    const engagementRate = this.calculateEngagementRate(profile);
    const avgLikes = this.calculateAvgLikes(profile);
    const avgComments = this.calculateAvgComments(profile);
    const postingFrequency = this.estimatePostingFrequency(profile);

    // Safe numeric values with defaults
    const safeFollowerCount = profile.follower_count ?? 0;
    const safeFollowingCount = profile.following_count ?? 0;
    const safePostCount = profile.post_count ?? 0;
    const safePosts = profile.posts || [];

    return `# INSTAGRAM PROFILE TO ANALYZE

**Username:** @${profile.username || 'unknown'}
**Display Name:** ${profile.display_name || profile.username || 'Unknown'}
**Follower Count:** ${safeFollowerCount.toLocaleString()}
**Following Count:** ${safeFollowingCount.toLocaleString()}
**Total Posts:** ${safePostCount.toLocaleString()}
**Verified:** ${profile.is_verified ? 'Yes' : 'No'}
**Business Account:** ${profile.is_business_account ? 'Yes' : 'No'}
**Private:** ${profile.is_private ? 'Yes' : 'No'}

## Bio
${profile.bio || 'No bio'}

## External Link
${profile.external_url || 'None'}

## Engagement Metrics (Last ${safePosts.length} posts)
- **Engagement Rate:** ${engagementRate.toFixed(2)}%
- **Avg Likes per Post:** ${avgLikes.toLocaleString()}
- **Avg Comments per Post:** ${avgComments.toLocaleString()}
- **Estimated Posting Frequency:** ${postingFrequency}

---`;
  }

  /**
   * Build recent posts section (DYNAMIC - never cached)
   * DEFENSIVE: Handle missing/undefined values gracefully
   */
  buildRecentPosts(profile: ProfileData, limit: number = 6): string {
    const safePosts = profile.posts || [];
    const posts = safePosts.slice(0, limit);
    const safeFollowerCount = profile.follower_count ?? 0;

    if (posts.length === 0) {
      return `# RECENT POSTS\n\nNo posts available for analysis.\n\n---\n\n`;
    }

    let postsSection = `# RECENT POSTS (Last ${posts.length})\n\n`;

    posts.forEach((post, index) => {
      const safeLikeCount = post.like_count ?? 0;
      const safeCommentCount = post.comment_count ?? 0;
      const engagement = safeFollowerCount > 0
        ? ((safeLikeCount + safeCommentCount) / safeFollowerCount * 100).toFixed(2)
        : '0.00';

      const postDate = post.timestamp
        ? new Date(post.timestamp).toLocaleDateString()
        : 'Unknown date';

      postsSection += `## Post ${index + 1} (${post.media_type || 'photo'})
**Posted:** ${postDate}
**Likes:** ${safeLikeCount.toLocaleString()} | **Comments:** ${safeCommentCount.toLocaleString()}
**Engagement:** ${engagement}%

**Caption:**
${post.caption || 'No caption'}

---

`;
    });

    return postsSection;
  }

  /**
   * LIGHT ANALYSIS PROMPT (STRIPPED DOWN)
   * Model: gpt-5-nano (fast, cheap, 6s avg)
   * Focus: Quick fit assessment - overall_score + summary only
   */
  buildLightAnalysisPrompt(business: BusinessProfile, profile: ProfileData): {
    system: string;
    user: string;
  } {
    const businessContext = this.buildBusinessContext(business);

    // DEFENSIVE: Ensure all numeric fields have defaults before using toLocaleString
    const safeFollowerCount = profile.follower_count ?? 0;
    const engagementRate = this.calculateEngagementRate(profile);
    const recentPosts = this.buildRecentPosts(profile, 6);

    return {
      system: `You are an expert Instagram prospecting analyst. Assess if an Instagram profile is a good fit for a business's partnership outreach.

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "summary_text": "2-3 sentences explaining the score"
}`,
      user: `${businessContext}

# PROFILE TO ANALYZE
**Username:** @${profile.username || 'unknown'}
**Follower Count:** ${safeFollowerCount.toLocaleString()}
**Engagement Rate:** ${engagementRate.toFixed(2)}%
**Bio:** ${profile.bio || 'No bio'}

${recentPosts}

# YOUR TASK
Score this profile 0-100 for partnership potential with ${business.business_name}.
Provide a 2-3 sentence summary explaining the score.

Return JSON:
{
  "overall_score": 0-100,
  "summary_text": "2-3 sentences"
}`
    };
  }

  // ===============================================================================
  // HELPER METHODS (All defensive against undefined/null values)
  // ===============================================================================

  private calculateEngagementRate(profile: ProfileData): number {
    const safePosts = profile.posts || [];
    const safeFollowerCount = profile.follower_count ?? 0;

    if (safePosts.length === 0 || safeFollowerCount === 0) return 0;

    const totalEngagement = safePosts.reduce(
      (sum, post) => sum + (post.like_count ?? 0) + (post.comment_count ?? 0),
      0
    );

    const avgEngagementPerPost = totalEngagement / safePosts.length;
    return (avgEngagementPerPost / safeFollowerCount) * 100;
  }

  private calculateAvgLikes(profile: ProfileData): number {
    const safePosts = profile.posts || [];
    if (safePosts.length === 0) return 0;

    const totalLikes = safePosts.reduce((sum, post) => sum + (post.like_count ?? 0), 0);
    return Math.round(totalLikes / safePosts.length);
  }

  private calculateAvgComments(profile: ProfileData): number {
    const safePosts = profile.posts || [];
    if (safePosts.length === 0) return 0;

    const totalComments = safePosts.reduce((sum, post) => sum + (post.comment_count ?? 0), 0);
    return Math.round(totalComments / safePosts.length);
  }

  private estimatePostingFrequency(profile: ProfileData): string {
    const safePosts = profile.posts || [];
    if (safePosts.length < 2) return 'Unknown';

    const oldestPost = safePosts[safePosts.length - 1];
    const newestPost = safePosts[0];

    if (!oldestPost?.timestamp || !newestPost?.timestamp) return 'Unknown';

    const oldest = new Date(oldestPost.timestamp);
    const newest = new Date(newestPost.timestamp);
    const daysDiff = (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff === 0) return 'Multiple posts per day';

    const postsPerDay = safePosts.length / daysDiff;

    if (postsPerDay >= 1) return `${postsPerDay.toFixed(1)} posts/day`;
    if (postsPerDay >= 0.5) return 'Several posts per week';
    if (postsPerDay >= 0.14) return '1-2 posts per week';
    return 'Less than weekly';
  }
}
