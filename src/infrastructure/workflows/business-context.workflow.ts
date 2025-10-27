// infrastructure/workflows/business-context.workflow.ts
// FIXED: Idempotent database operations + comprehensive logging + parallel execution diagnostics

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
 * CRITICAL FIXES:
 * 1. Database save is now IDEMPOTENT (checks if already created before inserting)
 * 2. Comprehensive logging at every step for debugging
 * 3. Parallel AI execution diagnostics
 * 4. Proper error handling with detailed context
 * 
 * Architecture:
 * - AI calls happen OUTSIDE step.do() blocks for true parallel execution
 * - step.do() blocks are ONLY for idempotent state transitions
 * - Each retry is logged with timing information
 * 
 * Flow:
 * 1. Initialize progress tracker (step.do - idempotent)
 * 2. Generate AI context (PARALLEL - outside step.do)
 * 3. Save to database (step.do - IDEMPOTENT with duplicate check)
 * 4. Mark complete (step.do - idempotent)
 */

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const workflowStartTime = Date.now();

    console.log('='.repeat(80));
    console.log('[BusinessContextWorkflow] WORKFLOW STARTING');
    console.log('[BusinessContextWorkflow] Timestamp:', new Date().toISOString());
    console.log('[BusinessContextWorkflow] Run ID:', params.run_id);
    console.log('[BusinessContextWorkflow] Account ID:', params.account_id);
    console.log('[BusinessContextWorkflow] User Inputs:', {
      business_name: params.user_inputs.business_name,
      signature_name: params.user_inputs.signature_name,
      industry: params.user_inputs.industry
    });
    console.log('='.repeat(80));

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize Progress Tracker (0%)
      // =========================================================================
      
      await step.do('initialize_progress', async () => {
        console.log('[BusinessContextWorkflow] STEP 1: ENTRY - Initializing progress tracker');
        const stepStartTime = Date.now();
        
        try {
          const response = await progressDO.fetch('http://do/initialize', {
            method: 'POST',
            body: JSON.stringify({
              run_id: params.run_id,
              account_id: params.account_id
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`DO initialize failed: ${errorText}`);
          }

          const stepDuration = Date.now() - stepStartTime;
          console.log('[BusinessContextWorkflow] STEP 1: SUCCESS', { duration_ms: stepDuration });
          
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 1: FAILED', {
            error_name: error.name,
            error_message: error.message,
            stack: error.stack
          });
          throw error;
        }
      });

      // =========================================================================
      // PARALLEL AI GENERATION (happens OUTSIDE step.do for true parallelism)
      // =========================================================================
      
      console.log('='.repeat(80));
      console.log('[BusinessContextWorkflow] AI GENERATION: STARTING (PARALLEL)');
      console.log('[BusinessContextWorkflow] This should complete in ~15-20 seconds');
      console.log('[BusinessContextWorkflow] If it takes 52+ seconds, parallel execution is broken');
      console.log('='.repeat(80));
      
      // Update progress to 33% BEFORE starting AI calls
      await this.updateProgress(progressDO, 33, 'Generating business context with AI');
      
      // Get API keys
      console.log('[BusinessContextWorkflow] Fetching API keys from secrets...');
      const secretsStartTime = Date.now();
      const openaiKey = await getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV);
      const claudeKey = await getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV);
      console.log('[BusinessContextWorkflow] API keys fetched', {
        duration_ms: Date.now() - secretsStartTime
      });
      
      // Initialize service
      console.log('[BusinessContextWorkflow] Initializing OnboardingService...');
      const service = new OnboardingService(this.env, openaiKey, claudeKey);
      
      // Execute 4 parallel AI calls
      console.log('[BusinessContextWorkflow] Calling generateBusinessContext...');
      console.log('[BusinessContextWorkflow] CRITICAL: 4 AI calls should execute in parallel via Promise.all');
      const aiStartTime = Date.now();
      
      const contextResult = await service.generateBusinessContext(params.user_inputs);
      
      const aiDuration = Date.now() - aiStartTime;
      console.log('='.repeat(80));
      console.log('[BusinessContextWorkflow] AI GENERATION: COMPLETE');
      console.log('[BusinessContextWorkflow] Duration:', aiDuration, 'ms');
      console.log('[BusinessContextWorkflow] Total Cost: $' + contextResult.ai_metadata.total_cost.toFixed(4));
      console.log('[BusinessContextWorkflow] Total Tokens:', contextResult.ai_metadata.total_tokens);
      
      if (aiDuration > 30000) {
        console.warn('[BusinessContextWorkflow] ⚠️  WARNING: AI generation took >30s!');
        console.warn('[BusinessContextWorkflow] Expected: 15-20s for parallel execution');
        console.warn('[BusinessContextWorkflow] This indicates parallel execution may be broken');
      } else {
        console.log('[BusinessContextWorkflow] ✓ AI generation time is acceptable');
      }
      console.log('='.repeat(80));

      // =========================================================================
      // STEP 2: Save to Database (66%) - IDEMPOTENT
      // =========================================================================
      
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('='.repeat(80));
        console.log('[BusinessContextWorkflow] STEP 2: ENTRY - Saving to database');
        console.log('[BusinessContextWorkflow] Account ID:', params.account_id);
        console.log('[BusinessContextWorkflow] Business Name:', params.user_inputs.business_name);
        console.log('[BusinessContextWorkflow] Signature Name:', params.user_inputs.signature_name);
        console.log('='.repeat(80));
        
        const saveStartTime = Date.now();
        
        try {
          // Update progress
          await this.updateProgress(progressDO, 66, 'Saving business profile');

          // Create Supabase client
          console.log('[BusinessContextWorkflow] Creating Supabase admin client...');
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          console.log('[BusinessContextWorkflow] Supabase client created');
          
          const businessRepo = new BusinessRepository(supabase);

          // =====================================================================
          // CRITICAL: Idempotent database save
          // This will check if profile already exists (by account_id + signature_name)
          // and return existing ID if found (safe for retries)
          // =====================================================================
          
          console.log('[BusinessContextWorkflow] Calling createBusinessProfile (idempotent)...');
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
          
          console.log('='.repeat(80));
          console.log('[BusinessContextWorkflow] STEP 2: SUCCESS');
          console.log('[BusinessContextWorkflow] Profile ID:', result.business_profile_id);
          console.log('[BusinessContextWorkflow] Was Created:', result.was_created);
          console.log('[BusinessContextWorkflow] Duration:', saveDuration, 'ms');
          
          if (!result.was_created) {
            console.log('[BusinessContextWorkflow] ✓ IDEMPOTENCY: Returned existing profile (retry detected)');
          }
          console.log('='.repeat(80));

          return result.business_profile_id;
          
        } catch (error: any) {
          const saveDuration = Date.now() - saveStartTime;
          
          console.error('='.repeat(80));
          console.error('[BusinessContextWorkflow] STEP 2: FAILED');
          console.error('[BusinessContextWorkflow] Error Name:', error.name);
          console.error('[BusinessContextWorkflow] Error Message:', error.message);
          console.error('[BusinessContextWorkflow] Error Code:', error.code);
          console.error('[BusinessContextWorkflow] Error Details:', error.details);
          console.error('[BusinessContextWorkflow] Duration:', saveDuration, 'ms');
          console.error('[BusinessContextWorkflow] Stack:', error.stack);
          console.error('='.repeat(80));
          
          throw error; // Re-throw to trigger step retry
        }
      });

      // =========================================================================
      // STEP 3: Mark Complete (100%)
      // =========================================================================
      
      await step.do('mark_complete', async () => {
        console.log('[BusinessContextWorkflow] STEP 3: ENTRY - Marking complete');
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
          console.log('[BusinessContextWorkflow] STEP 3: SUCCESS', { duration_ms: stepDuration });
          
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 3: FAILED', {
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
      console.log('[BusinessContextWorkflow] WORKFLOW COMPLETE');
      console.log('[BusinessContextWorkflow] Total Duration:', totalDuration, 'ms');
      console.log('[BusinessContextWorkflow] Business Profile ID:', businessProfileId);
      console.log('='.repeat(80));

      return {
        success: true,
        business_profile_id: businessProfileId,
        duration_ms: totalDuration
      };

    } catch (error: any) {
      const totalDuration = Date.now() - workflowStartTime;
      
      console.error('='.repeat(80));
      console.error('[BusinessContextWorkflow] WORKFLOW FAILED');
      console.error('[BusinessContextWorkflow] Duration:', totalDuration, 'ms');
      console.error('[BusinessContextWorkflow] Error:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      console.error('='.repeat(80));

      // Mark as failed in progress tracker
      await this.markFailed(progressDO, error.message);

      throw error;
    }
  }

  /**
   * Update progress in Durable Object
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
        console.error('[BusinessContextWorkflow] Progress update failed:', await response.text());
      }
    } catch (error: any) {
      console.error('[BusinessContextWorkflow] Progress update error:', error.message);
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
      console.error('[BusinessContextWorkflow] Failed to mark as failed:', error.message);
    }
  }
}
