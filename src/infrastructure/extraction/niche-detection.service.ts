// infrastructure/extraction/niche-detection.service.ts

/**
 * NICHE DETECTION SERVICE
 *
 * Fast AI-powered niche detection for Instagram profiles.
 * Uses GPT-4o-mini for quick, cost-effective classification.
 *
 * Requirements:
 * - Must return 1-2 word niche (e.g., "fitness coach", "copywriter")
 * - Must be definitively sure - only assigns niches to clear business profiles
 * - Returns null for non-business or ambiguous profiles
 */

import type { Env } from '@/shared/types/env.types';
import { logger } from '@/shared/utils/logger.util';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';

// ============================================================================
// CONSTANTS
// ============================================================================

// Use GPT-4o-mini for fast, cheap niche detection
export const NICHE_DETECTION_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 150; // Small output, just need 1-2 words

// ============================================================================
// TOOL SCHEMA FOR STRUCTURED OUTPUT
// ============================================================================

/**
 * JSON Schema for GPT-4o-mini tool calling
 * Ensures consistent structured output format
 */
const NICHE_DETECTION_TOOL_SCHEMA = {
  name: 'submit_niche_detection',
  description: 'Submit the detected niche for the Instagram profile.',
  parameters: {
    type: 'object',
    properties: {
      niche: {
        type: 'string',
        description: 'The 1-2 word niche/profession (e.g., "fitness coach", "copywriter", "photographer"). ONLY provide if definitively sure this is a business/professional account. Use lowercase.'
      },
      confidence: {
        type: 'string',
        enum: ['high', 'low'],
        description: 'Confidence level: "high" if clearly a business/professional, "low" if personal/ambiguous/unclear'
      },
      reasoning: {
        type: 'string',
        description: 'Brief 1-sentence explanation of why this niche was assigned or why confidence is low'
      }
    },
    required: ['niche', 'confidence', 'reasoning'],
    additionalProperties: false
  }
};

// ============================================================================
// SERVICE
// ============================================================================

export interface NicheDetectionInput {
  username: string;
  displayName: string | null;
  biography: string;
  followersCount: number;
  isBusinessAccount: boolean;
  businessCategoryName: string | null;
  externalUrl: string | null;
  topHashtags: string[]; // Top 5 hashtags
  recentCaptions: string[]; // Top 3 captions
}

export interface NicheDetectionResult {
  success: true;
  niche: string | null; // null if confidence is low or not a business
  confidence: 'high' | 'low';
  reasoning: string;
}

export interface NicheDetectionError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
}

export type NicheDetectionOutput = NicheDetectionResult | NicheDetectionError;

/**
 * Detect the niche/profession of an Instagram profile using AI
 */
export async function detectNiche(
  input: NicheDetectionInput,
  env: Env,
  openaiKey: string,
  claudeKey: string,
  aiGatewayToken: string
): Promise<NicheDetectionOutput> {
  const startTime = Date.now();

  logger.info('[NicheDetection] Starting niche detection', {
    username: input.username,
    isBusinessAccount: input.isBusinessAccount,
    businessCategory: input.businessCategoryName
  });

  try {
    // Build prompts
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input);

    // Create AI client
    const aiClient = new AIGatewayClient(
      env,
      openaiKey,
      claudeKey,
      aiGatewayToken
    );

    // Call GPT-4o-mini with structured output (fast and cheap)
    const response = await aiClient.callStructured({
      model: NICHE_DETECTION_MODEL,
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      max_tokens: MAX_OUTPUT_TOKENS,
      tool_schema: NICHE_DETECTION_TOOL_SCHEMA
    });

    // Validate response structure
    const result = response.content as {
      niche: string;
      confidence: 'high' | 'low';
      reasoning: string;
    };

    if (!isValidNicheResult(result)) {
      logger.error('[NicheDetection] Invalid result structure', {
        content: response.content
      });
      throw new Error('AI returned invalid niche detection structure');
    }

    // Only return niche if confidence is high
    const finalNiche = result.confidence === 'high' ? result.niche : null;

    const processingTime = Date.now() - startTime;

    logger.info('[NicheDetection] Detection complete', {
      username: input.username,
      niche: finalNiche,
      confidence: result.confidence,
      reasoning: result.reasoning,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      cost: response.usage.total_cost,
      processingTimeMs: processingTime
    });

    return {
      success: true,
      niche: finalNiche,
      confidence: result.confidence,
      reasoning: result.reasoning
    };

  } catch (error: any) {
    const processingTime = Date.now() - startTime;

    logger.error('[NicheDetection] Detection failed', {
      username: input.username,
      error: error.message,
      processingTimeMs: processingTime
    });

    return {
      success: false,
      error: {
        code: 'NICHE_DETECTION_FAILED',
        message: error.message,
        details: {
          model: NICHE_DETECTION_MODEL,
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
 * Build system prompt for niche detection
 */
function buildSystemPrompt(): string {
  return `You are an expert at detecting the professional niche of Instagram profiles.

## Your Task
Analyze Instagram profiles and determine their professional niche/industry in 1-2 words.

## Rules
1. **Be Selective**: ONLY assign a niche if you are DEFINITIVELY SURE this is a business or professional account
2. **Be Specific**: Use 1-2 words maximum (e.g., "fitness coach", "copywriter", "photographer", "real estate agent")
3. **Use Lowercase**: Always return niche in lowercase
4. **High Confidence**: Only mark confidence as "high" if the profile clearly shows:
   - Professional/business content
   - Clear service offering or expertise
   - Business-oriented language in bio
   - Professional hashtags or external links

5. **Low Confidence**: Mark confidence as "low" if:
   - Personal account (random posts, no clear business focus)
   - Ambiguous or unclear niche
   - Mixed content with no clear professional focus
   - Influencer/celebrity with no specific business offering
   - Insufficient information to determine niche

## Examples of Good Niches
- "fitness coach"
- "copywriter"
- "photographer"
- "real estate agent"
- "graphic designer"
- "social media manager"
- "nutritionist"
- "business coach"
- "makeup artist"
- "web developer"

## Examples of Low Confidence (DO NOT assign niche)
- Personal lifestyle accounts
- Random meme pages
- Ambiguous influencers
- Accounts with mixed unrelated content
- Fan pages
- Personal blogs without clear business focus`;
}

/**
 * Build user prompt with profile data
 */
function buildUserPrompt(input: NicheDetectionInput): string {
  const hashtagsText = input.topHashtags.length > 0
    ? input.topHashtags.map(h => `#${h}`).join(' ')
    : '(No hashtags)';

  const captionsText = input.recentCaptions.length > 0
    ? input.recentCaptions.slice(0, 3).map((c, i) => `${i + 1}. "${truncate(c, 100)}"`).join('\n')
    : '(No captions)';

  return `Analyze this Instagram profile and detect their professional niche:

## Profile Information
**Username:** @${input.username}
**Display Name:** ${input.displayName || '(None)'}
**Followers:** ${input.followersCount.toLocaleString()}
**Is Business Account:** ${input.isBusinessAccount ? 'Yes' : 'No'}
**Business Category:** ${input.businessCategoryName || '(None)'}
**External Link:** ${input.externalUrl || '(None)'}

## Bio
${input.biography || '(No bio)'}

## Top Hashtags
${hashtagsText}

## Recent Captions (excerpts)
${captionsText}

**Your Task**: Detect the 1-2 word professional niche of this profile. ONLY assign a niche if you are DEFINITIVELY SURE this is a business or professional account. If it's a personal account, random content, or unclear, mark confidence as "low" and provide a generic niche placeholder like "personal" or "lifestyle".`;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Validate niche detection result structure
 */
function isValidNicheResult(result: any): boolean {
  return (
    result &&
    typeof result.niche === 'string' &&
    typeof result.confidence === 'string' &&
    ['high', 'low'].includes(result.confidence) &&
    typeof result.reasoning === 'string'
  );
}
