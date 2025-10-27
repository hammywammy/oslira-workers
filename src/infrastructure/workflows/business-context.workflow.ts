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

      // STEP 3: Save to Database
      const businessProfileId = await step.do('save_to_database', async () => {
        await this.updateProgress(progressDO, 70, 'Saving business profile');

        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const businessRepo = new BusinessRepository(supabase);

        // Parse signature name (first name only)
        const signature_name = params.user_inputs.full_name.split(' ')[0];

        const result = await businessRepo.createBusinessProfile({
          account_id: params.account_id,
          full_name: params.user_inputs.full_name,
          signature_name: signature_name,
          business_one_liner: contextResult.business_one_liner,
          business_summary_generated: contextResult.business_summary_generated,
          business_context: contextResult.business_context
        });

        await this.updateProgress(progressDO, 95, 'Profile created');
        console.log('[Workflow] Saved profile:', result.business_profile_id);
        return result.business_profile_id;
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
