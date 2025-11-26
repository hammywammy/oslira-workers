// infrastructure/extraction/lead-analysis.service.ts

/**
 * LEAD ANALYSIS SERVICE
 *
 * AI-powered lead qualification and analysis using GPT-5.
 * Analyzes ICP profiles against business context to generate
 * personalized insights and outreach recommendations.
 *
 * Process:
 * 1. Receive CalculatedMetrics + BusinessContext
 * 2. Build comprehensive prompt with metrics and context
 * 3. Call GPT-5 via AI Gateway with structured output
 * 4. Return AIResponsePayload for database storage
 *
 * Output is stored in the ai_response JSONB column.
 */

import type { Env } from '@/shared/types/env.types';
import { logger } from '@/shared/utils/logger.util';
import {
  formatAbbreviated,
  formatPercentage,
  formatCount
} from '@/shared/utils/number-format.util';
import { AIGatewayClient, type AIResponse } from '@/infrastructure/ai/ai-gateway.client';
import type {
  CalculatedMetrics,
  BusinessContext,
  AILeadAnalysis,
  AIResponsePayload,
  TextDataForAI
} from './extraction.types';

// ============================================================================
// CONSTANTS
// ============================================================================

export const LEAD_ANALYSIS_MODEL = 'gpt-5';
const MAX_OUTPUT_TOKENS = 4000;

// ============================================================================
// TOOL SCHEMA FOR STRUCTURED OUTPUT
// ============================================================================

/**
 * JSON Schema for GPT-5 tool calling
 * Ensures consistent structured output format
 */
const LEAD_ANALYSIS_TOOL_SCHEMA = {
  name: 'submit_lead_analysis',
  description: 'Submit the lead analysis results with qualification tier, insights, and recommendations.',
  parameters: {
    type: 'object',
    properties: {
      leadTier: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description: 'Lead qualification tier based on fit with business services'
      },
      summary: {
        type: 'string',
        description: 'Brief 2-3 sentence summary of the ICP profile and their fit'
      },
      strengths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key strengths identified in the ICP (3-5 items)'
      },
      weaknesses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Areas where the ICP could improve (3-5 items)'
      },
      opportunities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific opportunities to pitch business services (3-5 items)'
      },
      outreachHooks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Personalized conversation starters based on ICP content (3-5 items)'
      },
      recommendedActions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recommended next steps for the business (2-4 items)'
      },
      riskFactors: {
        type: 'array',
        items: { type: 'string' },
        description: 'Risk factors to consider when pursuing this lead (1-3 items)'
      },
      fitReasoning: {
        type: 'string',
        description: 'Detailed explanation of why this ICP is/isn\'t a good fit (2-4 sentences)'
      },
      partnershipAssessment: {
        type: 'string',
        description: 'Quick, conversational partnership summary for salespeople (4-6 sentences). Use clear, direct business language WITHOUT excessive metrics or jargon. Cover: brief content/engagement observation, ICP fit analysis, alignment with value proposition, red flags or positive signals, and a clear pursue/don\'t pursue recommendation with rationale.'
      }
    },
    required: [
      'leadTier',
      'summary',
      'strengths',
      'weaknesses',
      'opportunities',
      'outreachHooks',
      'recommendedActions',
      'riskFactors',
      'fitReasoning',
      'partnershipAssessment'
    ],
    additionalProperties: false
  }
};

// ============================================================================
// SERVICE
// ============================================================================

export interface LeadAnalysisInput {
  calculatedMetrics: CalculatedMetrics;
  textData: TextDataForAI;
  businessContext: BusinessContext;
}

export interface LeadAnalysisResult {
  success: true;
  data: AIResponsePayload;
}

export interface LeadAnalysisError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
}

export type LeadAnalysisOutput = LeadAnalysisResult | LeadAnalysisError;

/**
 * Analyze an ICP profile against business context using GPT-5
 */
export async function analyzeLeadWithAI(
  input: LeadAnalysisInput,
  env: Env,
  openaiKey: string,
  claudeKey: string,
  aiGatewayToken: string
): Promise<LeadAnalysisOutput> {
  const startTime = Date.now();

  logger.info('[LeadAnalysis] Starting AI analysis', {
    username: input.calculatedMetrics.raw.username,
    businessName: input.businessContext.businessName,
    sampleSize: input.calculatedMetrics.sampleSize
  });

  try {
    // Build prompts
    const systemPrompt = buildSystemPrompt(input.businessContext);
    const userPrompt = buildUserPrompt(input.calculatedMetrics, input.textData);

    // Create AI client
    const aiClient = new AIGatewayClient(
      env,
      openaiKey,
      claudeKey,
      aiGatewayToken
    );

    // Call GPT-5 with structured output
    // OPTIMIZATION: Use 'medium' reasoning effort to reduce reasoning tokens
    // This balances analysis quality with speed/cost:
    // - 'high': ~2500 reasoning tokens, ~70s (default if not specified)
    // - 'medium': ~1000-1500 reasoning tokens, ~40-50s (target)
    // - 'low': May degrade analysis quality for complex profiles
    const response = await aiClient.callStructured({
      model: LEAD_ANALYSIS_MODEL,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: 'medium',
      tool_schema: LEAD_ANALYSIS_TOOL_SCHEMA
    });

    // Validate response structure
    const analysis = response.content as AILeadAnalysis;

    if (!isValidAnalysis(analysis)) {
      logger.error('[LeadAnalysis] Invalid analysis structure', {
        content: response.content
      });
      throw new Error('GPT-5 returned invalid analysis structure');
    }

    // Build response payload
    const payload: AIResponsePayload = {
      version: '1.0',
      analyzedAt: new Date().toISOString(),
      model: LEAD_ANALYSIS_MODEL,
      tokenUsage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cost: response.usage.total_cost
      },
      analysis
    };

    const processingTime = Date.now() - startTime;

    logger.info('[LeadAnalysis] Analysis complete', {
      username: input.calculatedMetrics.raw.username,
      leadTier: analysis.leadTier,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      cost: response.usage.total_cost,
      processingTimeMs: processingTime
    });

    return {
      success: true,
      data: payload
    };

  } catch (error: any) {
    const processingTime = Date.now() - startTime;

    logger.error('[LeadAnalysis] Analysis failed', {
      username: input.calculatedMetrics.raw.username,
      error: error.message,
      processingTimeMs: processingTime
    });

    return {
      success: false,
      error: {
        code: 'AI_ANALYSIS_FAILED',
        message: error.message,
        details: {
          model: LEAD_ANALYSIS_MODEL,
          processingTimeMs: processingTime
        }
      }
    };
  }
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

/**
 * Build system prompt with business context
 */
function buildSystemPrompt(business: BusinessContext): string {
  return `You are an expert lead qualification analyst for social media marketing services.

## Your Role
Analyze Instagram profiles (ICPs - Ideal Customer Profiles) to determine if they would benefit from our client's services. Provide actionable insights for sales outreach.

## Business Context
**Business Name:** ${business.businessName}
**Industry:** ${business.industry}
**Target Audience:** ${business.targetAudience}
**Value Proposition:** ${business.valueProposition}
**Pain Points We Solve:** ${business.painPoints.join(', ')}
**ICP Follower Range:** ${business.icpMinFollowers.toLocaleString()} - ${business.icpMaxFollowers ? business.icpMaxFollowers.toLocaleString() : 'unlimited'}

## Lead Qualification Criteria

### HOT Lead (High Priority)
- Clear alignment with our services
- Obvious gaps we can fill
- Decent engagement foundation to build on
- Shows business intent (external links, business account)
- Active posting indicates commitment

### WARM Lead (Medium Priority)
- Some alignment with our services
- Room for improvement we can help with
- May need education on value proposition
- Inconsistent but salvageable engagement

### COLD Lead (Low Priority)
- Poor fit for our services
- Very low engagement or fake follower indicators
- Inactive or abandoned accounts
- Already highly optimized (no need for our help)

## Analysis Guidelines
1. Be specific and actionable - avoid generic advice
2. Reference actual metrics when explaining reasoning
3. Identify 3-5 personalized outreach hooks based on their content
4. Consider both opportunities AND risks
5. Be honest about fit - not every lead is a good one

## Partnership Assessment Summary (IMPORTANT)
Write a 4-6 sentence conversational summary that salespeople can quickly read and act on WITHOUT needing to analyze metrics themselves.
- Use clear, direct business language - NOT technical jargon or metric-heavy analysis
- Structure: (1) Brief content/engagement observation, (2) ICP fit analysis (compare to target follower range), (3) Alignment with value proposition (signals of needing our product), (4) Red flags or positive signals, (5) Clear recommendation with brief rationale
- Example tone: "While engagement is strong with 955K average likes per post, the content focuses on creator spotlights rather than B2B topics. The profile's 697M followers far exceeds the ICP range of 0-100K for startup agencies. Recent posts show no signals of CRM needs or lead research pain points. Recommendation: do not pursue; focus instead on small B2B agencies with bios mentioning outbound or lead generation."`;
}

/**
 * Build user prompt with ICP metrics and content
 */
function buildUserPrompt(metrics: CalculatedMetrics, textData: TextDataForAI): string {
  const { raw, scores, gaps } = metrics;

  // Format key metrics
  const metricsSection = `## Profile Metrics

### Audience
- Followers: ${formatNumber(raw.followersCount)}
- Following: ${formatNumber(raw.followsCount)}
- Authority Ratio: ${raw.authorityRatio?.toFixed(2) ?? 'N/A'}
- Total Posts: ${raw.postsCount}

### Engagement (from ${metrics.sampleSize} recent posts)
- Engagement Rate: ${formatPercentage(raw.engagementRate)}
- Avg Likes/Post: ${formatNumber(raw.avgLikesPerPost)}
- Avg Comments/Post: ${raw.avgCommentsPerPost?.toFixed(1) ?? 'N/A'}
- Comment-to-Like Ratio: ${raw.commentToLikeRatio?.toFixed(3) ?? 'N/A'}
- Engagement Consistency: ${raw.engagementConsistency?.toFixed(1) ?? 'N/A'}/100

### Posting Behavior
- Posts/Month: ${raw.postingFrequency?.toFixed(1) ?? 'N/A'}
- Days Since Last Post: ${raw.daysSinceLastPost ?? 'N/A'}
- Posting Consistency: ${raw.postingConsistency?.toFixed(1) ?? 'N/A'}/100

### Content Strategy
- Dominant Format: ${raw.dominantFormat ?? 'N/A'}
- Reels Rate: ${formatPercentage(raw.reelsRate)}
- Avg Hashtags/Post: ${raw.avgHashtagsPerPost?.toFixed(1) ?? 'N/A'}
- Avg Caption Length: ${raw.avgCaptionLength?.toFixed(0) ?? 'N/A'} chars
- Location Tagging Rate: ${formatPercentage(raw.locationTaggingRate)}

### Profile Features
- Business Account: ${raw.isBusinessAccount ? 'Yes' : 'No'}
- Verified: ${raw.verified ? 'Yes' : 'No'}
- Has External Link: ${raw.hasExternalLink ? 'Yes' : 'No'}
- Has Bio: ${raw.hasBio ? 'Yes' : 'No'}
- Highlight Reels: ${raw.highlightReelCount}`;

  // Format composite scores
  // NOTE: Profile Health Score measures ACCOUNT QUALITY, not business fit
  const scoresSection = `## Composite Scores (0-100)
- Engagement Health: ${scores.engagementHealth}
- Content Sophistication: ${scores.contentSophistication}
- Account Maturity: ${scores.accountMaturity}
- Fake Follower Risk: ${scores.fakeFollowerRisk}
- **Profile Health Score: ${scores.profileHealthScore}** (measures account quality, NOT business fit)`;

  // Format gap detection
  const gapsSection = `## Detected Gaps
${gaps.engagementGap ? '- ENGAGEMENT GAP: Low engagement rate despite audience size' : ''}
${gaps.contentGap ? '- CONTENT GAP: Basic content strategy (low hashtags, short captions, or missing locations)' : ''}
${gaps.conversionGap ? '- CONVERSION GAP: No external links despite business potential' : ''}
${gaps.platformGap ? '- PLATFORM GAP: Under-utilizing Reels format' : ''}
${!gaps.engagementGap && !gaps.contentGap && !gaps.conversionGap && !gaps.platformGap ? '- No significant gaps detected' : ''}`;

  // Format content samples
  const contentSection = `## Content Samples

### Bio
${textData.biography || '(No bio)'}

### Recent Captions (excerpts)
${textData.recentCaptions.slice(0, 3).map((c, i) => `${i + 1}. "${truncate(c, 150)}"`).join('\n')}

### Top Hashtags Used
${textData.hashtagFrequency.slice(0, 10).map(h => `#${h.hashtag} (${h.count}x)`).join(', ') || '(None)'}

### Mentions
${textData.uniqueMentions.slice(0, 5).join(', ') || '(None)'}

### Locations Tagged
${textData.locationNames.slice(0, 5).join(', ') || '(None)'}`;

  return `Analyze this Instagram profile and determine lead qualification:

${metricsSection}

${scoresSection}

${gapsSection}

${contentSection}

Based on this data, provide your lead analysis using the submit_lead_analysis tool.`;
}

// ============================================================================
// HELPERS
// ============================================================================

// Note: formatNumber and formatPercentage are imported from @/shared/utils/number-format.util
// This ensures consistent formatting across the entire codebase

/**
 * Format large numbers with K/M suffixes for display
 * Uses centralized formatAbbreviated for consistent rounding
 */
function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  return formatAbbreviated(value, 1);
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Validate analysis response structure
 */
function isValidAnalysis(analysis: any): analysis is AILeadAnalysis {
  return (
    analysis &&
    typeof analysis.leadTier === 'string' &&
    ['hot', 'warm', 'cold'].includes(analysis.leadTier) &&
    typeof analysis.summary === 'string' &&
    Array.isArray(analysis.strengths) &&
    Array.isArray(analysis.weaknesses) &&
    Array.isArray(analysis.opportunities) &&
    Array.isArray(analysis.outreachHooks) &&
    Array.isArray(analysis.recommendedActions) &&
    Array.isArray(analysis.riskFactors) &&
    typeof analysis.fitReasoning === 'string' &&
    typeof analysis.partnershipAssessment === 'string'
  );
}

// Exports are already done via the const and function declarations above
