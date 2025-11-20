// infrastructure/ai/ai-analysis.service.ts

import type { Env } from '@/shared/types/env.types';
import type { BusinessProfile } from '@/infrastructure/database/repositories/business.repository';
import type { ProfileData } from './prompt-builder.service';
import { PromptBuilder } from './prompt-builder.service';
import { AIGatewayClient } from './ai-gateway.client';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * AI ANALYSIS SERVICE
 *
 * Executes Light Analysis only:
 * - LIGHT: Quick fit assessment (gpt-5-nano, 6s avg)
 * - Returns only overall_score + summary_text
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

export interface LightAnalysisResult {
  overall_score: number;
  summary_text: string;

  // Metadata
  model_used: string;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

// ===============================================================================
// SERVICE
// ===============================================================================

export class AIAnalysisService {
  private promptBuilder: PromptBuilder;
  private aiClient: AIGatewayClient;

  constructor(env: Env, openaiKey: string, claudeKey: string) {
    this.promptBuilder = new PromptBuilder();
    this.aiClient = new AIGatewayClient(env, openaiKey, claudeKey);
  }

  /**
   * Factory method to create service with secrets
   */
  static async create(env: Env): Promise<AIAnalysisService> {
    const openaiKey = await getSecret('OPENAI_API_KEY', env, env.APP_ENV);
    const claudeKey = await getSecret('ANTHROPIC_API_KEY', env, env.APP_ENV);

    return new AIAnalysisService(env, openaiKey, claudeKey);
  }

  // ===============================================================================
  // LIGHT ANALYSIS
  // ===============================================================================

  async executeLightAnalysis(
    business: BusinessProfile,
    profile: ProfileData
  ): Promise<LightAnalysisResult> {
    const prompts = this.promptBuilder.buildLightAnalysisPrompt(business, profile);

    const response = await this.aiClient.call({
      model: 'gpt-5-nano',
      system_prompt: prompts.system,
      user_prompt: prompts.user,
      max_tokens: 400,
      reasoning_effort: 'low',
      json_schema: this.getLightAnalysisSchema()
    });

    const parsed = typeof response.content === 'string'
      ? JSON.parse(response.content)
      : response.content;

    return {
      ...parsed,
      model_used: response.model_used,
      total_cost: response.usage.total_cost,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens
    };
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
}
