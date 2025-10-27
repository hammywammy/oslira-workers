// infrastructure/workflows/business-context.workflow.ts - WITH COMPREHENSIVE LOGGING

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * BUSINESS CONTEXT WORKFLOW - PRODUCTION WITH LOGGING
 * 
 * Every step logs:
 * - Entry point
 * - Success
 * - Failure with full error details
 */

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;

    console.log('='.repeat(80));
    console.log('[BusinessContextWorkflow] STARTING WORKFLOW');
    console.log('[BusinessContextWorkflow] Run ID:', params.run_id);
    console.log('[BusinessContextWorkflow] Account ID:', params.account_id);
    console.log('[BusinessContextWorkflow] User inputs:', JSON.stringify(params.user_inputs, null, 2));
    console.log('='.repeat(80));

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    console.log('[BusinessContextWorkflow] Progress DO initialized:', progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize Progress Tracker (0%)
      // =========================================================================
      
      console.log('[BusinessContextWorkflow] STEP 1: Initialize Progress - STARTING');
      
      await step.do('initialize_progress', async () => {
        console.log('[BusinessContextWorkflow] STEP 1: Calling DO initialize endpoint');
        
        const response = await progressDO.fetch('http://do/initialize', {
          method: 'POST',
          body: JSON.stringify({
            run_id: params.run_id,
            account_id: params.account_id
          })
        });

        console.log('[BusinessContextWorkflow] STEP 1: DO initialize response status:', response.status);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('[BusinessContextWorkflow] STEP 1: DO initialize FAILED:', errorText);
          throw new Error(`DO initialize failed: ${errorText}`);
        }

        console.log('[BusinessContextWorkflow] STEP 1: Initialize Progress - COMPLETE');
      });

      // =========================================================================
      // STEP 2: Generate AI Context (33%)
      // =========================================================================
      
      console.log('[BusinessContextWorkflow] STEP 2: Generate AI Context - STARTING');
      
      const contextResult = await step.do('generate_ai_context', async () => {
        console.log('[BusinessContextWorkflow] STEP 2: Updating progress to 33%');
        
        await this.updateProgress(progressDO, 33, 'Generating business context with AI');

        console.log('[BusinessContextWorkflow] STEP 2: Getting API keys from secrets');
        
        let openaiKey: string;
        let claudeKey: string;
        
        try {
          openaiKey = await getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV);
          console.log('[BusinessContextWorkflow] STEP 2: OpenAI key retrieved:', openaiKey ? 'YES' : 'NO');
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 2: FAILED to get OpenAI key:', error.message);
          throw new Error(`Failed to get OpenAI key: ${error.message}`);
        }

        try {
          claudeKey = await getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV);
          console.log('[BusinessContextWorkflow] STEP 2: Claude key retrieved:', claudeKey ? 'YES' : 'NO');
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 2: FAILED to get Claude key:', error.message);
          throw new Error(`Failed to get Claude key: ${error.message}`);
        }

        console.log('[BusinessContextWorkflow] STEP 2: Initializing OnboardingService');
        
        let service: OnboardingService;
        try {
          service = new OnboardingService(this.env, openaiKey, claudeKey);
          console.log('[BusinessContextWorkflow] STEP 2: OnboardingService initialized');
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 2: FAILED to initialize service:', error.message);
          throw new Error(`Failed to initialize service: ${error.message}`);
        }

        console.log('[BusinessContextWorkflow] STEP 2: Calling service.generateBusinessContext');
        console.log('[BusinessContextWorkflow] STEP 2: Input params:', JSON.stringify(params.user_inputs, null, 2));
        
        let result;
        try {
          result = await service.generateBusinessContext(params.user_inputs);
          
          console.log('[BusinessContextWorkflow] STEP 2: AI generation COMPLETE');
          console.log('[BusinessContextWorkflow] STEP 2: Results:', {
            one_liner_length: result.business_one_liner?.length,
            summary_length: result.business_summary_generated?.length,
            has_icp: !!result.ideal_customer_profile,
            has_metadata: !!result.operational_metadata,
            total_cost: result.ai_metadata?.total_cost,
            total_tokens: result.ai_metadata?.total_tokens,
          });
          
          return result;
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 2: AI generation FAILED');
          console.error('[BusinessContextWorkflow] STEP 2: Error name:', error.name);
          console.error('[BusinessContextWorkflow] STEP 2: Error message:', error.message);
          console.error('[BusinessContextWorkflow] STEP 2: Error stack:', error.stack);
          throw new Error(`AI generation failed: ${error.message}`);
        }
      });

      // =========================================================================
      // STEP 3: Save to Database (66%)
      // =========================================================================
      
      console.log('[BusinessContextWorkflow] STEP 3: Save to Database - STARTING');
      
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[BusinessContextWorkflow] STEP 3: Updating progress to 66%');
        
        await this.updateProgress(progressDO, 66, 'Saving business profile');

        console.log('[BusinessContextWorkflow] STEP 3: Creating Supabase client');
        
        let supabase;
        try {
          supabase = await SupabaseClientFactory.createAdminClient(this.env);
          console.log('[BusinessContextWorkflow] STEP 3: Supabase client created');
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 3: FAILED to create Supabase client:', error.message);
          throw new Error(`Failed to create Supabase client: ${error.message}`);
        }

        const businessRepo = new BusinessRepository(supabase);
        console.log('[BusinessContextWorkflow] STEP 3: BusinessRepository initialized');

        // Generate business slug
        const slug = this.generateSlug(params.user_inputs.business_name);
        console.log('[BusinessContextWorkflow] STEP 3: Generated slug:', slug);

        console.log('[BusinessContextWorkflow] STEP 3: Creating business profile in DB');
        console.log('[BusinessContextWorkflow] STEP 3: Data to insert:', {
          account_id: params.account_id,
          business_name: params.user_inputs.business_name,
          business_slug: slug,
          signature_name: params.user_inputs.signature_name,
          has_website: !!params.user_inputs.website,
        });

        let profile;
        try {
          profile = await businessRepo.createBusinessProfile({
            account_id: params.account_id,
            business_name: params.user_inputs.business_name,
            business_slug: slug,
            signature_name: params.user_inputs.signature_name,
            website: params.user_inputs.website || null,
            
            // User's raw input
            business_summary: params.user_inputs.business_summary,
            
            // AI-generated
            business_one_liner: contextResult.business_one_liner,
            business_summary_generated: contextResult.business_summary_generated,
            ideal_customer_profile: contextResult.ideal_customer_profile,
            operational_metadata: contextResult.operational_metadata,
            
            // Metadata
            context_version: 'v1.0',
            context_generated_at: new Date().toISOString(),
            context_manually_edited: false
          });

          console.log('[BusinessContextWorkflow] STEP 3: Business profile created successfully');
          console.log('[BusinessContextWorkflow] STEP 3: Profile ID:', profile.id);
          
          return profile.id;
        } catch (error: any) {
          console.error('[BusinessContextWorkflow] STEP 3: FAILED to create business profile');
          console.error('[BusinessContextWorkflow] STEP 3: Error name:', error.name);
          console.error('[BusinessContextWorkflow] STEP 3: Error message:', error.message);
          console.error('[BusinessContextWorkflow] STEP 3: Error stack:', error.stack);
          throw new Error(`Failed to create business profile: ${error.message}`);
        }
      });

      // =========================================================================
      // STEP 4: Mark Complete (100%)
      // =========================================================================
      
      console.log('[BusinessContextWorkflow] STEP 4: Mark Complete - STARTING');
      
      await step.do('mark_complete', async () => {
        console.log('[BusinessContextWorkflow] STEP 4: Calling DO complete endpoint');
        
        const response = await progressDO.fetch('http://do/complete', {
          method: 'POST',
          body: JSON.stringify({
            business_profile_id: businessProfileId,
            ...contextResult
          })
        });

        console.log('[BusinessContextWorkflow] STEP 4: DO complete response status:', response.status);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error('[BusinessContextWorkflow] STEP 4: DO complete FAILED:', errorText);
          throw new Error(`DO complete failed: ${errorText}`);
        }

        console.log('[BusinessContextWorkflow] STEP 4: Mark Complete - COMPLETE');
      });

      console.log('='.repeat(80));
      console.log('[BusinessContextWorkflow] WORKFLOW COMPLETED SUCCESSFULLY');
      console.log('[BusinessContextWorkflow] Run ID:', params.run_id);
      console.log('[BusinessContextWorkflow] Business Profile ID:', businessProfileId);
      console.log('='.repeat(80));

      return {
        success: true,
        run_id: params.run_id,
        business_profile_id: businessProfileId
      };

    } catch (error: any) {
      console.error('='.repeat(80));
      console.error('[BusinessContextWorkflow] WORKFLOW FAILED');
      console.error('[BusinessContextWorkflow] Run ID:', params.run_id);
      console.error('[BusinessContextWorkflow] Error name:', error.name);
      console.error('[BusinessContextWorkflow] Error message:', error.message);
      console.error('[BusinessContextWorkflow] Error stack:', error.stack);
      console.error('='.repeat(80));

      // Mark as failed in progress tracker
      console.log('[BusinessContextWorkflow] Marking as failed in DO');
      
      try {
        await progressDO.fetch('http://do/fail', {
          method: 'POST',
          body: JSON.stringify({ message: error.message })
        });
        console.log('[BusinessContextWorkflow] Successfully marked as failed in DO');
      } catch (doError: any) {
        console.error('[BusinessContextWorkflow] FAILED to mark as failed in DO:', doError.message);
      }

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
    console.log(`[BusinessContextWorkflow] updateProgress: ${progress}% - ${currentStep}`);
    
    try {
      const response = await progressDO.fetch('http://do/update', {
        method: 'POST',
        body: JSON.stringify({
          progress,
          current_step: currentStep,
          status: progress === 100 ? 'complete' : 'processing'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[BusinessContextWorkflow] updateProgress FAILED:', errorText);
        throw new Error(`Update progress failed: ${errorText}`);
      }

      console.log('[BusinessContextWorkflow] updateProgress SUCCESS');
    } catch (error: any) {
      console.error('[BusinessContextWorkflow] updateProgress ERROR:', error.message);
      throw error;
    }
  }

  /**
   * Generate URL-safe slug from business name
   */
  private generateSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 100);
    
    console.log('[BusinessContextWorkflow] generateSlug:', name, '->', slug);
    return slug;
  }
}

export default BusinessContextWorkflow;
