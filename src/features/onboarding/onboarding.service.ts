// features/onboarding/onboarding.service.ts

import type { Env } from '@/shared/types/env.types';
import type { OnboardingFormData, BusinessContextResult } from '@/shared/types/business-context.types';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';
import { BusinessContextPromptBuilder } from './business-context-prompts.service';

/**
 * ONBOARDING SERVICE
 * 
 * Executes 4 parallel AI calls to generate business context:
 * 1. business_one_liner (140 char tagline) - uses business_summary
 * 2. business_summary_generated (4 sentences) - uses business_summary
 * 3. ideal_customer_profile (JSON format) - NO business_summary
 * 4. operational_metadata (JSON format) - uses business_summary
 * 
 * Features:
 * - All calls via AI Gateway (GPT-5)
 * - Parallel execution (Promise.all)
 * - Retry logic with exponential backoff
 * - Cost tracking
 */

export class OnboardingService {
  private aiClient: AIGatewayClient;
  private promptBuilder: BusinessContextPromptBuilder;

  constructor(env: Env, openaiKey: string, claudeKey: string) {
    this.aiClient = new AIGatewayClient(env, openaiKey, claudeKey);
    this.promptBuilder = new BusinessContextPromptBuilder();
  }

  /**
   * Generate complete business context (4 parallel AI calls)
   */
  async generateBusinessContext(
    userInputs: OnboardingFormData
  ): Promise<BusinessContextResult> {
    const startTime = Date.now();

    console.log('[OnboardingService] Starting 4 parallel AI calls...');

    try {
      // Execute all 4 calls in parallel with retry logic
      const [oneLiner, summaryGenerated, icpJson, opMetadataJson] = await Promise.all([
        this.generateOneLinerWithRetry(userInputs),
        this.generateSummaryWithRetry(userInputs),
        this.generateICPJsonWithRetry(userInputs),
        this.generateOperationalJsonWithRetry(userInputs)
      ]);

      const totalTime = Date.now() - startTime;
      const totalTokens = 
        oneLiner.usage.input_tokens + oneLiner.usage.output_tokens +
        summaryGenerated.usage.input_tokens + summaryGenerated.usage.output_tokens +
        icpJson.usage.input_tokens + icpJson.usage.output_tokens +
        opMetadataJson.usage.input_tokens + opMetadataJson.usage.output_tokens;

      const totalCost = 
        oneLiner.usage.total_cost +
        summaryGenerated.usage.total_cost +
        icpJson.usage.total_cost +
        opMetadataJson.usage.total_cost;

      console.log('[OnboardingService] All AI calls complete:', {
        total_time_ms: totalTime,
        total_tokens: totalTokens,
        total_cost: totalCost.toFixed(4)
      });

      return {
        business_one_liner: oneLiner.content as string,
        business_summary_generated: summaryGenerated.content as string,
        ideal_customer_profile: icpJson.content,
        operational_metadata: opMetadataJson.content,
        ai_metadata: {
          model_used: 'gpt-5',
          total_tokens: totalTokens,
          total_cost: totalCost,
          generation_time_ms: totalTime
        }
      };

    } catch (error: any) {
      console.error('[OnboardingService] AI generation failed:', error);
      throw new Error(`Business context generation failed: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 1: Business One-Liner (with retry)
  // ===========================================================================

  private async generateOneLinerWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    try {
      return await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You are a copywriter creating concise business taglines. Maximum 140 characters.',
        user_prompt: this.promptBuilder.buildOneLinerPrompt(data),
        max_tokens: 50,
        temperature: 0.7
      });
    } catch (error: any) {
      if (attempt < 3) {
        console.warn(`[OnboardingService] One-liner attempt ${attempt} failed, retrying...`);
        await this.sleep(Math.pow(2, attempt) * 1000);
        return this.generateOneLinerWithRetry(data, attempt + 1);
      }
      throw error;
    }
  }

  // ===========================================================================
  // CALL 2: Business Summary Generated (with retry)
  // ===========================================================================

  private async generateSummaryWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    try {
      return await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You are a business writer creating polished 4-sentence descriptions.',
        user_prompt: this.promptBuilder.buildSummaryPrompt(data),
        max_tokens: 200,
        temperature: 0.5
      });
    } catch (error: any) {
      if (attempt < 3) {
        console.warn(`[OnboardingService] Summary attempt ${attempt} failed, retrying...`);
        await this.sleep(Math.pow(2, attempt) * 1000);
        return this.generateSummaryWithRetry(data, attempt + 1);
      }
      throw error;
    }
  }

  // ===========================================================================
  // CALL 3: Ideal Customer Profile JSON (with retry)
  // ===========================================================================

  private async generateICPJsonWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    try {
      return await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format user data into JSON. Never add data that wasn\'t provided. Never include business_summary in the output.',
        user_prompt: this.promptBuilder.buildICPJsonPrompt(data),
        max_tokens: 500,
        reasoning_effort: 'minimal',
        tool_schema: this.promptBuilder.getICPJsonSchema()
      });
    } catch (error: any) {
      if (attempt < 3) {
        console.warn(`[OnboardingService] ICP JSON attempt ${attempt} failed, retrying...`);
        await this.sleep(Math.pow(2, attempt) * 1000);
        return this.generateICPJsonWithRetry(data, attempt + 1);
      }
      throw error;
    }
  }

  // ===========================================================================
  // CALL 4: Operational Metadata JSON (with retry)
  // ===========================================================================

  private async generateOperationalJsonWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    try {
      return await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format user data into JSON. Never add data that wasn\'t provided. Always include business_summary in the output.',
        user_prompt: this.promptBuilder.buildOperationalJsonPrompt(data),
        max_tokens: 500,
        reasoning_effort: 'minimal',
        tool_schema: this.promptBuilder.getOperationalJsonSchema()
      });
    } catch (error: any) {
      if (attempt < 3) {
        console.warn(`[OnboardingService] Operational JSON attempt ${attempt} failed, retrying...`);
        await this.sleep(Math.pow(2, attempt) * 1000);
        return this.generateOperationalJsonWithRetry(data, attempt + 1);
      }
      throw error;
    }
  }

  // ===========================================================================
  // HELPER
  // ===========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
