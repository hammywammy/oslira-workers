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
 * - Retry logic with exponential backoff (3 attempts)
 * - Cost tracking
 * 
 * Token Limits (4x increase from original):
 * - One-liner: 800 tokens (was 200)
 * - Summary: 800 tokens (was 200)
 * - ICP JSON: 2000 tokens (was 500)
 * - Operational JSON: 2000 tokens (was 500)
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
    console.log('[OnboardingService] User inputs:', {
      business_name: userInputs.business_name,
      industry: userInputs.industry,
      signature_name: userInputs.signature_name
    });

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

      console.log('[OnboardingService] All 4 calls completed successfully:', {
        total_time_ms: totalTime,
        total_tokens: totalTokens,
        total_cost: totalCost,
        one_liner_length: oneLiner.content.length,
        summary_length: summaryGenerated.content.length
      });

      // Parse ICP and Operational JSON
      const icpData = typeof icpJson.content === 'string' 
        ? JSON.parse(icpJson.content) 
        : icpJson.content;

      const opData = typeof opMetadataJson.content === 'string'
        ? JSON.parse(opMetadataJson.content)
        : opMetadataJson.content;

      // Construct final result
      const result: BusinessContextResult = {
        business_one_liner: oneLiner.content,
        business_summary_generated: summaryGenerated.content,
        ideal_customer_profile: icpData,
        operational_metadata: opData,
        ai_metadata: {
          model_used: 'gpt-5',
          total_tokens: totalTokens,
          total_cost: totalCost,
          generation_time_ms: totalTime
        }
      };

      console.log('[OnboardingService] Business context generated successfully');
      return result;

    } catch (error: any) {
      console.error('[OnboardingService] Fatal error in generateBusinessContext:', {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack
      });
      throw new Error(`Business context generation failed: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 1: One-Liner (with retry)
  // ===========================================================================

  private async generateOneLinerWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] One-liner generation attempt ${attempt}/3`);
    
    try {
      return await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You write concise, punchy business taglines. Maximum 140 characters. No fluff.',
        user_prompt: this.promptBuilder.buildOneLinerPrompt(data),
        max_tokens: 800, // ✅ INCREASED: 200 → 800 (4x)
        temperature: 0.7
      });
    } catch (error: any) {
      console.error(`[OnboardingService] One-liner attempt ${attempt} failed:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying one-liner in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateOneLinerWithRetry(data, attempt + 1);
      }
      
      throw new Error(`One-liner generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 2: Summary (with retry)
  // ===========================================================================

  private async generateSummaryWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] Summary generation attempt ${attempt}/3`);
    
    try {
      return await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You write clear, professional business summaries. Exactly 4 sentences. No marketing fluff.',
        user_prompt: this.promptBuilder.buildSummaryPrompt(data),
        max_tokens: 800, // ✅ INCREASED: 200 → 800 (4x)
        temperature: 0.5
      });
    } catch (error: any) {
      console.error(`[OnboardingService] Summary attempt ${attempt} failed:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying summary in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateSummaryWithRetry(data, attempt + 1);
      }
      
      throw new Error(`Summary generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 3: Ideal Customer Profile JSON (with retry)
  // ===========================================================================

  private async generateICPJsonWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] ICP JSON generation attempt ${attempt}/3`);
    
    try {
      return await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format user data into JSON. Never add data that wasn\'t provided. Never include business_summary in the output.',
        user_prompt: this.promptBuilder.buildICPJsonPrompt(data),
        max_tokens: 2000, // ✅ INCREASED: 500 → 2000 (4x)
        reasoning_effort: 'minimal',
        tool_schema: this.promptBuilder.getICPJsonSchema()
      });
    } catch (error: any) {
      console.error(`[OnboardingService] ICP JSON attempt ${attempt} failed:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying ICP JSON in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateICPJsonWithRetry(data, attempt + 1);
      }
      
      throw new Error(`ICP JSON generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 4: Operational Metadata JSON (with retry)
  // ===========================================================================

  private async generateOperationalJsonWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] Operational JSON generation attempt ${attempt}/3`);
    
    try {
      return await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format user data into JSON. Never add data that wasn\'t provided. Always include business_summary in the output.',
        user_prompt: this.promptBuilder.buildOperationalJsonPrompt(data),
        max_tokens: 2000, // ✅ INCREASED: 500 → 2000 (4x)
        reasoning_effort: 'minimal',
        tool_schema: this.promptBuilder.getOperationalJsonSchema()
      });
    } catch (error: any) {
      console.error(`[OnboardingService] Operational JSON attempt ${attempt} failed:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying operational JSON in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateOperationalJsonWithRetry(data, attempt + 1);
      }
      
      throw new Error(`Operational JSON generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // HELPER
  // ===========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
