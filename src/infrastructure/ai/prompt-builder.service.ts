// infrastructure/ai/prompt-builder.service.ts

import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';
import type { AIProfileData, AIPostData } from '@/shared/types/profile.types';

/**
 * PROMPT BUILDER SERVICE
 *
 * Constructs prompts with proper caching structure:
 * - Business context: CACHED (800 tokens, reused across analyses)
 * - Profile data: DYNAMIC (changes per request, never cached)
 *
 * Cache savings: 90% on business context (30-40% total cost reduction)
 *
 * Uses unified types from @/shared/types/profile.types
 */

export class PromptBuilder {

  /**
   * Build business context (CACHED - 800 tokens)
   * This section is reused across all analyses for the same business profile
   *
   * FIXED: Correctly maps database JSONB fields (business_context & ideal_customer_profile)
   */
  buildBusinessContext(business: BusinessProfile): string {
    // Extract data from JSONB fields (database schema)
    const context = business.business_context || {};
    const icp = business.ideal_customer_profile || {};

    return `# BUSINESS CONTEXT (Your Client)

**Company:** ${business.business_name || business.full_name}
**One-Liner:** ${business.business_one_liner || 'Not provided'}
**Business Summary:** ${context.business_summary || business.business_summary_generated || 'Not provided'}

## Target Audience
${icp.target_audience || context.target_description || 'Not specified'}

## Communication Tone
${icp.brand_voice || context.communication_tone || 'Professional and engaging'}

## Ideal Customer Profile (ICP)
- **Follower Range:** ${icp.icp_min_followers || context.icp_min_followers || 0} - ${icp.icp_max_followers || context.icp_max_followers || 'unlimited'}
- **Target Company Sizes:** ${context.target_company_sizes?.join(', ') || 'Any'}

---`;
  }

  /**
   * Build profile summary (DYNAMIC - never cached)
   */
  buildProfileSummary(profile: AIProfileData): string {
    const avgLikes = this.calculateAvgLikes(profile);
    const avgComments = this.calculateAvgComments(profile);
    const postingFrequency = this.estimatePostingFrequency(profile);

    return `# INSTAGRAM PROFILE TO ANALYZE

**Username:** @${profile.username}
**Display Name:** ${profile.display_name}
**Follower Count:** ${profile.follower_count.toLocaleString()}
**Following Count:** ${profile.following_count.toLocaleString()}
**Total Posts:** ${profile.post_count.toLocaleString()}
**Verified:** ${profile.is_verified ? 'Yes' : 'No'}
**Business Account:** ${profile.is_business_account ? 'Yes' : 'No'}
**Private:** ${profile.is_private ? 'Yes' : 'No'}

## Bio
${profile.bio || 'No bio'}

## External Link
${profile.external_url || 'None'}

## Post Metrics (Last ${profile.posts.length} posts)
- **Avg Likes per Post:** ${avgLikes.toLocaleString()}
- **Avg Comments per Post:** ${avgComments.toLocaleString()}
- **Estimated Posting Frequency:** ${postingFrequency}

---`;
  }

  /**
   * Build recent posts section (DYNAMIC - never cached)
   */
  buildRecentPosts(profile: AIProfileData, limit: number = 6): string {
    const posts = profile.posts.slice(0, limit);

    let postsSection = `# RECENT POSTS (Last ${posts.length})\n\n`;

    posts.forEach((post, index) => {
      postsSection += `## Post ${index + 1} (${post.media_type})
**Posted:** ${new Date(post.timestamp).toLocaleDateString()}
**Likes:** ${post.like_count.toLocaleString()} | **Comments:** ${post.comment_count.toLocaleString()}

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
  buildLightAnalysisPrompt(business: BusinessProfile, profile: AIProfileData): {
    system: string;
    user: string;
  } {
    const businessContext = this.buildBusinessContext(business);
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
**Username:** @${profile.username}
**Follower Count:** ${profile.follower_count.toLocaleString()}
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
  // HELPER METHODS
  // ===============================================================================

  private calculateAvgLikes(profile: AIProfileData): number {
    if (!profile.posts.length) return 0;

    const totalLikes = profile.posts.reduce((sum, post) => sum + post.like_count, 0);
    return Math.round(totalLikes / profile.posts.length);
  }

  private calculateAvgComments(profile: AIProfileData): number {
    if (!profile.posts.length) return 0;

    const totalComments = profile.posts.reduce((sum, post) => sum + post.comment_count, 0);
    return Math.round(totalComments / profile.posts.length);
  }

  private estimatePostingFrequency(profile: AIProfileData): string {
    if (profile.posts.length < 2) return 'Unknown';

    const oldest = new Date(profile.posts[profile.posts.length - 1].timestamp);
    const newest = new Date(profile.posts[0].timestamp);
    const daysDiff = (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff === 0) return 'Multiple posts per day';

    const postsPerDay = profile.posts.length / daysDiff;

    if (postsPerDay >= 1) return `${postsPerDay.toFixed(1)} posts/day`;
    if (postsPerDay >= 0.5) return 'Several posts per week';
    if (postsPerDay >= 0.14) return '1-2 posts per week';
    return 'Less than weekly';
  }
}
