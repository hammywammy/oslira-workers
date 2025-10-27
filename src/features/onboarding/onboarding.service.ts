// features/onboarding/onboarding.service.ts
// FIXED: Added comprehensive parallel execution diagnostics

import type { Env } from '@/shared/types/env.types';
import type { OnboardingFormData, BusinessContextResult } from '@/shared/types/business-context.types';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';
import { BusinessContextPromptBuilder } from './business-context-prompts.service';

/**
 * ONBOARDING SERVICE - WITH PARALLEL EXECUTION DIAGNOSTICS
 * 
 * Executes 4 parallel AI calls to generate business context:
 * 1. business_one_liner (140 char tagline)
 * 2. business_summary_generated (4 sentences)
 * 3. ideal_customer_profile (JSON format)
 * 4. operational_metadata (JSON format)
 * 
 * CRITICAL: All calls execute in TRUE parallel via Promise.all
 * Expected duration: 15-20 seconds
 * If taking 52+ seconds, parallel execution is broken
 * 
 * Features:
 * - All calls via AI Gateway (GPT-5)
 * - Parallel execution with timing diagnostics
 * - Retry logic with exponential backoff (3 attempts)
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
    const overallStartTime = Date.now();

    console.log('='.repeat(80));
    console.log('[OnboardingService] PARALLEL EXECUTION STARTING');
    console.log('[OnboardingService] Timestamp:', new Date().toISOString());
    console.log('[OnboardingService] User inputs:', {
      business_name: userInputs.business_name,
      industry: userInputs.industry,
      signature_name: userInputs.signature_name
    });
    console.log('='.repeat(80));

    try {
      // =========================================================================
      // CRITICAL: Create all 4 promises IMMEDIATELY (non-blocking)
      // This ensures they can execute in parallel
      // =========================================================================
      
      console.log('[OnboardingService] Creating promise 1 (oneLiner)...');
      const promise1StartTime = Date.now();
      const oneLinerPromise = this.generateOneLinerWithRetry(userInputs);
      console.log('[OnboardingService] Promise 1 created in', Date.now() - promise1StartTime, 'ms');
      
      console.log('[OnboardingService] Creating promise 2 (summary)...');
      const promise2StartTime = Date.now();
      const summaryPromise = this.generateSummaryWithRetry(userInputs);
      console.log('[OnboardingService] Promise 2 created in', Date.now() - promise2StartTime, 'ms');
      
      console.log('[OnboardingService] Creating promise 3 (ICP)...');
      const promise3StartTime = Date.now();
      const icpPromise = this.generateICPJsonWithRetry(userInputs);
      console.log('[OnboardingService] Promise 3 created in', Date.now() - promise3StartTime, 'ms');
      
      console.log('[OnboardingService] Creating promise 4 (OpMetadata)...');
      const promise4StartTime = Date.now();
      const opMetadataPromise = this.generateOpMetadataJsonWithRetry(userInputs);
      console.log('[OnboardingService] Promise 4 created in', Date.now() - promise4StartTime, 'ms');

      // =========================================================================
      // AWAIT ALL 4 PROMISES IN PARALLEL
      // =========================================================================
      
      console.log('[OnboardingService] All 4 promises created');
      console.log('[OnboardingService] Now awaiting Promise.all (TRUE PARALLEL EXECUTION)...');
      const promiseAllStartTime = Date.now();
      
      const [oneLiner, summaryGenerated, icpJson, opMetadataJson] = await Promise.all([
        oneLinerPromise,
        summaryPromise,
        icpPromise,
        opMetadataPromise
      ]);
      
      const promiseAllDuration = Date.now() - promiseAllStartTime;
      
      console.log('='.repeat(80));
      console.log('[OnboardingService] Promise.all COMPLETE');
      console.log('[OnboardingService] Duration:', promiseAllDuration, 'ms');
      
      if (promiseAllDuration > 30000) {
        console.error('[OnboardingService] ❌ CRITICAL: Promise.all took', promiseAllDuration, 'ms');
        console.error('[OnboardingService] Expected: 15-20 seconds for parallel execution');
        console.error('[OnboardingService] This indicates calls are running SEQUENTIALLY, not in parallel');
        console.error('[OnboardingService] Check for:');
        console.error('[OnboardingService]   - Awaits inside individual retry functions');
        console.error('[OnboardingService]   - Sleep/delay calls blocking promise creation');
        console.error('[OnboardingService]   - Rate limiting in AI Gateway');
      } else if (promiseAllDuration < 10000) {
        console.log('[OnboardingService] ✓ EXCELLENT: Very fast parallel execution');
      } else {
        console.log('[OnboardingService] ✓ GOOD: Parallel execution time is acceptable');
      }
      console.log('='.repeat(80));

      // Parse results
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

      const overallDuration = Date.now() - overallStartTime;

      const result: BusinessContextResult = {
        business_one_liner: oneLiner.content,
        business_summary_generated: summaryGenerated.content,
        ideal_customer_profile: icpJson.content,
        operational_metadata: opMetadataJson.content,
        ai_metadata: {
          model_used: 'gpt-5',
          total_tokens: totalTokens,
          total_cost: totalCost,
          generation_time_ms: overallDuration
        }
      };

      console.log('[OnboardingService] COMPLETE - Final stats:', {
        total_duration_ms: overallDuration,
        total_tokens: totalTokens,
        total_cost: '$' + totalCost.toFixed(4)
      });

      return result;

    } catch (error: any) {
      const overallDuration = Date.now() - overallStartTime;
      
      console.error('='.repeat(80));
      console.error('[OnboardingService] FAILED');
      console.error('[OnboardingService] Duration:', overallDuration, 'ms');
      console.error('[OnboardingService] Error:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      console.error('='.repeat(80));
      
      throw new Error(`Business context generation failed: ${error.message}`);
    }
  }

  // ===========================================================================
  // CALL 1: One-liner (with retry)
  // ===========================================================================

  private async generateOneLinerWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] One-liner attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You write punchy, memorable one-liners for businesses. Maximum 140 characters. No fluff.',
        user_prompt: this.promptBuilder.buildOneLinerPrompt(data),
        max_tokens: 800
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] One-liner attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] One-liner attempt ${attempt} FAILED after ${callDuration}ms:`, {
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
    console.log(`[OnboardingService] Summary attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5',
        system_prompt: 'You write clear, professional business summaries. Exactly 4 sentences. No marketing fluff.',
        user_prompt: this.promptBuilder.buildSummaryPrompt(data),
        max_tokens: 800
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] Summary attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] Summary attempt ${attempt} FAILED after ${callDuration}ms:`, {
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
    console.log(`[OnboardingService] ICP JSON attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format user data into JSON. Never add data that wasn\'t provided. Never include business_summary in the output.',
        user_prompt: this.promptBuilder.buildICPJsonPrompt(data),
        max_tokens: 2000,
        json_schema: {
          name: 'ideal_customer_profile',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              business_description: { type: 'string' },
              target_audience: { type: 'string' },
              industry: { type: 'string' },
              icp_min_followers: { type: 'number' },
              icp_max_followers: { type: 'number' },
              brand_voice: { type: 'string' }
            },
            required: ['business_description', 'target_audience', 'industry', 'icp_min_followers', 'icp_max_followers', 'brand_voice'],
            additionalProperties: false
          }
        }
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] ICP JSON attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] ICP JSON attempt ${attempt} FAILED after ${callDuration}ms:`, {
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

  private async generateOpMetadataJsonWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] OpMetadata JSON attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.callStructured({
        model: 'gpt-5',
        system_prompt: 'You format operational data into JSON. Return exactly what was provided, properly structured.',
        user_prompt: this.promptBuilder.buildOperationalJsonPrompt(data),
        max_tokens: 2000,
        json_schema: {
          name: 'operational_metadata',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              business_summary: { type: 'string' },
              company_size: { type: 'string' },
              monthly_lead_goal: { type: 'number' },
              primary_objective: { type: 'string' },
              challenges: { type: 'array', items: { type: 'string' } },
              target_company_sizes: { type: 'array', items: { type: 'string' } },
              communication_channels: { type: 'array', items: { type: 'string' } },
              communication_tone: { type: 'string' },
              team_size: { type: 'string' },
              campaign_manager: { type: 'string' }
            },
            required: ['business_summary', 'company_size', 'monthly_lead_goal', 'primary_objective', 'challenges', 'target_company_sizes', 'communication_channels', 'communication_tone', 'team_size', 'campaign_manager'],
            additionalProperties: false
          }
        }
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] OpMetadata JSON attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] OpMetadata JSON attempt ${attempt} FAILED after ${callDuration}ms:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying OpMetadata JSON in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateOpMetadataJsonWithRetry(data, attempt + 1);
      }
      
      throw new Error(`OpMetadata JSON generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
