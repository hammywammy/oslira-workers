// infrastructure/workflows/analysis.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, AnalysisWorkflowParams } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { LeadsRepository } from '@/infrastructure/database/repositories/leads.repository';
import { AnalysisRepository } from '@/infrastructure/database/repositories/analysis.repository';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { R2CacheService, type ProfileData as CacheProfileData } from '@/infrastructure/cache/r2-cache.service';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { AIAnalysisService } from '@/infrastructure/ai/ai-analysis.service';
import { getSecret } from '@/infrastructure/config/secrets';
import type { ProfileData as AIProfileData } from '@/infrastructure/ai/prompt-builder.service';

/**
 * ANALYSIS WORKFLOW
 * 
 * CRITICAL: No step retries - fail fast on errors
 */

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {

  /**
   * Serialize error for logging - prevents '#<Object>' in logs
   */
  private serializeError(error: any): any {
    return {
      message: error?.message || String(error),
      name: error?.name,
      code: error?.code,
      detail: error?.detail,
      hint: error?.hint,
      stack: error?.stack,
      cause: error?.cause ? String(error.cause) : undefined
    };
  }

  /**
   * Transform camelCase cache ProfileData to snake_case AI ProfileData
   */
  private transformToAIProfile(cacheProfile: CacheProfileData): AIProfileData {
    return {
      username: cacheProfile.username,
      display_name: cacheProfile.displayName,
      follower_count: cacheProfile.followersCount,
      following_count: cacheProfile.followingCount,
      post_count: cacheProfile.postsCount,
      bio: cacheProfile.bio,
      external_url: cacheProfile.externalUrl,
      is_verified: cacheProfile.isVerified,
      is_private: cacheProfile.isPrivate,
      is_business_account: cacheProfile.isBusinessAccount,
      profile_pic_url: cacheProfile.profilePicUrl,
      posts: cacheProfile.latestPosts.map(post => ({
        id: post.id,
        caption: post.caption,
        like_count: post.likeCount,
        comment_count: post.commentCount,
        timestamp: post.timestamp,
        media_type: post.mediaType,
        media_url: post.mediaUrl
      }))
    };
  }

  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const creditsCost = this.getCreditCost(params.analysis_type);
    
    try {
      console.log(`[Workflow][${params.run_id}] START`, {
        username: params.username,
        type: params.analysis_type,
        credits: creditsCost
      });

      // Step 1: Initialize progress tracker
      await step.do('initialize_progress', {
        retries: { limit: 3, delay: '1 second', backoff: 'exponential' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Initializing progress tracker`);

          const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
          const progressDO = this.env.ANALYSIS_PROGRESS.get(id);

          const initResponse = await progressDO.fetch('http://do/initialize', {
            method: 'POST',
            body: JSON.stringify({
              run_id: params.run_id,
              account_id: params.account_id,
              username: params.username,
              analysis_type: params.analysis_type
            })
          });

          if (!initResponse.ok) {
            const error = await initResponse.text();
            console.error(`[Workflow][${params.run_id}] Failed to initialize progress:`, error);
            throw new Error(`Failed to initialize progress: ${error}`);
          }

          console.log(`[Workflow][${params.run_id}] Progress tracker initialized successfully`);
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 1 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 2: Check duplicate analysis (no retries - fail fast)
      await step.do('check_duplicate', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 2: Checking for duplicates`);
          await this.updateProgress(params.run_id, 5, 'Checking for duplicates');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const leadsRepo = new LeadsRepository(supabase);
          const analysisRepo = new AnalysisRepository(supabase);

          console.log(`[Workflow][${params.run_id}] Looking up existing lead for @${params.username}`);
          const existingLead = await leadsRepo.findByUsername(
            params.account_id,
            params.business_profile_id,
            params.username
          );

          if (existingLead) {
            console.log(`[Workflow][${params.run_id}] Found existing lead:`, existingLead.id);
            const duplicate = await analysisRepo.findInProgressAnalysis(
              existingLead.id,
              params.account_id
            );

            if (duplicate) {
              console.error(`[Workflow][${params.run_id}] Duplicate analysis found:`, duplicate.id);
              throw new Error('Analysis already in progress for this profile');
            }
          }
          console.log(`[Workflow][${params.run_id}] No duplicates found`);
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 2 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 3: Verify & deduct credits (no retries - fail fast on insufficient credits)
      await step.do('deduct_credits', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 3: Verifying credits (cost: ${creditsCost})`);
          await this.updateProgress(params.run_id, 10, 'Verifying credits');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const creditsRepo = new CreditsRepository(supabase);

          const hasCredits = await creditsRepo.hasSufficientCredits(
            params.account_id,
            creditsCost
          );

          if (!hasCredits) {
            console.error(`[Workflow][${params.run_id}] Insufficient credits`);
            // Non-retriable error - fail immediately
            throw new Error('Insufficient credits');
          }

          await creditsRepo.deductCredits(
            params.account_id,
            creditsCost,
            'analysis',
            `${params.analysis_type} analysis for @${params.username}`
          );

          console.log(`[Workflow][${params.run_id}] Credits deducted successfully`);
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 3 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 4: Get business profile
      const business = await step.do('get_business_profile', {
        retries: { limit: 2, delay: '1 second' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 4: Loading business profile`);
          await this.updateProgress(params.run_id, 15, 'Loading business profile');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const businessRepo = new BusinessRepository(supabase);
          const profile = await businessRepo.findById(params.business_profile_id);

          if (!profile) {
            console.error(`[Workflow][${params.run_id}] Business profile not found`);
            throw new Error('Business profile not found');
          }

          console.log(`[Workflow][${params.run_id}] Business profile loaded:`, profile.business_name);
          return profile;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 4 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 5: Check R2 cache
      let profile = await step.do('check_cache', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 5: Checking R2 cache for @${params.username}`);
          await this.updateProgress(params.run_id, 20, 'Checking cache');

          const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
          const cached = await cacheService.get(params.username, params.analysis_type);

          if (cached) {
            console.log(`[Workflow][${params.run_id}] Cache HIT for @${params.username}`);
          } else {
            console.log(`[Workflow][${params.run_id}] Cache MISS for @${params.username}`);
          }

          return cached;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 5 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 6: Scrape profile if cache miss
      if (!profile) {
        profile = await step.do('scrape_profile', {
          retries: { limit: 1, delay: '2 seconds' }
        }, async () => {
          try {
            console.log(`[Workflow][${params.run_id}] Step 6: Scraping Instagram profile @${params.username}`);
            await this.updateProgress(params.run_id, 30, 'Scraping Instagram profile');

            const apifyToken = await getSecret('APIFY_API_TOKEN', this.env, this.env.APP_ENV);
            const apifyAdapter = new ApifyAdapter(apifyToken);

            const postsLimit = this.getPostsLimit(params.analysis_type);
            console.log(`[Workflow][${params.run_id}] Scraping ${postsLimit} posts`);
            const scraped = await apifyAdapter.scrapeProfile(params.username, postsLimit);

            console.log(`[Workflow][${params.run_id}] Scraped profile:`, {
              username: scraped.username,
              followers: scraped.followersCount,
              posts: scraped.latestPosts.length
            });

            // Store in cache
            const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
            await cacheService.set(params.username, scraped, params.analysis_type);
            console.log(`[Workflow][${params.run_id}] Profile cached`);

            return scraped;
          } catch (error: any) {
            console.error(`[Workflow][${params.run_id}] Step 6 FAILED:`, this.serializeError(error));
            throw error;
          }
        });
      }

      // Step 7: Execute AI analysis
      const aiResult = await step.do('ai_analysis', {
        retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 7: Executing AI analysis`);
          await this.updateProgress(params.run_id, 50, 'Running AI analysis');

          // Transform camelCase cache profile to snake_case AI profile
          const aiProfile = this.transformToAIProfile(profile);

          const aiService = await AIAnalysisService.create(this.env);
          const result = await aiService.executeLightAnalysis(business, aiProfile);

          console.log(`[Workflow][${params.run_id}] AI analysis complete:`, {
            score: result.overall_score,
            model: result.model_used,
            cost: result.total_cost,
            tokens: `${result.input_tokens}/${result.output_tokens}`
          });

          return result;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 7 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 8: Upsert lead
      const leadId = await step.do('upsert_lead', {
        retries: { limit: 3, delay: '1 second' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 8: Upserting lead data`);
          await this.updateProgress(params.run_id, 80, 'Saving lead data');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const leadsRepo = new LeadsRepository(supabase);

          // Transform to AI profile format for database (snake_case)
          const aiProfile = this.transformToAIProfile(profile);

          const lead = await leadsRepo.upsertLead({
            account_id: params.account_id,
            business_profile_id: params.business_profile_id,
            username: params.username,
            display_name: aiProfile.display_name,
            follower_count: aiProfile.follower_count,
            following_count: aiProfile.following_count,
            external_url: aiProfile.external_url,
            profile_pic_url: aiProfile.profile_pic_url,
            is_verified: aiProfile.is_verified,
            is_private: aiProfile.is_private,
            is_business_account: aiProfile.is_business_account
          });

          console.log(`[Workflow][${params.run_id}] Lead upserted:`, lead.lead_id);
          return lead.lead_id;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 8 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 9: Save analysis
      const analysisId = await step.do('save_analysis', {
        retries: { limit: 3, delay: '1 second' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 9: Saving analysis results`);
          await this.updateProgress(params.run_id, 90, 'Saving analysis results');

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const analysisRepo = new AnalysisRepository(supabase);

          const analysis = await analysisRepo.createAnalysis({
            run_id: params.run_id,
            lead_id: leadId,
            account_id: params.account_id,
            business_profile_id: params.business_profile_id,
            analysis_type: params.analysis_type,
            status: 'complete'
          });

          console.log(`[Workflow][${params.run_id}] Analysis created:`, analysis.id);

          // Structure ai_response JSONB with all AI result data
          const aiResponse = {
            score: aiResult.overall_score,
            summary: aiResult.summary_text,
            model_used: aiResult.model_used,
            tokens: {
              input: aiResult.input_tokens,
              output: aiResult.output_tokens
            },
            cost_usd: aiResult.total_cost,
            generated_at: new Date().toISOString()
          };

          await analysisRepo.updateAnalysis(params.run_id, {
            overall_score: aiResult.overall_score,
            ai_response: aiResponse,
            total_cost_cents: Math.round(aiResult.total_cost * 100),
            status: 'complete',
            completed_at: new Date().toISOString()
          });

          console.log(`[Workflow][${params.run_id}] Analysis updated with results`);
          return analysis.id;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 9 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 10: Mark complete
      await step.do('complete_progress', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 10: Marking analysis as complete`);

          const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
          const progressDO = this.env.ANALYSIS_PROGRESS.get(id);

          await progressDO.fetch('http://do/complete', {
            method: 'POST',
            body: JSON.stringify({
              result: {
                lead_id: leadId,
                overall_score: aiResult.overall_score,
                summary_text: aiResult.summary_text
              }
            })
          });

          console.log(`[Workflow][${params.run_id}] Progress marked as complete`);
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 10 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      console.log(`[Workflow][${params.run_id}] SUCCESS`, {
        leadId,
        analysisId,
        score: aiResult.overall_score
      });

      return {
        success: true,
        run_id: params.run_id,
        lead_id: leadId,
        analysis_id: analysisId
      };

    } catch (error: any) {
      // Properly serialize error for logging
      const errorDetails = this.serializeError(error);

      console.error(`[Workflow][${params.run_id}] FAILED`, errorDetails);

      // Refund credits on failure (with retry limit)
      await step.do('refund_credits', {
        retries: { limit: 3, delay: '1 second', backoff: 'exponential' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Attempting to refund ${creditsCost} credits`);
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const creditsRepo = new CreditsRepository(supabase);

          await creditsRepo.addCredits(
            params.account_id,
            creditsCost,
            'refund',
            `Analysis failed: ${errorDetails.message}`
          );

          console.log(`[Workflow][${params.run_id}] Credits refunded: ${creditsCost}`);
        } catch (refundError: any) {
          console.error(`[Workflow][${params.run_id}] Refund failed:`, this.serializeError(refundError));
          // Don't throw - we still want to mark the analysis as failed even if refund fails
        }
      });

      // Mark as failed
      await this.markFailed(params.run_id, errorDetails.message || 'Unknown error');

      throw error;
    }
  }

  /**
   * Update progress - gets fresh stub each time (no serialization)
   */
  private async updateProgress(
    runId: string,
    progress: number,
    currentStep: string
  ): Promise<void> {
    console.log(`[Workflow][${runId}] Updating progress: ${progress}% - ${currentStep}`);

    const id = this.env.ANALYSIS_PROGRESS.idFromName(runId);
    const stub = this.env.ANALYSIS_PROGRESS.get(id);

    const response = await stub.fetch('http://do/update', {
      method: 'POST',
      body: JSON.stringify({
        progress,
        current_step: currentStep,
        status: progress === 100 ? 'complete' : 'processing'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Workflow][${runId}] Failed to update progress:`, error);
      throw new Error(`Failed to update progress: ${error}`);
    }
  }

  /**
   * Mark as failed
   */
  private async markFailed(runId: string, errorMessage: string): Promise<void> {
    console.log(`[Workflow][${runId}] Marking analysis as failed: ${errorMessage}`);

    const id = this.env.ANALYSIS_PROGRESS.idFromName(runId);
    const stub = this.env.ANALYSIS_PROGRESS.get(id);

    const response = await stub.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Workflow][${runId}] Failed to mark as failed:`, error);
    } else {
      console.log(`[Workflow][${runId}] Successfully marked as failed`);
    }
  }

  /**
   * Get credit cost by analysis type
   */
  private getCreditCost(type: 'light'): number {
    return 1;
  }

  /**
   * Get posts limit by analysis type
   */
  private getPostsLimit(type: 'light'): number {
    return 6;
  }
}

// Export the workflow
export default AnalysisWorkflow;
