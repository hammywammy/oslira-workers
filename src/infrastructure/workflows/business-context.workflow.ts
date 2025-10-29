// infrastructure/workflows/business-context.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    console.log('[Workflow] Starting for:', params.run_id);

    try {
      // STEP 1: Fetch Secrets
      const secrets = await step.do('fetch_secrets', async () => {
        await this.updateProgress(progressDO, 5, 'Loading configuration');

        const [openaiKey, claudeKey] = await Promise.all([
          getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
          getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV)
        ]);

        await this.updateProgress(progressDO, 10, 'Configuration loaded');
        return { openaiKey, claudeKey };
      });

      // STEP 2: AI Generation
      let contextResult: any;
      await step.do('generate_ai_content', async () => {
        await this.updateProgress(progressDO, 15, 'Generating business tagline');

        const service = new OnboardingService(this.env, secrets.openaiKey, secrets.claudeKey);
        contextResult = await service.generateBusinessContext(params.user_inputs);

        await this.updateProgress(progressDO, 60, 'AI generation complete');
        console.log('[Workflow] AI complete');
      });

// STEP 2: Save to Database
const businessProfileId = await step.do('save_to_database', async () => {
  console.log('[Step2] ENTRY - Saving business profile to database');
  const saveStartTime = Date.now();
  
  try {
    await this.updateProgress(progressDO, 70, 'Saving business profile');

    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const businessRepo = new BusinessRepository(supabase);

    console.log('[Step2] Calling createBusinessProfile with data:', {
      account_id: params.account_id,
      full_name: params.user_inputs.full_name,
      signature_name: params.user_inputs.signature_name,
      has_business_one_liner: !!contextResult.business_one_liner,
      has_business_summary_generated: !!contextResult.business_summary_generated
    });

    const result = await businessRepo.createBusinessProfile({
      account_id: params.account_id,
      full_name: params.user_inputs.full_name,
      signature_name: params.user_inputs.signature_name,
      business_one_liner: contextResult.business_one_liner,
      business_summary_generated: contextResult.business_summary_generated,
      
      // User inputs for manual JSON construction
      business_summary: params.user_inputs.business_summary,
      communication_tone: params.user_inputs.communication_tone,
      target_description: params.user_inputs.target_description,
      icp_min_followers: params.user_inputs.icp_min_followers,
      icp_max_followers: params.user_inputs.icp_max_followers,
      target_company_sizes: params.user_inputs.target_company_sizes,
      
      // AI generation metadata
      ai_generation_metadata: contextResult.ai_metadata
    });

    const saveDuration = Date.now() - saveStartTime;
    console.log('[Step2] ✓ Database save SUCCESS', {
      duration_ms: saveDuration,
      profile_id: result.business_profile_id,
      was_created: result.was_created
    });

    await this.updateProgress(progressDO, 95, 'Profile created successfully');

    return result.business_profile_id;
    
  } catch (error: any) {
    console.error('[Step2] ✗ Database save FAILED', {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    throw error;
  }
});

      // STEP 4: Complete
      await step.do('mark_complete', async () => {
        await progressDO.fetch('http://do/complete', {
          method: 'POST',
          body: JSON.stringify({
            result: {
              business_profile_id: businessProfileId,
              business_one_liner: contextResult.business_one_liner,
              business_summary_generated: contextResult.business_summary_generated
            }
          })
        });
        console.log('[Workflow] Complete');
      });

      console.log('[Workflow] SUCCESS');
      return { success: true, business_profile_id: businessProfileId };

    } catch (error: any) {
      console.error('[Workflow] FAILED:', error.message);
      await this.markFailed(progressDO, error.message);
      throw error;
    }
  }

  private async updateProgress(progressDO: any, progress: number, step: string): Promise<void> {
    try {
      await progressDO.fetch('http://do/update', {
        method: 'POST',
        body: JSON.stringify({ progress, current_step: step, status: 'processing' })
      });
    } catch (error: any) {
      console.error('[Workflow] Progress update failed:', error.message);
    }
  }

  private async markFailed(progressDO: any, errorMessage: string): Promise<void> {
    await progressDO.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ error_message: errorMessage })
    });
  }
}

export default BusinessContextWorkflow;
