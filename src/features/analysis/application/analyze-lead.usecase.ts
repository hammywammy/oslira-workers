// features/analysis/application/analyze-lead.usecase.ts

import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { LeadsRepository } from '@/infrastructure/database/repositories/leads.repository';
import { AnalysisRepository } from '@/infrastructure/database/repositories/analysis.repository';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { R2CacheService } from '@/infrastructure/cache/r2-cache.service';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { AIAnalysisService } from '@/infrastructure/ai/ai-analysis.service';
import { CostTracker } from '@/infrastructure/monitoring/cost-tracker.service';
import { PerformanceTracker } from '@/infrastructure/monitoring/performance-tracker.service';
import { getSecret } from '@/infrastructure/config/secrets';
import { generateId } from '@/shared/utils/id.util';
import { getCreditCost, getPostsLimit, getScrapingCost } from '@/config/operations-pricing.config';

/**
 * ANALYZE LEAD USE CASE
 *
 * Orchestrates the complete 12-step analysis flow:
 * 1. Generate run_id
 * 2. Check for duplicate in-progress analysis
 * 3. Verify sufficient credits
 * 4. Deduct credits IMMEDIATELY (atomic, prevents race conditions)
 * 5. Check R2 cache for profile
 * 6. [Cache miss] Scrape profile via Apify
 * 7. Store scraped profile in R2 cache
 * 8. Execute AI analysis (light only - extensible framework)
 * 9. Upsert lead record
 * 10. Save analysis results
 * 11. Track costs & performance
 * 12. Return formatted response
 *
 * Error Handling:
 * - Duplicate analysis → 409 Conflict
 * - Insufficient credits → 402 Payment Required
 * - Scrape failure → Auto-retry (3 attempts)
 * - AI failure → Refund credits + log error
 */

export interface AnalyzeLeadParams {
  accountId: string;
  businessProfileId: string;
  username: string;
  analysisType: 'light';  // Extensible - add more types as needed
}

export interface AnalyzeLeadResult {
  run_id: string;
  lead_id: string;
  analysis_id: string;
  status: 'complete' | 'failed';
  overall_score: number;
  niche_fit_score: number;
  engagement_score: number;
  summary_text: string;
  outreach_message?: string;  // Reserved for future analysis tiers
  actual_cost: number;
  processing_time_ms: number;
  cache_hit: boolean;
}

export class AnalyzeLeadUseCase {
  private env: Env;
  private costTracker: CostTracker;
  private perfTracker: PerformanceTracker;

  constructor(env: Env) {
    this.env = env;
    this.costTracker = new CostTracker();
    this.perfTracker = new PerformanceTracker();
  }

  /**
   * Execute analysis
   */
  async execute(params: AnalyzeLeadParams): Promise<AnalyzeLeadResult> {
    const startTime = Date.now();
    const runId = generateId('run');

    this.perfTracker.startStep('total');

    try {
      // Step 1-2: Initialize + Check duplicate
      await this.checkForDuplicate(params);

      // Step 3-4: Check credits + Deduct immediately
      const creditsCost = getCreditCost(params.analysisType);
      await this.deductCredits(params.accountId, creditsCost, params.analysisType);

      // Step 5-8: Get profile data (cache or scrape) + Run AI
      const analysisResult = await this.executeAnalysis(params);

      // Step 9: Upsert lead
      this.perfTracker.startStep('upsert_lead');
      const leadId = await this.upsertLead(params, analysisResult.profile);
      this.perfTracker.endStep('upsert_lead');

      // Step 10: Save analysis
      this.perfTracker.startStep('save_analysis');
      const analysisId = await this.saveAnalysis({
        runId,
        leadId,
        accountId: params.accountId,
        businessProfileId: params.businessProfileId,
        analysisType: params.analysisType,
        result: analysisResult.aiResult,
        creditsCharged: creditsCost
      });
      this.perfTracker.endStep('save_analysis');

      // Step 11: Track costs
      await this.trackCosts(runId, {
        apifyCost: analysisResult.apifyCost,
        aiCost: analysisResult.aiResult.total_cost
      });

      // Step 12: Return result
      this.perfTracker.endStep('total');
      const processingTime = Date.now() - startTime;

      return {
        run_id: runId,
        lead_id: leadId,
        analysis_id: analysisId,
        status: 'complete',
        overall_score: analysisResult.aiResult.overall_score,
        niche_fit_score: analysisResult.aiResult.overall_score,  // Light analysis uses overall_score
        engagement_score: analysisResult.aiResult.overall_score,  // Light analysis uses overall_score
        summary_text: analysisResult.aiResult.summary_text,
        outreach_message: undefined,  // Reserved for future analysis tiers
        actual_cost: analysisResult.apifyCost + analysisResult.aiResult.total_cost,
        processing_time_ms: processingTime,
        cache_hit: analysisResult.cacheHit
      };

    } catch (error: any) {
      // On failure, refund credits
      await this.refundCredits(params.accountId, getCreditCost(params.analysisType));

      throw error;
    }
  }

  /**
   * Check for duplicate in-progress analysis
   */
  private async checkForDuplicate(params: AnalyzeLeadParams): Promise<void> {
    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const analysisRepo = new AnalysisRepository(supabase);

    // Find existing lead by username
    const leadsRepo = new LeadsRepository(supabase);
    const existingLead = await leadsRepo.findByUsername(
      params.accountId,
      params.businessProfileId,
      params.username
    );

    if (existingLead) {
      const duplicate = await analysisRepo.findInProgressAnalysis(
        existingLead.id,
        params.accountId
      );

      if (duplicate) {
        throw new Error('Analysis already in progress for this profile');
      }
    }
  }

  /**
   * Deduct credits atomically
   */
  private async deductCredits(
    accountId: string,
    amount: number,
    analysisType: 'light'
  ): Promise<void> {
    this.perfTracker.startStep('deduct_credits');

    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const creditsRepo = new CreditsRepository(supabase);

    const hasCredits = await creditsRepo.hasSufficientCredits(accountId, amount);
    if (!hasCredits) {
      throw new Error('Insufficient credits');
    }

    await creditsRepo.deductCredits(
      accountId,
      amount,
      'analysis',
      `${analysisType} analysis for @${accountId}`
    );

    this.perfTracker.endStep('deduct_credits');
  }

  /**
   * Refund credits on failure
   */
  private async refundCredits(accountId: string, amount: number): Promise<void> {
    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const creditsRepo = new CreditsRepository(supabase);
      
      await creditsRepo.addCredits(accountId, amount, 'refund', 'Analysis failed - refund issued');
    } catch (error) {
      console.error('[RefundCredits] Failed to refund:', error);
      // Don't throw - already in error state
    }
  }

  /**
   * Execute complete analysis (cache check + scrape + AI)
   */
  private async executeAnalysis(params: AnalyzeLeadParams) {
    // Get business profile
    this.perfTracker.startStep('fetch_business_profile');
    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const businessRepo = new BusinessRepository(supabase);
    const business = await businessRepo.findById(params.businessProfileId);
    
    if (!business) {
      throw new Error('Business profile not found');
    }
    this.perfTracker.endStep('fetch_business_profile');

    // Check R2 cache
    this.perfTracker.startStep('check_cache');
    const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
    let profile = await cacheService.get(params.username, params.analysisType);
    let cacheHit = !!profile;
    let apifyCost = 0;
    this.perfTracker.endStep('check_cache');

    // Cache miss - scrape profile
    if (!profile) {
      this.perfTracker.startStep('scrape_profile');
      const apifyToken = await getSecret('APIFY_API_TOKEN', this.env, this.env.APP_ENV);
      const apifyAdapter = new ApifyAdapter(apifyToken);

      const postsLimit = getPostsLimit(params.analysisType);
      profile = await apifyAdapter.scrapeProfile(params.username, postsLimit);

      apifyCost = getScrapingCost(params.analysisType);
      this.costTracker.recordCost('apify', apifyCost);

      this.perfTracker.endStep('scrape_profile');

      // Store in cache
      this.perfTracker.startStep('store_cache');
      await cacheService.set(params.username, profile, params.analysisType);
      this.perfTracker.endStep('store_cache');
    }

    // Execute AI analysis (extensible - add more cases when implementing additional tiers)
    this.perfTracker.startStep('ai_analysis');
    const aiService = await AIAnalysisService.create(this.env);
    const aiResult = await aiService.executeLightAnalysis(business, profile);

    this.costTracker.recordCost('ai', aiResult.total_cost);
    this.perfTracker.endStep('ai_analysis');

    return { profile, aiResult, cacheHit, apifyCost };
  }

  /**
   * Upsert lead record
   */
  private async upsertLead(params: AnalyzeLeadParams, profile: any): Promise<string> {
    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const leadsRepo = new LeadsRepository(supabase);

    const lead = await leadsRepo.upsertLead({
      account_id: params.accountId,
      business_profile_id: params.businessProfileId,
      username: params.username,
      display_name: profile.display_name,
      follower_count: profile.follower_count,
      following_count: profile.following_count,
      post_count: profile.post_count,
      external_url: profile.external_url,
      profile_pic_url: profile.profile_pic_url,
      is_verified: profile.is_verified,
      is_private: profile.is_private,
      is_business_account: profile.is_business_account
    });

    return lead.lead_id;
  }

  /**
   * Save analysis results
   */
  private async saveAnalysis(data: {
    runId: string;
    leadId: string;
    accountId: string;
    businessProfileId: string;
    analysisType: 'light';
    result: any;
    creditsCharged: number;
  }): Promise<string> {
    const supabase = await SupabaseClientFactory.createAdminClient(this.env);
    const analysisRepo = new AnalysisRepository(supabase);

    const analysis = await analysisRepo.createAnalysis({
      run_id: data.runId,
      lead_id: data.leadId,
      account_id: data.accountId,
      business_profile_id: data.businessProfileId,
      analysis_type: data.analysisType,
      status: 'complete'
    });

    // Update with results
    // Structure ai_response JSONB with only analysis results
    // (cost/timing metadata goes to operations_ledger)
    const aiResponse = {
      score: data.result.overall_score,
      summary: data.result.summary_text
    };

    await analysisRepo.updateAnalysis(data.runId, {
      overall_score: data.result.overall_score,
      ai_response: aiResponse,
      status: 'complete',
      completed_at: new Date().toISOString()
    });

    return analysis.id;
  }

  /**
   * Track costs for analytics
   */
  private async trackCosts(runId: string, costs: { apifyCost: number; aiCost: number }): Promise<void> {
    // TODO: Log to Analytics Engine
    console.log(`[CostTracking] Run ${runId}: Apify=$${costs.apifyCost.toFixed(4)}, AI=$${costs.aiCost.toFixed(4)}`);
  }

  // NOTE: Credit cost, posts limit, and scraping cost functions moved to centralized config
  // Use imports from '@/config/operations-pricing.config'
}
