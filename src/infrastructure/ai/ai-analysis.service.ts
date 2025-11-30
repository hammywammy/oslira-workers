// infrastructure/ai/ai-analysis.service.ts

import type { Env } from '@/shared/types/env.types';
import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';
import type { AIProfileData } from '@/shared/types/profile.types';
import { PromptBuilder } from './prompt-builder.service';
import { AIGatewayClient } from './ai-gateway.client';
import { getSecret } from '@/infrastructure/config/secrets';
import {
  type AnalysisType,
  getAnalysisConfig,
  ANALYSIS_TYPES
} from '@/config/analysis-types.config';

/**
 * AI ANALYSIS SERVICE
 *
 * MODULAR DESIGN:
 * - executeAnalysis() routes to correct execution based on analysis type
 * - Each type uses configuration from analysis-types.config
 * - Light analysis = quick score + brief summary (NO detailed recommendations)
 * - Deep analysis = comprehensive analysis with detailed insights
 *
 * Analysis Types:
 * - LIGHT: Quick fit assessment (~15s avg, score + 2-3 sentence summary)
 *   - Returns: overall_score, summary_text
 *   - NO: leadTier, strengths, weaknesses, recommendations
 *
 * - DEEP: In-depth assessment (~45s avg, 4-6 sentence summary)
 *   - Returns: overall_score, summary_text (detailed)
 *   - Phase 2 AI adds: leadTier, strengths, opportunities, recommendedActions
 *
 * Features:
 * - Prompt caching on business context (30-40% cost savings)
 * - Structured JSON responses
 * - Error handling + retry logic
 * - Cost tracking per call
 */

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

/**
 * Light analysis result - MINIMAL output
 * Only score and brief summary, no detailed recommendations
 */
export interface LightAnalysisResult {
  overall_score: number;
  summary_text: string;

  // Metadata
  model_used: string;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Deep analysis result - COMPREHENSIVE output
 * Score, detailed summary (Phase 2 AI adds leadTier, strengths, etc.)
 */
export interface DeepAnalysisResult {
  overall_score: number;
  summary_text: string;

  // Metadata
  model_used: string;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Unified analysis result type - works for all analysis types
 * Use discriminated union for type safety
 */
export type AnalysisResult = LightAnalysisResult | DeepAnalysisResult;

// ===============================================================================
// SERVICE
// ===============================================================================

export class AIAnalysisService {
  private promptBuilder: PromptBuilder;
  private aiClient: AIGatewayClient;

  constructor(env: Env, openaiKey: string, claudeKey: string, private aiGatewayToken: string) {
    this.promptBuilder = new PromptBuilder();
    this.aiClient = new AIGatewayClient(env, openaiKey, claudeKey, aiGatewayToken);
  }

  /**
   * Factory method to create service with secrets
   */
  static async create(env: Env): Promise<AIAnalysisService> {
    const openaiKey = await getSecret('OPENAI_API_KEY', env, env.APP_ENV);
    const claudeKey = await getSecret('ANTHROPIC_API_KEY', env, env.APP_ENV);
    const aiGatewayToken = await getSecret('CLOUDFLARE_AI_GATEWAY_TOKEN', env, env.APP_ENV);

    return new AIAnalysisService(env, openaiKey, claudeKey, aiGatewayToken);
  }

  // ===============================================================================
  // MODULAR ANALYSIS ROUTER
  // ===============================================================================

  /**
   * MODULAR: Execute analysis based on type
   * Routes to the correct execution method automatically
   */
  async executeAnalysis(
    analysisType: AnalysisType,
    business: BusinessProfile,
    profile: AIProfileData
  ): Promise<AnalysisResult> {
    switch (analysisType) {
      case 'light':
        return this.executeLightAnalysis(business, profile);
      case 'deep':
        return this.executeDeepAnalysis(business, profile);
      default:
        throw new Error(`Unknown analysis type: ${analysisType}`);
    }
  }

  // ===============================================================================
  // LIGHT ANALYSIS
  // ===============================================================================

  /**
   * LIGHT ANALYSIS
   * Quick fit assessment with minimal output:
   * - overall_score (0-100)
   * - summary_text (2-3 sentences)
   *
   * NO detailed recommendations, strengths, or lead qualification.
   * Uses gpt-5-nano for speed and cost efficiency.
   */
  async executeLightAnalysis(
    business: BusinessProfile,
    profile: AIProfileData,
    attempt: number = 1
  ): Promise<LightAnalysisResult> {
    const config = ANALYSIS_TYPES.light;
    const prompts = this.promptBuilder.buildLightAnalysisPrompt(business, profile);

    // =========================================================================
    // PROFILE ASSESSMENT AI (Light) - INPUT LOGGING
    // =========================================================================
    console.log('[ProfileAssessmentAI] Starting light analysis', {
      analysisType: 'light',
      username: profile.username,
      businessName: business.business_name,
      followerCount: profile.follower_count,
      postsCount: profile.posts.length,
      model: config.ai.model,
      maxTokens: config.ai.maxTokens
    });

    // Increase tokens on retry
    const maxTokens = attempt === 1 ? config.ai.maxTokens : config.ai.retryMaxTokens;

    try {
      const response = await this.aiClient.call({
        model: config.ai.model,
        system_prompt: prompts.system,
        user_prompt: prompts.user,
        max_tokens: maxTokens,
        reasoning_effort: config.ai.reasoningEffort,
        json_schema: this.getLightAnalysisSchema()
      });

      // Parse response
      const parsed = typeof response.content === 'string'
        ? JSON.parse(response.content)
        : response.content;

      const result: LightAnalysisResult = {
        overall_score: parsed.overall_score,
        summary_text: parsed.summary_text,
        model_used: response.model_used,
        total_cost: response.usage.total_cost,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      };

      // Log AI response
      console.log('[ProfileAssessmentAI] Light analysis complete', {
        overall_score: result.overall_score,
        summary_length: result.summary_text.length,
        model_used: result.model_used,
        total_cost: result.total_cost,
        tokens_in: result.input_tokens,
        tokens_out: result.output_tokens
      });

      return result;

    } catch (error: any) {
      // Retry on parse error (likely truncation)
      if (error.name === 'SyntaxError' && attempt < 3) {
        console.warn(`[AIAnalysis] Light parse failed on attempt ${attempt}, retrying with more tokens`);
        return this.executeLightAnalysis(business, profile, attempt + 1);
      }

      throw error;
    }
  }

  // ===============================================================================
  // DEEP ANALYSIS
  // ===============================================================================

  /**
   * DEEP ANALYSIS
   * Comprehensive fit assessment with detailed output:
   * - overall_score (0-100)
   * - summary_text (4-6 sentences with detailed reasoning)
   *
   * Phase 2 AI (run separately in workflow) adds:
   * - leadTier, strengths, opportunities, recommendedActions
   *
   * Uses more powerful model and tokens for extended analysis.
   */
  async executeDeepAnalysis(
    business: BusinessProfile,
    profile: AIProfileData,
    attempt: number = 1
  ): Promise<DeepAnalysisResult> {
    const config = ANALYSIS_TYPES.deep;
    const prompts = this.promptBuilder.buildDeepAnalysisPrompt(business, profile);

    // Profile Assessment AI (Deep) - Structured logging
    console.log('[ProfileAssessmentAI] Starting deep analysis', {
      analysisType: 'deep',
      username: profile.username,
      businessName: business.business_name,
      followerCount: profile.follower_count,
      postsCount: profile.posts.length,
      model: config.ai.model,
      maxTokens: config.ai.maxTokens,
      promptLength: prompts.user.length
    });

    // Increase tokens on retry
    const maxTokens = attempt === 1 ? config.ai.maxTokens : config.ai.retryMaxTokens;

    try {
      const response = await this.aiClient.call({
        model: config.ai.model,
        system_prompt: prompts.system,
        user_prompt: prompts.user,
        max_tokens: maxTokens,
        reasoning_effort: config.ai.reasoningEffort,
        json_schema: this.getDeepAnalysisSchema()
      });

      // Parse response
      const parsed = typeof response.content === 'string'
        ? JSON.parse(response.content)
        : response.content;

      const result: DeepAnalysisResult = {
        overall_score: parsed.overall_score,
        summary_text: parsed.summary_text,
        model_used: response.model_used,
        total_cost: response.usage.total_cost,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      };

      // Log AI response
      console.log('[ProfileAssessmentAI] Deep analysis complete', {
        overall_score: result.overall_score,
        summary_length: result.summary_text.length,
        model_used: result.model_used,
        total_cost: result.total_cost,
        tokens_in: result.input_tokens,
        tokens_out: result.output_tokens
      });

      return result;

    } catch (error: any) {
      // Retry on parse error (likely truncation)
      if (error.name === 'SyntaxError' && attempt < 3) {
        console.warn(`[AIAnalysis] Deep parse failed on attempt ${attempt}, retrying with more tokens`);
        return this.executeDeepAnalysis(business, profile, attempt + 1);
      }

      throw error;
    }
  }

  // ===============================================================================
  // JSON SCHEMAS (for structured output)
  // ===============================================================================

  private getLightAnalysisSchema() {
    return {
      name: 'light_analysis',
      description: 'Quick Instagram profile fit assessment',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          overall_score: { type: 'integer', minimum: 0, maximum: 100 },
          summary_text: { type: 'string' }
        },
        required: ['overall_score', 'summary_text'],
        additionalProperties: false
      }
    };
  }

  private getDeepAnalysisSchema() {
    return {
      name: 'deep_analysis',
      description: 'In-depth Instagram profile fit assessment with detailed analysis',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          overall_score: { type: 'integer', minimum: 0, maximum: 100 },
          summary_text: { type: 'string' }
        },
        required: ['overall_score', 'summary_text'],
        additionalProperties: false
      }
    };
  }
}
