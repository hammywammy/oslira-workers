// infrastructure/workflows/business-context.workflow.ts - FIXED FOR PARALLEL EXECUTION

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * BUSINESS CONTEXT WORKFLOW - OPTIMIZED FOR PARALLEL EXECUTION
 * 
 * CRITICAL ARCHITECTURE:
 * - AI calls happen OUTSIDE step.do() blocks to run in true parallel
 * - step.do() blocks are ONLY for idempotent state transitions
 * - Workflow completes in ~20 seconds instead of timing out
 * 
 * Flow:
 * 1. Initialize progress (step.do - ensures idempotency)
 * 2. Generate AI context (PARALLEL - happens outside step.do)
 * 3. Save to database (step.do - ensures idempotency)
 * 4. Mark complete (step.do - ensures idempotency)
 */

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;

    console.log('='.repeat(80));
    console.log('[BusinessContextWorkflow] STARTING WORKFLOW');
    console.log('[BusinessContextWorkflow] Run ID:', params.run_id);
    console.log('[BusinessContextWorkflow] Account ID:', params.account_id);
    console.log('='.repeat(80));

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize Progress Tracker (0%)
      // =========================================================================
      
      await step.do('initialize_progress', async () => {
        console.log('[BusinessContextWorkflow] STEP 1: Initializing progress tracker');
        
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

        console.log('[BusinessContextWorkflow] STEP 1: Complete');
      });

      // =========================================================================
      // PARALLEL AI GENERATION (happens OUTSIDE step.do for true parallelism)
      // =========================================================================
      
      console.log('[BusinessContextWorkflow] AI Generation: STARTING (parallel)');
      
      // Update progress to 33% BEFORE starting AI calls
      await this.updateProgress(progressDO, 33, 'Generating business context with AI');
      
      // Get API keys
      console.log('[BusinessContextWorkflow] Getting API keys from secrets');
      const openaiKey = await getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV);
      const claudeKey = await getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV);
      
      // Initialize service
      console.log('[BusinessContextWorkflow] Initializing OnboardingService');
      const service = new OnboardingService(this.env, openaiKey, claudeKey);
      
      // Execute 4 parallel AI calls (Promise.all runs truly in parallel here)
      console.log('[BusinessContextWorkflow] Calling generateBusinessContext (4 parallel calls)');
      const aiStartTime = Date.now();
      
      const contextResult = await service.generateBusinessContext(params.user_inputs);
      
      const aiDuration = Date.now() - aiStartTime;
      console.log('[BusinessContextWorkflow] AI Generation: COMPLETE', {
        duration_ms: aiDuration,
        total_cost: contextResult.ai_metadata.total_cost,
        total_tokens: contextResult.ai_metadata.total_tokens
      });

      // =========================================================================
      // STEP 2: Save to Database (66%)
      // =========================================================================
      
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[BusinessContextWorkflow] STEP 2: Saving to database');
        
        await this.updateProgress(progressDO, 66, 'Saving business profile');

        // Create Supabase client
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const businessRepo = new BusinessRepository(supabase);

        // Generate business slug
        const slug = this.generateSlug(params.user_inputs.business_name);

        // Create business profile
        console.log('[BusinessContextWorkflow] STEP 2: Creating business profile');
        const businessProfile = await businessRepo.createBusinessProfile({
          account_id: params.account_id,
          business_name: params.user_inputs.business_name,
          business_slug: slug,
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

        console.log('[BusinessContextWorkflow] STEP 2: Complete', {
          business_profile_id: businessProfile.business_profile_id
        });

        return businessProfile.business_profile_id;
      });

      // =========================================================================
      // STEP 3: Mark Complete (100%)
      // =========================================================================
      
      await step.do('mark_complete', async () => {
        console.log('[BusinessContextWorkflow] STEP 3: Marking complete');
        
        const response = await progressDO.fetch('http://do/complete', {
          method: 'POST',
          body: JSON.stringify({
            result: {
              business_profile_id: businessProfileId,
              ...contextResult
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`DO complete failed: ${errorText}`);
        }

        console.log('[BusinessContextWorkflow] STEP 3: Complete');
      });

      console.log('='.repeat(80));
      console.log('[BusinessContextWorkflow] WORKFLOW COMPLETE');
      console.log('[BusinessContextWorkflow] Business Profile ID:', businessProfileId);
      console.log('='.repeat(80));

      return {
        success: true,
        business_profile_id: businessProfileId,
        run_id: params.run_id
      };

    } catch (error: any) {
      console.error('='.repeat(80));
      console.error('[BusinessContextWorkflow] WORKFLOW FAILED');
      console.error('[BusinessContextWorkflow] Error:', error.message);
      console.error('[BusinessContextWorkflow] Stack:', error.stack);
      console.error('='.repeat(80));

      // Mark as failed
      await progressDO.fetch('http://do/fail', {
        method: 'POST',
        body: JSON.stringify({
          error_message: error.message
        })
      });

      throw error;
    }
  }

  /**
   * Update progress in Durable Object
   */
  private async updateProgress(
    progressDO: DurableObjectStub,
    progress: number,
    currentStep: string
  ): Promise<void> {
    const response = await progressDO.fetch('http://do/update', {
      method: 'POST',
      body: JSON.stringify({
        progress,
        current_step: currentStep,
        status: 'processing'
      })
    });

    if (!response.ok) {
      console.error('[BusinessContextWorkflow] Failed to update progress:', await response.text());
      // Don't throw - progress updates are non-critical
    }
  }

  /**
   * Generate URL-safe slug from business name
   */
  private generateSlug(businessName: string): string {
    return businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }
}

export default BusinessContextWorkflow;
