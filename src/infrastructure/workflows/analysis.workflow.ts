// infrastructure/workflows/analysis.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, AnalysisWorkflowParams } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { LeadsRepository } from '@/infrastructure/database/repositories/leads.repository';
import { AnalysisRepository } from '@/infrastructure/database/repositories/analysis.repository';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { R2CacheService } from '@/infrastructure/cache/r2-cache.service';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { AIAnalysisService } from '@/infrastructure/ai/ai-analysis.service';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * ANALYSIS WORKFLOW
 * 
 * Async orchestration for Instagram profile analysis
 * 
 * Benefits over synchronous execution:
 * - No Worker timeout limits (can run 30+ minutes)
 * - Automatic retry on transient failures
 * - Progress tracking via Durable Object
 * - Cancellation support
 * - Cost-effective (only pay for execution time)
 * 
 * Flow:
 * 1. Initialize progress tracker
 * 2. Check duplicate & credits
 * 3. Deduct credits
 * 4. Get/scrape profile
 * 5. Execute AI analysis
 * 6. Save results
 * 7. Update progress to 100%
 */

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  
  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    
    try {
      // Step 1: Initialize progress tracker
      const progressDO = await step.do('initialize_progress', async () => {
        const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
        const stub = this.env.ANALYSIS_PROGRESS.get(id);
        
        await stub.fetch('http://do/initialize', {
          method: 'POST',
          body: JSON.stringify({
            run_id: params.run_id,
            account_id: params.account_id,
            username: params.username,
            analysis_type: params.analysis_type
          })
        });
        
        return stub;
      });

      // Step 2: Check duplicate analysis
      await step.do('check_duplicate', async () => {
        await this.updateProgress(progressDO, 5, 'Checking for duplicates');
        
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const leadsRepo = new LeadsRepository(supabase);
        const analysisRepo = new AnalysisRepository(supabase);
        
        const existingLead = await leadsRepo.findByUsername(
          params.account_id,
          params.business_profile_id,
          params.username
        );
        
        if (existingLead) {
          const duplicate = await analysisRepo.findInProgressAnalysis(
            existingLead.id,
            params.account_id
          );
          
          if (duplicate) {
            throw new Error('Analysis already in progress for this profile');
          }
        }
      });

      // Step 3: Verify & deduct credits
      const creditsCost = this.getCreditCost(params.analysis_type);
      
      await step.do('deduct_credits', async () => {
        await this.updateProgress(progressDO, 10, 'Deducting credits');
        
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const creditsRepo = new CreditsRepository(supabase);
        
        const hasCredits = await creditsRepo.hasSufficientCredits(
          params.account_id,
          creditsCost
        );
        
        if (!hasCredits) {
          throw new Error('Insufficient credits');
        }
        
        await creditsRepo.deductCredits(
          params.account_id,
          creditsCost,
          'analysis',
          `${params.analysis_type} analysis for @${params.username}`
        );
      });

      // Step 4: Get business profile
      const business = await step.do('get_business_profile', async () => {
        await this.updateProgress(progressDO, 15, 'Loading business profile');
        
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const businessRepo = new BusinessRepository(supabase);
        const profile = await businessRepo.findById(params.business_profile_id);
        
        if (!profile) {
          throw new Error('Business profile not found');
        }
        
        return profile;
      });

      // Step 5: Check R2 cache
      let profile = await step.do('check_cache', async () => {
        await this.updateProgress(progressDO, 20, 'Checking cache');
        
        const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
        return await cacheService.get(params.username, params.analysis_type);
      });

      // Step 6: Scrape profile if cache miss
      if (!profile) {
        profile = await step.do('scrape_profile', async () => {
          await this.updateProgress(progressDO, 30, 'Scraping Instagram profile');
          
          const apifyToken = await getSecret('APIFY_API_TOKEN', this.env, this.env.APP_ENV);
          const apifyAdapter = new ApifyAdapter(apifyToken);
          
          const postsLimit = this.getPostsLimit(params.analysis_type);
          const scraped = await apifyAdapter.scrapeProfile(params.username, postsLimit);
          
          // Store in cache
          const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
          await cacheService.set(params.username, scraped, params.analysis_type);
          
          return scraped;
        });
      }

      // Step 7: Execute AI analysis
      const aiResult = await step.do('ai_analysis', async () => {
        await this.updateProgress(progressDO, 50, 'Running AI analysis');
        
        const aiService = await AIAnalysisService.create(this.env);
        
        switch (params.analysis_type) {
          case 'light':
            return await aiService.executeLightAnalysis(business, profile);
          case 'deep':
            return await aiService.executeDeepAnalysis(business, profile);
          case 'xray':
            return await aiService.executeXRayAnalysis(business, profile);
        }
      });

      // Step 8: Upsert lead
      const leadId = await step.do('upsert_lead', async () => {
        await this.updateProgress(progressDO, 80, 'Saving lead data');
        
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const leadsRepo = new LeadsRepository(supabase);
        
        const lead = await leadsRepo.upsertLead({
          account_id: params.account_id,
          business_profile_id: params.business_profile_id,
          instagram_username: params.username,
          display_name: profile.display_name,
          follower_count: profile.follower_count,
          following_count: profile.following_count,
          post_count: profile.post_count,
          bio: profile.bio,
          external_url: profile.external_url,
          profile_pic_url: profile.profile_pic_url,
          is_verified: profile.is_verified,
          is_private: profile.is_private,
          is_business_account: profile.is_business_account
        });
        
        return lead.id;
      });

      // Step 9: Save analysis
      const analysisId = await step.do('save_analysis', async () => {
        await this.updateProgress(progressDO, 90, 'Saving analysis results');
        
        const supabase = await SupabaseClientFactory.createAdminClient(this.env);
        const analysisRepo = new AnalysisRepository(supabase);
        
        const analysis = await analysisRepo.createAnalysis({
          run_id: params.run_id,
          lead_id: leadId,
          account_id: params.account_id,
          business_profile_id: params.business_profile_id,
          analysis_type: params.analysis_type,
          credits_used: creditsCost,
          ai_model_used: aiResult.model_used,
          status: 'complete'
        });
        
        await analysisRepo.updateAnalysis(params.run_id, {
          overall_score: aiResult.overall_score,
          niche_fit_score: aiResult.niche_fit_score,
          engagement_score: aiResult.engagement_score,
          confidence_level: aiResult.confidence_level,
          summary_text: aiResult.summary_text,
          actual_cost: aiResult.total_cost,
          status: 'complete',
          completed_at: new Date().toISOString()
        });
        
        return analysis.id;
      });

// Step 10: Mark complete in progress tracker
await step.do('complete_progress', async () => {
  await progressDO.fetch('http://do/complete', {
    method: 'POST',
    body: JSON.stringify({
      result: {
        lead_id: leadId, // ← CRITICAL: Frontend needs this
        overall_score: aiResult.overall_score,
        niche_fit_score: aiResult.niche_fit_score,
        engagement_score: aiResult.engagement_score,
        confidence_level: aiResult.confidence_level,
        summary_text: aiResult.summary_text,
        outreach_message: aiResult.outreach_message
      }
    })
  });
});

      return {
        success: true,
        run_id: params.run_id,
        lead_id: leadId,
        analysis_id: analysisId
      };

    } catch (error: any) {
      // Refund credits on failure
      await step.do('refund_credits', async () => {
        try {
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const creditsRepo = new CreditsRepository(supabase);
          
          await creditsRepo.addCredits(
            params.account_id,
            creditsCost,
            'refund',
            `Analysis failed: ${error.message}`
          );
        } catch (refundError) {
          console.error('[Workflow] Refund failed:', refundError);
        }
      });

      // Mark as failed in progress tracker
      const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
      const progressDO = this.env.ANALYSIS_PROGRESS.get(id);
      
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
   * Get credit cost by analysis type
   */
  private getCreditCost(type: 'light' | 'deep' | 'xray'): number {
    const costs = { light: 1, deep: 3, xray: 5 };
    return costs[type];
  }

  /**
   * Get posts limit by analysis type
   */
  private getPostsLimit(type: 'light' | 'deep' | 'xray'): number {
    const limits = { light: 6, deep: 12, xray: 12 };
    return limits[type];
  }
}

// Export the workflow
export default AnalysisWorkflow;
