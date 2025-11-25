import type { ProfileData } from '@/shared/types/analysis.types';

// BusinessProfile type - add this interface at top of file
export interface BusinessProfile {
  business_name: string;
  business_one_liner?: string;
  business_niche?: string;
  target_audience: string;
  industry?: string;
  icp_min_followers?: number;
  icp_max_followers?: number;
  icp_min_engagement_rate?: number;
  icp_content_themes?: string[];
  icp_geographic_focus?: string;
  icp_industry_niche?: string;
  selling_points?: string[];
  brand_voice?: string;
  outreach_goals?: string;
}

// ===============================================================================
// JSON SCHEMAS FOR NEW PAYLOAD STRUCTURE
// ===============================================================================

export function getLightAnalysisJsonSchema() {
  return {
    name: 'LightAnalysisResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string', maxLength: 400 },
        confidence: { type: 'number', minimum: 0.0, maximum: 1.0 }
      },
      required: ['score', 'summary', 'confidence']
    }
  };
}

// NOTE: Deep and X-Ray analysis schemas removed - only light analysis is currently supported
// The framework is extensible - add new schema functions here when implementing additional analysis tiers

export function getPersonalityAnalysisJsonSchema() {
  return {
    name: 'PersonalityAnalysis',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disc_profile: { 
          type: 'string',
          description: 'Primary DISC type (D, I, S, C) or hybrid (DI, SC, etc.)'
        },
        behavior_patterns: { 
          type: 'array', 
          items: { type: 'string' },
          minItems: 3,
          maxItems: 5,
          description: 'Observable behavioral tendencies'
        },
        communication_style: { 
          type: 'string',
          description: 'How they communicate - tone, formality, directness'
        },
        motivation_drivers: { 
          type: 'array', 
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'What appears to motivate them'
        },
        content_authenticity: {
          type: 'string',
          enum: ['ai_generated', 'ai_assisted', 'human_authentic', 'insufficient_data'],
          description: 'Assessment of whether captions are AI-written or human'
        },
        data_confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Confidence in personality assessment based on data quality'
        }
      },
      required: ['disc_profile', 'behavior_patterns', 'communication_style', 'motivation_drivers', 'content_authenticity', 'data_confidence']
    }
  };
}

// NOTE: buildDeepAnalysisPrompt, buildXRayAnalysisPrompt, and buildMarketCompletionPrompt removed
// The framework is extensible - add new prompt builders here when implementing additional analysis tiers
// ===============================================================================
// OUTREACH MESSAGE PROMPTS
// ===============================================================================

export function buildOutreachMessagePrompt(
  profile: ProfileData, 
  business: BusinessProfile, 
  analysis: any
): string {
  return `# PERSONALIZED OUTREACH MESSAGE GENERATION

## TARGET PROFILE
- **Username**: @${profile.username}
- **Display Name**: ${profile.displayName || profile.username}
- **Followers**: ${profile.followersCount.toLocaleString()}
- **Bio**: "${profile.bio || 'No bio available'}"
- **Verified**: ${profile.isVerified ? 'Yes' : 'No'}
- **Business Account**: ${profile.isBusinessAccount ? 'Yes' : 'No'}

## BUSINESS CONTEXT
- **Company**: ${business.business_name}
- **Industry**: ${business.business_niche}
- **Business Summary**: ${business.business_one_liner || business.target_audience}
- **Target Audience**: ${business.target_audience}

## ANALYSIS INSIGHTS
- **Overall Score**: ${analysis.score}/100
- **Niche Fit**: ${analysis.niche_fit}/100
- **Key Selling Points**: ${analysis.selling_points?.join(', ') || 'Not available'}

## MESSAGE REQUIREMENTS
Write a personalized outreach message that:

1. **Addresses them personally** using their display name or username
2. **Shows genuine interest** in their content/audience
3. **Mentions specific details** from their profile (follower count, niche, etc.)
4. **Clearly states the collaboration opportunity** 
5. **Includes a clear call-to-action**
6. **Maintains professional but friendly tone**
7. **Keeps length between 150-250 words**

## TONE GUIDELINES
- Professional but approachable
- Genuine interest, not generic template
- Confident but not pushy
- Focus on mutual benefit
- Include specific numbers when relevant (follower count, etc.)

Generate ONLY the message text - no subject line, no extra formatting, no introduction. Start directly with the greeting.`;
}

// ===============================================================================
// SUMMARY GENERATION PROMPTS
// ===============================================================================

export function buildQuickSummaryPrompt(profile: ProfileData): string {
  return `Generate a concise 1-2 sentence summary for this Instagram profile:

@${profile.username} - ${profile.followersCount.toLocaleString()} followers
Bio: "${profile.bio || 'No bio'}"
Verified: ${profile.isVerified ? 'Yes' : 'No'}
Engagement: ${profile.engagement?.engagementRate || 'Unknown'}%

Create a brief summary suitable for dashboard lists. Focus on key characteristics and business potential. Maximum 150 characters.`;
}

// NOTE: buildDeepSummaryPrompt removed - only light analysis is currently supported
// The framework is extensible - add summary prompt builders here when implementing additional analysis tiers

export function buildSpeedLightAnalysisPrompt(
  profile: ProfileData, 
  business: BusinessProfile
): string {
  let prompt = `Score @${profile.username} (${profile.followersCount} followers) for: ${business.business_one_liner || business.target_audience || business.business_name}

Bio: "${profile.bio || 'No bio'}"
Business: ${profile.isBusinessAccount ? 'Yes' : 'No'}`;

  // Only add basic engagement if available (no AI cost, just helps accuracy)
  if (profile.engagement) {
    const eng = profile.engagement;
    prompt += `\nEngagement: ${eng.engagementRate}% ER (${eng.avgLikes} likes, ${eng.avgComments} comments from ${eng.postsAnalyzed} posts)`;
    
    // Add format info if available (free pre-processing)
    if (eng.formatDistribution) {
      prompt += ` | Primary format: ${eng.formatDistribution.primaryFormat}`;
    }
  }

  prompt += `\n\nReturn JSON: {"score": 0-100, "summary": "one sentence why", "confidence": 0.8}`;

  return prompt;
}

export function buildPersonalityAnalysisPrompt(profile: ProfileData): string {
  // Use preprocessed summary if available (cheap), else sample captions
  const hasPreProcessed = !!(profile as any).preProcessed;
  
  let contentSample = '';
  if (hasPreProcessed) {
    contentSample = (profile as any).preProcessed.summary;
  } else if (profile.latestPosts && profile.latestPosts.length > 0) {
    contentSample = profile.latestPosts.slice(0, 6).map((p: any, i: number) => 
      `${i+1}. "${p.caption?.slice(0, 100)}..." (${p.likesCount}♡)`
    ).join('\n');
  }

  return `PERSONALITY ANALYSIS: @${profile.username}

Bio: "${profile.bio || 'No bio'}"
Type: ${profile.isVerified ? '✓' : ''}${profile.isBusinessAccount ? 'Business' : 'Personal'}
Followers: ${profile.followersCount.toLocaleString()}

Content:
${contentSample || 'No content available'}

CRITICAL RULES:
- Base analysis ONLY on observable behavior
- NO business or collaboration context
- Be honest about AI-written vs human captions
- If data is limited, reflect this in data_confidence

Assess:
1. DISC Profile (D/I/S/C or hybrid)
2. Behavior Patterns (3-5 observable tendencies)
3. Communication Style (tone, formality, directness)
4. Motivation Drivers (2-4 key motivators)
5. Content Authenticity (are captions AI-generated, AI-assisted, or human authentic?)

JSON only.`;
}

export function getSpeedLightAnalysisJsonSchema() {
  return getLightAnalysisJsonSchema(); // Reuse existing schema
}

export interface PreScreenResult {
  shouldProcess: boolean;
  earlyScore?: number;
  reason?: string;
}

export function preScreenProfile(
  profile: ProfileData, 
  business: BusinessProfile
): PreScreenResult {
  // Instant rejection criteria
  if (profile.isPrivate && profile.followersCount < 1000) {
    return {
      shouldProcess: false,
      earlyScore: 15,
      reason: 'Private account with low followers - no analysis possible'
    };
  }
  
  if (profile.followersCount === 0) {
    return {
      shouldProcess: false,
      earlyScore: 0,
      reason: 'Account has no followers'
    };
  }
  
  // Suspicious ratio check
  const followRatio = profile.followingCount > 0 ? 
    profile.followersCount / profile.followingCount : 999;
    
  if (followRatio < 0.1 && profile.followersCount > 1000) {
    return {
      shouldProcess: false,
      earlyScore: 20,
      reason: 'Suspicious follow ratio indicates bot/spam account'
    };
  }
  
  // All checks passed
  return { shouldProcess: true };
}

function buildBusinessContext(business: BusinessProfile): string {
  return `Business Context: ${business.business_name} - ${business.business_one_liner}
Target Audience: ${business.target_audience}
...`
}
