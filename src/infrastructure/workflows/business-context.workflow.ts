// infrastructure/workflows/business-context.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * BUSINESS CONTEXT WORKFLOW
 * 
 * Async orchestration for business context generation
 * 
 * Benefits:
 * - No Worker timeout limits (can run 30+ minutes if needed)
 * - Automatic retry on transient failures
 * - Progress tracking via Durable Object
 * - Clean separation of concerns
 * 
 * Flow:
 * 1. Initialize progress tracker (0%)
 * 2. Generate AI context (4 parallel calls) (33%)
 * 3. Save to database (66%)
 * 4. Complete (100%)
 */

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;

    console.log('[BusinessContextWorkflow] Starting:', params.run_id);

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize Progress Tracker (0%)
      // =========================================================================
      
      await step.do('initialize_progress', async () => {
        await progressDO.fetch('http://do/initialize', {
          method: 'POST',
          body: JSON.stringify({
            run_id: params.run_id,
            account_id: params.account_id
          })
        });

        console.log('[BusinessContextWorkflow] Progress initialized');
      });

      // =========================================================================
      // STEP 2: Generate AI Context (33%)
      // =========================================================================
      
      const contextResult = await step.do('generate_ai_context', async () => {
        await this.updateProgress(progressDO, 33, 'Generating business context with AI');

        // Get API keys
        const openaiKey = await getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV);
        const claudeKey = await getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV);

        // Initialize service
        const service = new OnboardingService(this.env, openaiKey, claudeKey);

        // Execute 4 parallel AI calls
        const result = await service.generateBusinessContext(params.user_inputs);

        console.log('[BusinessContextWorkflow] AI generation complete:', {
          one_liner_length: result.business_one_liner.length,
          summary_length: result.business_summary_generated.length,
          total_cost: result.ai_metadata.total_cost
        });

        return result;
      });

      // =========================================================================
      // STEP 3: Save to Database (66%)
      // =========================================================================
      
      const businessProfileId = await step.do('save_to_database', async () => {
        await this.updateProgress(progressDO, 66, 'Saving business profile');

        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const businessRepo = new BusinessRepository(supabase);

        // Generate business slug
        const slug = this.generateSlug(params.user_inputs.business_name);

        // Insert business profile
        const profile = await businessRepo.createBusinessProfile({
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

        console.log('[BusinessContextWorkflow] Business profile created:', profile.id);

        return profile.id;
      });

      // =========================================================================
      // STEP 4: Mark Complete (100%)
      // =========================================================================
      
      await step.do('mark_complete', async () => {
        await progressDO.fetch('http://do/complete', {
          method: 'POST',
          body: JSON.stringify({
            business_profile_id: businessProfileId,
            ...contextResult
          })
        });

        console.log('[BusinessContextWorkflow] Workflow complete');
      });

      return {
        success: true,
        run_id: params.run_id,
        business_profile_id: businessProfileId
      };

    } catch (error: any) {
      console.error('[BusinessContextWorkflow] Error:', error);

      // Mark as failed in progress tracker
      await progressDO.fetch('http://do/fail', {
        method: 'POST',
        body: JSON.stringify({ message: error.message })
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
    await progressDO.fetch('http://do/update', {
      method: 'POST',
      body: JSON.stringify({
        progress,
        current_step: currentStep,
        status: progress === 100 ? 'complete' : 'processing'
      })
    });
  }

  /**
   * Generate URL-safe slug from business name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 100);
  }
}

// Export the workflow
export default BusinessContextWorkflow;
