// infrastructure/workflows/analysis.workflow.ts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env, AnalysisWorkflowParams } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { LeadsRepository } from '@/infrastructure/database/repositories/leads.repository';
import { AnalysisRepository } from '@/infrastructure/database/repositories/analysis.repository';
import { BusinessRepository } from '@/infrastructure/database/repositories/business.repository';
import { OperationsLedgerRepository } from '@/infrastructure/database/repositories/operations-ledger.repository';
import { R2CacheService, type ProfileData } from '@/infrastructure/cache/r2-cache.service';
import { AvatarCacheService } from '@/infrastructure/cache/avatar-cache.service';
import { ApifyAdapter, type ScrapeResult, type ApifyErrorItem } from '@/infrastructure/scraping/apify.adapter';
import { AIAnalysisService } from '@/infrastructure/ai/ai-analysis.service';
import { getSecret } from '@/infrastructure/config/secrets';
import { toAIProfile, type AIProfileData } from '@/shared/types/profile.types';
import { getStepProgress } from './workflow-progress.config';
import {
  getCreditCost,
  getPostsLimit,
  buildOperationsMetrics,
  type AnalysisType
} from '@/config/operations-pricing.config';
import {
  PreAnalysisChecksService,
  type PreAnalysisChecksSummary,
  type AnalysisResultType
} from '@/infrastructure/analysis-checks';

// Phase 2: Profile Extraction & Score Calculation
import {
  createProfileExtractionService,
  transformToCalculatedMetrics,
  analyzeLeadWithAI,
  fetchBusinessContext,
  type ExtractionOutput,
  type CalculatedMetrics,
  type AIResponsePayload,
  type TextDataForAI
} from '@/infrastructure/extraction';

/**
 * ANALYSIS WORKFLOW
 *
 * CRITICAL: No step retries - fail fast on errors
 */

/**
 * CRITICAL_PROGRESS_STEPS: Only these steps send progress updates to the DO
 * OPTIMIZATION: Reduces 11 HTTP calls → 4 HTTP calls (saves 700-1400ms)
 *
 * Rationale: Users only need to see progress on major, visible steps
 * - scrape_profile: First major wait (45%)
 * - ai_analysis: Longest step (95%)
 * - upsert_lead: Almost done (97%)
 * - complete_progress: Done (100%)
 */
const CRITICAL_PROGRESS_STEPS = new Set([
  'scrape_profile',
  'ai_analysis',
  'upsert_lead',
  'complete_progress'
]);

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

  // Removed: transformToAIProfile method - now using toAIProfile() from @/shared/types/profile.types

  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const creditsCost = getCreditCost(params.analysis_type);
    const workflowStartTime = Date.now();

    // Timing tracker
    const timing = {
      cache_check: 0,
      scraping: 0,
      pre_checks: 0,
      ai_analysis: 0,
      db_upsert: 0,
      cache_hit: false
    };

    // Track scrape error info for pre-analysis checks
    let scrapeErrorInfo: ApifyErrorItem | null = null;

    try {
      console.log(`[Workflow][${params.run_id}] START`, {
        username: params.username,
        type: params.analysis_type,
        credits: creditsCost
      });

      // Step 1: Connect to pre-initialized progress tracker
      // NOTE: DO is now initialized in the API handler BEFORE workflow starts
      // This ensures SSE connections can establish without race conditions
      await step.do('connect_progress', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Connecting to progress tracker`);

          const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
          const progressDO = this.env.ANALYSIS_PROGRESS.get(id);

          // Verify DO was initialized by checking for existing progress state
          const progressResponse = await progressDO.fetch('http://do/progress');
          const progress = await progressResponse.json();

          if (!progress) {
            console.error(`[Workflow][${params.run_id}] Progress tracker not initialized!`);
            throw new Error('Progress tracker not initialized by API handler');
          }

          console.log(`[Workflow][${params.run_id}] Connected to progress tracker successfully`, {
            status: progress.status,
            progress: progress.progress
          });
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 1 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 1b: Fetch secrets early (for Phase 2 AI analysis)
      const secrets = await step.do('fetch_secrets', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 1b: Fetching API secrets`);

          const [openaiKey, claudeKey, aiGatewayToken] = await Promise.all([
            getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
            getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV),
            getSecret('CLOUDFLARE_AI_GATEWAY_TOKEN', this.env, this.env.APP_ENV)
          ]);

          console.log(`[Workflow][${params.run_id}] Secrets fetched successfully`);
          return { openaiKey, claudeKey, aiGatewayToken };
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 1b FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 2: Check duplicate analysis (no retries - fail fast)
      // OPTIMIZED: Uses single JOIN query instead of two sequential queries (saves 2-3s)
      await step.do('check_duplicate', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 2: Checking for duplicates`);
          // NOTE: Progress update moved to critical steps only (see MUST DO #3)

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const analysisRepo = new AnalysisRepository(supabase);

          // ONE query instead of two (findByUsername + findInProgressAnalysis)
          console.log(`[Workflow][${params.run_id}] Checking for in-progress analysis for @${params.username}`);
          const result = await analysisRepo.findLeadWithInProgressAnalysis(
            params.account_id,
            params.business_profile_id,
            params.username,
            params.run_id
          );

          if (result.hasInProgress) {
            console.error(`[Workflow][${params.run_id}] Duplicate analysis found for lead: ${result.leadId}`);
            throw new Error('Analysis already in progress for this profile');
          }

          console.log(`[Workflow][${params.run_id}] No duplicates found (excluding self)`);
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 2 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Steps 3-4: Parallel setup (deduct balance + load business profile)
      // OPTIMIZED: Run in parallel since they don't depend on each other (saves ~500ms)
      // NOTE: Progress update skipped - non-critical step (see CRITICAL_PROGRESS_STEPS)
      const business = await step.do('setup_parallel', async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Steps 3-4: Running setup in parallel`);

          const [_, businessProfile] = await Promise.all([
            // Task 1: Verify & deduct balance (MODULAR - routes to correct credit type)
            (async () => {
              console.log(`[Workflow][${params.run_id}] [Parallel] Verifying balance (cost: ${creditsCost}, type: ${params.analysis_type})`);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const creditsRepo = new CreditsRepository(supabase);

              // MODULAR: Uses analysis type to check correct credit balance
              const hasBalance = await creditsRepo.hasSufficientBalanceForAnalysis(
                params.account_id,
                params.analysis_type as AnalysisType,
                creditsCost
              );

              if (!hasBalance) {
                console.error(`[Workflow][${params.run_id}] Insufficient ${params.analysis_type} analyses balance`);
                throw new Error(`Insufficient ${params.analysis_type} analyses balance`);
              }

              // MODULAR: Deducts from correct credit type based on analysis type
              await creditsRepo.deductForAnalysis(
                params.account_id,
                params.analysis_type as AnalysisType,
                creditsCost,
                'analysis',
                `${params.analysis_type} analysis for @${params.username}`
              );

              console.log(`[Workflow][${params.run_id}] [Parallel] Balance deducted successfully`);
            })(),

            // Task 2: Load business profile
            (async () => {
              console.log(`[Workflow][${params.run_id}] [Parallel] Loading business profile`);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const businessRepo = new BusinessRepository(supabase);
              const profile = await businessRepo.findById(params.business_profile_id);

              if (!profile) {
                console.error(`[Workflow][${params.run_id}] Business profile not found`);
                throw new Error('Business profile not found');
              }

              console.log(`[Workflow][${params.run_id}] [Parallel] Business profile loaded:`, profile.business_name);
              return profile;
            })()
          ]);

          return businessProfile;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Setup parallel FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 5: Check R2 cache
      // NOTE: Progress update skipped - non-critical step (see CRITICAL_PROGRESS_STEPS)
      let profile = await step.do('check_cache', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 5: Checking R2 cache for @${params.username}`);

          const cacheStart = Date.now();
          const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
          const cached = await cacheService.get(params.username, params.analysis_type);
          timing.cache_check = Date.now() - cacheStart;

          if (cached) {
            console.log(`[Workflow][${params.run_id}] Cache HIT for @${params.username}`);
            timing.cache_hit = true;
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
      // Uses scrapeProfileWithMeta to capture error info for pre-analysis checks
      if (!profile) {
        const scrapeResult = await step.do('scrape_profile', {
          retries: { limit: 1, delay: '2 seconds' }
        }, async (): Promise<ScrapeResult> => {
          try {
            console.log(`[Workflow][${params.run_id}] Step 6: Scraping Instagram profile @${params.username}`);
            const stepInfo = getStepProgress(params.analysis_type, 'scrape_profile');
            await this.updateProgress(params.run_id, stepInfo.percentage, stepInfo.description);

            const scrapeStart = Date.now();
            const apifyToken = await getSecret('APIFY_API_TOKEN', this.env, this.env.APP_ENV);
            const apifyAdapter = new ApifyAdapter(apifyToken);

            const postsLimit = getPostsLimit(params.analysis_type);
            console.log(`[Workflow][${params.run_id}] Scraping ${postsLimit} posts`);

            // Use scrapeProfileWithMeta to get detailed error info instead of throwing
            const result = await apifyAdapter.scrapeProfileWithMeta(params.username, postsLimit);
            timing.scraping = Date.now() - scrapeStart;

            if (result.success && result.profile) {
              console.log(`[Workflow][${params.run_id}] Scraped profile:`, {
                username: result.profile.username,
                followers: result.profile.followersCount,
                posts: result.profile.latestPosts.length,
                isPrivate: result.profile.isPrivate
              });

              // Store in cache only if successful
              const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
              await cacheService.set(params.username, result.profile, params.analysis_type);
              console.log(`[Workflow][${params.run_id}] Profile cached`);
            } else {
              console.log(`[Workflow][${params.run_id}] Scrape returned error:`, result.error);
            }

            return result;
          } catch (error: any) {
            console.error(`[Workflow][${params.run_id}] Step 6 FAILED:`, this.serializeError(error));
            // Return as error result instead of throwing
            return {
              success: false,
              error: {
                username: params.username,
                error: 'scrape_error',
                errorDescription: error.message
              }
            };
          }
        });

        // Extract profile and error info from result
        if (scrapeResult.success && scrapeResult.profile) {
          profile = scrapeResult.profile;
        } else {
          scrapeErrorInfo = scrapeResult.error || null;
        }
      }

      // Step 6b: Run pre-analysis checks (private profile, not found, etc.)
      // This step determines if we should bypass AI analysis
      const preChecksResult = await step.do('pre_analysis_checks', async (): Promise<PreAnalysisChecksSummary> => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 6b: Running pre-analysis checks`);

          const checksStart = Date.now();
          const checksService = new PreAnalysisChecksService();

          const result = await checksService.runChecks({
            profile: profile || null,
            rawApifyResponse: scrapeErrorInfo,
            username: params.username,
            accountId: params.account_id,
            businessProfileId: params.business_profile_id,
            requestedAnalysisType: params.analysis_type as AnalysisType,
            icpSettings: businessProfile ? {
              icp_min_followers: businessProfile.icp_min_followers,
              icp_max_followers: businessProfile.icp_max_followers
            } : null
          });

          timing.pre_checks = Date.now() - checksStart;

          console.log(`[Workflow][${params.run_id}] Pre-analysis checks complete:`, {
            allPassed: result.allPassed,
            checksRun: result.checksRun,
            failedCheck: result.failedCheck?.checkName,
            durationMs: result.durationMs
          });

          return result;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 6b FAILED:`, this.serializeError(error));
          // On check error, allow analysis to proceed (fail-open)
          return {
            allPassed: true,
            results: [],
            checksRun: 0,
            durationMs: 0
          };
        }
      });

      // Handle bypassed analysis (private profile, not found, etc.)
      if (!preChecksResult.allPassed && preChecksResult.failedCheck) {
        const failedCheck = preChecksResult.failedCheck;
        console.log(`[Workflow][${params.run_id}] Pre-analysis check failed - bypassing AI analysis`, {
          check: failedCheck.checkName,
          resultType: failedCheck.resultType,
          shouldRefund: failedCheck.shouldRefund
        });

        // Step 6c: Refund if needed (the check said we should)
        // MODULAR: Refunds to correct credit type based on analysis type
        if (failedCheck.shouldRefund) {
          await step.do('refund_for_bypass', {
            retries: { limit: 3, delay: '1 second', backoff: 'exponential' }
          }, async () => {
            try {
              console.log(`[Workflow][${params.run_id}] Refunding ${creditsCost} ${params.analysis_type} analyses for bypassed check`);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const creditsRepo = new CreditsRepository(supabase);

              await creditsRepo.addForAnalysis(
                params.account_id,
                params.analysis_type as AnalysisType,
                creditsCost,
                'refund',
                `Analysis bypassed (${failedCheck.resultType}): @${params.username}`
              );

              console.log(`[Workflow][${params.run_id}] ${params.analysis_type} analyses refunded for bypass`);
            } catch (refundError: any) {
              console.error(`[Workflow][${params.run_id}] Refund failed:`, this.serializeError(refundError));
              // Continue anyway - don't fail the workflow for refund issues
            }
          });
        }

        // Step 6d: Create minimal lead record if we have any profile data
        let bypassLeadId: string | null = null;
        if (profile) {
          bypassLeadId = await step.do('upsert_bypass_lead', {
            retries: { limit: 3, delay: '1 second' }
          }, async () => {
            try {
              console.log(`[Workflow][${params.run_id}] Creating lead record for bypassed profile`);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const leadsRepo = new LeadsRepository(supabase);

              const aiProfile = toAIProfile(profile);

              const lead = await leadsRepo.upsertLead({
                account_id: params.account_id,
                business_profile_id: params.business_profile_id,
                username: params.username,
                display_name: aiProfile.display_name,
                follower_count: aiProfile.follower_count,
                following_count: aiProfile.following_count,
                post_count: aiProfile.post_count,
                external_url: aiProfile.external_url,
                profile_pic_url: aiProfile.profile_pic_url,
                is_verified: aiProfile.is_verified,
                is_private: aiProfile.is_private,
                is_business_account: aiProfile.is_business_account
              });

              console.log(`[Workflow][${params.run_id}] Bypass lead created: ${lead.lead_id}`);
              return lead.lead_id;
            } catch (error: any) {
              console.error(`[Workflow][${params.run_id}] Bypass lead creation failed:`, this.serializeError(error));
              return null;
            }
          });
        }

        // Step 6e: Save bypassed analysis result
        const bypassAnalysisId = await step.do('save_bypass_analysis', {
          retries: { limit: 3, delay: '1 second' }
        }, async () => {
          try {
            console.log(`[Workflow][${params.run_id}] Saving bypassed analysis record`);
            const supabase = await SupabaseClientFactory.createAdminClient(this.env);
            const analysisRepo = new AnalysisRepository(supabase);

            const aiResponse = {
              score: failedCheck.score ?? 0,
              summary: failedCheck.summary || `Unable to analyze: ${failedCheck.reason}`,
              bypassed: true,
              bypass_reason: failedCheck.reason,
              bypass_check: failedCheck.checkName
            };

            const analysis = await analysisRepo.updateAnalysis(params.run_id, {
              overall_score: failedCheck.score ?? 0,
              ai_response: aiResponse,
              analysis_type: failedCheck.resultType as AnalysisResultType,
              status: 'complete',
              completed_at: new Date().toISOString()
            });

            console.log(`[Workflow][${params.run_id}] Bypass analysis saved:`, analysis.id);
            return analysis.id;
          } catch (error: any) {
            console.error(`[Workflow][${params.run_id}] Bypass analysis save failed:`, this.serializeError(error));
            throw error;
          }
        });

        // Step 6f: Mark complete in progress tracker
        await step.do('complete_bypass_progress', {
          retries: { limit: 2, delay: '500 milliseconds' }
        }, async () => {
          try {
            console.log(`[Workflow][${params.run_id}] Marking bypassed analysis as complete`);

            const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
            const progressDO = this.env.ANALYSIS_PROGRESS.get(id);

            await progressDO.fetch('http://do/complete', {
              method: 'POST',
              body: JSON.stringify({
                result: {
                  lead_id: bypassLeadId,
                  overall_score: failedCheck.score ?? 0,
                  summary_text: failedCheck.summary || `Unable to analyze: ${failedCheck.reason}`,
                  bypassed: true,
                  bypass_reason: failedCheck.resultType
                }
              })
            });

            console.log(`[Workflow][${params.run_id}] Bypass progress marked as complete`);
          } catch (error: any) {
            console.error(`[Workflow][${params.run_id}] Bypass progress complete failed:`, this.serializeError(error));
          }
        });

        console.log(`[Workflow][${params.run_id}] BYPASSED (${failedCheck.resultType})`, {
          leadId: bypassLeadId,
          analysisId: bypassAnalysisId,
          reason: failedCheck.reason
        });

        // Return early - skip AI analysis and remaining steps
        return {
          success: true,
          run_id: params.run_id,
          lead_id: bypassLeadId,
          analysis_id: bypassAnalysisId,
          bypassed: true,
          bypass_reason: failedCheck.resultType
        };
      }

      // Safety check: profile should not be null at this point
      // (ProfileNotFoundCheck should have caught null profiles)
      if (!profile) {
        throw new Error('Profile data is null - this should have been caught by pre-analysis checks');
      }

      // Step 6c: Phase 2 - Extract metrics and calculate scores
      // This runs the comprehensive profile extraction and score calculation
      let calculatedMetrics: CalculatedMetrics | null = null;
      let textDataForAI: TextDataForAI | null = null;
      let phase2AIResponse: AIResponsePayload | null = null;

      const phase2Result = await step.do('extract_and_score', {
        retries: { limit: 1, delay: '1 second' }
      }, async (): Promise<{ calculatedMetrics: CalculatedMetrics | null; textDataForAI: TextDataForAI | null }> => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 6c: Phase 2 - Extracting metrics and calculating scores`);

          // Run profile extraction service
          const extractor = createProfileExtractionService();
          const extractionResult: ExtractionOutput = extractor.extract(profile);

          if (!extractionResult.success) {
            console.warn(`[Workflow][${params.run_id}] Phase 2 extraction failed:`, extractionResult.error);
            return { calculatedMetrics: null, textDataForAI: null };
          }

          // Transform to CalculatedMetrics format (includes scores and gaps)
          const metrics = transformToCalculatedMetrics(extractionResult.data);

          console.log(`[Workflow][${params.run_id}] Phase 2 extraction complete:`, {
            sampleSize: metrics.sampleSize,
            scores: metrics.scores,
            gaps: metrics.gaps
          });

          return {
            calculatedMetrics: metrics,
            textDataForAI: extractionResult.data.textDataForAI
          };

        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Phase 2 extraction error (non-fatal):`, this.serializeError(error));
          // Return null to fall back to old system
          return { calculatedMetrics: null, textDataForAI: null };
        }
      });

      calculatedMetrics = phase2Result.calculatedMetrics;
      textDataForAI = phase2Result.textDataForAI;

      // Step 6d: Phase 2 - Run GPT-5 Lead Analysis (if extraction succeeded)
      if (calculatedMetrics && textDataForAI) {
        phase2AIResponse = await step.do('phase2_ai_analysis', {
          retries: { limit: 1, delay: '2 seconds' }
        }, async (): Promise<AIResponsePayload | null> => {
          try {
            console.log(`[Workflow][${params.run_id}] Step 6d: Phase 2 - Running GPT-5 lead analysis`);

            // Fetch business context for AI prompt
            const supabase = await SupabaseClientFactory.createAdminClient(this.env);
            const businessContextResult = await fetchBusinessContext(supabase, params.business_profile_id);

            if (!businessContextResult.success) {
              console.warn(`[Workflow][${params.run_id}] Failed to fetch business context:`, businessContextResult.error);
              return null;
            }

            // Run GPT-5 lead analysis
            const aiResult = await analyzeLeadWithAI(
              {
                calculatedMetrics: calculatedMetrics!,
                textData: textDataForAI!,
                businessContext: businessContextResult.data
              },
              this.env,
              secrets.openaiKey,
              secrets.claudeKey,
              secrets.aiGatewayToken
            );

            if (!aiResult.success) {
              console.warn(`[Workflow][${params.run_id}] Phase 2 AI analysis failed:`, aiResult.error);
              return null;
            }

            console.log(`[Workflow][${params.run_id}] Phase 2 AI analysis complete:`, {
              leadTier: aiResult.data.analysis.leadTier,
              confidence: aiResult.data.analysis.confidence,
              tokensUsed: aiResult.data.tokenUsage
            });

            return aiResult.data;

          } catch (error: any) {
            console.error(`[Workflow][${params.run_id}] Phase 2 AI analysis error (non-fatal):`, this.serializeError(error));
            return null;
          }
        });
      }

      // Step 7: Execute AI analysis
      // MODULAR: Routes to correct analysis execution based on type
      const aiResult = await step.do('ai_analysis', {
        retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 7: Executing ${params.analysis_type} AI analysis`);
          const stepInfo = getStepProgress(params.analysis_type as AnalysisType, 'ai_analysis');
          await this.updateProgress(params.run_id, stepInfo.percentage, stepInfo.description);

          const aiStart = Date.now();
          // Transform camelCase cache profile to snake_case AI profile
          const aiProfile = toAIProfile(profile!);

          const aiService = await AIAnalysisService.create(this.env);
          // MODULAR: executeAnalysis routes to correct method based on analysis type
          const result = await aiService.executeAnalysis(params.analysis_type as AnalysisType, business, aiProfile);
          timing.ai_analysis = Date.now() - aiStart;

          console.log(`[Workflow][${params.run_id}] ${params.analysis_type} AI analysis complete:`, {
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

      // Step 8: Upsert lead (avatar caching moved off critical path)
      // OPTIMIZED: Avatar caching is now fire-and-forget (saves 1-2s)
      const leadId = await step.do('upsert_lead', {
        retries: { limit: 3, delay: '1 second' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 8: Upserting lead data`);
          const stepInfo = getStepProgress(params.analysis_type, 'upsert_lead');
          await this.updateProgress(params.run_id, stepInfo.percentage, stepInfo.description);

          const upsertStart = Date.now();
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const leadsRepo = new LeadsRepository(supabase);

          // Transform to AI profile format for database (snake_case)
          const aiProfile = toAIProfile(profile);

          // Step 8a: Upsert lead with Instagram URL first (to get lead_id)
          const lead = await leadsRepo.upsertLead({
            account_id: params.account_id,
            business_profile_id: params.business_profile_id,
            username: params.username,
            display_name: aiProfile.display_name,
            follower_count: aiProfile.follower_count,
            following_count: aiProfile.following_count,
            post_count: aiProfile.post_count,
            external_url: aiProfile.external_url,
            profile_pic_url: aiProfile.profile_pic_url, // Instagram URL initially
            is_verified: aiProfile.is_verified,
            is_private: aiProfile.is_private,
            is_business_account: aiProfile.is_business_account
          });

          console.log(`[Workflow][${params.run_id}] Lead upserted: ${lead.lead_id}`);

          // Step 8b: Cache avatar to R2 (FIRE-AND-FORGET - don't wait)
          // This saves 1-2s on the critical path while still caching the avatar
          if (aiProfile.profile_pic_url) {
            const avatarService = new AvatarCacheService(this.env.R2_MEDIA_BUCKET);
            const leadIdForClosure = lead.lead_id;
            const profilePicUrl = aiProfile.profile_pic_url;

            // Fire-and-forget: don't await, just start the async operation
            avatarService.cacheAvatar(leadIdForClosure, profilePicUrl)
              .then(async (r2Url) => {
                if (r2Url) {
                  // Update lead with R2 URL in background
                  const bgSupabase = await SupabaseClientFactory.createAdminClient(this.env);
                  await bgSupabase
                    .from('leads')
                    .update({ profile_pic_url: r2Url })
                    .eq('id', leadIdForClosure);
                  console.log(`[Workflow][${params.run_id}] Background: Avatar cached and lead updated`);
                }
              })
              .catch((err) => {
                console.error(`[Workflow][${params.run_id}] Background avatar cache failed:`, err);
              });

            console.log(`[Workflow][${params.run_id}] Avatar caching started in background`);
          }

          timing.db_upsert = Date.now() - upsertStart;
          return lead.lead_id;
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 8 FAILED:`, this.serializeError(error));
          throw error;
        }
      });

      // Step 9: Save analysis
      // NOTE: Progress update skipped - non-critical step (see CRITICAL_PROGRESS_STEPS)
      const analysisId = await step.do('save_analysis', {
        retries: { limit: 3, delay: '1 second' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 9: Updating existing analysis record with results`);

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const analysisRepo = new AnalysisRepository(supabase);

          // Structure ai_response JSONB - merge old format with Phase 2 if available
          // Old format: { score, summary } for backward compatibility
          // Phase 2 format: Full AIResponsePayload with leadTier, confidence, etc.
          const aiResponse: any = {
            // Always include basic fields (backward compat)
            score: aiResult.overall_score,
            summary: aiResult.summary_text
          };

          // Merge Phase 2 AI response if available
          if (phase2AIResponse) {
            aiResponse.phase2 = phase2AIResponse;
            console.log(`[Workflow][${params.run_id}] Including Phase 2 AI response:`, {
              leadTier: phase2AIResponse.analysis.leadTier,
              confidence: phase2AIResponse.analysis.confidence
            });
          }

          // UPDATE existing analysis record (created in handler before workflow started)
          // Include calculated_metrics from Phase 2 extraction if available
          const analysis = await analysisRepo.updateAnalysis(params.run_id, {
            overall_score: aiResult.overall_score,
            ai_response: aiResponse,
            calculated_metrics: calculatedMetrics || undefined,
            status: 'complete',
            completed_at: new Date().toISOString()
          });

          console.log(`[Workflow][${params.run_id}] Analysis updated with results:`, analysis.id);
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

      // Step 11: Log to operations ledger (using centralized pricing config)
      await step.do('log_operations', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 11: Logging to operations ledger`);

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const operationsRepo = new OperationsLedgerRepository(supabase);

          const totalDuration = Date.now() - workflowStartTime;

          // Build metrics using centralized config (handles pricing, actor ID, etc.)
          const metrics = buildOperationsMetrics({
            analysisType: params.analysis_type as AnalysisType,
            aiCost: aiResult.total_cost,
            aiModel: aiResult.model_used,
            tokensIn: aiResult.input_tokens,
            tokensOut: aiResult.output_tokens,
            cacheHit: timing.cache_hit,
            timing: {
              cache_check: timing.cache_check,
              scraping: timing.scraping > 0 ? timing.scraping : undefined,
              ai_analysis: timing.ai_analysis,
              db_upsert: timing.db_upsert,
              total_ms: totalDuration
            }
          });

          await operationsRepo.logOperation({
            account_id: params.account_id,
            operation_type: 'analysis',
            operation_id: params.run_id,
            analysis_type: params.analysis_type,
            username: params.username,
            metrics
          });

          console.log(`[Workflow][${params.run_id}] Operations logged`, {
            total_cost: metrics.cost.total_usd,
            total_duration_ms: metrics.duration.total_ms
          });
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 11 FAILED (non-fatal):`, this.serializeError(error));
          // Don't throw - logging failures shouldn't break the workflow
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

      // Refund analyses balance on failure (with retry limit)
      // MODULAR: Refunds to correct credit type based on analysis type
      await step.do('refund_balance', {
        retries: { limit: 3, delay: '1 second', backoff: 'exponential' }
      }, async () => {
        try {
          console.log(`[Workflow][${params.run_id}] Attempting to refund ${creditsCost} ${params.analysis_type} analyses`);
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const creditsRepo = new CreditsRepository(supabase);

          await creditsRepo.addForAnalysis(
            params.account_id,
            params.analysis_type as AnalysisType,
            creditsCost,
            'refund',
            `Analysis failed: ${errorDetails.message}`
          );

          console.log(`[Workflow][${params.run_id}] ${params.analysis_type} analyses refunded: ${creditsCost}`);
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
   * Mark as failed - updates both DO and database
   */
  private async markFailed(runId: string, errorMessage: string): Promise<void> {
    console.log(`[Workflow][${runId}] Marking analysis as failed: ${errorMessage}`);

    // Update Durable Object
    const id = this.env.ANALYSIS_PROGRESS.idFromName(runId);
    const stub = this.env.ANALYSIS_PROGRESS.get(id);

    const response = await stub.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Workflow][${runId}] Failed to mark DO as failed:`, error);
    } else {
      console.log(`[Workflow][${runId}] Successfully marked DO as failed`);
    }

    // Update database record so getActiveAnalyses stops returning this job
    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const analysisRepo = new AnalysisRepository(supabase);

      await analysisRepo.updateAnalysis(runId, {
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date().toISOString()
      });

      console.log(`[Workflow][${runId}] Successfully updated database analysis status to failed`);
    } catch (dbError: any) {
      console.error(`[Workflow][${runId}] Failed to update database:`, this.serializeError(dbError));
      // Don't throw - we still want the workflow to complete even if DB update fails
    }
  }

}

// Export the workflow
export default AnalysisWorkflow;
