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
import { logger } from '@/shared/utils/logger.util';

// Phase 2: Profile Extraction & Data Transformation
import {
  createProfileExtractionService,
  transformToExtractedData,
  analyzeLeadWithAI,
  fetchBusinessContext,
  detectNiche,
  calculateLeadTier,
  type ExtractionOutput,
  type ExtractedData,
  type AIResponsePayload,
  type TextDataForAI,
  type ApifyFullProfile,
  type NicheDetectionOutput
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

/**
 * Convert ProfileData (cache format) to ApifyFullProfile (extraction format)
 * Handles field name mismatches: likeCount → likesCount, commentCount → commentsCount
 * Preserves rich metadata (hashtags, mentions, locations, video data) for accurate analysis
 */
function profileDataToApifyFormat(profile: ProfileData): ApifyFullProfile {
  return {
    id: profile.username,
    username: profile.username,
    fullName: profile.displayName,
    biography: profile.bio,
    externalUrl: profile.externalUrl,
    externalUrls: profile.externalUrl ? [{ title: 'External Link', url: profile.externalUrl }] : [],
    profilePicUrl: profile.profilePicUrl,
    followersCount: profile.followersCount,
    followsCount: profile.followingCount,
    postsCount: profile.postsCount,
    verified: profile.isVerified,
    private: profile.isPrivate,
    isBusinessAccount: profile.isBusinessAccount,
    hasChannel: false,
    businessCategoryName: null,
    latestPosts: profile.latestPosts.map(post => ({
      id: post.id,
      shortCode: post.id,
      caption: post.caption,
      likesCount: post.likeCount,
      commentsCount: post.commentCount,
      timestamp: post.timestamp,
      type: mapMediaTypeToApify(post.mediaType, post.productType),
      productType: post.productType as 'feed' | 'clips' | 'igtv' | undefined,
      displayUrl: post.mediaUrl || '',
      videoUrl: post.videoUrl || undefined,
      videoViewCount: post.videoViewCount || undefined,
      hashtags: post.hashtags || [],
      mentions: post.mentions || [],
      taggedUsers: [],
      locationName: post.locationName || null,
      locationId: null,
      alt: null,
      isCommentsDisabled: false
    }))
  };
}

/**
 * Map ProfileData mediaType back to Apify format
 * Considers productType for accurate Reels detection
 */
function mapMediaTypeToApify(
  mediaType: 'photo' | 'video' | 'carousel',
  productType?: string | null
): 'Image' | 'Video' | 'Sidecar' {
  // Reels (productType='clips') are always Videos
  if (productType === 'clips') return 'Video';
  if (mediaType === 'video') return 'Video';
  if (mediaType === 'carousel') return 'Sidecar';
  return 'Image';
}

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

    // Context for structured logging
    const logContext = {
      runId: params.run_id,
      username: params.username,
      accountId: params.account_id,
      analysisType: params.analysis_type
    };

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
      logger.info('Analysis workflow started', {
        ...logContext,
        credits: creditsCost
      });

      // Step 1: Connect to pre-initialized progress tracker
      // NOTE: DO is now initialized in the API handler BEFORE workflow starts
      // This ensures SSE connections can establish without race conditions
      await step.do('connect_progress', async () => {
        try {
          logger.info('Connecting to progress tracker', logContext);

          const id = this.env.ANALYSIS_PROGRESS.idFromName(params.run_id);
          const progressDO = this.env.ANALYSIS_PROGRESS.get(id);

          // Verify DO was initialized by checking for existing progress state
          const progressResponse = await progressDO.fetch('http://do/progress');
          const progress = await progressResponse.json();

          if (!progress) {
            logger.error('Progress tracker not initialized', logContext);
            throw new Error('Progress tracker not initialized by API handler');
          }

          logger.info('Connected to progress tracker successfully', {
            ...logContext,
            status: progress.status,
            progress: progress.progress
          });
        } catch (error: any) {
          logger.error('Step 1 (connect_progress) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
          throw error;
        }
      });

      // Step 1b: Fetch secrets early (for Phase 2 AI analysis)
      const secrets = await step.do('fetch_secrets', async () => {
        try {
          logger.info('Fetching API secrets', logContext);

          const [openaiKey, claudeKey, aiGatewayToken] = await Promise.all([
            getSecret('OPENAI_API_KEY', this.env, this.env.APP_ENV),
            getSecret('ANTHROPIC_API_KEY', this.env, this.env.APP_ENV),
            getSecret('CLOUDFLARE_AI_GATEWAY_TOKEN', this.env, this.env.APP_ENV)
          ]);

          logger.info('Secrets fetched successfully', logContext);
          return { openaiKey, claudeKey, aiGatewayToken };
        } catch (error: any) {
          logger.error('Step 1b (fetch_secrets) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
          throw error;
        }
      });

      // Step 2: Check duplicate analysis (no retries - fail fast)
      // OPTIMIZED: Uses single JOIN query instead of two sequential queries (saves 2-3s)
      await step.do('check_duplicate', async () => {
        try {
          logger.info('Checking for duplicate analysis', logContext);

          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const analysisRepo = new AnalysisRepository(supabase);

          const result = await analysisRepo.findLeadWithInProgressAnalysis(
            params.account_id,
            params.business_profile_id,
            params.username,
            params.run_id
          );

          if (result.hasInProgress) {
            logger.error('Duplicate analysis found', {
              ...logContext,
              leadId: result.leadId
            });
            throw new Error('Analysis already in progress for this profile');
          }

          logger.info('No duplicate analysis found', logContext);
        } catch (error: any) {
          logger.error('Step 2 (check_duplicate) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
          throw error;
        }
      });

      // Steps 3-4: Parallel setup (deduct balance + load business profile)
      // OPTIMIZED: Run in parallel since they don't depend on each other (saves ~500ms)
      // NOTE: Progress update skipped - non-critical step (see CRITICAL_PROGRESS_STEPS)
      const business = await step.do('setup_parallel', async () => {
        try {
          logger.info('Running setup in parallel', logContext);

          const [_, businessProfile] = await Promise.all([
            // Task 1: Verify & deduct balance (MODULAR - routes to correct credit type)
            (async () => {
              logger.info('Verifying balance', {
                ...logContext,
                cost: creditsCost,
                type: params.analysis_type
              });
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const creditsRepo = new CreditsRepository(supabase);

              // MODULAR: Uses analysis type to check correct credit balance
              const hasBalance = await creditsRepo.hasSufficientBalanceForAnalysis(
                params.account_id,
                params.analysis_type as AnalysisType,
                creditsCost
              );

              if (!hasBalance) {
                logger.error('Insufficient balance for analysis', logContext);
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

              logger.info('Balance deducted successfully', logContext);
            })(),

            // Task 2: Load business profile
            (async () => {
              console.log(`[Workflow][${params.run_id}] [Parallel] Loading business profile`);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const businessRepo = new BusinessRepository(supabase);
              const profile = await businessRepo.findById(params.business_profile_id);

              if (!profile) {
                logger.error('Business profile not found', logContext);
                throw new Error('Business profile not found');
              }

              logger.info('[Parallel] Business profile loaded:', { ...logContext, profile.business_name });
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
              logger.info('Scrape returned error:', { ...logContext, result.error });
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
            icpSettings: null
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

            logger.info('Bypass analysis saved:', { ...logContext, analysis.id });
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

      // Step 6c: Phase 2 - Extract actionable data
      // This runs the profile extraction and transforms to lean, actionable signals
      let extractedData: ExtractedData | null = null;
      let textDataForAI: TextDataForAI | null = null;
      let phase2AIResponse: AIResponsePayload | null = null;

      const phase2Result = await step.do('extract_data', {
        retries: { limit: 1, delay: '1 second' }
      }, async (): Promise<{ extractedData: ExtractedData | null; textDataForAI: TextDataForAI | null }> => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 6c: Phase 2 - Extracting actionable data`);

          // Convert cache format to Apify format (fixes likeCount → likesCount mismatch)
          const apifyProfile = profileDataToApifyFormat(profile);

          // Log sample post data to verify transformation
          console.log(`[Workflow][${params.run_id}] Sample post data:`, {
            firstPost: apifyProfile.latestPosts[0] ? {
              hasLikesCount: apifyProfile.latestPosts[0].likesCount !== undefined,
              hasCommentsCount: apifyProfile.latestPosts[0].commentsCount !== undefined,
              likesValue: apifyProfile.latestPosts[0].likesCount,
              commentsValue: apifyProfile.latestPosts[0].commentsCount
            } : 'No posts'
          });

          // Run profile extraction service
          const extractor = createProfileExtractionService();
          const extractionResult: ExtractionOutput = extractor.extract(apifyProfile);

          if (!extractionResult.success) {
            console.warn(`[Workflow][${params.run_id}] Phase 2 extraction failed:`, extractionResult.error);
            return { extractedData: null, textDataForAI: null };
          }

          // Transform to ExtractedData format (lean, actionable signals only)
          const data = transformToExtractedData(extractionResult.data);

          console.log(`[Workflow][${params.run_id}] Phase 2 extraction complete:`, {
            sampleSize: data.metadata.sampleSize,
            hasHashtags: data.static.topHashtags.length > 0,
            hasMentions: data.static.topMentions.length > 0,
            fakeFollowerWarning: data.calculated.fakeFollowerWarning
          });

          return {
            extractedData: data,
            textDataForAI: extractionResult.data.textDataForAI
          };

        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Phase 2 extraction error (non-fatal):`, this.serializeError(error));
          // Return null on error
          return { extractedData: null, textDataForAI: null };
        }
      });

      extractedData = phase2Result.extractedData;
      textDataForAI = phase2Result.textDataForAI;

      // Step 6d: Detect niche using AI
      let detectedNiche: string | null = null;
      const nicheResult = await step.do('detect_niche', {
        retries: { limit: 1, delay: '1 second' }
      }, async (): Promise<string | null> => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 6d: Detecting profile niche`);

          // Only run niche detection if we have extracted data
          if (!extractedData || !textDataForAI) {
            console.log(`[Workflow][${params.run_id}] Skipping niche detection - no extracted data`);
            return null;
          }

          // Prepare niche detection input
          const nicheInput = {
            username: params.username,
            displayName: profile.displayName,
            biography: textDataForAI.biography,
            followersCount: profile.followersCount,
            isBusinessAccount: profile.isBusinessAccount,
            businessCategoryName: extractedData.static.businessCategoryName,
            externalUrl: extractedData.static.externalUrl,
            topHashtags: extractedData.static.topHashtags.map(h => h.hashtag).slice(0, 5),
            recentCaptions: textDataForAI.recentCaptions
          };

          // Run niche detection
          const result = await detectNiche(
            nicheInput,
            this.env,
            secrets.openaiKey,
            secrets.claudeKey,
            secrets.aiGatewayToken
          );

          if (!result.success) {
            console.warn(`[Workflow][${params.run_id}] Niche detection failed:`, result.error);
            return null;
          }

          console.log(`[Workflow][${params.run_id}] Niche detected:`, {
            niche: result.niche,
            confidence: result.confidence,
            reasoning: result.reasoning
          });

          return result.niche;

        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Niche detection error (non-fatal):`, error.message);
          return null;
        }
      });

      detectedNiche = nicheResult;

      // Step 7: PARALLEL AI Analysis - Run both AI analyses simultaneously
      // OPTIMIZATION: Runs both AI calls in parallel (saves ~14s)
      // - Lead Qualification AI: GPT-5 comprehensive analysis (~50-60s) - leadTier, strengths, opportunities
      // - Profile Assessment AI: Quick scoring (~14s) - overall_score, summary_text
      // Total time: max(60, 14) = ~60s instead of 60+14 = ~74s sequential
      const parallelAIResult = await step.do('parallel_ai_analysis', {
        retries: { limit: 1, delay: '2 seconds' }
      }, async (): Promise<{
        phase2Response: AIResponsePayload | null;
        deepAIResult: {
          overall_score: number;
          summary_text: string;
          model_used: string;
          input_tokens: number;
          output_tokens: number;
          total_cost: number;
        };
      }> => {
        try {
          console.log(`[Workflow][${params.run_id}] Step 7: PARALLEL AI Analysis starting`);
          const stepInfo = getStepProgress(params.analysis_type as AnalysisType, 'ai_analysis');
          await this.updateProgress(params.run_id, stepInfo.percentage, stepInfo.description);

          const aiStart = Date.now();

          // PARALLEL AI EXECUTION
          // Both tasks are IIFEs that start executing immediately
          // Promise.all waits for the slower one (usually Lead Qualification at ~50-60s)
          // Total time should be max(leadQual, profileAssess) not leadQual + profileAssess

          const leadQualificationTask = (async (): Promise<AIResponsePayload | null> => {
            if (!extractedData || !textDataForAI) {
              console.log(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI skipped - no extracted data`);
              return null;
            }

            try {
              const leadQualStart = Date.now();
              console.log(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI starting (setup)...`);

              // Fetch business context for AI prompt
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const businessContextResult = await fetchBusinessContext(supabase, params.business_profile_id);

              if (!businessContextResult.success) {
                console.warn(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI - Failed to fetch business context:`, businessContextResult.error);
                return null;
              }

              const setupDuration = Date.now() - leadQualStart;
              console.log(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI call starting (setup took ${setupDuration}ms)...`);
              const aiCallStart = Date.now();

              // Run GPT-5 lead qualification analysis
              const aiResult = await analyzeLeadWithAI(
                {
                  extractedData: extractedData!,
                  textData: textDataForAI!,
                  businessContext: businessContextResult.data
                },
                this.env,
                secrets.openaiKey,
                secrets.claudeKey,
                secrets.aiGatewayToken
              );

              const aiCallDuration = Date.now() - aiCallStart;
              const totalDuration = Date.now() - leadQualStart;

              if (!aiResult.success) {
                console.warn(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI failed:`, aiResult.error);
                return null;
              }

              console.log(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI complete`, {
                leadTier: aiResult.data.analysis.leadTier,
                setupMs: setupDuration,
                aiCallMs: aiCallDuration,
                totalMs: totalDuration
              });

              return { data: aiResult.data, durationMs: totalDuration };
            } catch (error: any) {
              console.error(`[Workflow][${params.run_id}] [Parallel] Lead Qualification AI error:`, error.message);
              return null;
            }
          })();

          const profileAssessmentTask = (async () => {
            console.log(`[Workflow][${params.run_id}] [Parallel] Profile Assessment AI starting...`);
            const assessStart = Date.now();

            // Transform camelCase cache profile to snake_case AI profile
            const aiProfile = toAIProfile(profile!);

            // OPTIMIZATION: Reuse pre-fetched secrets from step 1b instead of re-fetching
            // This saves 3 async getSecret() calls and ensures true parallel execution
            const aiService = new AIAnalysisService(
              this.env,
              secrets.openaiKey,
              secrets.claudeKey,
              secrets.aiGatewayToken
            );
            const result = await aiService.executeAnalysis(params.analysis_type as AnalysisType, business, aiProfile);

            const assessDuration = Date.now() - assessStart;

            console.log(`[Workflow][${params.run_id}] [Parallel] Profile Assessment AI complete`, {
              score: result.overall_score,
              model: result.model_used,
              durationMs: assessDuration
            });

            return { data: result, durationMs: assessDuration };
          })();

          // Run BOTH in parallel - total time = max(leadQual, profileAssess)
          const [leadQualResult, profileAssessResultWithDuration] = await Promise.all([leadQualificationTask, profileAssessmentTask]);

          timing.ai_analysis = Date.now() - aiStart;

          // Extract individual durations for SLA tracking
          const leadQualDurationMs = leadQualResult?.durationMs ?? 0;
          const profileAssessDurationMs = profileAssessResultWithDuration.durationMs;

          // Store AI breakdown for SLA logging
          (timing as any).ai_breakdown = {
            leadQualificationMs: leadQualDurationMs,
            profileAssessmentMs: profileAssessDurationMs,
            parallelStatus: timing.ai_analysis <= 70000 ? 'optimal' : timing.ai_analysis <= 90000 ? 'good' : 'degraded'
          };

          // Log parallel execution results with verification
          // If truly parallel, totalDurationMs should be close to the max of the two, not the sum
          // Calculate parallel efficiency: ratio of actual time to expected sequential time
          const expectedSequentialMs = 60000 + 14000; // ~74s if run sequentially
          const parallelSavingsMs = expectedSequentialMs - timing.ai_analysis;
          const parallelStatus = (timing as any).ai_breakdown.parallelStatus;

          console.log(`[Workflow][${params.run_id}] PARALLEL AI Analysis complete`, {
            totalDurationMs: timing.ai_analysis,
            leadQualSuccess: !!leadQualResult,
            leadTier: leadQualResult?.data?.analysis?.leadTier || 'N/A',
            profileScore: profileAssessResultWithDuration.data.overall_score,
            profileModel: profileAssessResultWithDuration.data.model_used,
            parallelExecution: {
              status: parallelStatus,
              totalMs: timing.ai_analysis,
              leadQualificationMs: leadQualDurationMs,
              profileAssessmentMs: profileAssessDurationMs,
              expectedSequentialMs,
              savedMs: parallelSavingsMs > 0 ? parallelSavingsMs : 0,
              note: parallelStatus === 'optimal'
                ? '✓ Perfect parallelization - total time equals slowest component'
                : parallelStatus === 'good'
                  ? '✓ Good parallelization - minor overhead detected'
                  : '⚠ Degraded parallelization - investigate bottleneck'
            }
          });

          return {
            phase2Response: leadQualResult?.data ?? null,
            deepAIResult: profileAssessResultWithDuration.data
          };
        } catch (error: any) {
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          console.error(`[Workflow][${params.run_id}] ❌ STEP 7 FAILED - AI ANALYSIS ERROR ❌`, {
            step: 'parallel_ai_analysis',
            progress: '95%',
            username: params.username,
            error: errorDetails,
            context: {
              has_profile: !!profile,
              has_extracted_data: !!extractedData,
              has_text_data: !!textDataForAI,
              analysis_type: params.analysis_type,
              timing_before_failure: {
                cache_check: timing.cache_check,
                scraping: timing.scraping,
                pre_checks: timing.pre_checks
              }
            }
          });
          throw error;
        }
      });

      // Extract results from parallel execution
      phase2AIResponse = parallelAIResult.phase2Response;
      const aiResult = parallelAIResult.deepAIResult;

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
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          console.error(`[Workflow][${params.run_id}] ❌ STEP 8 FAILED - LEAD UPSERT ERROR ❌`, {
            step: 'upsert_lead',
            progress: '97%',
            username: params.username,
            error: errorDetails,
            context: {
              account_id: params.account_id,
              business_profile_id: params.business_profile_id,
              has_profile: !!profile,
              analysis_type: params.analysis_type
            }
          });
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

          // Structure ai_response JSONB - flatten Phase 2 fields to top level
          // Format: { score, leadTier, strengths, weaknesses, riskFactors, fitReasoning, opportunities, recommendedActions }
          const aiResponse: any = {
            // Always include basic fields (backward compat)
            score: aiResult.overall_score
          };

          // Flatten Phase 2 AI response fields to top level if available
          if (phase2AIResponse) {
            // Flatten analysis fields directly to top level (no nesting)
            Object.assign(aiResponse, phase2AIResponse.analysis);
            console.log(`[Workflow][${params.run_id}] Including Phase 2 AI response:`, {
              leadTier: phase2AIResponse.analysis.leadTier
            });
          }

          // Add niche to ai_response if detected
          if (detectedNiche) {
            aiResponse.niche = detectedNiche;
            console.log(`[Workflow][${params.run_id}] Including detected niche: ${detectedNiche}`);
          }

          // Update extracted_data with leadTier based on overall_score
          let finalExtractedData = extractedData;
          if (extractedData) {
            const leadTier = calculateLeadTier(aiResult.overall_score);
            finalExtractedData = {
              ...extractedData,
              calculated: {
                ...extractedData.calculated,
                leadTier
              }
            };
            console.log(`[Workflow][${params.run_id}] Lead tier calculated: ${leadTier} (score: ${aiResult.overall_score})`);
          }

          // UPDATE existing analysis record (created in handler before workflow started)
          // Include extracted_data from Phase 2 extraction if available
          // Include niche in separate column for easy querying
          // Include version tracking for A/B testing and debugging
          const analysis = await analysisRepo.updateAnalysis(params.run_id, {
            overall_score: aiResult.overall_score,
            ai_response: aiResponse,
            extracted_data: finalExtractedData || undefined,
            niche: detectedNiche,
            status: 'complete',
            completed_at: new Date().toISOString(),
            extraction_version: finalExtractedData?.metadata?.version || '1.0',
            model_versions: {
              profile_assessment: aiResult.model_used,
              lead_qualification: phase2AIResponse?.model || aiResult.model_used
            }
          });

          logger.info('Analysis updated with results:', { ...logContext, analysis.id });
          return analysis.id;
        } catch (error: any) {
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          console.error(`[Workflow][${params.run_id}] ❌ STEP 9 FAILED - SAVE ANALYSIS ERROR ❌`, {
            step: 'save_analysis',
            progress: '98%',
            username: params.username,
            error: errorDetails,
            context: {
              run_id: params.run_id,
              has_phase2_response: !!phase2AIResponse,
              has_extracted_data: !!extractedData,
              overall_score: aiResult?.overall_score
            }
          });
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

          // Calculate total AI cost (Step 7 + Phase 2)
          // Phase 2 cost is tracked in phase2AIResponse.tokenUsage.cost
          const phase2AICost = phase2AIResponse?.tokenUsage?.cost ?? 0;
          const totalAICost = aiResult.total_cost + phase2AICost;

          // Build metrics using centralized config (handles pricing, actor ID, etc.)
          const metrics = buildOperationsMetrics({
            analysisType: params.analysis_type as AnalysisType,
            aiCost: totalAICost,
            aiModel: aiResult.model_used,
            tokensIn: aiResult.input_tokens + (phase2AIResponse?.tokenUsage?.input ?? 0),
            tokensOut: aiResult.output_tokens + (phase2AIResponse?.tokenUsage?.output ?? 0),
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

          // Log detailed cost breakdown for transparency
          const apifyCost = metrics.cost.items.scraping.usd;
          const totalCostUsd = metrics.cost.total_usd;

          // Calculate cache savings (scraping cost avoided when cache hit)
          const SCRAPING_COST_USD = 0.003; // Cost per scrape
          const cacheSavingsUsd = timing.cache_hit ? SCRAPING_COST_USD : 0;
          const savingsPercent = timing.cache_hit ? Math.round((cacheSavingsUsd / (totalCostUsd + cacheSavingsUsd)) * 100) : 0;

          // Get AI breakdown for performance metrics
          const aiBreakdownData = (timing as any).ai_breakdown;

          console.log(`[Workflow][${params.run_id}] Operations logged - COST BREAKDOWN`, {
            total_cost_usd: totalCostUsd,
            breakdown: {
              profile_assessment_ai: `$${aiResult.total_cost.toFixed(6)}`,
              lead_qualification_ai: `$${phase2AICost.toFixed(6)}`,
              apify_scraping: timing.cache_hit ? '$0.000000 (cached)' : `$${apifyCost.toFixed(6)}`,
              cache_savings: timing.cache_hit ? `$${cacheSavingsUsd.toFixed(6)}` : '$0.000000',
              sum_check: `$${(aiResult.total_cost + phase2AICost + apifyCost).toFixed(6)}`
            },
            cache_hit: timing.cache_hit,
            savings_percent: timing.cache_hit ? `${savingsPercent}%` : '0%',
            total_duration_ms: metrics.duration.total_ms,

            // Profile metadata for cost/complexity correlation
            profile_metadata: {
              analysis_type: params.analysis_type,
              lead_tier: phase2AIResponse?.analysis?.leadTier ?? 'N/A',
              fake_follower_warning: extractedData?.calculated?.fakeFollowerWarning ?? 'N/A'
            },

            // Performance metrics for monitoring
            performance_metrics: {
              sla_status: 'calculated_later', // SLA is calculated after this step
              reasoning_tokens: phase2AIResponse?.tokenUsage?.output ?? 0,
              parallel_efficiency: aiBreakdownData?.parallelStatus ?? 'N/A'
            }
          });

          // COST ALERT THRESHOLDS
          // Alert when analysis costs exceed expected range
          const COST_WARN_THRESHOLD = 0.05;     // $0.05 per analysis
          const COST_CRITICAL_THRESHOLD = 0.10; // $0.10 per analysis

          if (totalCostUsd >= COST_CRITICAL_THRESHOLD) {
            console.error(`[CostAlert][${params.run_id}] CRITICAL: Analysis cost $${totalCostUsd.toFixed(4)} exceeds critical threshold $${COST_CRITICAL_THRESHOLD}`, {
              username: params.username,
              analysisType: params.analysis_type,
              totalCost: totalCostUsd,
              threshold: COST_CRITICAL_THRESHOLD,
              breakdown: {
                profileAssessmentAI: aiResult.total_cost,
                leadQualificationAI: phase2AICost,
                scraping: apifyCost
              }
            });
          } else if (totalCostUsd >= COST_WARN_THRESHOLD) {
            console.warn(`[CostAlert][${params.run_id}] WARNING: Analysis cost $${totalCostUsd.toFixed(4)} exceeds warning threshold $${COST_WARN_THRESHOLD}`, {
              username: params.username,
              analysisType: params.analysis_type,
              totalCost: totalCostUsd,
              threshold: COST_WARN_THRESHOLD
            });
          }
        } catch (error: any) {
          console.error(`[Workflow][${params.run_id}] Step 11 FAILED (non-fatal):`, this.serializeError(error));
          // Don't throw - logging failures shouldn't break the workflow
        }
      });

      // SLA TRACKING
      // Track workflow duration against SLA targets
      const totalDurationMs = Date.now() - workflowStartTime;
      const SLA_TARGET_MS = 60_000;      // 60 seconds (target)
      const SLA_WARNING_MS = 90_000;     // 90 seconds (warning)
      const SLA_CRITICAL_MS = 120_000;   // 120 seconds (critical)

      const slaStatus =
        totalDurationMs <= SLA_TARGET_MS ? 'met' :
        totalDurationMs <= SLA_WARNING_MS ? 'warning' :
        totalDurationMs <= SLA_CRITICAL_MS ? 'critical' :
        'severe';

      // Get AI breakdown if available
      const aiBreakdown = (timing as any).ai_breakdown;

      const slaLog = {
        runId: params.run_id,
        username: params.username,
        analysisType: params.analysis_type,
        durationMs: totalDurationMs,
        durationSec: (totalDurationMs / 1000).toFixed(1),
        slaStatus,
        slaTargetMs: SLA_TARGET_MS,
        exceededBy: totalDurationMs > SLA_TARGET_MS ? `${((totalDurationMs - SLA_TARGET_MS) / 1000).toFixed(1)}s` : null,
        componentTiming: {
          cacheCheckMs: timing.cache_check ?? 0,
          scrapingMs: timing.scraping ?? 0,
          preChecksMs: timing.pre_checks ?? 0,
          aiAnalysisMs: timing.ai_analysis ?? 0,
          aiBreakdown: aiBreakdown ? {
            profileAssessmentMs: aiBreakdown.profileAssessmentMs,
            leadQualificationMs: aiBreakdown.leadQualificationMs,
            parallelStatus: aiBreakdown.parallelStatus
          } : undefined,
          dbUpsertMs: timing.db_upsert ?? 0
        }
      };

      if (slaStatus === 'severe') {
        console.error(`[SLA][${params.run_id}] SEVERE: Analysis took ${slaLog.durationSec}s, severely exceeding target (>${SLA_CRITICAL_MS / 1000}s)`, slaLog);
      } else if (slaStatus === 'critical') {
        console.error(`[SLA][${params.run_id}] CRITICAL: Analysis took ${slaLog.durationSec}s, exceeding critical threshold`, slaLog);
      } else if (slaStatus === 'warning') {
        console.warn(`[SLA][${params.run_id}] WARNING: Analysis took ${slaLog.durationSec}s, exceeding target`, slaLog);
      } else {
        console.log(`[SLA][${params.run_id}] SLA MET: Analysis completed in ${slaLog.durationSec}s`, {
          slaStatus,
          durationMs: totalDurationMs,
          targetMs: SLA_TARGET_MS
        });
      }

      console.log(`[Workflow][${params.run_id}] SUCCESS`, {
        leadId,
        analysisId,
        score: aiResult.overall_score,
        durationMs: totalDurationMs,
        slaStatus
      });

      return {
        success: true,
        run_id: params.run_id,
        lead_id: leadId,
        analysis_id: analysisId
      };

    } catch (error: any) {
      // ========================================================================
      // CRITICAL ERROR HANDLER - Comprehensive coordinated error logging
      // ========================================================================
      // This catch block handles ALL workflow failures and ensures proper logging
      // BEFORE broadcasting the failure to the Durable Object

      const errorDetails = this.serializeError(error);
      const workflowDuration = Date.now() - workflowStartTime;

      // COMPREHENSIVE ERROR LOG - This will show exactly what failed and why
      console.error(`[Workflow][${params.run_id}] ❌❌❌ WORKFLOW FAILED ❌❌❌`, {
        username: params.username,
        analysis_type: params.analysis_type,
        run_id: params.run_id,
        duration_ms: workflowDuration,
        error: {
          message: errorDetails.message,
          name: errorDetails.name,
          code: errorDetails.code,
          detail: errorDetails.detail,
          hint: errorDetails.hint,
          stack: errorDetails.stack
        },
        context: {
          account_id: params.account_id,
          business_profile_id: params.business_profile_id,
          cache_hit: timing.cache_hit,
          timing_so_far: {
            cache_check: timing.cache_check,
            scraping: timing.scraping,
            pre_checks: timing.pre_checks,
            ai_analysis: timing.ai_analysis,
            db_upsert: timing.db_upsert
          }
        },
        // Include error cause chain if present
        cause: errorDetails.cause
      });

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

      // Mark as failed - this will broadcast to DO and update database
      await this.markFailed(params.run_id, errorDetails.message || 'Unknown error', errorDetails);

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
   * Mark as failed - updates both DO and database with comprehensive error logging
   * CRITICAL: This method logs BEFORE broadcasting failure to ensure error details are captured
   */
  private async markFailed(runId: string, errorMessage: string, errorDetails?: any): Promise<void> {
    // ========================================================================
    // COORDINATED ERROR LOGGING - Log comprehensive error details BEFORE
    // broadcasting failure to Durable Object
    // ========================================================================
    console.error(`[Workflow][${runId}] 🔴 MARKING ANALYSIS AS FAILED 🔴`, {
      error_message: errorMessage,
      error_details: errorDetails || { message: errorMessage },
      timestamp: new Date().toISOString(),
      note: 'About to broadcast failure to Durable Object and update database'
    });

    // Update Durable Object - this broadcasts the failure to connected clients
    const id = this.env.ANALYSIS_PROGRESS.idFromName(runId);
    const stub = this.env.ANALYSIS_PROGRESS.get(id);

    console.log(`[Workflow][${runId}] Broadcasting failure to Durable Object...`);

    const response = await stub.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Workflow][${runId}] ❌ Failed to mark DO as failed:`, error);
    } else {
      console.log(`[Workflow][${runId}] ✓ Successfully broadcasted failure to DO`);
    }

    // Update database record so getActiveAnalyses stops returning this job
    try {
      console.log(`[Workflow][${runId}] Updating database analysis status to failed...`);

      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const analysisRepo = new AnalysisRepository(supabase);

      await analysisRepo.updateAnalysis(runId, {
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date().toISOString()
      });

      console.log(`[Workflow][${runId}] ✓ Successfully updated database analysis status to failed`);
    } catch (dbError: any) {
      const dbErrorDetails = this.serializeError(dbError);
      console.error(`[Workflow][${runId}] ❌ Failed to update database:`, {
        database_error: dbErrorDetails,
        original_error: errorMessage
      });
      // Don't throw - we still want the workflow to complete even if DB update fails
    }

    console.error(`[Workflow][${runId}] 🔴 FAILURE HANDLING COMPLETE 🔴 - Error has been logged, broadcasted, and persisted`);
  }

}

// Export the workflow
export default AnalysisWorkflow;
