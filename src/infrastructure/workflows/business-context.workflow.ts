// infrastructure/workflows/business-context.workflow.ts
// PRODUCTION-GRADE FIXES:
// 1. ✅ Secrets fetching INSIDE step.do() for automatic retry
// 2. ✅ Secrets cached in DO state (enterprise-safe, 24hr TTL)
// 3. ✅ AI calls remain PARALLEL (outside step.do) for 15-20s execution
// 4. ✅ Comprehensive error logging with full context
// 5. ✅ Idempotent database operations

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * BUSINESS CONTEXT WORKFLOW - PRODUCTION-GRADE IDEMPOTENT EXECUTION
 * 
 * ARCHITECTURE:
 * - Secrets fetched INSIDE step.do() for automatic retry on AWS failures
 * - AI calls happen OUTSIDE step.do() blocks for true parallel execution (15-20s)
 * - step.do() blocks are ONLY for idempotent state transitions
 * - Secrets cached in DO state (secure, 24hr TTL)
 * 
 * FLOW:
 * 1. Initialize progress + fetch/cache secrets (step.do - idempotent + retriable)
 * 2. Generate AI context (PARALLEL - outside step.do, uses cached secrets)
 * 3. Save to database (step.do - IDEMPOTENT with duplicate check)
 * 4. Mark complete (step.do - idempotent)
 */

interface CachedSecrets {
  openai_key: string;
  claude_key: string;
  cached_at: string;
}

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const workflowStartTime = Date.now();

    console.log('='.repeat(80));
    console.log('[BusinessContextWorkflow] WORKFLOW STARTING');
    console.log('[BusinessContextWorkflow] Timestamp:', new Date().toISOString());
    console.log('[BusinessContextWorkflow] Run ID:', params.run_id);
    console.log('[BusinessContextWorkflow] Account ID:', params.account_id);
    console.log('[BusinessContextWorkflow] Business:', params.user_inputs.business_name);
    console.log('[BusinessContextWorkflow] Signature:', params.user_inputs.signature_name);
    console.log('='.repeat(80));

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize Progress + Fetch/Cache Secrets (0%)
      // =========================================================================
      // CRITICAL: Network calls (AWS Secrets Manager) MUST be inside step.do()
      // for automatic retry. This fixes the silent failure issue.
      
      const cachedSecrets = await step.do('initialize_and_fetch_secrets', async () => {
        console.log('[Workflow.Step1] ENTRY - Initialize progress + fetch secrets');
        const stepStartTime = Date.now();
        
        try {
          // Initialize progress tracker
          console.log('[Workflow.Step1] Initializing progress in DO...');
          const initResponse = await progressDO.fetch('http://do/initialize', {
            method: 'POST',
            body: JSON.stringify({
              run_id: params.run_id,
              account_id: params.account_id
            })
          });

          if (!initResponse.ok) {
            const errorText = await initResponse.text();
            throw new Error(`DO initialize failed: ${errorText}`);
          }
          console.log('[Workflow.Step1] ✓ Progress initialized');

          // Check for cached secrets in DO first
          console.log('[Workflow.Step1] Checking for cached secrets in DO...');
          const cacheResponse = await progressDO.fetch('http://do/get-secrets', {
            method: 'GET'
          });

          let secrets: CachedSecrets;

          if (cacheResponse.ok) {
            const cached = await cacheResponse.json();
            if (cached && cached.openai_key && cached.claude_key) {
              const cacheAge = Date.now() - new Date(cached.cached_at).getTime();
              const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
              
              if (cacheAge < CACHE_TTL) {
                console.log('[Workflow.Step1] ✓ Using cached secrets', {
                  cache_age_hours: (cacheAge / (60 * 60 * 1000)).toFixed(2)
                });
                secrets = cached;
              } else {
                console.log('[Workflow.Step1] Cached secrets expired, fetching new...');
                secrets = await this.fetchAndCacheSecrets(progressDO);
              }
            } else {
              console.log('[Workflow.Step1] No valid cached secrets, fetching from AWS...');
              secrets = await this.fetchAndCacheSecrets(progressDO);
            }
          } else {
            console.log('[Workflow.Step1] Cache miss, fetching from AWS Secrets Manager...');
            secrets = await this.fetchAndCacheSecrets(progressDO);
          }

          const stepDuration = Date.now() - stepStartTime;
          console.log('[Workflow.Step1] ✓ SUCCESS', { duration_ms: stepDuration });
          
          return secrets;
          
        } catch (error: any) {
          const stepDuration = Date.now() - stepStartTime;
          console.error('[Workflow.Step1] ✗ FAILED', {
            duration_ms: stepDuration,
            error_name: error.name,
            error_message: error.message,
            error_code: error.code,
            error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
          });
          throw error;
        }
      });

      // =========================================================================
      // PARALLEL AI GENERATION (happens OUTSIDE step.do for true parallelism)
      // =========================================================================
      // CRITICAL: AI calls must be OUTSIDE step.do() to execute in parallel
      // Expected duration: 15-20 seconds for 4 parallel calls
      
      console.log('='.repeat(80));
      console.log('[Workflow.AI] PARALLEL EXECUTION STARTING');
      console.log('[Workflow.AI] Expected duration: 15-20 seconds');
      console.log('[Workflow.AI] If >30s, parallel execution is broken');
      console.log('='.repeat(80));
      
      // Update progress to 33% BEFORE starting AI calls
      await this.updateProgress(progressDO, 33, 'Generating business context with AI');
      
      // Initialize service with cached secrets
      console.log('[Workflow.AI] Initializing OnboardingService with cached keys...');
      const service = new OnboardingService(
        this.env,
        cachedSecrets.openai_key,
        cachedSecrets.claude_key
      );
      
      // Execute 4 parallel AI calls
      console.log('[Workflow.AI] Executing 4 parallel AI calls via Promise.all...');
      const aiStartTime = Date.now();
      
      const contextResult = await service.generateBusinessContext(params.user_inputs);
      
      const aiDuration = Date.now() - aiStartTime;
      console.log('='.repeat(80));
      console.log('[Workflow.AI] COMPLETE');
      console.log('[Workflow.AI] Duration:', aiDuration, 'ms', `(${(aiDuration / 1000).toFixed(1)}s)`);
      console.log('[Workflow.AI] Cost: $' + contextResult.ai_metadata.total_cost.toFixed(4));
      console.log('[Workflow.AI] Tokens:', contextResult.ai_metadata.total_tokens);
      
      if (aiDuration > 30000) {
        console.warn('[Workflow.AI] ⚠️  WARNING: Took >30s! Parallel execution may be broken');
      } else if (aiDuration > 20000) {
        console.log('[Workflow.AI] ⚠️  Acceptable but slow (>20s)');
      } else {
        console.log('[Workflow.AI] ✓ Excellent parallel execution time');
      }
      console.log('='.repeat(80));

      // =========================================================================
      // STEP 2: Save to Database (66%) - IDEMPOTENT
      // =========================================================================
      
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[Workflow.Step2] ENTRY - Saving to database (IDEMPOTENT)');
        console.log('[Workflow.Step2] Account:', params.account_id);
        console.log('[Workflow.Step2] Business:', params.user_inputs.business_name);
        console.log('[Workflow.Step2] Signature:', params.user_inputs.signature_name);
        
        const saveStartTime = Date.now();
        
        try {
          // Update progress
          await this.updateProgress(progressDO, 66, 'Saving business profile');

          // Create Supabase client
          console.log('[Workflow.Step2] Creating Supabase admin client...');
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          console.log('[Workflow.Step2] ✓ Supabase client ready');
          
          const businessRepo = new BusinessRepository(supabase);

          // CRITICAL: Idempotent database save
          // Checks if profile already exists (by account_id + signature_name)
          // Returns existing ID if found (safe for retries)
          console.log('[Workflow.Step2] Calling createBusinessProfile (idempotent)...');
          const result = await businessRepo.createBusinessProfile({
            account_id: params.account_id,
            business_name: params.user_inputs.business_name,
            signature_name: params.user_inputs.signature_name,
            business_one_liner: contextResult.business_one_liner,
            business_summary: params.user_inputs.business_summary,
            business_summary_generated: contextResult.business_summary_generated,
            website: params.user_inputs.website,
            industry: contextResult.ideal_customer_profile.industry,
            company_size: params.user_inputs.company_size,
            target_audience: contextResult.ideal_customer_profile.target_audience,
            icp_min_followers: contextResult.ideal_customer_profile.icp_min_followers,
            icp_max_followers: contextResult.ideal_customer_profile.icp_max_followers,
            brand_voice: contextResult.ideal_customer_profile.brand_voice,
            operational_metadata: contextResult.operational_metadata,
            ai_generation_metadata: contextResult.ai_metadata
          });

          const saveDuration = Date.now() - saveStartTime;
          
          console.log('[Workflow.Step2] ✓ SUCCESS', {
            duration_ms: saveDuration,
            profile_id: result.business_profile_id,
            was_created: result.was_created
          });
          
          if (!result.was_created) {
            console.log('[Workflow.Step2] ℹ️  IDEMPOTENCY: Returned existing profile (retry detected)');
          }

          return result.business_profile_id;
          
        } catch (error: any) {
          const saveDuration = Date.now() - saveStartTime;
          
          console.error('[Workflow.Step2] ✗ FAILED', {
            duration_ms: saveDuration,
            error_name: error.name,
            error_message: error.message,
            error_code: error.code,
            error_details: error.details,
            error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
          });
          
          throw error; // Re-throw to trigger step retry
        }
      });

      // =========================================================================
      // STEP 3: Mark Complete (100%)
      // =========================================================================
      
      await step.do('mark_complete', async () => {
        console.log('[Workflow.Step3] ENTRY - Marking complete');
        const stepStartTime = Date.now();
        
        try {
          const response = await progressDO.fetch('http://do/complete', {
            method: 'POST',
            body: JSON.stringify({
              result: {
                business_profile_id: businessProfileId,
                business_one_liner: contextResult.business_one_liner,
                business_summary_generated: contextResult.business_summary_generated,
                ideal_customer_profile: contextResult.ideal_customer_profile,
                operational_metadata: contextResult.operational_metadata,
                ai_metadata: contextResult.ai_metadata
              }
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`DO complete failed: ${errorText}`);
          }

          const stepDuration = Date.now() - stepStartTime;
          console.log('[Workflow.Step3] ✓ SUCCESS', { duration_ms: stepDuration });
          
        } catch (error: any) {
          console.error('[Workflow.Step3] ✗ FAILED', {
            error_name: error.name,
            error_message: error.message
          });
          throw error;
        }
      });

      // =========================================================================
      // WORKFLOW COMPLETE
      // =========================================================================
      
      const totalDuration = Date.now() - workflowStartTime;
      console.log('='.repeat(80));
      console.log('[Workflow] ✓ COMPLETE');
      console.log('[Workflow] Total Duration:', totalDuration, 'ms', `(${(totalDuration / 1000).toFixed(1)}s)`);
      console.log('[Workflow] Business Profile ID:', businessProfileId);
      console.log('='.repeat(80));

      return {
        success: true,
        business_profile_id: businessProfileId,
        duration_ms: totalDuration
      };

    } catch (error: any) {
      const totalDuration = Date.now() - workflowStartTime;
      
      console.error('='.repeat(80));
      console.error('[Workflow] ✗ FAILED');
      console.error('[Workflow] Duration:', totalDuration, 'ms');
      console.error('[Workflow] Error:', {
        name: error.name,
        message: error.message,
        code: error.code,
        stack: error.stack
      });
      console.error('='.repeat(80));

      // Mark as failed in progress tracker
      await this.markFailed(progressDO, error.message);

      throw error;
    }
  }

  /**
   * Fetch secrets from AWS and cache in DO
   * CRITICAL: This runs INSIDE step.do() for automatic retry
   */
  private async fetchAndCacheSecrets(progressDO: any): Promise<CachedSecrets> {
    console.log('[Workflow] Fetching secrets from AWS Secrets Manager...');
    const fetchStartTime = Date.now();
    
    try {
      // Fetch both keys in parallel
      const [openaiKey, claudeKey] = await Promise.all([
        getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
        getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV)
      ]);
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log('[Workflow] ✓ Secrets fetched from AWS', {
        duration_ms: fetchDuration,
        openai_key_length: openaiKey.length,
        claude_key_length: claudeKey.length
      });

      // Cache in DO for 24 hours
      const secrets: CachedSecrets = {
        openai_key: openaiKey,
        claude_key: claudeKey,
        cached_at: new Date().toISOString()
      };

      console.log('[Workflow] Caching secrets in DO (24hr TTL)...');
      const cacheResponse = await progressDO.fetch('http://do/cache-secrets', {
        method: 'POST',
        body: JSON.stringify(secrets)
      });

      if (!cacheResponse.ok) {
        console.warn('[Workflow] ⚠️  Failed to cache secrets in DO (non-critical)');
      } else {
        console.log('[Workflow] ✓ Secrets cached in DO');
      }

      return secrets;
      
    } catch (error: any) {
      const fetchDuration = Date.now() - fetchStartTime;
      console.error('[Workflow] ✗ Failed to fetch secrets from AWS', {
        duration_ms: fetchDuration,
        error_name: error.name,
        error_message: error.message,
        aws_region: this.env.AWS_REGION,
        app_env: this.env.APP_ENV
      });
      throw new Error(`AWS Secrets Manager failed: ${error.message}`);
    }
  }

  /**
   * Update progress in Durable Object
   * Non-critical - failures are logged but don't stop workflow
   */
  private async updateProgress(
    progressDO: any,
    progress: number,
    currentStep: string
  ): Promise<void> {
    try {
      const response = await progressDO.fetch('http://do/update', {
        method: 'POST',
        body: JSON.stringify({
          progress,
          current_step: currentStep,
          status: 'processing'
        })
      });

      if (!response.ok) {
        console.error('[Workflow] Progress update failed:', await response.text());
      }
    } catch (error: any) {
      console.error('[Workflow] Progress update error:', error.message);
      // Don't throw - progress updates are non-critical
    }
  }

  /**
   * Mark generation as failed
   */
  private async markFailed(progressDO: any, errorMessage: string): Promise<void> {
    try {
      await progressDO.fetch('http://do/fail', {
        method: 'POST',
        body: JSON.stringify({ error_message: errorMessage })
      });
    } catch (error: any) {
      console.error('[Workflow] Failed to mark as failed:', error.message);
    }
  }
}
