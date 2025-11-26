// infrastructure/ai/prompt-builder.service.ts

import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';
import type { AIProfileData, AIPostData } from '@/shared/types/profile.types';
import {
  type AnalysisType,
  getPromptConfig,
  getPostsLimit
} from '@/config/operations-pricing.config';

/**
 * PROMPT BUILDER SERVICE
 *
 * Constructs prompts with proper caching structure:
 * - Business context: CACHED (800 tokens, reused across analyses)
 * - Profile data: DYNAMIC (changes per request, never cached)
 *
 * MODULAR DESIGN:
 * - buildAnalysisPrompt() routes to correct prompt based on analysis type
 * - Each analysis type has configurable summary length and caption truncation
 * - Deep analysis = 2x summary sentences vs light
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
   * CONSOLIDATION NOTE: Database has overlapping fields. Priority order:
   * 1. business_context (primary source) - contains user-entered onboarding data
   * 2. ideal_customer_profile (secondary) - may have additional ICP settings
   * 3. Generated fields (fallback) - AI-generated summaries
   *
   * TODO: Consider database migration to consolidate these fields
   * to avoid ~200 tokens of redundant data per analysis
   */
  buildBusinessContext(business: BusinessProfile): string {
    // Extract data from JSONB fields (database schema)
    const context = business.business_context || {};
    const icp = business.ideal_customer_profile || {};

    // Use single source of truth with fallback priority
    const businessSummary = context.business_summary
      || business.business_summary_generated
      || 'Not provided';
    const targetAudience = context.target_description
      || icp.target_audience
      || 'Not specified';
    const communicationTone = context.communication_tone
      || icp.brand_voice
      || 'Professional and engaging';
    const minFollowers = context.icp_min_followers ?? icp.icp_min_followers ?? 0;
    const maxFollowers = context.icp_max_followers ?? icp.icp_max_followers ?? null;
    const maxFollowersDisplay = maxFollowers !== null ? maxFollowers.toLocaleString() : 'unlimited';

    return `# BUSINESS CONTEXT (Your Client)

**Company:** ${business.business_name || business.full_name}
**One-Liner:** ${business.business_one_liner || 'Not provided'}
**Business Summary:** ${businessSummary}

## Target Audience
${targetAudience}

## Communication Tone
${communicationTone}

## Ideal Customer Profile (ICP)
- **Follower Range:** ${minFollowers.toLocaleString()} - ${maxFollowersDisplay}
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
   * MODULAR: Caption truncation length is configurable per analysis type
   */
  buildRecentPosts(
    profile: AIProfileData,
    limit: number = 6,
    captionTruncateLength: number = 200
  ): string {
    const posts = profile.posts.slice(0, limit);

    let postsSection = `# RECENT POSTS (Last ${posts.length})\n\n`;

    posts.forEach((post, index) => {
      // Truncate caption based on configured length
      const caption = post.caption
        ? (post.caption.length > captionTruncateLength
          ? post.caption.substring(0, captionTruncateLength) + '...'
          : post.caption)
        : 'No caption';

      postsSection += `## Post ${index + 1} (${post.media_type})
**Posted:** ${new Date(post.timestamp).toLocaleDateString()}
**Likes:** ${post.like_count.toLocaleString()} | **Comments:** ${post.comment_count.toLocaleString()}

**Caption:**
${caption}

---

`;
    });

    return postsSection;
  }

  // ===============================================================================
  // MODULAR PROMPT ROUTER
  // ===============================================================================

  /**
   * MODULAR: Build analysis prompt for any analysis type
   * Routes to the correct prompt builder based on type
   */
  buildAnalysisPrompt(
    analysisType: AnalysisType,
    business: BusinessProfile,
    profile: AIProfileData
  ): { system: string; user: string } {
    switch (analysisType) {
      case 'light':
        return this.buildLightAnalysisPrompt(business, profile);
      case 'deep':
        return this.buildDeepAnalysisPrompt(business, profile);
      default:
        throw new Error(`Unknown analysis type: ${analysisType}`);
    }
  }

  // ===============================================================================
  // LIGHT ANALYSIS PROMPT
  // ===============================================================================

  /**
   * LIGHT ANALYSIS PROMPT (STRIPPED DOWN)
   * Model: gpt-5-nano (fast, cheap, 6s avg)
   * Focus: Quick fit assessment - overall_score + summary only
   */
  buildLightAnalysisPrompt(business: BusinessProfile, profile: AIProfileData): {
    system: string;
    user: string;
  } {
    const config = getPromptConfig('light');
    const postsLimit = getPostsLimit('light');

    const businessContext = this.buildBusinessContext(business);
    const recentPosts = this.buildRecentPosts(profile, postsLimit, config.caption_truncate_length);

    return {
      system: `You are an expert Instagram prospecting analyst. Assess if an Instagram profile is a good fit for a business's partnership outreach.

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "summary_text": "${config.summary_sentences} sentences explaining the score"
}`,
      user: `${businessContext}

# PROFILE TO ANALYZE
**Username:** @${profile.username}
**Follower Count:** ${profile.follower_count.toLocaleString()}
**Bio:** ${profile.bio || 'No bio'}

${recentPosts}

# YOUR TASK
Score this profile 0-100 for partnership potential with ${business.business_name}.
Provide a ${config.summary_sentences} sentence summary explaining the score.

Return JSON:
{
  "overall_score": 0-100,
  "summary_text": "${config.summary_sentences} sentences"
}`
    };
  }

  // ===============================================================================
  // DEEP ANALYSIS PROMPT
  // ===============================================================================

  /**
   * DEEP ANALYSIS PROMPT (EXTENDED)
   * Model: gpt-5-nano (same model, more tokens)
   * Focus: In-depth fit assessment - 2x longer summary than light
   *
   * Key differences from light:
   * - 4-6 sentence summary (vs 2-3)
   * - 400 char caption truncation (vs 200)
   * - More detailed reasoning in summary
   */
  buildDeepAnalysisPrompt(business: BusinessProfile, profile: AIProfileData): {
    system: string;
    user: string;
  } {
    const config = getPromptConfig('deep');
    const postsLimit = getPostsLimit('deep');

    const businessContext = this.buildBusinessContext(business);
    const profileSummary = this.buildProfileSummary(profile);
    const recentPosts = this.buildRecentPosts(profile, postsLimit, config.caption_truncate_length);

    return {
      system: `You are an expert Instagram prospecting analyst. Provide an in-depth assessment of whether an Instagram profile is a good fit for a business's partnership outreach.

Your analysis should be thorough and cover:
- Content alignment with business values
- Audience engagement quality
- Brand fit and partnership potential
- Specific observations from recent posts

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "summary_text": "${config.summary_sentences} sentences with detailed analysis"
}`,
      user: `${businessContext}

${profileSummary}

${recentPosts}

# YOUR TASK
Provide an in-depth analysis of this profile's partnership potential with ${business.business_name}.

Your summary should:
- Explain the score with specific reasoning (${config.summary_sentences} sentences)
- Reference specific content or engagement patterns you observed
- Highlight any red flags or especially strong alignment signals
- Be actionable for the business deciding whether to reach out

Return JSON:
{
  "overall_score": 0-100,
  "summary_text": "${config.summary_sentences} sentences with detailed analysis"
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
