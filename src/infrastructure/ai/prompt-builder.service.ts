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
   */
  buildProfileSummary(profile: ProfileData): string {
    const engagementRate = this.calculateEngagementRate(profile);
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

## Engagement Metrics (Last ${profile.posts.length} posts)
- **Engagement Rate:** ${engagementRate.toFixed(2)}%
- **Avg Likes per Post:** ${avgLikes.toLocaleString()}
- **Avg Comments per Post:** ${avgComments.toLocaleString()}
- **Estimated Posting Frequency:** ${postingFrequency}

---`;
  }

  /**
   * Build recent posts section (DYNAMIC - never cached)
   */
  buildRecentPosts(profile: ProfileData, limit: number = 12): string {
    const posts = profile.posts.slice(0, limit);
    
    let postsSection = `# RECENT POSTS (Last ${posts.length})\n\n`;
    
    posts.forEach((post, index) => {
      const engagement = ((post.like_count + post.comment_count) / profile.follower_count * 100).toFixed(2);
      
      postsSection += `## Post ${index + 1} (${post.media_type})
**Posted:** ${new Date(post.timestamp).toLocaleDateString()}
**Likes:** ${post.like_count.toLocaleString()} | **Comments:** ${post.comment_count.toLocaleString()}
**Engagement:** ${engagement}%

**Caption:**
${post.caption || 'No caption'}

---

`;
    });
    
    return postsSection;
  }

  /**
   * LIGHT ANALYSIS PROMPT
   * Model: gpt-5-nano (fast, cheap, 6s avg)
   * Focus: Quick fit assessment
   */
  buildLightAnalysisPrompt(business: BusinessProfile, profile: ProfileData): {
    system: string;
    user: string;
  } {
    const businessContext = this.buildBusinessContext(business);
    const profileSummary = this.buildProfileSummary(profile);
    const recentPosts = this.buildRecentPosts(profile, 6); // Only 6 posts for light
    
    return {
      system: `You are an expert Instagram prospecting analyst. Your job is to quickly assess if an Instagram profile is a good fit for a business's outreach efforts.

Analyze the profile against the business's ICP criteria and provide a fast, accurate fit assessment.

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "niche_fit_score": 0-100,
  "engagement_score": 0-100,
  "confidence_level": 0-100,
  "summary_text": "2-3 sentence summary",
  "key_strengths": ["strength1", "strength2"],
  "red_flags": ["flag1", "flag2"],
  "recommended_action": "pursue" | "maybe" | "skip"
}`,
      user: `${businessContext}

${profileSummary}

${recentPosts}

# YOUR TASK
Assess this profile's fit for the business above. Focus on:
1. Does follower count match ICP?
2. Is engagement rate acceptable?
3. Do content themes align?
4. Does audience match target market?

Provide scores and a quick summary.`
    };
  }

  /**
   * DEEP ANALYSIS PROMPT
   * Model: gpt-5-mini (balanced, 12-18s avg)
   * Focus: Detailed fit + outreach strategy
   */
  buildDeepAnalysisPrompt(business: BusinessProfile, profile: ProfileData): {
    system: string;
    user: string;
  } {
    const businessContext = this.buildBusinessContext(business);
    const profileSummary = this.buildProfileSummary(profile);
    const recentPosts = this.buildRecentPosts(profile, 12); // All 12 posts
    
    return {
      system: `You are an expert Instagram prospecting analyst specializing in B2B partnership assessment.

Your analysis should be comprehensive and actionable, providing:
1. Detailed fit assessment across multiple dimensions
2. Content strategy analysis
3. Audience quality evaluation
4. Partnership opportunity identification
5. Personalized outreach recommendations

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "niche_fit_score": 0-100,
  "engagement_score": 0-100,
  "audience_quality_score": 0-100,
  "content_quality_score": 0-100,
  "confidence_level": 0-100,
  "summary_text": "3-5 sentence detailed summary",
  "key_strengths": ["strength1", "strength2", "strength3"],
  "improvement_areas": ["area1", "area2"],
  "partnership_opportunities": ["opportunity1", "opportunity2"],
  "outreach_angles": ["angle1", "angle2", "angle3"],
  "recommended_action": "pursue" | "maybe" | "skip",
  "urgency_level": "high" | "medium" | "low"
}`,
      user: `${businessContext}

${profileSummary}

${recentPosts}

# YOUR TASK
Provide a comprehensive analysis of this profile's fit for the business above.

Analyze:
1. **ICP Fit:** How well does this profile match the target criteria?
2. **Content Strategy:** What themes, styles, and formats do they use?
3. **Audience Quality:** Who follows them? Are they engaged?
4. **Partnership Potential:** What collaboration opportunities exist?
5. **Outreach Strategy:** What angles would resonate with this person?

Be specific and actionable in your recommendations.`
    };
  }

  /**
   * XRAY ANALYSIS PROMPT - PSYCHOGRAPHIC DEEP DIVE
   * Model: gpt-5 (premium, 16-18s avg)
   * Focus: Personality, motivations, decision-making style
   */
  buildXRayAnalysisPrompt(business: BusinessProfile, profile: ProfileData): {
    system: string;
    user: string;
  } {
    const businessContext = this.buildBusinessContext(business);
    const profileSummary = this.buildProfileSummary(profile);
    const recentPosts = this.buildRecentPosts(profile, 12);
    
    return {
      system: `You are an expert psychographic analyst specializing in personality profiling from social media behavior.

Your analysis should reveal:
1. Core personality traits (Big Five model)
2. Communication style and preferences
3. Motivational drivers and values
4. Decision-making patterns
5. Psychological hooks for outreach

Respond in JSON format with these exact fields:
{
  "overall_score": 0-100,
  "niche_fit_score": 0-100,
  "engagement_score": 0-100,
  "audience_quality_score": 0-100,
  "content_quality_score": 0-100,
  "psychographic_fit_score": 0-100,
  "confidence_level": 0-100,
  "summary_text": "5-7 sentence comprehensive summary",
  "personality_traits": {
    "openness": 0-100,
    "conscientiousness": 0-100,
    "extraversion": 0-100,
    "agreeableness": 0-100,
    "neuroticism": 0-100
  },
  "communication_style": "direct" | "diplomatic" | "emotional" | "analytical",
  "motivation_drivers": ["driver1", "driver2", "driver3"],
  "decision_making_style": "analytical" | "intuitive" | "collaborative" | "decisive",
  "psychological_hooks": ["hook1", "hook2", "hook3"],
  "outreach_strategy": "Detailed paragraph explaining optimal approach",
  "recommended_action": "pursue" | "maybe" | "skip",
  "urgency_level": "high" | "medium" | "low"
}`,
      user: `${businessContext}

${profileSummary}

${recentPosts}

# YOUR TASK
Provide a deep psychographic analysis of this Instagram profile.

Go beyond surface metrics and analyze:
1. **Personality Traits:** What kind of person are they? (Use Big Five model)
2. **Communication Style:** How do they express themselves?
3. **Motivations:** What drives their content and decisions?
4. **Decision-Making:** How do they approach choices and partnerships?
5. **Psychological Hooks:** What messaging would resonate deeply?

This is premium analysis - be thorough, insightful, and actionable.`
    };
  }

  /**
   * OUTREACH MESSAGE GENERATION PROMPT
   * Used for DEEP and XRAY analyses
   */
  buildOutreachMessagePrompt(
    business: BusinessProfile,
    profile: ProfileData,
    analysisInsights: string
  ): { system: string; user: string } {
    const businessContext = this.buildBusinessContext(business);
    
    return {
      system: `You are an expert cold outreach copywriter specializing in Instagram DM messages.

Your messages should:
1. Be personalized and genuine (no templates)
2. Reference specific content from their profile
3. Lead with value, not a sales pitch
4. Match the recipient's communication style
5. Be concise (2-4 sentences max)
6. End with a soft CTA

Respond with ONLY the message text - no JSON, no explanations.`,
      user: `${businessContext}

# PROFILE TO MESSAGE
**Username:** @${profile.username}
**Display Name:** ${profile.display_name}
**Bio:** ${profile.bio}

# ANALYSIS INSIGHTS
${analysisInsights}

# YOUR TASK
Write a personalized Instagram DM that:
1. References something specific from their recent content
2. Connects it to how ${business.business_name} could help them
3. Feels natural, not salesy
4. Matches their communication style

Remember: This is the first message - build curiosity, don't pitch hard.`
    };
  }

  // ===============================================================================
  // HELPER METHODS
  // ===============================================================================

  private calculateEngagementRate(profile: ProfileData): number {
    if (!profile.posts.length || !profile.follower_count) return 0;
    
    const totalEngagement = profile.posts.reduce(
      (sum, post) => sum + post.like_count + post.comment_count,
      0
    );
    
    const avgEngagementPerPost = totalEngagement / profile.posts.length;
    return (avgEngagementPerPost / profile.follower_count) * 100;
  }

  private calculateAvgLikes(profile: ProfileData): number {
    if (!profile.posts.length) return 0;
    
    const totalLikes = profile.posts.reduce((sum, post) => sum + post.like_count, 0);
    return Math.round(totalLikes / profile.posts.length);
  }

  private calculateAvgComments(profile: ProfileData): number {
    if (!profile.posts.length) return 0;
    
    const totalComments = profile.posts.reduce((sum, post) => sum + post.comment_count, 0);
    return Math.round(totalComments / profile.posts.length);
  }

  private estimatePostingFrequency(profile: ProfileData): string {
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
