// infrastructure/workflows/business-context.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { StripeService } from '@/infrastructure/billing/stripe.service';
import { getSecret } from '@/infrastructure/config/secrets';

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    console.log('[Workflow] Starting for:', params.run_id);

    try {
      // =========================================================================
      // STEP 1: Fetch Secrets
      // =========================================================================
      const secrets = await step.do('fetch_secrets', async () => {
        await this.updateProgress(progressDO, 5, 'Loading configuration');

        const [openaiKey, claudeKey] = await Promise.all([
          getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
          getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV)
        ]);

        await this.updateProgress(progressDO, 10, 'Configuration loaded');
        return { openaiKey, claudeKey };
      });

      // =========================================================================
      // STEP 2: AI Generation
      // =========================================================================
      let contextResult: any;
      await step.do('generate_ai_content', async () => {
        await this.updateProgress(progressDO, 15, 'Generating business tagline');

        const service = new OnboardingService(this.env, secrets.openaiKey, secrets.claudeKey);
        contextResult = await service.generateBusinessContext(params.user_inputs);

        await this.updateProgress(progressDO, 60, 'AI generation complete');
        console.log('[Workflow] AI complete');
      });

      // =========================================================================
      // STEP 3: Save to Database
      // =========================================================================
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[Step3] ENTRY - Saving business profile to database');
        const saveStartTime = Date.now();
        
        try {
          await this.updateProgress(progressDO, 70, 'Saving business profile');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const businessRepo = new BusinessRepository(supabase);

          console.log('[Step3] Calling createBusinessProfile with data:', {
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
          console.log('[Step3] ✓ Database save SUCCESS', {
            duration_ms: saveDuration,
            profile_id: result.business_profile_id,
            was_created: result.was_created
          });

          await this.updateProgress(progressDO, 80, 'Profile created successfully');

          return result.business_profile_id;
          
        } catch (error: any) {
          console.error('[Step3] ✗ Database save FAILED', {
            error_name: error.name,
            error_message: error.message,
            error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
          });
          throw error;
        }
      });

      // =========================================================================
      // STEP 4: Update Stripe Customer Metadata
      // =========================================================================
      await step.do('update_stripe_metadata', async () => {
        console.log('[Step4] ENTRY - Updating Stripe customer metadata');
        const stripeStartTime = Date.now();

        try {
          await this.updateProgress(progressDO, 85, 'Updating Stripe metadata');

          // Fetch stripe_customer_id from accounts table
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const { data: account, error: fetchError } = await supabase
            .from('accounts')
            .select('stripe_customer_id')
            .eq('id', params.account_id)
            .single();

          if (fetchError) {
            console.error('[Step4] ✗ Failed to fetch account', {
              error: fetchError.message,
              account_id: params.account_id
            });
            throw new Error(`Failed to fetch account: ${fetchError.message}`);
          }

          if (!account?.stripe_customer_id) {
            console.warn('[Step4] ⚠ No stripe_customer_id found - skipping metadata update', {
              account_id: params.account_id,
              has_account: !!account
            });
            return;
          }

          // Update Stripe customer metadata
          const stripeService = new StripeService(this.env);
          
          await stripeService.updateCustomerMetadata({
            customer_id: account.stripe_customer_id,
            metadata: {
              business_profile_id: businessProfileId,
              onboarding_completed: 'true',
              onboarding_completed_at: new Date().toISOString(),
            }
          });

          const stripeDuration = Date.now() - stripeStartTime;
          console.log('[Step4] ✓ Stripe metadata update SUCCESS', {
            duration_ms: stripeDuration,
            customer_id: account.stripe_customer_id,
            business_profile_id: businessProfileId,
            metadata_keys: ['business_profile_id', 'onboarding_completed', 'onboarding_completed_at']
          });

          await this.updateProgress(progressDO, 90, 'Stripe metadata updated');

        } catch (error: any) {
          // Log error but DON'T fail entire workflow
          // Stripe metadata is nice-to-have, not critical
          console.error('[Step4] ✗ Stripe metadata update FAILED (NON-FATAL)', {
            error_name: error.name,
            error_message: error.message,
            error_stack: error.stack?.split('\n').slice(0, 3).join('\n'),
            account_id: params.account_id,
            business_profile_id: businessProfileId
          });
          console.warn('[Step4] ⚠ Continuing workflow despite Stripe error');
        }
      });

// STEP 5: Mark Complete
await step.do('mark_complete', async () => {
  console.log('[Workflow] Calling /complete endpoint...');
  
  const completeResponse = await progressDO.fetch('http://do/complete', {
    method: 'POST',
    body: JSON.stringify({
      result: {
        business_profile_id: businessProfileId,
        business_one_liner: contextResult.business_one_liner,
        business_summary_generated: contextResult.business_summary_generated
      }
    })
  });

  if (!completeResponse.ok) {
    const error = await completeResponse.text();
    console.error('[Workflow] /complete endpoint failed:', error);
    throw new Error(`Failed to mark complete: ${error}`);
  }

  const completeData = await completeResponse.json();
  console.log('[Workflow] ✓ Complete endpoint response:', completeData);
  console.log('[Workflow] ========== WORKFLOW COMPLETE ==========');
  
  // ✅ NO MORE UPDATES AFTER THIS - STATUS STAYS 'complete'
});

      console.log('[Workflow] ========== SUCCESS ==========', {
        run_id: params.run_id,
        account_id: params.account_id,
        business_profile_id: businessProfileId
      });

      return { success: true, business_profile_id: businessProfileId };

    } catch (error: any) {
      console.error('[Workflow] ========== FAILED ==========', {
        run_id: params.run_id,
        account_id: params.account_id,
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack?.split('\n').slice(0, 5).join('\n')
      });
      
      await this.markFailed(progressDO, error.message);
      throw error;
    }
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

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
