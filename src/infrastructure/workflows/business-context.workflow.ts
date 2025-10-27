// infrastructure/workflows/business-context.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextWorkflowParams } from '@/shared/types/business-context.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OnboardingService } from '@/features/onboarding/onboarding.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * BUSINESS CONTEXT GENERATION WORKFLOW - STREAMLINED 4-STEP
 * 
 * Orchestrates business context generation:
 * 1. Fetch secrets (10%)
 * 2. Generate AI content (15-60%)
 * 3. Save to database (70-95%)
 * 4. Complete (100%)
 * 
 * Duration: 8-15 seconds for 2 AI calls
 */

interface CachedSecrets {
  openai_key: string;
  claude_key: string;
}

export class BusinessContextWorkflow extends WorkflowEntrypoint<Env, BusinessContextWorkflowParams> {
  
  async run(event: WorkflowEvent<BusinessContextWorkflowParams>, step: WorkflowStep) {
    const workflowStartTime = Date.now();
    const params = event.payload;

    console.log('='.repeat(80));
    console.log('[Workflow] BUSINESS CONTEXT GENERATION - STREAMLINED 4-STEP');
    console.log('[Workflow] Run ID:', params.run_id);
    console.log('[Workflow] Account ID:', params.account_id);
    console.log('[Workflow] Timestamp:', new Date().toISOString());
    console.log('='.repeat(80));

    // Get progress Durable Object
    const progressId = this.env.BUSINESS_CONTEXT_PROGRESS.idFromName(params.run_id);
    const progressDO = this.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    try {
      // =========================================================================
      // STEP 1: Initialize + Fetch Secrets (0% → 10%)
      // =========================================================================
      const cachedSecrets = await step.do('fetch_secrets', async () => {
        console.log('[Step1] Fetching API secrets...');
        await this.updateProgress(progressDO, 5, 'Loading configuration');

        const [openaiKey, claudeKey] = await Promise.all([
          getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
          getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV)
        ]);

        await this.updateProgress(progressDO, 10, 'Configuration loaded');
        console.log('[Step1] ✓ Secrets fetched');

        return { openai_key: openaiKey, claude_key: claudeKey };
      });

      // =========================================================================
      // STEP 2: AI Generation (10% → 60%)
      // =========================================================================
      let contextResult: any;
      
      // Use step.do for AI generation with intermediate progress updates
      await step.do('generate_ai_content', async () => {
        console.log('[Step2] Starting AI generation...');
        await this.updateProgress(progressDO, 15, 'Generating business tagline');

        const service = new OnboardingService(
          this.env,
          cachedSecrets.openai_key,
          cachedSecrets.claude_key
        );

        // Start AI generation
        const aiStartTime = Date.now();
        contextResult = await service.generateBusinessContext(params.user_inputs);
        const aiDuration = Date.now() - aiStartTime;

        await this.updateProgress(progressDO, 60, 'AI generation complete');
        
        console.log('[Step2] ✓ AI complete', {
          duration_ms: aiDuration,
          cost: contextResult.ai_metadata.total_cost,
          tokens: contextResult.ai_metadata.total_tokens
        });
      });

      // =========================================================================
      // STEP 3: Save to Database (60% → 95%)
      // =========================================================================
      const businessProfileId = await step.do('save_to_database', async () => {
        console.log('[Step3] Saving business profile...');
        await this.updateProgress(progressDO, 70, 'Saving business profile');

        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const businessRepo = new BusinessRepository(supabase);

        // Extract first name from full_name
        const fullName = params.user_inputs.signature_name; // "Hamza Williams"
        const signatureName = fullName.split(' ')[0]; // "Hamza"

        // Extract business name from summary
        const businessName = this.extractBusinessName(params.user_inputs.business_summary);

        const result = await businessRepo.createBusinessProfile({
          account_id: params.account_id,
          full_name: fullName,
          signature_name: signatureName,
          business_name: businessName,
          business_one_liner: contextResult.business_one_liner,
          business_summary: params.user_inputs.business_summary,
          business_summary_generated: contextResult.business_summary_generated,
          website: null, // Not collected in 4-step flow
          industry: contextResult.ideal_customer_profile.industry,
          company_size: contextResult.operational_metadata.company_size,
          target_audience: contextResult.ideal_customer_profile.target_audience,
          icp_min_followers: contextResult.ideal_customer_profile.icp_min_followers,
          icp_max_followers: contextResult.ideal_customer_profile.icp_max_followers,
          brand_voice: contextResult.ideal_customer_profile.brand_voice,
          operational_metadata: contextResult.operational_metadata,
          ai_generation_metadata: contextResult.ai_metadata
        });

        await this.updateProgress(progressDO, 95, 'Profile created successfully');
        
        console.log('[Step3] ✓ Profile saved', {
          profile_id: result.business_profile_id,
          business_name: businessName,
          full_name: fullName,
          signature_name: signatureName
        });

        return result.business_profile_id;
      });

      // =========================================================================
      // STEP 4: Mark Complete (95% → 100%)
      // =========================================================================
      await step.do('mark_complete', async () => {
        console.log('[Step4] Marking complete...');
        
        const response = await progressDO.fetch('http://do/complete', {
          method: 'POST',
          body: JSON.stringify({
            result: {
              business_profile_id: businessProfileId,
              business_one_liner: contextResult.business_one_liner,
              business_summary_generated: contextResult.business_summary_generated
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to mark complete: ${await response.text()}`);
        }

        console.log('[Step4] ✓ Complete');
      });

      const totalDuration = Date.now() - workflowStartTime;
      console.log('[Workflow] ✓ SUCCESS', {
        duration_ms: totalDuration,
        profile_id: businessProfileId
      });
      console.log('='.repeat(80));

      return {
        success: true,
        business_profile_id: businessProfileId,
        duration_ms: totalDuration
      };

    } catch (error: any) {
      console.error('[Workflow] ✗ FAILED', {
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack
      });

      try {
        await this.markFailed(progressDO, error.message);
      } catch (markError) {
        console.error('[Workflow] Failed to mark as failed:', markError);
      }

      throw error;
    }
  }

  /**
   * Extract business name from summary
   * Examples:
   * "Oslira is an AI platform..." → "Oslira"
   * "My business is a marketing agency..." → "Marketing Agency"
   * "I run a copywriting service..." → "Copywriting Service"
   */
  private extractBusinessName(businessSummary: string): string {
    // Try pattern: "BUSINESS_NAME is/provides/offers..."
    const patternMatch = businessSummary.match(/^([A-Z][a-zA-Z0-9\s]+?)\s+(is|provides|offers|helps|enables)/);
    if (patternMatch) {
      return patternMatch[1].trim();
    }

    // Try pattern: "My business/company is NAME"
    const myBusinessMatch = businessSummary.match(/[Mm]y (?:business|company) is (?:a|an) (.+?)[.,]/);
    if (myBusinessMatch) {
      return myBusinessMatch[1].trim();
    }

    // Try pattern: "I run NAME"
    const iRunMatch = businessSummary.match(/I run (?:a|an) (.+?)[.,]/);
    if (iRunMatch) {
      return iRunMatch[1].trim();
    }

    // Default: capitalize first 3 words
    const words = businessSummary.trim().split(/\s+/);
    return words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  private async updateProgress(progressDO: any, progress: number, currentStep: string): Promise<void> {
    try {
      await progressDO.fetch('http://do/update', {
        method: 'POST',
        body: JSON.stringify({ 
          progress, 
          current_step: currentStep, 
          status: 'processing' 
        })
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
