import type { ProfileData, BusinessProfile } from '../types/interfaces.js';
import { logger } from '../utils/logger.js';

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

export function getDeepAnalysisJsonSchema() {
  return {
    name: 'DeepAnalysisResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Core scores (for runs table)
        score: { type: 'integer', minimum: 0, maximum: 100 },
        engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
        niche_fit: { type: 'integer', minimum: 0, maximum: 100 },
        quick_summary: { 
          type: 'string', 
          maxLength: 600,
          description: 'Short 1-2 sentence summary for dashboard lists'
        },
        confidence_level: { 
          type: 'number', 
          minimum: 0, 
          maximum: 1,
          description: 'Confidence in analysis from 0.0 to 1.0'
        },
        
        // Deep payload structure (for payloads table)
        deep_payload: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deep_summary: { 
              type: 'string',
              description: 'Comprehensive analysis of the profile and partnership potential'
            },
            selling_points: { 
              type: 'array', 
              items: { type: 'string' }, 
              minItems: 3, 
              maxItems: 8,
              description: 'Key selling points for why this influencer is valuable'
            },
            outreach_message: { 
              type: 'string',
              description: 'Personalized outreach message for this specific influencer'
            },
            engagement_breakdown: {
              type: 'object',
              additionalProperties: false,
              properties: {
                avg_likes: { type: 'integer', minimum: 0 },
                avg_comments: { type: 'integer', minimum: 0 },
                engagement_rate: { type: 'number', minimum: 0, maximum: 100 }
              },
              required: ['avg_likes', 'avg_comments', 'engagement_rate'],
              description: 'Detailed engagement metrics breakdown'
            },
            audience_insights: { 
              type: 'string',
              description: 'Detailed audience analysis and insights'
            },
            reasons: { 
              type: 'array', 
              items: { type: 'string' }, 
              minItems: 3, 
              maxItems: 10,
              description: 'Specific reasons why this profile is a good/bad fit'
            }
          },
          required: ['deep_summary', 'selling_points', 'outreach_message', 'engagement_breakdown', 'audience_insights', 'reasons']
        }
      },
      required: ['score', 'engagement_score', 'niche_fit', 'quick_summary', 'confidence_level', 'deep_payload']
    }
  };
}

export function getXRayAnalysisJsonSchema() {
  return {
    name: 'XRayAnalysisResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Core scores (for runs table)
        score: { type: 'integer', minimum: 0, maximum: 100 },
        engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
        niche_fit: { type: 'integer', minimum: 0, maximum: 100 },
        quick_summary: { 
          type: 'string', 
          maxLength: 800,
          description: 'Short 1-2 sentence summary for dashboard lists'
        },
        confidence_level: { 
          type: 'number', 
          minimum: 0, 
          maximum: 1,
          description: 'Confidence in analysis from 0.0 to 1.0'
        },
        
        // X-Ray payload structure (for payloads table)
        xray_payload: {
          type: 'object',
          additionalProperties: false,
          properties: {
            copywriter_profile: {
              type: 'object',
              additionalProperties: false,
              properties: {
                    deep_summary: { 
      type: 'string',
      description: 'Comprehensive X-Ray analysis explaining psychological profile, commercial intelligence, and persuasion strategy'
    },
                demographics: { 
                  type: 'string',
                  description: 'Age, gender, location, lifestyle demographics'
                },
                psychographics: { 
                  type: 'string',
                  description: 'Personality traits, values, interests, motivations'
                },
                pain_points: { 
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 2,
                  maxItems: 6,
                  description: 'Key problems and frustrations this person faces'
                },
                dreams_desires: { 
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 2,
                  maxItems: 6,
                  description: 'Goals, aspirations, and desired outcomes'
                }
              },
              required: ['deep_summary', 'copywriter_profile', 'commercial_intelligence', 'persuasion_strategy']
            },
            commercial_intelligence: {
              type: 'object',
              additionalProperties: false,
              properties: {
                budget_tier: { 
                  type: 'string',
                  enum: ['low-budget', 'mid-market', 'premium', 'luxury'],
                  description: 'Estimated spending capacity based on lifestyle indicators'
                },
                decision_role: { 
                  type: 'string',
                  enum: ['primary', 'influencer', 'gatekeeper', 'researcher'],
                  description: 'Role in purchasing decisions'
                },
                buying_stage: { 
                  type: 'string',
                  enum: ['unaware', 'problem-aware', 'solution-aware', 'product-aware', 'ready-to-buy'],
                  description: 'Current stage in buying journey'
                },
                objections: { 
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 2,
                  maxItems: 5,
                  description: 'Likely objections and concerns about purchasing'
                }
              },
              required: ['budget_tier', 'decision_role', 'buying_stage', 'objections']
            },
            persuasion_strategy: {
              type: 'object',
              additionalProperties: false,
              properties: {
                primary_angle: { 
                  type: 'string',
                  enum: ['transformation', 'status', 'convenience', 'fear-of-missing-out', 'social-proof', 'authority'],
                  description: 'Primary persuasion angle to use'
                },
                hook_style: { 
                  type: 'string',
                  enum: ['problem-agitation', 'curiosity-gap', 'social-proof', 'authority-positioning', 'story-based'],
                  description: 'Most effective hook style for this person'
                },
                proof_elements: { 
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 3,
                  maxItems: 7,
                  description: 'Types of proof that would be most convincing'
                },
                communication_style: { 
                  type: 'string',
                  enum: ['casual-friendly', 'professional', 'authoritative', 'empathetic', 'energetic'],
                  description: 'Communication tone that would resonate best'
                }
              },
              required: ['primary_angle', 'hook_style', 'proof_elements', 'communication_style']
            }
          },
          required: ['copywriter_profile', 'commercial_intelligence', 'persuasion_strategy']
        }
      },
      required: ['score', 'engagement_score', 'niche_fit', 'quick_summary', 'confidence_level', 'xray_payload']
    }
  };
}

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

export function buildDeepAnalysisPrompt(
  profile: ProfileData, 
  business: BusinessProfile,
  context?: {
    triage?: any;
    preprocessor?: any;
  }
): string {
  const preProcessed = (profile as any).preProcessed;
  
  let prompt = `PARTNERSHIP ANALYSIS

Profile: @${profile.username}
Followers: ${profile.followersCount.toLocaleString()} | Posts: ${profile.postsCount}
Bio: "${profile.bio || 'None'}"
Status: ${profile.isVerified ? 'Verified' : 'Unverified'} ${profile.isBusinessAccount ? 'Business' : 'Personal'}
Contact: ${profile.externalUrl ? 'Has link' : 'No link'}`;

  // Use pre-processed summary if available
  if (preProcessed?.summary) {
    prompt += `\n\nDATA INTELLIGENCE:\n${preProcessed.summary}`;
  } else if (profile.engagement) {
    const eng = profile.engagement;
    prompt += `\nEngagement: ${eng.engagementRate}% ER (${eng.avgLikes} likes, ${eng.avgComments} comments, ${eng.postsAnalyzed} posts)`;
  }

  // Add sample content
  const recentContent = profile.latestPosts?.slice(0, 2).map(p => 
    `"${p.caption?.slice(0, 40)}..." (${p.likesCount} likes)`
  ).join(' | ') || 'No recent posts';
  
  prompt += `\nRecent Content: ${recentContent}`;

  prompt += `\n\nBusiness Context: ${business.business_name} - ${business.business_one_liner || business.target_audience}

CRITICAL: Assess REAL collaboration fit. If this profile's audience is:
- Not the business target (e.g., platform users vs B2B buyers)
- Not solution-aware for this offering
- Not decision-makers in this category

Then score accordingly (0-40 range) and explain the mismatch clearly. Do not manufacture fit.

Score collaboration potential (0-100) honestly and provide strategy ONLY if fit exists.
Return JSON with deep_summary (explain fit reality), selling_points, outreach_message, engagement_breakdown, audience_insights, reasons.`;

  return prompt;
}

export function buildXRayAnalysisPrompt(
  profile: ProfileData, 
  business: BusinessProfile,
  context?: {
    triage?: any;
    preprocessor?: any;
  }
): string {
  const preProcessed = (profile as any).preProcessed;
  
  let prompt = `X-RAY PROFILE ANALYSIS

@${profile.username} (${profile.followersCount} followers)
Bio: "${profile.bio || 'None'}"
Type: ${profile.isVerified ? '✓' : ''}${profile.isBusinessAccount ? 'Biz' : 'Personal'}`;

  if (preProcessed?.summary) {
    prompt += `\n\nDATA INTELLIGENCE:\n${preProcessed.summary}`;
  } else if (profile.engagement) {
    prompt += `\nEngagement: ${profile.engagement.engagementRate}% ER (${profile.engagement.postsAnalyzed} posts)`;
  }

  const contentSample = profile.latestPosts?.slice(0, 3).map(p => 
    `"${p.caption?.slice(0, 50)}..." (${p.likesCount}♡ ${p.commentsCount}💬)`
  ).join(' | ') || 'No posts';
  
  prompt += `\nContent Sample: ${contentSample}`;

  prompt += `\n\nExtract observable demographics, psychographics, pain_points, dreams_desires from visible data only.
Score partnership viability for ${business.business_name} (${business.business_one_liner || business.target_audience}).
Return JSON with xray_payload structure including deep_summary, copywriter_profile, commercial_intelligence, persuasion_strategy.`;

  return prompt;
}

export function buildMarketCompletionPrompt(
  profile: ProfileData,
  business: BusinessProfile, 
  stage1Result: any
): string {
  return `# X-RAY STAGE 2: Market Research Completion

## STAGE 1 OBSERVABLE DATA
${JSON.stringify(stage1Result, null, 2)}

## BUSINESS CONTEXT
- **Industry**: ${business.industry || 'Business tools/education'}
- **Target**: ${business.target_audience}
- **Niche**: Copywriting education / faith-forward entrepreneurship

## TASK: Complete Client Brief Using Industry Knowledge

Fill missing demographic/market data using copywriting education industry standards:

### COMPLETE DEMOGRAPHICS
Age Range, Gender Identity, Income Level, Professional Background, Education Level, Family Status, Geographic Location, Cultural Background, Values & Beliefs, Social Status

### COMPLETE PSYCHOGRAPHICS  
Core Personality Traits, Hobbies & Interests, Day-to-Day Routines, Media Consumption, Buying Psychology, Decision-Making Style, Community & Social Circles

### ADD MARKET RESEARCH SECTIONS
**current_struggles**: Daily operational challenges for copywriting educators
**night_worries**: Income/reputation concerns for online course creators
**worst_case_scenarios**: Business failure fears in education space
**ideal_outcomes**: Success definitions for copywriting educators
**aspirational_goals**: Wealth/lifestyle goals beyond immediate business
**emotional_rewards**: Recognition/impact satisfaction drivers
**one_big_promise**: Typical transformation copywriting educators offer
**existing_solution_gaps**: Current market problems in copywriting education
**product_service_details**: Standard offering structures for this niche
**key_benefits**: Common value propositions for copywriting tools
**common_objections**: Price/trust/time concerns for educators
**implementation_concerns**: Technical/workflow adoption barriers
**time_commitment_worries**: Bandwidth concerns for content creators

Base responses on industry standards for copywriting education market, not profile speculation.

Return complete expanded profile with all sections filled.`;
}
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

export function buildDeepSummaryPrompt(
  profile: ProfileData, 
  business: BusinessProfile, 
  analysis: any
): string {
  return `# EXECUTIVE ANALYSIS SUMMARY

## PROFILE OVERVIEW
- **Influencer**: @${profile.username} (${profile.displayName || 'N/A'})
- **Audience**: ${profile.followersCount.toLocaleString()} followers
- **Verification**: ${profile.isVerified ? 'Verified' : 'Unverified'}
- **Engagement Rate**: ${profile.engagement?.engagementRate || 'Unknown'}%
- **Bio**: "${profile.bio || 'No bio available'}"

## BUSINESS CONTEXT
- **Company**: ${business.business_name}
- **Industry**: ${business.business_niche}
- **Business Summary**: ${business.business_one_liner || business.target_audience}
- **Target Market**: ${business.target_audience}

## ANALYSIS RESULTS
- **Overall Score**: ${analysis.score}/100
- **Engagement Score**: ${analysis.engagement_score}/100  
- **Niche Fit**: ${analysis.niche_fit}/100
- **Audience Quality**: ${analysis.audience_quality}

## TASK
Write a 5-7 sentence executive summary that covers:
1. Profile overview and key metrics
2. Audience quality assessment
3. Business alignment and partnership potential
4. Key opportunities or concerns
5. Strategic recommendation

Be specific, actionable, and executive-level. No preface or conclusion needed.`;
}

// Add these functions to the END of prompts.ts

// ===============================================================================
// TRIAGE FUNCTIONS
// ===============================================================================

export function getTriageJsonSchema() {
  return {
    name: 'TriageResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lead_score: { type: 'integer', minimum: 0, maximum: 100 },
        data_richness: { type: 'integer', minimum: 0, maximum: 100 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        early_exit: { type: 'boolean' },
        focus_points: { 
          type: 'array', 
          items: { type: 'string' }, 
          minItems: 2, 
          maxItems: 4 
        }
      },
      required: ['lead_score', 'data_richness', 'confidence', 'early_exit', 'focus_points']
    }
  };
}

export function buildTriagePrompt(snapshot: any, businessOneLiner: string): string {
  return `TRIAGE: ${businessOneLiner}

@${snapshot.username} - ${snapshot.followers} followers
${snapshot.verified ? '✓' : ''}${snapshot.private ? 'Private' : 'Public'} | "${snapshot.bio_short || 'No bio'}"
Links: ${snapshot.external_domains.join(',') || 'None'}
Posts: ~${snapshot.posts_30d} recent
Content: ${snapshot.top_captions.slice(0, 2).map(cap => `"${cap.slice(0, 30)}"`).join(' | ') || 'None'}
Engagement: ${snapshot.engagement_signals ? `${snapshot.engagement_signals.avg_likes} likes avg` : 'Unknown'}

Score lead_score (0-100), data_richness (0-100), confidence (0-1), early_exit (bool), focus_points (2-4 items).
JSON only.`;
}

// ===============================================================================
// PREPROCESSOR FUNCTIONS
// ===============================================================================

export function getPreprocessorJsonSchema() {
  return {
    name: 'PreprocessorResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        posting_cadence: { type: 'string' },
        content_themes: { 
          type: 'array', 
          items: { type: 'string' },
          maxItems: 5
        },
        audience_signals: { 
          type: 'array', 
          items: { type: 'string' },
          maxItems: 4
        },
        brand_mentions: { 
          type: 'array', 
          items: { type: 'string' }
        },
        engagement_patterns: { type: 'string' },
        collaboration_history: { type: 'string' },
        contact_readiness: { type: 'string' },
        content_quality: { type: 'string' }
      },
      required: ['posting_cadence', 'content_themes', 'audience_signals', 'brand_mentions', 'engagement_patterns', 'collaboration_history', 'contact_readiness', 'content_quality']
    }
  };
}

export function buildPreprocessorPrompt(profile: any): string {
  const posts = profile.latestPosts?.slice(0, 4).map(p => 
    `"${p.caption?.slice(0, 60)}..." (${p.likesCount}♡)`
  ).join(' | ') || 'No posts';

  return `DATA EXTRACT: @${profile.username}

${profile.followersCount} followers | ${profile.isBusinessAccount ? 'Business' : 'Personal'}
Bio: "${profile.bio || 'None'}"
Link: ${profile.externalUrl ? 'Yes' : 'No'}
Engagement: ${profile.engagement?.engagementRate || 'Unknown'}%
Posts: ${posts}

Extract posting_cadence, content_themes, audience_signals, brand_mentions, engagement_patterns, collaboration_history, contact_readiness, content_quality.
JSON only.`;
}

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
    contentSample = profile.latestPosts.slice(0, 6).map((p, i) => 
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
