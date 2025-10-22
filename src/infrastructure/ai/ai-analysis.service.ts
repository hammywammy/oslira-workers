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
 * Executes AI analysis for all three tiers:
 * - LIGHT: Quick fit assessment (gpt-5-nano, 6s avg)
 * - DEEP: Detailed analysis + outreach (gpt-5-mini, 12-18s avg)
 * - XRAY: Psychographic deep dive (gpt-5, 16-18s avg)
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
  niche_fit_score: number;
  engagement_score: number;
  confidence_level: number;
  summary_text: string;
  key_strengths: string[];
  red_flags: string[];
  recommended_action: 'pursue' | 'maybe' | 'skip';
  
  // Metadata
  model_used: string;
  total_cost: number;
  input_tokens: number;
  output_tokens: number;
}

export interface DeepAnalysisResult extends LightAnalysisResult {
  audience_quality_score: number;
  content_quality_score: number;
  improvement_areas: string[];
  partnership_opportunities: string[];
  outreach_angles: string[];
  urgency_level: 'high' | 'medium' | 'low';
  outreach_message: string; // Generated separately
}

export interface XRayAnalysisResult extends DeepAnalysisResult {
  psychographic_fit_score: number;
  personality_traits: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  communication_style: 'direct' | 'diplomatic' | 'emotional' | 'analytical';
  motivation_drivers: string[];
  decision_making_style: 'analytical' | 'intuitive' | 'collaborative' | 'decisive';
  psychological_hooks: string[];
  outreach_strategy: string;
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
      max_tokens: 800,
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
  // DEEP ANALYSIS
  // ===============================================================================

  async executeDeepAnalysis(
    business: BusinessProfile,
    profile: ProfileData
  ): Promise<DeepAnalysisResult> {
    // Step 1: Core analysis
    const prompts = this.promptBuilder.buildDeepAnalysisPrompt(business, profile);

    const coreResponse = await this.aiClient.call({
      model: 'gpt-5-mini',
      system_prompt: prompts.system,
      user_prompt: prompts.user,
      max_tokens: 1500,
      json_schema: this.getDeepAnalysisSchema()
    });

    const coreParsed = typeof coreResponse.content === 'string'
      ? JSON.parse(coreResponse.content)
      : coreResponse.content;

    // Step 2: Generate outreach message (parallel would be ideal, but sequential for now)
    const outreachPrompts = this.promptBuilder.buildOutreachMessagePrompt(
      business,
      profile,
      coreParsed.summary_text
    );

    const outreachResponse = await this.aiClient.call({
      model: 'gpt-5-mini',
      system_prompt: outreachPrompts.system,
      user_prompt: outreachPrompts.user,
      max_tokens: 300
    });

    const outreachMessage = typeof outreachResponse.content === 'string'
      ? outreachResponse.content
      : JSON.stringify(outreachResponse.content);

    // Combine costs
    const totalCost = coreResponse.usage.total_cost + outreachResponse.usage.total_cost;
    const totalInputTokens = coreResponse.usage.input_tokens + outreachResponse.usage.input_tokens;
    const totalOutputTokens = coreResponse.usage.output_tokens + outreachResponse.usage.output_tokens;

    return {
      ...coreParsed,
      outreach_message: outreachMessage.trim(),
      model_used: coreResponse.model_used,
      total_cost: totalCost,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens
    };
  }

  // ===============================================================================
  // XRAY ANALYSIS
  // ===============================================================================

  async executeXRayAnalysis(
    business: BusinessProfile,
    profile: ProfileData
  ): Promise<XRayAnalysisResult> {
    // Step 1: Psychographic analysis
    const prompts = this.promptBuilder.buildXRayAnalysisPrompt(business, profile);

    const psychoResponse = await this.aiClient.call({
      model: 'gpt-5',
      system_prompt: prompts.system,
      user_prompt: prompts.user,
      max_tokens: 2500,
      reasoning_effort: 'medium',
      json_schema: this.getXRayAnalysisSchema()
    });

    const psychoParsed = typeof psychoResponse.content === 'string'
      ? JSON.parse(psychoResponse.content)
      : psychoResponse.content;

    // Step 2: Generate outreach message with psychographic insights
    const outreachPrompts = this.promptBuilder.buildOutreachMessagePrompt(
      business,
      profile,
      `${psychoParsed.summary_text}\n\nPsychographic Insights:\n- Communication Style: ${psychoParsed.communication_style}\n- Key Hooks: ${psychoParsed.psychological_hooks.join(', ')}`
    );

    const outreachResponse = await this.aiClient.call({
      model: 'gpt-5-mini', // Use mini for outreach generation (cost optimization)
      system_prompt: outreachPrompts.system,
      user_prompt: outreachPrompts.user,
      max_tokens: 300
    });

    const outreachMessage = typeof outreachResponse.content === 'string'
      ? outreachResponse.content
      : JSON.stringify(outreachResponse.content);

    // Combine costs
    const totalCost = psychoResponse.usage.total_cost + outreachResponse.usage.total_cost;
    const totalInputTokens = psychoResponse.usage.input_tokens + outreachResponse.usage.input_tokens;
    const totalOutputTokens = psychoResponse.usage.output_tokens + outreachResponse.usage.output_tokens;

    return {
      ...psychoParsed,
      outreach_message: outreachMessage.trim(),
      model_used: psychoResponse.model_used,
      total_cost: totalCost,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens
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
          niche_fit_score: { type: 'integer', minimum: 0, maximum: 100 },
          engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
          confidence_level: { type: 'integer', minimum: 0, maximum: 100 },
          summary_text: { type: 'string' },
          key_strengths: { type: 'array', items: { type: 'string' } },
          red_flags: { type: 'array', items: { type: 'string' } },
          recommended_action: { type: 'string', enum: ['pursue', 'maybe', 'skip'] }
        },
        required: [
          'overall_score',
          'niche_fit_score',
          'engagement_score',
          'confidence_level',
          'summary_text',
          'key_strengths',
          'red_flags',
          'recommended_action'
        ],
        additionalProperties: false
      }
    };
  }

  private getDeepAnalysisSchema() {
    return {
      name: 'deep_analysis',
      description: 'Comprehensive Instagram profile analysis',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          overall_score: { type: 'integer', minimum: 0, maximum: 100 },
          niche_fit_score: { type: 'integer', minimum: 0, maximum: 100 },
          engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
          audience_quality_score: { type: 'integer', minimum: 0, maximum: 100 },
          content_quality_score: { type: 'integer', minimum: 0, maximum: 100 },
          confidence_level: { type: 'integer', minimum: 0, maximum: 100 },
          summary_text: { type: 'string' },
          key_strengths: { type: 'array', items: { type: 'string' } },
          improvement_areas: { type: 'array', items: { type: 'string' } },
          partnership_opportunities: { type: 'array', items: { type: 'string' } },
          outreach_angles: { type: 'array', items: { type: 'string' } },
          recommended_action: { type: 'string', enum: ['pursue', 'maybe', 'skip'] },
          urgency_level: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: [
          'overall_score',
          'niche_fit_score',
          'engagement_score',
          'audience_quality_score',
          'content_quality_score',
          'confidence_level',
          'summary_text',
          'key_strengths',
          'improvement_areas',
          'partnership_opportunities',
          'outreach_angles',
          'recommended_action',
          'urgency_level'
        ],
        additionalProperties: false
      }
    };
  }

  private getXRayAnalysisSchema() {
    return {
      name: 'xray_analysis',
      description: 'Psychographic deep dive analysis',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          overall_score: { type: 'integer', minimum: 0, maximum: 100 },
          niche_fit_score: { type: 'integer', minimum: 0, maximum: 100 },
          engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
          audience_quality_score: { type: 'integer', minimum: 0, maximum: 100 },
          content_quality_score: { type: 'integer', minimum: 0, maximum: 100 },
          psychographic_fit_score: { type: 'integer', minimum: 0, maximum: 100 },
          confidence_level: { type: 'integer', minimum: 0, maximum: 100 },
          summary_text: { type: 'string' },
          personality_traits: {
            type: 'object',
            properties: {
              openness: { type: 'integer', minimum: 0, maximum: 100 },
              conscientiousness: { type: 'integer', minimum: 0, maximum: 100 },
              extraversion: { type: 'integer', minimum: 0, maximum: 100 },
              agreeableness: { type: 'integer', minimum: 0, maximum: 100 },
              neuroticism: { type: 'integer', minimum: 0, maximum: 100 }
            },
            required: ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'],
            additionalProperties: false
          },
          communication_style: { type: 'string', enum: ['direct', 'diplomatic', 'emotional', 'analytical'] },
          motivation_drivers: { type: 'array', items: { type: 'string' } },
          decision_making_style: { type: 'string', enum: ['analytical', 'intuitive', 'collaborative', 'decisive'] },
          psychological_hooks: { type: 'array', items: { type: 'string' } },
          outreach_strategy: { type: 'string' },
          recommended_action: { type: 'string', enum: ['pursue', 'maybe', 'skip'] },
          urgency_level: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: [
          'overall_score',
          'niche_fit_score',
          'engagement_score',
          'audience_quality_score',
          'content_quality_score',
          'psychographic_fit_score',
          'confidence_level',
          'summary_text',
          'personality_traits',
          'communication_style',
          'motivation_drivers',
          'decision_making_style',
          'psychological_hooks',
          'outreach_strategy',
          'recommended_action',
          'urgency_level'
        ],
        additionalProperties: false
      }
    };
  }
}
