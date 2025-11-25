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
  // LIGHT ANALYSIS
  // ===============================================================================

  async executeLightAnalysis(
    business: BusinessProfile,
    profile: ProfileData,
    attempt: number = 1
  ): Promise<LightAnalysisResult> {
    const prompts = this.promptBuilder.buildLightAnalysisPrompt(business, profile);

    // =========================================================================
    // COMPREHENSIVE LOGGING - Shows ALL data fed to AI
    // =========================================================================
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🤖 AI ANALYSIS INPUT - Full Context Preview');
    console.log('═══════════════════════════════════════════════════════════════');

    // Log business data extraction
    const context = business.business_context || {};
    const icp = business.ideal_customer_profile || {};

    console.log('📊 BUSINESS DATA (from database):');
    console.log('  • business_name:', business.business_name || 'MISSING');
    console.log('  • full_name:', business.full_name || 'MISSING');
    console.log('  • business_one_liner:', business.business_one_liner || 'MISSING');
    console.log('  • business_summary_generated:', business.business_summary_generated || 'MISSING');

    console.log('\n📦 business_context (JSONB):');
    console.log('  • business_summary:', context.business_summary || 'MISSING');
    console.log('  • communication_tone:', context.communication_tone || 'MISSING');
    console.log('  • target_description:', context.target_description || 'MISSING');
    console.log('  • icp_min_followers:', context.icp_min_followers || 'MISSING');
    console.log('  • icp_max_followers:', context.icp_max_followers || 'MISSING');
    console.log('  • target_company_sizes:', context.target_company_sizes || 'MISSING');

    console.log('\n🎯 ideal_customer_profile (JSONB):');
    console.log('  • target_audience:', icp.target_audience || 'MISSING');
    console.log('  • brand_voice:', icp.brand_voice || 'MISSING');
    console.log('  • icp_min_followers:', icp.icp_min_followers || 'MISSING');
    console.log('  • icp_max_followers:', icp.icp_max_followers || 'MISSING');

    console.log('\n📝 PROFILE DATA:');
    console.log('  • username:', profile.username);
    console.log('  • follower_count:', profile.follower_count.toLocaleString());
    console.log('  • bio:', (profile.bio || 'No bio').substring(0, 100));
    console.log('  • posts:', profile.posts.length);

    console.log('\n🎨 PROMPTS SENT TO AI:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('SYSTEM PROMPT:');
    console.log(prompts.system);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('USER PROMPT (first 500 chars):');
    console.log(prompts.user.substring(0, 500) + '...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('USER PROMPT (full length):', prompts.user.length, 'characters');
    console.log('═══════════════════════════════════════════════════════════════\n');

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
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('✅ AI ANALYSIS OUTPUT');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('📊 Result:');
      console.log('  • overall_score:', result.overall_score);
      console.log('  • summary_text:', result.summary_text);
      console.log('  • model_used:', result.model_used);
      console.log('  • total_cost: $' + result.total_cost.toFixed(6));
      console.log('  • tokens:', result.input_tokens, 'in /', result.output_tokens, 'out');
      console.log('═══════════════════════════════════════════════════════════════\n');

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
