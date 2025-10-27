// infrastructure/workflows/business-context.workflow.ts
// DIAGNOSTIC VERSION - Logs at every possible failure point

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

interface CachedSecrets {
  openai_key: string;
  claude_key: string;
  cached_at: string;
}

// Log at module load
console.log('[WorkflowModule] business-context.workflow.ts loaded');

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  // Log constructor
  constructor(ctx: any, env: Env) {
    console.log('[WorkflowConstructor] ENTRY');
    try {
      super(ctx, env);
      console.log('[WorkflowConstructor] ✓ super() called successfully');
      console.log('[WorkflowConstructor] Env keys:', Object.keys(env).slice(0, 10).join(', '));
    } catch (error: any) {
      console.error('[WorkflowConstructor] ✗ FAILED in super()', {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack
      });
      throw error;
    }
  }
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    console.log('[Workflow] ='.repeat(40));
    console.log('[Workflow] RUN METHOD ENTRY');
    console.log('[Workflow] ='.repeat(40));
    
    let params: BusinessContextWorkflowParams;
    let workflowStartTime: number;
    
    try {
      console.log('[Workflow] Extracting payload...');
      params = event.payload;
      workflowStartTime = Date.now();
      
      console.log('[Workflow] ✓ Payload extracted');
      console.log('[Workflow] Run ID:', params?.run_id || 'MISSING');
      console.log('[Workflow] Account ID:', params?.account_id || 'MISSING');
      
      if (!params) {
        throw new Error('Event payload is null or undefined');
      }
      if (!params.run_id) {
        throw new Error('run_id is missing from payload');
      }
      if (!params.account_id) {
        throw new Error('account_id is missing from payload');
      }
      if (!params.user_inputs) {
        throw new Error('user_inputs is missing from payload');
      }
      
      console.log('[Workflow] ✓ Payload validated');
      
    } catch (error: any) {
      console.error('[Workflow] ✗ FAILED during payload extraction', {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack,
        event_keys: event ? Object.keys(event) : 'event is null',
        payload_type: event?.payload ? typeof event.payload : 'no payload'
      });
      throw error;
    }

    console.log('[Workflow] Timestamp:', new Date().toISOString());
    console.log('[Workflow] Business:', params.user_inputs?.business_name || 'MISSING');
    console.log('[Workflow] Signature:', params.user_inputs?.signature_name || 'MISSING');

    // Get progress Durable Object
    let progressDO: any;
    try {
      console.log('[Workflow] Checking env.BUSINESS_CONTEXT_PROGRESS binding...');
      
      if (!this.env.BUSINESS_CONTEXT_PROGRESS) {
        throw new Error('BUSINESS_CONTEXT_PROGRESS binding is undefined');
      }
      
      console.log('[Workflow] ✓ Binding exists');
      console.log('[Workflow] Getting DO ID from name:', params.run_id);
      
      const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
      console.log('[Workflow] ✓ Got DO ID');
      
      progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);
      console.log('[Workflow] ✓ Got DO stub');
      
    } catch (error: any) {
      console.error('[Workflow] ✗ FAILED getting DO', {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack,
        binding_exists: !!this.env.BUSINESS_CONTEXT_PROGRESS,
        env_keys: Object.keys(this.env).slice(0, 20)
      });
      throw error;
    }

    try {
      console.log('[Workflow] Starting Step 1...');
      
      // STEP 1: Initialize + Fetch Secrets
      const cachedSecrets = await step.do('initialize_and_fetch_secrets', async () => {
        console.log('[Step1] ENTRY');
        const stepStartTime = Date.now();
        
        try {
          // Initialize progress
          console.log('[Step1] Calling DO initialize...');
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
          console.log('[Step1] ✓ Progress initialized');

          // Fetch secrets from AWS
          console.log('[Step1] Fetching secrets from AWS...');
          console.log('[Step1] AWS Region:', this.env.AWS_REGION);
          console.log('[Step1] App Env:', this.env.APP_ENV);
          console.log('[Step1] Has AWS credentials:', !!(this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY));
          
          const [openaiKey, claudeKey] = await Promise.all([
            getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
            getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV)
          ]);
          
          console.log('[Step1] ✓ Secrets fetched', {
            openai_length: openaiKey?.length || 0,
            claude_length: claudeKey?.length || 0
          });

          const secrets: CachedSecrets = {
            openai_key: openaiKey,
            claude_key: claudeKey,
            cached_at: new Date().toISOString()
          };

          const stepDuration = Date.now() - stepStartTime;
          console.log('[Step1] ✓ SUCCESS', { duration_ms: stepDuration });
          
          return secrets;
          
        } catch (error: any) {
          const stepDuration = Date.now() - stepStartTime;
          console.error('[Step1] ✗ FAILED', {
            duration_ms: stepDuration,
            error_name: error.name,
            error_message: error.message,
            error_code: error.code,
            error_stack: error.stack
          });
          throw error;
        }
      });

      console.log('[Workflow] ✓ Step 1 complete, starting AI generation...');
      
      // AI Generation (parallel, outside step.do)
      await this.updateProgress(progressDO, 33, 'Generating business context with AI');
      
      console.log('[Workflow] Initializing OnboardingService...');
      const service = new OnboardingService(
        this.env,
        cachedSecrets.openai_key,
        cachedSecrets.claude_key
      );
      
      console.log('[Workflow] Calling generateBusinessContext...');
      const aiStartTime = Date.now();
      
      const contextResult = await service.generateBusinessContext(params.user_inputs);
      
      const aiDuration = Date.now() - aiStartTime;
      console.log('[Workflow] ✓ AI complete', {
        duration_ms: aiDuration,
        cost: contextResult.ai_metadata.total_cost
      });

      // STEP 2: Save to Database
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[Step2] ENTRY - Saving to database');
        const saveStartTime = Date.now();
        
        try {
          await this.updateProgress(progressDO, 66, 'Saving business profile');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const businessRepo = new BusinessRepository(supabase);

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
          console.log('[Step2] ✓ SUCCESS', {
            duration_ms: saveDuration,
            profile_id: result.business_profile_id
          });

          return result.business_profile_id;
          
        } catch (error: any) {
          console.error('[Step2] ✗ FAILED', {
            error_name: error.name,
            error_message: error.message
          });
          throw error;
        }
      });

      // STEP 3: Mark Complete
      await step.do('mark_complete', async () => {
        console.log('[Step3] ENTRY');
        
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
          throw new Error(`DO complete failed: ${await response.text()}`);
        }

        console.log('[Step3] ✓ SUCCESS');
      });

      const totalDuration = Date.now() - workflowStartTime;
      console.log('[Workflow] ✓ COMPLETE', {
        duration_ms: totalDuration,
        profile_id: businessProfileId
      });

      return {
        success: true,
        business_profile_id: businessProfileId,
        duration_ms: totalDuration
      };

    } catch (error: any) {
      console.error('[Workflow] ✗ WORKFLOW FAILED', {
        error_name: error.name,
        error_message: error.message,
        error_code: error.code,
        error_stack: error.stack
      });

      try {
        await this.markFailed(progressDO, error.message);
      } catch (markError: any) {
        console.error('[Workflow] Failed to mark as failed:', markError.message);
      }

      throw error;
    }
  }

  private async updateProgress(progressDO: any, progress: number, currentStep: string): Promise<void> {
    try {
      await progressDO.fetch('http://do/update', {
        method: 'POST',
        body: JSON.stringify({ progress, current_step: currentStep, status: 'processing' })
      });
    } catch (error: any) {
      console.error('[Workflow] Progress update error:', error.message);
    }
  }

  private async markFailed(progressDO: any, errorMessage: string): Promise<void> {
    try {
      await progressDO.fetch('http://do/fail', {
        method: 'POST',
        body: JSON.stringify({ error_message: errorMessage })
      });
    } catch (error: any) {
      console.error('[Workflow] Mark failed error:', error.message);
    }
  }
}

// Export default for Cloudflare Workers
export default BusinessContextWorkflow;
