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
  buildOperationsMetrics
} from '@/config/operations-pricing.config';
import {
  type AnalysisType,
  isFeatureEnabled,
  getAnalysisConfig
} from '@/config/analysis-types.config';
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

  private accountId!: string; // Store account ID for broadcast calls

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
    this.accountId = params.account_id; // Store for broadcast calls
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
              logger.info('Loading business profile', logContext);
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const businessRepo = new BusinessRepository(supabase);
              const profile = await businessRepo.findById(params.business_profile_id);

              if (!profile) {
                logger.error('Business profile not found', logContext);
                throw new Error('Business profile not found');
              }

              logger.info('Business profile loaded', {
                ...logContext,
                businessName: profile.business_name
              });
              return profile;
            })()
          ]);

          return businessProfile;
        } catch (error: any) {
          logger.error('Step 3-4 (setup_parallel) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
          throw error;
        }
      });

      // Step 5: Check R2 cache
      // NOTE: Progress update skipped - non-critical step (see CRITICAL_PROGRESS_STEPS)
      let profile = await step.do('check_cache', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          logger.info('Checking R2 cache', logContext);

          const cacheStart = Date.now();
          const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
          const cached = await cacheService.get(params.username, params.analysis_type);
          timing.cache_check = Date.now() - cacheStart;

          if (cached) {
            logger.info('Cache HIT', logContext);
            timing.cache_hit = true;
          } else {
            logger.info('Cache MISS', logContext);
          }

          return cached;
        } catch (error: any) {
          logger.error('Step 5 (check_cache) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
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
            logger.info('Scraping Instagram profile', logContext);
            const stepInfo = getStepProgress(params.analysis_type, 'scrape_profile');
            await this.broadcastProgress(
              params.run_id,
              stepInfo.percentage,
              { current: 1, total: 3 },
              stepInfo.description,
              'analyzing'
            );

            const scrapeStart = Date.now();
            const apifyToken = await getSecret('APIFY_API_TOKEN', this.env, this.env.APP_ENV);
            const apifyAdapter = new ApifyAdapter(apifyToken);

            const postsLimit = getPostsLimit(params.analysis_type);
            logger.info('Scraping posts', {
              ...logContext,
              postsLimit
            });

            // Use scrapeProfileWithMeta to get detailed error info instead of throwing
            const result = await apifyAdapter.scrapeProfileWithMeta(params.username, postsLimit);
            timing.scraping = Date.now() - scrapeStart;

            if (result.success && result.profile) {
              logger.info('Profile scraped successfully', {
                ...logContext,
                followers: result.profile.followersCount,
                posts: result.profile.latestPosts.length,
                isPrivate: result.profile.isPrivate
              });

              // Store in cache only if successful
              const cacheService = new R2CacheService(this.env.R2_CACHE_BUCKET);
              await cacheService.set(params.username, result.profile, params.analysis_type);
              logger.info('Profile cached', logContext);
            } else {
              logger.info('Scrape returned error', {
                ...logContext,
                error: result.error
              });
            }

            return result;
          } catch (error: any) {
            logger.error('Step 6 (scrape_profile) failed', {
              ...logContext,
              error: this.serializeError(error)
            });
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
          logger.info('Running pre-analysis checks', logContext);

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

          logger.info('Pre-analysis checks complete', {
            ...logContext,
            allPassed: result.allPassed,
            checksRun: result.checksRun,
            failedCheck: result.failedCheck?.checkName,
            durationMs: result.durationMs
          });

          return result;
        } catch (error) {
          logger.error('Step 6b (pre_analysis_checks) failed', {
            ...logContext,
            error: this.serializeError(error)
          });
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
        logger.info('Pre-analysis check failed - bypassing AI analysis', {
          ...logContext,
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
              logger.info('Refunding credits for bypassed check', {
                ...logContext,
                credits: creditsCost,
                reason: failedCheck.resultType
              });
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const creditsRepo = new CreditsRepository(supabase);

              await creditsRepo.addForAnalysis(
                params.account_id,
                params.analysis_type as AnalysisType,
                creditsCost,
                'refund',
                `Analysis bypassed (${failedCheck.resultType}): @${params.username}`
              );

              logger.info('Credits refunded for bypass', logContext);
            } catch (refundError) {
              logger.error('Refund for bypass failed', {
                ...logContext,
                error: this.serializeError(refundError)
              });
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
              logger.info('Creating lead record for bypassed profile', logContext);
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

              logger.info('Bypass lead created', {
                ...logContext,
                leadId: lead.lead_id
              });
              return lead.lead_id;
            } catch (error) {
              logger.error('Bypass lead creation failed', {
                ...logContext,
                error: this.serializeError(error)
              });
              return null;
            }
          });
        }

        // Step 6e: Save bypassed analysis result
        const bypassAnalysisId = await step.do('save_bypass_analysis', {
          retries: { limit: 3, delay: '1 second' }
        }, async () => {
          try {
            logger.info('Saving bypassed analysis record', logContext);
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

            logger.info('Bypass analysis saved', {
              ...logContext,
              analysisId: analysis.id
            });
            return analysis.id;
          } catch (error) {
            logger.error('Bypass analysis save failed', {
              ...logContext,
              error: this.serializeError(error)
            });
            throw error;
          }
        });

        // Step 6f: Mark complete in progress tracker
        await step.do('complete_bypass_progress', {
          retries: { limit: 2, delay: '500 milliseconds' }
        }, async () => {
          try {
            logger.info('Marking bypassed analysis as complete', logContext);

            await this.broadcastProgress(
              params.run_id,
              100,
              { current: 3, total: 3 },
              failedCheck.summary || `Unable to analyze: ${failedCheck.reason}`,
              'complete'
            );

            logger.info('Bypass progress marked as complete', logContext);
          } catch (error) {
            logger.error('Bypass progress complete failed', {
              ...logContext,
              error: this.serializeError(error)
            });
          }
        });

        logger.info('Analysis bypassed', {
          ...logContext,
          leadId: bypassLeadId,
          analysisId: bypassAnalysisId,
          reason: failedCheck.reason,
          resultType: failedCheck.resultType
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
          logger.info('Extracting actionable data (Phase 2)', logContext);

          // Convert cache format to Apify format (fixes likeCount → likesCount mismatch)
          const apifyProfile = profileDataToApifyFormat(profile);

          // Log sample post data to verify transformation
          logger.info('Sample post data extracted', {
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
            logger.warn('Phase 2 extraction failed', { ...logContext, error: extractionResult.error });
            return { extractedData: null, textDataForAI: null };
          }

          // Transform to ExtractedData format (lean, actionable signals only)
          const data = transformToExtractedData(extractionResult.data);

          logger.info('Phase 2 extraction complete', {
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
          logger.error('Phase 2 extraction error (non-fatal)', { ...logContext, error: this.serializeError(error) });
          // Return null on error
          return { extractedData: null, textDataForAI: null };
        }
      });

      extractedData = phase2Result.extractedData;
      textDataForAI = phase2Result.textDataForAI;

      // Step 6d: Detect niche using AI (DEEP only)
      // MODULAR: Skip niche detection for Light analysis
      let detectedNiche: string | null = null;
      const shouldRunNicheDetection = isFeatureEnabled(params.analysis_type as AnalysisType, 'runNicheDetection');

      if (shouldRunNicheDetection) {
        const nicheResult = await step.do('detect_niche', {
          retries: { limit: 1, delay: '1 second' }
        }, async (): Promise<string | null> => {
          try {
            logger.info('Detecting profile niche', logContext);

            // Only run niche detection if we have extracted data
            if (!extractedData || !textDataForAI) {
              logger.info('Skipping niche detection - no extracted data', logContext);
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
              logger.warn('Niche detection failed', { ...logContext, error: result.error });
              return null;
            }

            logger.info('Niche detected', {
              niche: result.niche,
              confidence: result.confidence,
              reasoning: result.reasoning
            });

            return result.niche;

          } catch (error: any) {
            logger.error('Niche detection error (non-fatal)', { ...logContext, error: error instanceof Error ? error.message : String(error) });
            return null;
          }
        });

        detectedNiche = nicheResult;
      } else {
        logger.info('Skipping niche detection for light analysis', logContext);
      }

      // Step 7: AI Analysis
      // MODULAR: Light analysis runs ONLY Profile Assessment AI (fast, ~15s)
      //          Deep analysis runs BOTH in parallel (Lead Qualification + Profile Assessment)
      //
      // Light Analysis (~15s):
      // - Profile Assessment AI only: score + 2-3 sentence summary
      // - NO Lead Qualification AI (no leadTier, strengths, opportunities)
      //
      // Deep Analysis (~45s parallel):
      // - Lead Qualification AI: GPT-5 comprehensive (~50-60s) - leadTier, strengths, opportunities
      // - Profile Assessment AI: Quick scoring (~14s) - overall_score, summary_text
      // - Total time: max(60, 14) = ~60s instead of 60+14 = ~74s sequential
      const shouldRunLeadQualification = isFeatureEnabled(params.analysis_type as AnalysisType, 'runLeadQualificationAI');

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
          const analysisMode = shouldRunLeadQualification ? 'deep (parallel)' : 'light (profile only)';
          logger.info(`Starting AI analysis [${analysisMode}]`, logContext);

          const stepInfo = getStepProgress(params.analysis_type as AnalysisType, 'ai_analysis');
          await this.broadcastProgress(
            params.run_id,
            stepInfo.percentage,
            { current: 2, total: 3 },
            stepInfo.description,
            'analyzing'
          );

          const aiStart = Date.now();

          // MODULAR AI EXECUTION
          // Light: Only Profile Assessment (no Lead Qualification)
          // Deep: Both in parallel for efficiency

          const leadQualificationTask = (async (): Promise<AIResponsePayload | null> => {
            // MODULAR: Skip Lead Qualification for Light analysis
            if (!shouldRunLeadQualification) {
              logger.info('[AI] Lead Qualification AI skipped - light analysis mode', logContext);
              return null;
            }

            if (!extractedData || !textDataForAI) {
              logger.info('[Parallel] Lead Qualification AI skipped - no extracted data', logContext);
              return null;
            }

            try {
              const leadQualStart = Date.now();
              logger.info('[Parallel] Lead Qualification AI starting (setup)', logContext);

              // Fetch business context for AI prompt
              const supabase = await SupabaseClientFactory.createAdminClient(this.env);
              const businessContextResult = await fetchBusinessContext(supabase, params.business_profile_id);

              if (!businessContextResult.success) {
                logger.warn('[Parallel] Lead Qualification AI - Failed to fetch business context', { ...logContext, error: businessContextResult.error });
                return null;
              }

              const setupDuration = Date.now() - leadQualStart;
              logger.info('[Parallel] Lead Qualification AI call starting', { ...logContext, setupMs: setupDuration });
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
                logger.warn('[Parallel] Lead Qualification AI failed', { ...logContext, error: aiResult.error });
                return null;
              }

              logger.info('[Parallel] Lead Qualification AI complete', {
                leadTier: aiResult.data.analysis.leadTier,
                setupMs: setupDuration,
                aiCallMs: aiCallDuration,
                totalMs: totalDuration
              });

              return { data: aiResult.data, durationMs: totalDuration };
            } catch (error: any) {
              logger.error('[Parallel] Lead Qualification AI error', { ...logContext, error: error instanceof Error ? error.message : String(error) });
              return null;
            }
          })();

          const profileAssessmentTask = (async () => {
            logger.info('[Parallel] Profile Assessment AI starting', logContext);
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

            logger.info('[Parallel] Profile Assessment AI complete', {
              score: result.overall_score,
              model: result.model_used,
              durationMs: assessDuration
            });

            return { data: result, durationMs: assessDuration };
          })();

          // Run AI tasks - for Light only Profile Assessment runs, for Deep both run in parallel
          const [leadQualResult, profileAssessResultWithDuration] = await Promise.all([leadQualificationTask, profileAssessmentTask]);

          timing.ai_analysis = Date.now() - aiStart;

          // Extract individual durations for SLA tracking
          const leadQualDurationMs = leadQualResult?.durationMs ?? 0;
          const profileAssessDurationMs = profileAssessResultWithDuration.durationMs;

          // Store AI breakdown for SLA logging
          // Light analysis has different SLA targets (~15-20s vs ~60-70s for deep)
          const lightSlaThreshold = 25000;  // 25s target for light
          const deepSlaThreshold = 70000;   // 70s target for deep
          const slaThreshold = shouldRunLeadQualification ? deepSlaThreshold : lightSlaThreshold;

          (timing as any).ai_breakdown = {
            mode: shouldRunLeadQualification ? 'deep_parallel' : 'light_single',
            leadQualificationMs: leadQualDurationMs,
            profileAssessmentMs: profileAssessDurationMs,
            parallelStatus: timing.ai_analysis <= slaThreshold ? 'optimal' : timing.ai_analysis <= slaThreshold * 1.3 ? 'good' : 'degraded'
          };

          const parallelStatus = (timing as any).ai_breakdown.parallelStatus;

          if (shouldRunLeadQualification) {
            // Deep analysis: Log parallel execution metrics
            const expectedSequentialMs = 60000 + 14000; // ~74s if run sequentially
            const parallelSavingsMs = expectedSequentialMs - timing.ai_analysis;

            logger.info('Deep AI Analysis complete (parallel)', {
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
          } else {
            // Light analysis: Simple logging (no parallel execution)
            logger.info('Light AI Analysis complete', {
              totalDurationMs: timing.ai_analysis,
              profileScore: profileAssessResultWithDuration.data.overall_score,
              profileModel: profileAssessResultWithDuration.data.model_used,
              status: parallelStatus,
              note: 'Light analysis - Profile Assessment AI only'
            });
          }

          return {
            phase2Response: leadQualResult?.data ?? null,
            deepAIResult: profileAssessResultWithDuration.data
          };
        } catch (error: any) {
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          logger.error('AI analysis failed (Step 7)', {
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
          logger.info('Upserting lead data', logContext);
          const stepInfo = getStepProgress(params.analysis_type, 'upsert_lead');
          await this.broadcastProgress(
            params.run_id,
            stepInfo.percentage,
            { current: 3, total: 3 },
            stepInfo.description,
            'analyzing'
          );

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

          logger.info('Lead upserted', { ...logContext, leadId: lead.lead_id });

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
                  logger.info('Background: Avatar cached and lead updated', logContext);
                }
              })
              .catch((err) => {
                logger.error('Background avatar cache failed', { ...logContext, error: err instanceof Error ? err.message : String(err) });
              });

            logger.info('Avatar caching started in background', logContext);
          }

          timing.db_upsert = Date.now() - upsertStart;
          return lead.lead_id;
        } catch (error: any) {
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          logger.error('Lead upsert failed (Step 8)', {
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
          logger.info('Updating analysis record with results', logContext);

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
            logger.info('Including Phase 2 AI response', {
              leadTier: phase2AIResponse.analysis.leadTier
            });
          }

          // Add niche to ai_response if detected
          if (detectedNiche) {
            aiResponse.niche = detectedNiche;
            logger.info('Including detected niche', { ...logContext, niche: detectedNiche });
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
            logger.info('Lead tier calculated', { ...logContext, leadTier, score: aiResult.overall_score });
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

          logger.info('Analysis updated with results', {
            ...logContext,
            analysisId: analysis.id
          });
          return analysis.id;
        } catch (error) {
          // CRITICAL ERROR LOGGING - Comprehensive error details before failure propagates
          const errorDetails = this.serializeError(error);
          logger.error('Analysis save failed (Step 9)', {
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
          logger.info('Marking analysis as complete', logContext);

          await this.broadcastProgress(
            params.run_id,
            100,
            { current: 3, total: 3 },
            'Analysis complete',
            'complete'
          );

          logger.info('Progress marked as complete', logContext);
        } catch (error: any) {
          logger.error('Complete progress failed (Step 10)', { ...logContext, error: this.serializeError(error) });
          throw error;
        }
      });

      // Step 11: Log to operations ledger (using centralized pricing config)
      await step.do('log_operations', {
        retries: { limit: 2, delay: '500 milliseconds' }
      }, async () => {
        try {
          logger.info('Logging to operations ledger', logContext);

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

          logger.info('Operations logged - COST BREAKDOWN', {
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
            logger.error('CRITICAL: Analysis cost exceeds threshold', { ...logContext, alert: 'cost_critical', message: `Cost $${totalCostUsd.toFixed(4)} exceeds critical threshold $${COST_CRITICAL_THRESHOLD}`, username: params.username, analysisType: params.analysis_type, totalCost: totalCostUsd, threshold: COST_CRITICAL_THRESHOLD, breakdown: { profileAssessmentAI: aiResult.total_cost, leadQualificationAI: phase2AICost, scraping: apifyCost } });
          } else if (totalCostUsd >= COST_WARN_THRESHOLD) {
            logger.warn('WARNING: Analysis cost exceeds threshold', { ...logContext, alert: 'cost_warning', message: `Cost $${totalCostUsd.toFixed(4)} exceeds warning threshold $${COST_WARN_THRESHOLD}`, username: params.username, analysisType: params.analysis_type, totalCost: totalCostUsd, threshold: COST_WARN_THRESHOLD });
          }
        } catch (error: any) {
          logger.error('Operations ledger logging failed (non-fatal)', { ...logContext, error: this.serializeError(error) });
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
        logger.error('SLA SEVERE: Analysis duration severely exceeded target', { ...logContext, sla: 'severe', message: `Analysis took ${slaLog.durationSec}s, severely exceeding target (>${SLA_CRITICAL_MS / 1000}s)`, ...slaLog });
      } else if (slaStatus === 'critical') {
        logger.error('SLA CRITICAL: Analysis duration exceeded critical threshold', { ...logContext, sla: 'critical', message: `Analysis took ${slaLog.durationSec}s, exceeding critical threshold`, ...slaLog });
      } else if (slaStatus === 'warning') {
        logger.warn('SLA WARNING: Analysis duration exceeded target', { ...logContext, sla: 'warning', message: `Analysis took ${slaLog.durationSec}s, exceeding target`, ...slaLog });
      } else {
        logger.info('SLA MET: Analysis completed within target', { ...logContext, sla: 'met', message: `Analysis completed in ${slaLog.durationSec}s`, slaStatus, durationMs: totalDurationMs, targetMs: SLA_TARGET_MS });
      }

      logger.info('Workflow completed successfully', {
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
      logger.error('Workflow failed', {
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
          logger.info('Attempting to refund credits', { ...logContext, credits: creditsCost });
          const supabase = await SupabaseClientFactory.createAdminClient(this.env);
          const creditsRepo = new CreditsRepository(supabase);

          await creditsRepo.addForAnalysis(
            params.account_id,
            params.analysis_type as AnalysisType,
            creditsCost,
            'refund',
            `Analysis failed: ${errorDetails.message}`
          );

          logger.info('Credits refunded', { ...logContext, credits: creditsCost });
        } catch (refundError: any) {
          logger.error('Refund failed', { ...logContext, error: this.serializeError(refundError) });
          // Don't throw - we still want to mark the analysis as failed even if refund fails
        }
      });

      // Mark as failed - this will broadcast to DO and update database
      await this.markFailed(params.run_id, errorDetails.message || 'Unknown error', errorDetails);

      throw error;
    }
  }

  /**
   * Broadcast progress update via Worker internal endpoint
   * Replaces direct DO communication with HTTP broadcast call
   */
  private async broadcastProgress(
    runId: string,
    progress: number,
    step: { current: number; total: number },
    currentStep: string,
    status: 'analyzing' | 'complete' | 'failed'
  ): Promise<void> {
    try {
      logger.debug('Broadcasting progress', { runId, progress, step, currentStep, status });

      // Determine message type based on status
      const type = status === 'complete' ? 'analysis.complete' :
                   status === 'failed' ? 'analysis.failed' : 'analysis.progress';

      // Call internal broadcast endpoint
      const apiUrl = this.env.APP_ENV === 'staging'
        ? 'https://api-staging.oslira.com'
        : 'https://api.oslira.com';

      const response = await fetch(`${apiUrl}/api/internal/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: this.accountId,
          type,
          runId,
          data: {
            progress,
            step,
            status,
            currentStep
          }
        })
      });

      if (!response.ok) {
        logger.warn('[Workflow] Broadcast failed (non-fatal)', {
          runId,
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch (error) {
      // Don't fail workflow if broadcast fails
      logger.error('[Workflow] Broadcast error (non-fatal)', { error });
    }
  }

  /**
   * Mark as failed - updates database and broadcasts failure
   */
  private async markFailed(runId: string, errorMessage: string, errorDetails?: any): Promise<void> {
    logger.error('Marking analysis as failed', {
      error_message: errorMessage,
      error_details: errorDetails || { message: errorMessage },
      timestamp: new Date().toISOString()
    });

    // Broadcast failure to frontend
    await this.broadcastProgress(
      runId,
      0,
      { current: 0, total: 3 },
      `Analysis failed: ${errorMessage}`,
      'failed'
    );

    // Update database record
    try {
      logger.info('Updating database analysis status to failed', { runId });

      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const analysisRepo = new AnalysisRepository(supabase);

      await analysisRepo.updateAnalysis(runId, {
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date().toISOString()
      });

      logger.info('Successfully updated database analysis status to failed', { runId });
    } catch (dbError: any) {
      const dbErrorDetails = this.serializeError(dbError);
      logger.error('Failed to update database', {
        database_error: dbErrorDetails,
        original_error: errorMessage
      });
    }
  }

}

// Export the workflow
export default AnalysisWorkflow;
