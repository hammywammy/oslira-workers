// infrastructure/ai/ai-analysis.service.ts

import type { Env } from '@/shared/types/env.types';
import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';
import type { AIProfileData } from '@/shared/types/profile.types';
import { PromptBuilder } from './prompt-builder.service';
import { AIGatewayClient } from './ai-gateway.client';
import { getSecret } from '@/infrastructure/config/secrets';
import {
  type AnalysisType,
  getAIModel,
  getAIMaxTokens
} from '@/config/operations-pricing.config';

/**
 * AI ANALYSIS SERVICE
 *
 * MODULAR DESIGN:
 * - executeAnalysis() routes to correct execution based on analysis type
 * - Each type uses configuration from operations-pricing.config
 * - Deep analysis = same model, more tokens for longer output
 *
 * Analysis Types:
 * - LIGHT: Quick fit assessment (6s avg, 2-3 sentence summary)
 * - DEEP: In-depth assessment (12s avg, 4-6 sentence summary)
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
 * Unified analysis result type - works for all analysis types
 */
export interface AnalysisResult {
  overall_score: number;
  summary_text: string;

  // Metadata
  model_used: string;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

// Backward compatibility alias
export type LightAnalysisResult = AnalysisResult;

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

  async executeLightAnalysis(
    business: BusinessProfile,
    profile: AIProfileData,
    attempt: number = 1
  ): Promise<LightAnalysisResult> {
    const prompts = this.promptBuilder.buildLightAnalysisPrompt(business, profile);

    // =========================================================================
    // PROFILE ASSESSMENT AI (Light) - INPUT LOGGING
    // =========================================================================
    console.log('[ProfileAssessmentAI] Starting analysis', {
      analysisType: 'light',
      username: profile.username,
      businessName: business.business_name,
      followerCount: profile.follower_count,
      postsCount: profile.posts.length
    });

    // Increase tokens on retry
    const maxTokens = attempt === 1 ? 800 : 1200;

    try {
      const response = await this.aiClient.call({
        model: 'gpt-5-nano',
        system_prompt: prompts.system,
        user_prompt: prompts.user,
        max_tokens: maxTokens,
        reasoning_effort: 'low',
        json_schema: this.getLightAnalysisSchema()
      });

      // Parse response
      const parsed = typeof response.content === 'string'
        ? JSON.parse(response.content)
        : response.content;

      const result = {
        ...parsed,
        model_used: response.model_used,
        total_cost: response.usage.total_cost,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      };

      // Log AI response
      console.log('[ProfileAssessmentAI] Analysis complete', {
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
        console.warn(`[AIAnalysis] Parse failed on attempt ${attempt}, retrying with more tokens`);
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
   * Same model as light, but with 2x output tokens for longer summary
   * Uses deep prompt configuration for extended analysis
   */
  async executeDeepAnalysis(
    business: BusinessProfile,
    profile: AIProfileData,
    attempt: number = 1
  ): Promise<AnalysisResult> {
    const prompts = this.promptBuilder.buildDeepAnalysisPrompt(business, profile);
    const model = getAIModel('deep');
    const baseMaxTokens = getAIMaxTokens('deep');

    // Profile Assessment AI (Deep) - Structured logging
    console.log('[ProfileAssessmentAI] Starting deep analysis', {
      username: profile.username,
      businessName: business.business_name,
      followerCount: profile.follower_count,
      postsCount: profile.posts.length,
      model,
      maxTokens: baseMaxTokens,
      promptLength: prompts.user.length
    });

    // Increase tokens on retry
    const maxTokens = attempt === 1 ? baseMaxTokens : baseMaxTokens * 1.5;

    try {
      const response = await this.aiClient.call({
        model,
        system_prompt: prompts.system,
        user_prompt: prompts.user,
        max_tokens: maxTokens,
        reasoning_effort: 'low',
        json_schema: this.getDeepAnalysisSchema()
      });

      // Parse response
      const parsed = typeof response.content === 'string'
        ? JSON.parse(response.content)
        : response.content;

      const result = {
        ...parsed,
        model_used: response.model_used,
        total_cost: response.usage.total_cost,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      };

      // Log AI response
      console.log('[ProfileAssessmentAI] Analysis complete', {
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
