// infrastructure/workflows/business-context.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { StripeService } from '@/infrastructure/billing/stripe.service';
import { getSecret } from '@/infrastructure/config/secrets';
import { logger } from '@/shared/utils/logger.util';

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    // Context for structured logging
    const logContext = {
      runId: params.run_id,
      accountId: params.account_id
    };

    logger.info('Business context workflow started', logContext);

    try {
      // =========================================================================
      // STEP 1: Fetch Secrets (no progress update - quick operation)
      // =========================================================================
      const secrets = await step.do('fetch_secrets', async () => {
        const [openaiKey, claudeKey, aiGatewayToken] = await Promise.all([
          getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
          getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV),
          getSecret('CLOUDFLARE_AI_GATEWAY_TOKEN', this.env, this.env.APP_ENV)
        ]);

        return { openaiKey, claudeKey, aiGatewayToken };
      });

      // =========================================================================
      // STEP 2: AI Generation (UPDATE 1: 10%, UPDATE 2: 70%)
      // =========================================================================
      let contextResult: any;
      await step.do('generate_ai_content', async () => {
        // UPDATE 1: Start AI generation
        await this.updateProgress(progressDO, 10, 'Generating AI content...');

        const service = new OnboardingService(this.env, secrets.openaiKey, secrets.claudeKey, secrets.aiGatewayToken);
        contextResult = await service.generateBusinessContext(params.user_inputs);

        // UPDATE 2: AI complete, saving to database
        await this.updateProgress(progressDO, 70, 'Saving to database...');
        logger.info('AI generation complete', logContext);
      });

      // =========================================================================
      // STEP 3: Save to Database (no progress update - 70% already set)
      // =========================================================================
      const businessProfileId = await step.do('save_to_database', async () => {
        logger.info('Saving business profile to database', logContext);
        const saveStartTime = Date.now();

        try {
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const businessRepo = new BusinessRepository(supabase);

          logger.info('Creating business profile', {
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
            business_name: params.user_inputs.business_name,
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
          logger.info('Business profile saved successfully', {
            duration_ms: saveDuration,
            profile_id: result.business_profile_id,
            was_created: result.was_created
          });

          return result.business_profile_id;

        } catch (error: any) {
          logger.error('Business profile save failed', { ...logContext, error: {
            error_name: error.name,
            error_message: error.message,
            error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
          } });
          throw error;
        }
      });

// =========================================================================
// STEP 4: Mark Business Profile as Onboarded (no progress update)
// =========================================================================
await step.do('mark_business_onboarded', async () => {
  logger.info('Marking business profile as onboarded', logContext);

  const supabase = await SupabaseClientFactory.createAdminClient(this.env);

  const { error: dbUpdateError } = await supabase
    .from('business_profiles')
    .update({
      onboarding_completed: true,
      onboarding_completed_at: new Date().toISOString()
    })
    .eq('id', businessProfileId);

  if (dbUpdateError) {
    logger.error('Failed to mark business onboarded', { ...logContext, error: {
      error: dbUpdateError.message,
      error_code: dbUpdateError.code,
      business_profile_id: businessProfileId
    } });
    throw new Error(`Failed to mark business onboarded: ${dbUpdateError.message}`);
  }

  logger.info('Business marked as onboarded', {
    business_profile_id: businessProfileId
  });
});

// =========================================================================
// STEP 5: Link Stripe Customer to Subscription (no progress update)
// =========================================================================
await step.do('link_stripe_to_subscription', async () => {
  logger.info('Linking Stripe customer to subscription', logContext);

  try {
    const supabase = await SupabaseClientFactory.createAdminClient(this.env);

    const isProduction = this.env.APP_ENV === 'production';
    const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('stripe_customer_id_test, stripe_customer_id_live')
      .eq('id', params.account_id)
      .single();

    const stripeCustomerId = isProduction
      ? account?.stripe_customer_id_live
      : account?.stripe_customer_id_test;

    if (accountError || !stripeCustomerId) {
      logger.warn('No stripe_customer_id found - skipping subscription link', { ...logContext, account_id: params.account_id, has_account: !!account, error: accountError?.message });
      return;
    }

    // Update subscription with environment-specific column
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({ [columnName]: stripeCustomerId })
      .eq('account_id', params.account_id);

    if (updateError) {
      logger.error('Failed to update subscription with stripe_customer_id', { ...logContext, error_code: updateError.code, error_message: updateError.message, account_id: params.account_id, stripe_customer_id: stripeCustomerId });
    } else {
      logger.info('Subscription linked to Stripe customer', {
        account_id: params.account_id,
        stripe_customer_id: stripeCustomerId
      });
    }

    // Update Stripe customer metadata with business context
    const { StripeService } = await import('@/infrastructure/billing/stripe.service');
    const stripeService = new StripeService(this.env);

    await stripeService.updateCustomerMetadata({
      customer_id: stripeCustomerId,
      metadata: {
        business_profile_id: businessProfileId,
        onboarding_completed: 'true',
        onboarding_completed_at: new Date().toISOString(),
        business_name: params.user_inputs.business_name,
        signature_name: params.user_inputs.signature_name
      }
    });

    logger.info('Stripe customer metadata updated', logContext);

  } catch (error: any) {
    // Non-fatal - log and continue
    logger.error('Subscription/Stripe update failed (non-fatal)', { ...logContext, error_message: error.message, account_id: params.account_id });
  }
});

// =========================================================================
// STEP 6: Mark Complete (UPDATE 3: 100% via /complete endpoint)
// =========================================================================
await step.do('mark_complete', async () => {
  logger.info('Calling complete endpoint', logContext);

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
    logger.error('Complete endpoint failed', { ...logContext, error });
    throw new Error(`Failed to mark complete: ${error}`);
  }

  const completeData = await completeResponse.json();
  logger.info('Complete endpoint response', completeData);
  logger.info('Business context workflow complete', logContext);
});

      logger.info('Workflow completed successfully', {
        run_id: params.run_id,
        account_id: params.account_id,
        business_profile_id: businessProfileId
      });

      return { success: true, business_profile_id: businessProfileId };

    } catch (error: any) {
      logger.error('Workflow failed', {
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
      logger.error('Progress update failed', { runId, error: error.message });
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
