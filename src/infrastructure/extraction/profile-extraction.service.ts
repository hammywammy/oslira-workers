// infrastructure/extraction/profile-extraction.service.ts

import { logger } from '@/shared/utils/logger.util';
import type {
  ApifyFullProfile,
  ApifyFullPost,
  DataAvailabilityFlags,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ProfileMetrics,
  EngagementMetrics,
  FrequencyMetrics,
  FormatMetrics,
  ContentMetrics,
  VideoMetrics,
  RiskScores,
  DerivedMetrics,
  TextDataForAI,
  HashtagFrequency,
  MentionFrequency,
  ExtractionMetadata,
  SkippedMetricReason,
  ExtractionResult,
  ExtractionOutput,
  ExternalLinkInfo
} from './extraction.types';

/**
 * COMPREHENSIVE INSTAGRAM PROFILE EXTRACTION SERVICE
 *
 * Processes Apify Instagram profile scraper responses and calculates
 * all possible metrics with graceful handling of missing data.
 *
 * Features:
 * - Validation pipeline with prerequisite checks
 * - 52 metrics organized in logical groups
 * - Comprehensive logging for debugging
 * - Graceful degradation when data is missing
 * - Deterministic output (same input = same output)
 *
 * @version 1.1.0
 */
export class ProfileExtractionService {
  private static readonly VERSION = '1.2.0';

  // Tracking for metrics calculation
  private metricsCalculated = 0;
  private metricsSkipped = 0;
  private skippedReasons: SkippedMetricReason[] = [];
  /** High-resolution start time using performance.now() for microsecond precision */
  private startTimeHR = 0;

  /**
   * Main entry point - extract all metrics from an Apify profile response
   */
  extract(rawProfile: unknown): ExtractionOutput {
    // Use performance.now() for high-resolution timing (microsecond precision)
    // This prevents "0ms" processing times when operations complete very fast
    this.startTimeHR = performance.now();
    this.metricsCalculated = 0;
    this.metricsSkipped = 0;
    this.skippedReasons = [];

    const logContext = { service: 'ProfileExtraction', version: ProfileExtractionService.VERSION };

    logger.info('='.repeat(80), logContext);
    logger.info('PROFILE EXTRACTION STARTED', logContext);
    logger.info('='.repeat(80), logContext);

    // =========================================================================
    // PHASE 1: VALIDATION PIPELINE
    // =========================================================================
    logger.info('PHASE 1: Running validation pipeline...', logContext);

    const validation = this.runValidationPipeline(rawProfile);

    if (!validation.isValid) {
      const errorResult = this.buildErrorResult(validation, rawProfile);
      logger.error('Extraction aborted - validation failed', {
        ...logContext,
        errors: validation.errors,
        processingTimeMs: Math.round(performance.now() - this.startTimeHR)
      });
      return errorResult;
    }

    // Safe to cast after validation
    const profile = rawProfile as ApifyFullProfile;

    logger.info('Validation passed', {
      ...logContext,
      username: profile.username,
      flags: validation.flags
    });

    // =========================================================================
    // PHASE 2: METRIC CALCULATION
    // =========================================================================
    logger.info('PHASE 2: Calculating metrics...', { ...logContext, username: profile.username });

    // Group 1: Profile Metrics (Always calculable)
    logger.info('--- GROUP 1: Profile Metrics ---', logContext);
    const profileMetrics = this.calculateProfileMetrics(profile);

    // Group 2a: Engagement Metrics
    logger.info('--- GROUP 2a: Engagement Metrics ---', logContext);
    const engagementMetrics = this.calculateEngagementMetrics(profile, validation.flags);

    // Group 2b: Frequency Metrics
    logger.info('--- GROUP 2b: Frequency Metrics ---', logContext);
    const frequencyMetrics = this.calculateFrequencyMetrics(profile, validation.flags);

    // Group 2c: Format Metrics
    logger.info('--- GROUP 2c: Format Metrics ---', logContext);
    const formatMetrics = this.calculateFormatMetrics(profile, validation.flags);

    // Group 2d: Content Metrics
    logger.info('--- GROUP 2d: Content Metrics ---', logContext);
    const contentMetrics = this.calculateContentMetrics(profile, validation.flags);

    // Group 3: Video Metrics
    logger.info('--- GROUP 3: Video Metrics ---', logContext);
    const videoMetrics = this.calculateVideoMetrics(profile, validation.flags);

    // Group 4: Risk Scores & Derived Metrics
    logger.info('--- GROUP 4: Risk Scores & Derived Metrics ---', logContext);
    const riskScores = this.calculateRiskScores(profile, engagementMetrics, validation.flags);
    const derivedMetrics = this.calculateDerivedMetrics(profile, engagementMetrics, frequencyMetrics, validation.flags);

    // Group 5: Text Data for AI
    logger.info('--- GROUP 5: Text Data for AI ---', logContext);
    const textDataForAI = this.extractTextData(profile, validation.flags);

    // =========================================================================
    // PHASE 3: BUILD RESULT
    // =========================================================================
    logger.info('PHASE 3: Building extraction result...', logContext);

    const metadata = this.buildMetadata(profile);
    const result: ExtractionResult = {
      validation,
      metadata,
      profileMetrics,
      engagementMetrics,
      frequencyMetrics,
      formatMetrics,
      contentMetrics,
      videoMetrics,
      riskScores,
      derivedMetrics,
      textDataForAI
    };

    // Final logging summary
    this.logExtractionSummary(result);

    return { success: true, data: result };
  }

  // ===========================================================================
  // PHASE 1: VALIDATION PIPELINE
  // ===========================================================================

  private runValidationPipeline(rawProfile: unknown): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    logger.info('Step 1.1: Profile existence check', { service: 'ProfileExtraction' });

    // Step 1: Profile existence check
    if (!rawProfile || typeof rawProfile !== 'object') {
      logger.error('VALIDATION FAILED: Profile does not exist or is not an object', {
        service: 'ProfileExtraction',
        rawType: typeof rawProfile,
        isNull: rawProfile === null
      });
      errors.push({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profile does not exist'
      });
      return {
        isValid: false,
        flags: this.buildEmptyFlags(),
        errors,
        warnings
      };
    }

    const profile = rawProfile as Partial<ApifyFullProfile>;

    // Check username exists
    if (!profile.username) {
      logger.error('VALIDATION FAILED: Username missing', { service: 'ProfileExtraction' });
      errors.push({
        code: 'PROFILE_NOT_FOUND',
        message: 'Profile username is missing',
        field: 'username'
      });
      return {
        isValid: false,
        flags: this.buildEmptyFlags(),
        errors,
        warnings
      };
    }

    logger.info('Step 1.1 PASSED: Profile exists', {
      service: 'ProfileExtraction',
      username: profile.username
    });

    // Step 2: Privacy check
    logger.info('Step 1.2: Privacy check', {
      service: 'ProfileExtraction',
      username: profile.username
    });

    if (profile.private === true) {
      logger.warn('VALIDATION FAILED: Profile is private', {
        service: 'ProfileExtraction',
        username: profile.username
      });
      errors.push({
        code: 'PROFILE_PRIVATE',
        message: 'Profile is private - cannot analyze'
      });
      return {
        isValid: false,
        flags: { ...this.buildEmptyFlags(), profileExists: true, isPrivate: true },
        errors,
        warnings
      };
    }

    logger.info('Step 1.2 PASSED: Profile is public', {
      service: 'ProfileExtraction',
      username: profile.username
    });

    // Step 3: Data availability assessment
    logger.info('Step 1.3: Assessing data availability...', {
      service: 'ProfileExtraction',
      username: profile.username
    });

    const flags = this.assessDataAvailability(profile);

    // Log detailed availability
    logger.info('Data availability assessment complete', {
      service: 'ProfileExtraction',
      username: profile.username,
      ...flags
    });

    // Add warnings for missing data
    if (!flags.hasPosts) {
      warnings.push({
        code: 'NO_POSTS',
        message: 'No posts available - engagement metrics will be null'
      });
      logger.warn('Warning: No posts available', {
        service: 'ProfileExtraction',
        username: profile.username
      });
    }

    if (!flags.hasTimestamps && flags.hasPosts) {
      warnings.push({
        code: 'NO_TIMESTAMPS',
        message: 'Posts lack timestamps - frequency metrics will be null'
      });
      logger.warn('Warning: Posts lack timestamps', {
        service: 'ProfileExtraction',
        username: profile.username
      });
    }

    if (!flags.hasVideoData) {
      warnings.push({
        code: 'NO_VIDEO_DATA',
        message: 'No video view data available - video metrics will be null'
      });
    }

    logger.info('Step 1.3 PASSED: Data availability assessed', {
      service: 'ProfileExtraction',
      username: profile.username
    });

    return {
      isValid: true,
      flags,
      errors,
      warnings
    };
  }

  private assessDataAvailability(profile: Partial<ApifyFullProfile>): DataAvailabilityFlags {
    const posts = profile.latestPosts || [];

    // Check profile-level data
    const hasProfileData =
      profile.username !== undefined &&
      profile.followersCount !== undefined &&
      profile.followsCount !== undefined &&
      profile.postsCount !== undefined;

    // Check posts exist
    const hasPosts = posts.length > 0;

    // Check engagement data in posts - at least one post has likes OR comments data
    // Using != null to check for both null and undefined
    const hasEngagementData = hasPosts && posts.some(
      p => p.likesCount != null || p.commentsCount != null
    );

    // Check video view data
    const hasVideoData = posts.some(
      p => p.videoViewCount !== undefined && p.videoViewCount !== null
    );

    // Check business data
    const hasBusinessData =
      profile.isBusinessAccount !== undefined ||
      profile.businessCategoryName !== null;

    // Check external links
    const hasExternalLinks: boolean =
      profile.externalUrl !== null ||
      (Array.isArray(profile.externalUrls) && profile.externalUrls.length > 0);

    // Check bio
    const hasBio = !!profile.biography && profile.biography.length > 0;

    // Check timestamps
    const hasTimestamps = posts.some(
      p => p.timestamp !== undefined && p.timestamp !== null
    );

    // Check hashtags
    const hasHashtags = posts.some(
      p => p.hashtags && p.hashtags.length > 0
    );

    // Check mentions
    const hasMentions = posts.some(
      p => p.mentions && p.mentions.length > 0
    );

    // Check location data
    const hasLocationData = posts.some(
      p => p.locationName !== null && p.locationName !== undefined
    );

    return {
      profileExists: true,
      isPrivate: false,
      hasProfileData,
      hasPosts,
      hasEngagementData,
      hasVideoData,
      hasBusinessData,
      hasExternalLinks,
      hasBio,
      hasTimestamps,
      hasHashtags,
      hasMentions,
      hasLocationData
    };
  }

  private buildEmptyFlags(): DataAvailabilityFlags {
    return {
      profileExists: false,
      isPrivate: false,
      hasProfileData: false,
      hasPosts: false,
      hasEngagementData: false,
      hasVideoData: false,
      hasBusinessData: false,
      hasExternalLinks: false,
      hasBio: false,
      hasTimestamps: false,
      hasHashtags: false,
      hasMentions: false,
      hasLocationData: false
    };
  }

  // ===========================================================================
  // GROUP 1: PROFILE METRICS (Always calculable if profile exists)
  // ===========================================================================

  private calculateProfileMetrics(profile: ApifyFullProfile): ProfileMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'ProfileMetrics', username: profile.username };

    logger.info('Calculating profile metrics...', logContext);

    // Authority ratio calculation
    // Raw: exact followers/following ratio for display/comparison
    // Score: logarithmic 0-100 scale for normalized comparison
    let authorityRatioRaw: number | null = null;
    let authorityRatio: number | null = null;

    if (profile.followsCount > 0) {
      const rawRatio = profile.followersCount / profile.followsCount;
      authorityRatioRaw = this.round(rawRatio, 2);

      // Logarithmic scaling for better differentiation:
      // log10(10) = 1 → 25, log10(100) = 2 → 50, log10(1000) = 3 → 75, log10(10000) = 4 → 100
      authorityRatio = this.round(Math.min(100, Math.max(0, Math.log10(rawRatio) * 25)), 2);
      this.metricsCalculated += 2;

      logger.debug('authorityRatio calculated', {
        ...logContext,
        rawRatio: authorityRatioRaw,
        logScore: authorityRatio
      });
    } else if (profile.followersCount >= 100) {
      // Perfect score when follows=0 but has significant followers (rare, highly authoritative)
      authorityRatioRaw = profile.followersCount; // Use followers as raw (since can't divide by 0)
      authorityRatio = 100;
      this.metricsCalculated += 2;
      logger.debug('authorityRatio: perfect score (follows=0 with followers)', {
        ...logContext,
        authorityRatioRaw,
        authorityRatio
      });
    } else {
      logger.debug('authorityRatio skipped: followsCount is 0 with few followers', logContext);
      this.metricsSkipped += 2;
    }

    // Extract full external URLs array with metadata
    const externalUrls: ExternalLinkInfo[] = (profile.externalUrls || []).map(link => ({
      url: link.url,
      title: link.title || '',
      linkType: (link as any).link_type || 'external'
    }));

    // Count unique URLs (deduplicate externalUrl if already in externalUrls)
    const allUrls = new Set<string>();
    if (profile.externalUrl) {
      allUrls.add(profile.externalUrl);
    }
    externalUrls.forEach(link => allUrls.add(link.url));
    const externalLinksCount = allUrls.size;

    const metrics: ProfileMetrics = {
      followersCount: profile.followersCount,
      followsCount: profile.followsCount,
      postsCount: profile.postsCount,
      authorityRatioRaw,
      authorityRatio,
      isBusinessAccount: profile.isBusinessAccount || false,
      verified: profile.verified || false,
      hasChannel: profile.hasChannel || false,
      businessCategoryName: profile.businessCategoryName || null,
      hasExternalLink: profile.externalUrl !== null || externalLinksCount > 0,
      externalUrl: profile.externalUrl || null,
      externalUrls,
      externalLinksCount,
      highlightReelCount: profile.highlightReelCount ?? 0,
      igtvVideoCount: profile.igtvVideoCount ?? 0,
      hasBio: !!profile.biography && profile.biography.length > 0,
      bioLength: profile.biography?.length || 0,
      username: profile.username
    };

    // Count calculated metrics
    this.metricsCalculated += 15; // 16 metrics minus authorityRatio already counted

    logger.info('Profile metrics calculated', {
      ...logContext,
      followersCount: metrics.followersCount,
      followsCount: metrics.followsCount,
      postsCount: metrics.postsCount,
      authorityRatio: metrics.authorityRatio,
      verified: metrics.verified,
      isBusinessAccount: metrics.isBusinessAccount
    });

    return metrics;
  }

  // ===========================================================================
  // GROUP 2a: ENGAGEMENT METRICS (Requires posts with engagement data)
  // ===========================================================================

  private calculateEngagementMetrics(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): EngagementMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'EngagementMetrics', username: profile.username };

    if (!flags.hasPosts) {
      logger.warn('Skipping engagement metrics: No posts available', logContext);
      this.addSkippedReason('EngagementMetrics', 'No posts available', [
        'totalLikes', 'totalComments', 'avgLikesPerPost', 'engagementRate', 'etc.'
      ]);
      this.metricsSkipped += 11;
      return this.buildNullEngagementMetrics('No posts available');
    }

    if (!flags.hasEngagementData) {
      logger.warn('Skipping engagement metrics: Posts lack engagement data', logContext);
      this.addSkippedReason('EngagementMetrics', 'Posts lack engagement data', [
        'totalLikes', 'totalComments', 'avgLikesPerPost', 'engagementRate', 'etc.'
      ]);
      this.metricsSkipped += 11;
      return this.buildNullEngagementMetrics('Posts lack engagement data');
    }

    logger.info('Calculating engagement metrics...', {
      ...logContext,
      postCount: profile.latestPosts.length
    });

    const posts = profile.latestPosts;
    const postCount = posts.length;

    // Calculate totals
    const totalLikes = posts.reduce((sum, p) => sum + (p.likesCount || 0), 0);
    const totalComments = posts.reduce((sum, p) => sum + (p.commentsCount || 0), 0);
    const totalEngagement = totalLikes + totalComments;

    logger.debug('Engagement totals calculated', {
      ...logContext,
      totalLikes,
      totalComments,
      totalEngagement
    });

    // Calculate averages
    const avgLikesPerPost = this.round(totalLikes / postCount, 2);
    const avgCommentsPerPost = this.round(totalComments / postCount, 2);
    const avgEngagementPerPost = this.round(totalEngagement / postCount, 2);

    // Engagement rate (DECIMAL: raw ratio, not percentage)
    // Example: 288,227 / 6,552,484 = 0.044 (represents 4.4%)
    let engagementRate: number | null = null;
    if (profile.followersCount > 0) {
      engagementRate = this.round(avgEngagementPerPost / profile.followersCount, 4);
    }

    logger.debug('Engagement rate calculated', {
      ...logContext,
      avgEngagementPerPost,
      followersCount: profile.followersCount,
      engagementRate,
      engagementRatePercent: engagementRate ? (engagementRate * 100).toFixed(2) + '%' : null
    });

    // Comment to like ratio (standardized to 3 decimal places for consistency)
    let commentToLikeRatio: number | null = null;
    if (avgLikesPerPost > 0) {
      commentToLikeRatio = this.round(avgCommentsPerPost / avgLikesPerPost, 3);
    }

    // Per-post engagement rates for consistency calculation
    // Note: Raw rates without time-weighting (used for general metrics)
    const engagementRatePerPost = posts.map(p => {
      const postEngagement = (p.likesCount || 0) + (p.commentsCount || 0);
      return profile.followersCount > 0
        ? this.round((postEngagement / profile.followersCount) * 100, 4)
        : 0;
    });

    // =========================================================================
    // ENGAGEMENT CONSISTENCY CALCULATION
    // Uses Coefficient of Variation (CV) with time-based weighting
    //
    // CV = stdDev / mean - normalizes variation relative to average engagement
    // Time weighting accounts for recent posts still accumulating engagement
    //
    // Interpretation guide:
    // - CV < 0.5: Very consistent engagement across posts
    // - CV 0.5-1.0: Moderate variation (normal for most accounts)
    // - CV 1.0-2.0: High variation (some posts perform much better)
    // - CV > 2.0: Extreme variation (viral posts + flops)
    //
    // Consistency score = 100 / (1 + CV)
    // - Score ~100: All posts perform similarly
    // - Score ~50: Significant variation (CV = 1)
    // - Score ~33: High variation (CV = 2)
    // - Score ~25: Extreme variation (CV = 3)
    // =========================================================================

    // Calculate time-weighted engagement rates (normalize for post age)
    const weightedEngagementRates = posts.map(p => {
      const postEngagement = (p.likesCount || 0) + (p.commentsCount || 0);
      const rawRate = profile.followersCount > 0
        ? (postEngagement / profile.followersCount) * 100
        : 0;

      // Apply time-based multiplier to normalize for post age
      const ageMultiplier = this.getPostAgeMultiplier(p.timestamp);
      // Divide by multiplier to boost recent posts' apparent engagement
      return ageMultiplier > 0 ? rawRate / ageMultiplier : rawRate;
    });

    const engagementStdDev = this.calculateStdDev(weightedEngagementRates);

    // Calculate mean engagement rate for CV calculation
    const meanEngagementRate = weightedEngagementRates.length > 0
      ? weightedEngagementRates.reduce((a, b) => a + b, 0) / weightedEngagementRates.length
      : null;

    let engagementConsistency: number | null = null;
    let coefficientOfVariation: number | null = null;

    if (engagementStdDev !== null && meanEngagementRate !== null && meanEngagementRate > 0.0001) {
      // Protect against division by very small numbers (floating point precision)
      coefficientOfVariation = this.round(engagementStdDev / meanEngagementRate, 4);
      // Scale: CV of 0 = 100 consistency, CV of 1 = 50 consistency, CV of 2 = 33 consistency
      engagementConsistency = this.round(100 / (1 + coefficientOfVariation), 2);
    }

    logger.debug('Engagement consistency calculated', {
      ...logContext,
      engagementStdDev,
      meanEngagementRate,
      coefficientOfVariation,
      engagementConsistency,
      timeWeightingApplied: true
    });

    this.metricsCalculated += 11;

    const metrics: EngagementMetrics = {
      totalLikes,
      totalComments,
      totalEngagement,
      avgLikesPerPost,
      avgCommentsPerPost,
      avgEngagementPerPost,
      engagementRate,
      commentToLikeRatio,
      engagementStdDev,
      engagementConsistency,
      engagementRatePerPost,
      _reason: null
    };

    logger.info('Engagement metrics calculated', {
      ...logContext,
      totalLikes,
      totalComments,
      engagementRate,
      engagementConsistency
    });

    return metrics;
  }

  private buildNullEngagementMetrics(reason: string): EngagementMetrics {
    return {
      totalLikes: null,
      totalComments: null,
      totalEngagement: null,
      avgLikesPerPost: null,
      avgCommentsPerPost: null,
      avgEngagementPerPost: null,
      engagementRate: null,
      commentToLikeRatio: null,
      engagementStdDev: null,
      engagementConsistency: null,
      engagementRatePerPost: [],
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 2b: FREQUENCY METRICS (Requires posts with timestamps)
  // ===========================================================================

  private calculateFrequencyMetrics(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): FrequencyMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'FrequencyMetrics', username: profile.username };

    if (!flags.hasPosts) {
      logger.warn('Skipping frequency metrics: No posts available', logContext);
      this.addSkippedReason('FrequencyMetrics', 'No posts available', [
        'postingFrequency', 'daysSinceLastPost', 'postingConsistency'
      ]);
      this.metricsSkipped += 8;
      return this.buildNullFrequencyMetrics('No posts available');
    }

    if (!flags.hasTimestamps) {
      logger.warn('Skipping frequency metrics: Posts lack timestamps', logContext);
      this.addSkippedReason('FrequencyMetrics', 'Posts lack timestamps', [
        'postingFrequency', 'daysSinceLastPost', 'postingConsistency'
      ]);
      this.metricsSkipped += 8;
      return this.buildNullFrequencyMetrics('Posts lack timestamps');
    }

    logger.info('Calculating frequency metrics...', logContext);

    const posts = profile.latestPosts;

    // Parse timestamps and sort
    const timestamps = posts
      .map(p => this.parseTimestamp(p.timestamp))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    if (timestamps.length === 0) {
      logger.warn('No valid timestamps found', logContext);
      this.metricsSkipped += 8;
      return this.buildNullFrequencyMetrics('No valid timestamps');
    }

    const oldestTimestamp = timestamps[0];
    const newestTimestamp = timestamps[timestamps.length - 1];
    const now = Date.now();

    const oldestPostTimestamp = new Date(oldestTimestamp).toISOString();
    const newestPostTimestamp = new Date(newestTimestamp).toISOString();
    const postingPeriodDays = this.round((newestTimestamp - oldestTimestamp) / 86400000, 2);
    const daysSinceLastPost = this.round((now - newestTimestamp) / 86400000, 2);

    logger.debug('Timestamp analysis', {
      ...logContext,
      oldestPostTimestamp,
      newestPostTimestamp,
      postingPeriodDays,
      daysSinceLastPost
    });

    // Calculate posting frequency (posts per month)
    let postingFrequency: number | null = null;
    if (postingPeriodDays > 0) {
      postingFrequency = this.round((timestamps.length / postingPeriodDays) * 30, 2);
    } else if (timestamps.length === 1) {
      // Single post - can't calculate frequency
      logger.debug('Single post - cannot calculate frequency', logContext);
    }

    // Calculate time between posts
    const timeBetweenPostsDays: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const daysBetween = (timestamps[i] - timestamps[i - 1]) / 86400000;
      timeBetweenPostsDays.push(this.round(daysBetween, 2));
    }

    const avgDaysBetweenPosts = timeBetweenPostsDays.length > 0
      ? this.round(timeBetweenPostsDays.reduce((a, b) => a + b, 0) / timeBetweenPostsDays.length, 2)
      : null;

    // Posting consistency formula: 100 / (1 + (stdDev / 5))
    let postingConsistency: number | null = null;
    if (timeBetweenPostsDays.length > 1) {
      const stdDev = this.calculateStdDev(timeBetweenPostsDays);
      if (stdDev !== null) {
        postingConsistency = this.round(100 / (1 + (stdDev / 5)), 2);
      }
    }

    logger.debug('Posting consistency calculated', {
      ...logContext,
      avgDaysBetweenPosts,
      postingConsistency,
      timeBetweenPostsCount: timeBetweenPostsDays.length
    });

    this.metricsCalculated += 8;

    const metrics: FrequencyMetrics = {
      oldestPostTimestamp,
      newestPostTimestamp,
      postingPeriodDays,
      postingFrequency,
      daysSinceLastPost,
      avgDaysBetweenPosts,
      timeBetweenPostsDays,
      postingConsistency,
      _reason: null
    };

    logger.info('Frequency metrics calculated', {
      ...logContext,
      postingFrequency,
      daysSinceLastPost,
      postingConsistency
    });

    return metrics;
  }

  private buildNullFrequencyMetrics(reason: string): FrequencyMetrics {
    return {
      oldestPostTimestamp: null,
      newestPostTimestamp: null,
      postingPeriodDays: null,
      postingFrequency: null,
      daysSinceLastPost: null,
      avgDaysBetweenPosts: null,
      timeBetweenPostsDays: [],
      postingConsistency: null,
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 2c: FORMAT METRICS (Requires posts)
  // ===========================================================================

  private calculateFormatMetrics(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): FormatMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'FormatMetrics', username: profile.username };

    if (!flags.hasPosts) {
      logger.warn('Skipping format metrics: No posts available', logContext);
      this.addSkippedReason('FormatMetrics', 'No posts available', [
        'reelsRate', 'videoRate', 'imageRate', 'formatDiversity'
      ]);
      this.metricsSkipped += 10;
      return this.buildNullFormatMetrics('No posts available');
    }

    logger.info('Calculating format metrics...', logContext);

    const posts = profile.latestPosts;
    const postCount = posts.length;

    // Log raw post type data for debugging format detection
    logger.debug('Raw post types for format detection', {
      ...logContext,
      postCount,
      posts: posts.slice(0, 5).map(p => ({
        id: p.id,
        type: p.type,
        productType: p.productType,
        hasVideoUrl: !!p.videoUrl
      }))
    });

    // Count by format
    // Note: Reels are a SUBSET of Videos (all reels have type='Video' AND productType='clips')
    const reelsCount = posts.filter(p => p.productType === 'clips').length;
    const videoCount = posts.filter(p => p.type === 'Video').length;
    const nonReelsVideoCount = videoCount - reelsCount; // Traditional videos (IGTV, regular videos)
    const imageCount = posts.filter(p => p.type === 'Image').length;
    const carouselCount = posts.filter(p => p.type === 'Sidecar').length;

    logger.debug('Format counts', {
      ...logContext,
      reelsCount,
      videoCount,
      nonReelsVideoCount,
      imageCount,
      carouselCount,
      total: postCount,
      note: 'reelsCount + nonReelsVideoCount = videoCount'
    });

    // Calculate rates
    const reelsRate = this.round((reelsCount / postCount) * 100, 2);
    const videoRate = this.round((videoCount / postCount) * 100, 2);
    const imageRate = this.round((imageCount / postCount) * 100, 2);
    const carouselRate = this.round((carouselCount / postCount) * 100, 2);

    // Format diversity (0-4 scale)
    // Counts distinct format types used:
    // - Reels (short-form vertical videos)
    // - Non-reels videos (traditional videos, IGTV)
    // - Images
    // - Carousels
    let formatDiversity = 0;
    if (reelsCount > 0) formatDiversity++;
    if (nonReelsVideoCount > 0) formatDiversity++; // Only count non-reels videos separately
    if (imageCount > 0) formatDiversity++;
    if (carouselCount > 0) formatDiversity++;

    // Determine dominant format
    // Note: For dominantFormat, we use the more specific breakdown
    const formatCounts = [
      { format: 'reels' as const, count: reelsCount },
      { format: 'video' as const, count: nonReelsVideoCount }, // Non-reels videos only
      { format: 'image' as const, count: imageCount },
      { format: 'carousel' as const, count: carouselCount }
    ].sort((a, b) => b.count - a.count);

    let dominantFormat: 'reels' | 'video' | 'image' | 'carousel' | 'mixed' | null = null;
    if (postCount > 0) {
      const topFormat = formatCounts[0];
      const secondFormat = formatCounts[1];
      // If top format is >50% of posts, it's dominant
      if (topFormat.count > postCount * 0.5) {
        dominantFormat = topFormat.format;
      } else if (topFormat.count > 0 && secondFormat.count > 0) {
        dominantFormat = 'mixed';
      }
    }

    this.metricsCalculated += 11; // Added nonReelsVideoCount

    const metrics: FormatMetrics = {
      reelsCount,
      videoCount,
      nonReelsVideoCount,
      imageCount,
      carouselCount,
      reelsRate,
      videoRate,
      imageRate,
      carouselRate,
      formatDiversity,
      dominantFormat,
      _reason: null
    };

    logger.info('Format metrics calculated', {
      ...logContext,
      formatDiversity,
      dominantFormat,
      reelsRate,
      imageRate
    });

    return metrics;
  }

  private buildNullFormatMetrics(reason: string): FormatMetrics {
    return {
      reelsCount: 0,
      videoCount: 0,
      nonReelsVideoCount: 0,
      imageCount: 0,
      carouselCount: 0,
      reelsRate: null,
      videoRate: null,
      imageRate: null,
      carouselRate: null,
      formatDiversity: 0,
      dominantFormat: null,
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 2d: CONTENT METRICS (Requires posts)
  // ===========================================================================

  private calculateContentMetrics(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): ContentMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'ContentMetrics', username: profile.username };

    if (!flags.hasPosts) {
      logger.warn('Skipping content metrics: No posts available', logContext);
      this.addSkippedReason('ContentMetrics', 'No posts available', [
        'avgHashtagsPerPost', 'avgMentionsPerPost', 'locationTaggingRate'
      ]);
      this.metricsSkipped += 14;
      return this.buildNullContentMetrics('No posts available');
    }

    logger.info('Calculating content metrics...', logContext);

    const posts = profile.latestPosts;
    const postCount = posts.length;

    // Hashtag analysis - clean and normalize for proper deduplication
    // Uses cleanHashtag to remove trailing punctuation (commas, periods, etc.) and normalize
    const allHashtags = posts
      .flatMap(p => p.hashtags || [])
      .map(h => this.cleanHashtag(h))
      .filter(h => h.length > 0);
    const totalHashtags = allHashtags.length;
    const uniqueHashtags = [...new Set(allHashtags)];
    const uniqueHashtagCount = uniqueHashtags.length;
    const avgHashtagsPerPost = this.round(totalHashtags / postCount, 2);
    const hashtagDiversity = totalHashtags > 0
      ? this.round(uniqueHashtagCount / totalHashtags, 4)
      : null;

    // Validation: uniqueHashtagCount should always be <= totalHashtags
    if (uniqueHashtagCount > totalHashtags) {
      logger.warn('Hashtag validation failed: uniqueHashtagCount > totalHashtags', {
        ...logContext,
        totalHashtags,
        uniqueHashtagCount
      });
    }

    logger.debug('Hashtag analysis', {
      ...logContext,
      totalHashtags,
      uniqueHashtagCount,
      avgHashtagsPerPost,
      hashtagDiversity,
      topHashtags: uniqueHashtags.slice(0, 5) // Show top 5 for debugging
    });

    // Mention analysis
    const allMentions = posts.flatMap(p => p.mentions || []);
    const totalMentions = allMentions.length;
    const uniqueMentionCount = new Set(allMentions).size;
    const avgMentionsPerPost = this.round(totalMentions / postCount, 2);

    // Caption analysis
    // Note: JavaScript .length counts UTF-16 code units (emojis = 2 chars)
    // All posts included, even those with empty captions
    const captions = posts.map(p => p.caption || '');
    const captionLengths = captions.map(c => c.length);
    const totalCaptionLength = captionLengths.reduce((a, b) => a + b, 0);
    const avgCaptionLength = this.round(totalCaptionLength / postCount, 2);
    const maxCaptionLength = Math.max(...captionLengths);

    // Additional metrics for posts with captions only
    const postsWithCaptions = captions.filter(c => c.length > 0).length;
    const avgCaptionLengthNonEmpty = postsWithCaptions > 0
      ? this.round(totalCaptionLength / postsWithCaptions, 2)
      : null;

    logger.debug('Caption analysis', {
      ...logContext,
      totalPosts: postCount,
      postsWithCaptions,
      avgCaptionLength,
      avgCaptionLengthNonEmpty,
      maxCaptionLength,
      note: 'avgCaptionLength includes empty captions; avgCaptionLengthNonEmpty excludes them'
    });

    // Location analysis
    const postsWithLocation = posts.filter(p => p.locationName !== null && p.locationName !== undefined).length;
    const locationTaggingRate = this.round((postsWithLocation / postCount) * 100, 2);

    // Alt text analysis
    const postsWithAltText = posts.filter(p => p.alt !== null && p.alt !== undefined && p.alt.length > 0).length;
    const altTextRate = this.round((postsWithAltText / postCount) * 100, 2);

    // Comments disabled analysis
    const postsWithCommentsDisabled = posts.filter(p => p.isCommentsDisabled === true).length;
    const commentsDisabledRate = this.round((postsWithCommentsDisabled / postCount) * 100, 2);
    const commentsEnabledRate = this.round(100 - commentsDisabledRate, 2);

    this.metricsCalculated += 14;

    const metrics: ContentMetrics = {
      totalHashtags,
      avgHashtagsPerPost,
      uniqueHashtagCount,
      hashtagDiversity,
      totalMentions,
      avgMentionsPerPost,
      uniqueMentionCount,
      totalCaptionLength,
      avgCaptionLength,
      maxCaptionLength,
      postsWithLocation,
      locationTaggingRate,
      postsWithAltText,
      altTextRate,
      postsWithCommentsDisabled,
      commentsDisabledRate,
      commentsEnabledRate,
      _reason: null
    };

    logger.info('Content metrics calculated', {
      ...logContext,
      avgHashtagsPerPost,
      avgCaptionLength,
      locationTaggingRate,
      commentsEnabledRate
    });

    return metrics;
  }

  private buildNullContentMetrics(reason: string): ContentMetrics {
    return {
      totalHashtags: 0,
      avgHashtagsPerPost: null,
      uniqueHashtagCount: 0,
      hashtagDiversity: null,
      totalMentions: 0,
      avgMentionsPerPost: null,
      uniqueMentionCount: 0,
      totalCaptionLength: 0,
      avgCaptionLength: null,
      maxCaptionLength: 0,
      postsWithLocation: 0,
      locationTaggingRate: null,
      postsWithAltText: 0,
      altTextRate: null,
      postsWithCommentsDisabled: 0,
      commentsDisabledRate: null,
      commentsEnabledRate: null,
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 3: VIDEO METRICS (Requires posts with video view data)
  // ===========================================================================

  private calculateVideoMetrics(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): VideoMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'VideoMetrics', username: profile.username };

    if (!flags.hasVideoData) {
      logger.warn('Skipping video metrics: No video view data available', logContext);
      this.addSkippedReason('VideoMetrics', 'No video view data available', [
        'avgVideoViews', 'videoViewToLikeRatio'
      ]);
      this.metricsSkipped += 4;
      return this.buildNullVideoMetrics('No video view data available');
    }

    logger.info('Calculating video metrics...', logContext);

    const posts = profile.latestPosts;

    // Filter to posts with video view data
    const videoPosts = posts.filter(
      p => p.videoViewCount !== undefined && p.videoViewCount !== null
    );

    const videoPostCount = videoPosts.length;

    if (videoPostCount === 0) {
      logger.warn('No posts with video view count found', logContext);
      this.metricsSkipped += 4;
      return this.buildNullVideoMetrics('No posts with video view count');
    }

    // Calculate view totals
    const totalVideoViews = videoPosts.reduce((sum, p) => sum + (p.videoViewCount || 0), 0);
    const avgVideoViews = this.round(totalVideoViews / videoPostCount, 2);

    // Video view to like ratio
    const videoLikes = videoPosts.reduce((sum, p) => sum + (p.likesCount || 0), 0);
    const avgVideoLikes = videoLikes / videoPostCount;
    let videoViewToLikeRatio: number | null = null;
    if (avgVideoLikes > 0) {
      videoViewToLikeRatio = this.round(avgVideoViews / avgVideoLikes, 2);
    }

    this.metricsCalculated += 4;

    const metrics: VideoMetrics = {
      videoPostCount,
      totalVideoViews,
      avgVideoViews,
      videoViewToLikeRatio,
      _reason: null
    };

    logger.info('Video metrics calculated', {
      ...logContext,
      videoPostCount,
      avgVideoViews,
      videoViewToLikeRatio
    });

    return metrics;
  }

  private buildNullVideoMetrics(reason: string): VideoMetrics {
    return {
      videoPostCount: 0,
      totalVideoViews: null,
      avgVideoViews: null,
      videoViewToLikeRatio: null,
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 4: RISK SCORES & DERIVED METRICS
  // ===========================================================================

  /**
   * Calculate Fake Follower Risk Score (0-100)
   *
   * IMPORTANT DISCLAIMER:
   * This is a HEURISTIC-BASED indicator, NOT a definitive measure of fake followers.
   * It identifies patterns commonly associated with purchased followers or bot activity,
   * but legitimate accounts can trigger these signals due to various factors:
   * - New accounts still building engagement
   * - Niche content with naturally lower engagement
   * - Celebrity/brand accounts with passive followers
   * - Recent viral growth that engagement hasn't caught up with
   *
   * Use this score as ONE data point among many, not as definitive proof.
   * High scores warrant manual review, not automatic rejection.
   *
   * Interpretation Guide:
   * - 0-20: Low risk - Few or no warning signs
   * - 21-40: Moderate risk - Some patterns present, worth noting
   * - 41-60: Elevated risk - Multiple warning signs, recommend manual review
   * - 61-80: High risk - Strong indicators of inauthenticity
   * - 81-100: Very high risk - Multiple severe indicators
   *
   * Factors Evaluated:
   * 1. Engagement Rate vs Account Size (0-35 points)
   * 2. Authority Ratio / Follow Ratio (0-25 points)
   * 3. Content-to-Follower Ratio (0-20 points)
   * 4. Engagement Consistency Anomalies (0-20 points)
   */
  private calculateRiskScores(
    profile: ApifyFullProfile,
    engagementMetrics: EngagementMetrics,
    flags: DataAvailabilityFlags
  ): RiskScores {
    const logContext = { service: 'ProfileExtraction', group: 'RiskScores', username: profile.username };

    logger.info('Calculating risk scores...', logContext);

    const warnings: string[] = [];
    let fakeFollowerRiskScore = 0;

    // =========================================================================
    // FACTOR 1: Engagement Rate Analysis (0-35 points)
    // Low engagement relative to followers is a key indicator of inauthentic followers.
    // Uses tiered thresholds based on account size (larger accounts naturally have lower ER).
    // =========================================================================
    if (engagementMetrics.engagementRate !== null) {
      const er = engagementMetrics.engagementRate;
      const followers = profile.followersCount;

      // Tiered thresholds: larger accounts naturally have lower engagement rates
      // Industry benchmarks: micro (<10k): 3-6%, small (10-50k): 2-4%, medium (50-500k): 1-2%, large (>500k): 0.5-1%
      let expectedMinER: number;
      if (followers < 10000) {
        expectedMinER = 1.5;  // Micro accounts should have at least 1.5%
      } else if (followers < 50000) {
        expectedMinER = 1.0;  // Small accounts: at least 1%
      } else if (followers < 500000) {
        expectedMinER = 0.5;  // Medium accounts: at least 0.5%
      } else {
        expectedMinER = 0.2;  // Large accounts: at least 0.2%
      }

      if (er < expectedMinER * 0.25) {
        // Critically low engagement (< 25% of expected)
        fakeFollowerRiskScore += 35;
        warnings.push(`Critically low engagement rate (${er.toFixed(2)}% vs expected >${expectedMinER}%)`);
      } else if (er < expectedMinER * 0.5) {
        // Very low engagement (25-50% of expected)
        fakeFollowerRiskScore += 25;
        warnings.push(`Very low engagement rate (${er.toFixed(2)}% vs expected >${expectedMinER}%)`);
      } else if (er < expectedMinER) {
        // Below expected engagement
        fakeFollowerRiskScore += 15;
        warnings.push(`Below-average engagement rate (${er.toFixed(2)}% vs expected >${expectedMinER}%)`);
      }

      logger.debug('Risk factor: Engagement analysis', {
        ...logContext,
        engagementRate: er,
        expectedMinER,
        followers,
        riskAdded: fakeFollowerRiskScore
      });
    }

    // =========================================================================
    // FACTOR 2: Authority Ratio Analysis (0-25 points)
    // Following more people than followers can indicate follow/unfollow schemes.
    // Note: This overlaps with factor 3 in the old code, now consolidated.
    // =========================================================================
    if (profile.followsCount > 0 && profile.followersCount > 0) {
      const authorityRatio = profile.followersCount / profile.followsCount;

      if (authorityRatio < 0.3) {
        // Extremely low authority - follows 3x+ more than followers
        fakeFollowerRiskScore += 25;
        warnings.push(`Very low authority ratio (${authorityRatio.toFixed(2)}x) - follows far exceed followers`);
      } else if (authorityRatio < 0.7) {
        // Low authority - follows significantly more than followers
        fakeFollowerRiskScore += 15;
        warnings.push(`Low authority ratio (${authorityRatio.toFixed(2)}x) - follows exceed followers`);
      } else if (authorityRatio < 1.0) {
        // Borderline - follows slightly more than followers
        fakeFollowerRiskScore += 5;
        warnings.push(`Borderline authority ratio (${authorityRatio.toFixed(2)}x)`);
      }

      logger.debug('Risk factor: Authority ratio', {
        ...logContext,
        authorityRatio,
        followersCount: profile.followersCount,
        followsCount: profile.followsCount
      });
    }

    // =========================================================================
    // FACTOR 3: Content-to-Follower Ratio (0-20 points)
    // High followers with very few posts can indicate purchased followers.
    // Legitimate accounts typically grow followers through content.
    // =========================================================================
    if (profile.followersCount > 1000 && profile.postsCount > 0) {
      const followersPerPost = profile.followersCount / profile.postsCount;

      // Expected: roughly 50-500 followers per post for organic growth
      // Very high ratios indicate growth that outpaces content creation
      if (followersPerPost > 5000 && profile.followersCount > 50000) {
        fakeFollowerRiskScore += 20;
        warnings.push(`Unrealistic followers/post ratio (${Math.round(followersPerPost)}:1) - growth outpaces content`);
      } else if (followersPerPost > 2000 && profile.followersCount > 20000) {
        fakeFollowerRiskScore += 12;
        warnings.push(`High followers/post ratio (${Math.round(followersPerPost)}:1)`);
      } else if (followersPerPost > 1000 && profile.followersCount > 10000) {
        fakeFollowerRiskScore += 5;
        warnings.push(`Elevated followers/post ratio (${Math.round(followersPerPost)}:1)`);
      }

      logger.debug('Risk factor: Content-to-follower ratio', {
        ...logContext,
        followersPerPost,
        followersCount: profile.followersCount,
        postsCount: profile.postsCount
      });
    }

    // =========================================================================
    // FACTOR 4: Engagement Consistency Analysis (0-20 points)
    // Suspiciously consistent OR wildly inconsistent engagement can indicate bots.
    // Bot engagement often shows unnaturally even distribution.
    // =========================================================================
    if (engagementMetrics.engagementConsistency !== null && engagementMetrics.engagementRate !== null) {
      const consistency = engagementMetrics.engagementConsistency;
      const er = engagementMetrics.engagementRate;

      // Suspiciously HIGH consistency with low engagement = potential bot engagement
      // (Bots tend to deliver consistent numbers, organic engagement varies naturally)
      if (consistency > 90 && er < 1.0) {
        fakeFollowerRiskScore += 15;
        warnings.push(`Suspiciously consistent engagement (${consistency.toFixed(0)}%) with low rate`);
      }

      // Very LOW consistency might indicate engagement manipulation on specific posts
      if (consistency < 20) {
        fakeFollowerRiskScore += 10;
        warnings.push(`Highly inconsistent engagement (${consistency.toFixed(0)}%) - possible selective boosting`);
      }

      logger.debug('Risk factor: Engagement consistency', {
        ...logContext,
        engagementConsistency: consistency,
        engagementRate: er
      });
    }

    // Clamp to 0-100
    fakeFollowerRiskScore = Math.min(100, Math.max(0, fakeFollowerRiskScore));

    this.metricsCalculated += 2;

    const metrics: RiskScores = {
      fakeFollowerRiskScore,
      fakeFollowerWarnings: warnings,
      _reason: null
    };

    logger.info('Risk scores calculated', {
      ...logContext,
      fakeFollowerRiskScore,
      warningsCount: warnings.length,
      interpretation: fakeFollowerRiskScore <= 20 ? 'LOW_RISK' :
                       fakeFollowerRiskScore <= 40 ? 'MODERATE_RISK' :
                       fakeFollowerRiskScore <= 60 ? 'ELEVATED_RISK' :
                       fakeFollowerRiskScore <= 80 ? 'HIGH_RISK' : 'VERY_HIGH_RISK'
    });

    return metrics;
  }

  private calculateDerivedMetrics(
    profile: ApifyFullProfile,
    engagementMetrics: EngagementMetrics,
    frequencyMetrics: FrequencyMetrics,
    flags: DataAvailabilityFlags
  ): DerivedMetrics {
    const logContext = { service: 'ProfileExtraction', group: 'DerivedMetrics', username: profile.username };

    logger.info('Calculating derived metrics...', logContext);

    // Content Density (posts per follower)
    let contentDensity: number | null = null;
    if (profile.followersCount > 0) {
      contentDensity = this.round((profile.postsCount / profile.followersCount) * 1000, 4);
    }

    // Viral Post Analysis
    // Note: Based on small sample (typically 12 posts), NOT statistically significant
    let recentViralPostCount = 0;
    let recentPostsSampled = 0;
    let viralPostRate: number | null = null;

    if (flags.hasPosts && engagementMetrics.avgEngagementPerPost !== null) {
      const viralThreshold = engagementMetrics.avgEngagementPerPost * 2;
      const posts = profile.latestPosts;
      recentPostsSampled = posts.length;

      recentViralPostCount = posts.filter(p => {
        const engagement = (p.likesCount || 0) + (p.commentsCount || 0);
        return engagement >= viralThreshold;
      }).length;

      // Keep viralPostRate for backwards compatibility (deprecated)
      viralPostRate = this.round((recentViralPostCount / posts.length) * 100, 2);

      logger.debug('Viral post analysis (sample-based)', {
        ...logContext,
        viralThreshold,
        recentViralPostCount,
        recentPostsSampled,
        note: `${recentViralPostCount} of ${recentPostsSampled} recent posts are viral - NOT representative of full history`
      });
    }

    this.metricsCalculated += 4;

    const metrics: DerivedMetrics = {
      contentDensity,
      recentViralPostCount,
      recentPostsSampled,
      viralPostRate, // deprecated, kept for backwards compatibility
      _reason: null
    };

    logger.info('Derived metrics calculated', {
      ...logContext,
      contentDensity,
      recentViralPostCount,
      recentPostsSampled
    });

    return metrics;
  }

  // ===========================================================================
  // GROUP 5: TEXT DATA FOR AI ANALYSIS
  // ===========================================================================

  private extractTextData(
    profile: ApifyFullProfile,
    flags: DataAvailabilityFlags
  ): TextDataForAI {
    const logContext = { service: 'ProfileExtraction', group: 'TextDataForAI', username: profile.username };

    logger.info('Extracting text data for AI...', logContext);

    const posts = profile.latestPosts || [];

    // Biography
    const biography = profile.biography || '';

    // Recent captions (first 10 posts)
    const recentCaptions = posts
      .slice(0, 10)
      .map(p => p.caption || '')
      .filter(c => c.length > 0);

    // All hashtags - cleaned of trailing punctuation (e.g., commas, periods, exclamation marks)
    const allHashtags = posts
      .flatMap(p => p.hashtags || [])
      .map(h => this.cleanHashtag(h))
      .filter(tag => tag.length > 0);
    const uniqueHashtags = [...new Set(allHashtags)];

    // Hashtag frequency (top 10)
    const hashtagCounts = new Map<string, number>();
    allHashtags.forEach(tag => {
      hashtagCounts.set(tag, (hashtagCounts.get(tag) || 0) + 1);
    });
    const hashtagFrequency: HashtagFrequency[] = Array.from(hashtagCounts.entries())
      .map(([hashtag, count]) => ({ hashtag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // All mentions - normalize to lowercase for consistent deduplication
    const allMentions = posts.flatMap(p => (p.mentions || []).map(m => m.toLowerCase().trim()));
    const uniqueMentions = [...new Set(allMentions)];

    // Top mentions frequency (similar to hashtagFrequency)
    const mentionCounts = new Map<string, number>();
    allMentions.forEach(mention => {
      mentionCounts.set(mention, (mentionCounts.get(mention) || 0) + 1);
    });
    const topMentions: MentionFrequency[] = Array.from(mentionCounts.entries())
      .map(([username, count]) => ({ username, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5); // Top 5 mentions

    // External link titles
    const externalLinkTitles = (profile.externalUrls || []).map(l => l.title);

    // Location names
    const locationNames = posts
      .filter(p => p.locationName)
      .map(p => p.locationName as string);

    this.metricsCalculated += 8;

    const textData: TextDataForAI = {
      biography,
      recentCaptions,
      allHashtags,
      uniqueHashtags,
      totalHashtagsCount: allHashtags.length,
      uniqueHashtagsCount: uniqueHashtags.length,
      hashtagFrequency,
      allMentions,
      uniqueMentions,
      topMentions,
      externalLinkTitles,
      locationNames
    };

    logger.info('Text data extracted', {
      ...logContext,
      bioLength: biography.length,
      captionsCount: recentCaptions.length,
      uniqueHashtagsCount: uniqueHashtags.length,
      uniqueMentionsCount: uniqueMentions.length
    });

    return textData;
  }

  // ===========================================================================
  // METADATA & RESULT BUILDING
  // ===========================================================================

  private buildMetadata(profile: ApifyFullProfile): ExtractionMetadata {
    // Use performance.now() for high-resolution timing
    // Math.round converts to integer milliseconds while preserving sub-ms precision in calculation
    const endTimeHR = performance.now();
    const rawProcessingTimeMs = endTimeHR - this.startTimeHR;
    // Round to nearest millisecond, minimum 1ms for display
    const processingTimeMs = Math.max(1, Math.round(rawProcessingTimeMs));

    // Log precise timing for debugging (with sub-millisecond detail)
    logger.debug('[ProfileExtraction] High-resolution timing', {
      startTimeHR: this.startTimeHR.toFixed(3),
      endTimeHR: endTimeHR.toFixed(3),
      rawProcessingTimeMs: rawProcessingTimeMs.toFixed(3),
      reportedMs: processingTimeMs
    });

    const postCount = profile.latestPosts?.length || 0;

    // Calculate data completeness - capped at 100% to prevent display issues
    const totalPossibleMetrics = 73; // Total number of metrics defined
    const rawCompleteness = (this.metricsCalculated / totalPossibleMetrics) * 100;
    const dataCompleteness = this.round(Math.min(100, rawCompleteness), 2);

    const metadata: ExtractionMetadata = {
      username: profile.username,
      processedAt: new Date().toISOString(),
      processingTimeMs,
      samplePostCount: postCount,
      totalPostCount: profile.postsCount,
      dataCompleteness,
      metricsCalculated: this.metricsCalculated,
      metricsSkipped: this.metricsSkipped,
      skippedReasons: this.skippedReasons,
      extractionVersion: ProfileExtractionService.VERSION
    };

    return metadata;
  }

  private buildErrorResult(validation: ValidationResult, rawProfile: unknown): ExtractionOutput {
    const endTimeHR = performance.now();
    const rawProcessingTimeMs = endTimeHR - this.startTimeHR;
    const processingTimeMs = Math.max(1, Math.round(rawProcessingTimeMs));
    const username = (rawProfile as any)?.username || 'unknown';

    const primaryError = validation.errors[0] || {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown validation error'
    };

    return {
      success: false,
      error: {
        code: primaryError.code,
        message: primaryError.message,
        details: {
          allErrors: validation.errors,
          flags: validation.flags
        }
      },
      metadata: {
        username,
        processedAt: new Date().toISOString(),
        processingTimeMs
      }
    };
  }

  // ===========================================================================
  // LOGGING SUMMARY
  // ===========================================================================

  private logExtractionSummary(result: ExtractionResult): void {
    const logContext = { service: 'ProfileExtraction' };

    // =========================================================================
    // INFO LEVEL: Compact category summary for production monitoring
    // =========================================================================

    // Calculate metric counts per category (estimated based on data availability)
    const categoryCounts = {
      profile: 17,  // Fixed profile metrics count
      engagement: result.engagementMetrics._reason ? 0 : 11,
      frequency: result.frequencyMetrics._reason ? 0 : 8,
      format: result.formatMetrics._reason ? 0 : 11,
      content: result.contentMetrics._reason ? 0 : 14,
      video: result.videoMetrics._reason ? 0 : 4,
      risk: 2,
      derived: 4,
      text: 8
    };

    // Build compact category summary string
    const categoryParts = Object.entries(categoryCounts)
      .filter(([_, count]) => count > 0)
      .map(([name, count]) => `${name}:${count}`);

    logger.info('EXTRACTION COMPLETE', {
      ...logContext,
      username: result.metadata.username,
      processingTimeMs: result.metadata.processingTimeMs,
      samplePosts: result.metadata.samplePostCount,
      totalPosts: result.metadata.totalPostCount,
      completeness: `${result.metadata.dataCompleteness}%`,
      metrics: `${result.metadata.metricsCalculated} calculated, ${result.metadata.metricsSkipped} skipped`,
      breakdown: categoryParts.join(' | '),
      version: result.metadata.extractionVersion
    });

    // Log warnings at WARN level (always visible)
    if (result.validation.warnings.length > 0) {
      logger.warn('Extraction warnings', {
        ...logContext,
        username: result.metadata.username,
        warnings: result.validation.warnings.map(w => w.message)
      });
    }

    // Log skipped metrics at INFO level (important for debugging data issues)
    if (this.skippedReasons.length > 0) {
      logger.info('Metrics skipped due to missing data', {
        ...logContext,
        username: result.metadata.username,
        skippedGroups: this.skippedReasons.map(r => `${r.metricGroup}: ${r.reason}`)
      });
    }

    // =========================================================================
    // DEBUG LEVEL: Detailed per-group breakdown for development/debugging
    // =========================================================================

    logger.debug('=== DETAILED EXTRACTION RESULTS ===', logContext);

    logger.debug('VALIDATION FLAGS', {
      ...logContext,
      ...result.validation.flags
    });

    logger.debug('PROFILE METRICS', {
      ...logContext,
      followersCount: result.profileMetrics.followersCount,
      followsCount: result.profileMetrics.followsCount,
      postsCount: result.profileMetrics.postsCount,
      authorityRatioRaw: result.profileMetrics.authorityRatioRaw,
      authorityRatio: result.profileMetrics.authorityRatio,
      verified: result.profileMetrics.verified,
      isBusinessAccount: result.profileMetrics.isBusinessAccount,
      hasExternalLink: result.profileMetrics.hasExternalLink,
      externalLinksCount: result.profileMetrics.externalLinksCount,
      highlightReelCount: result.profileMetrics.highlightReelCount,
      hasBio: result.profileMetrics.hasBio,
      bioLength: result.profileMetrics.bioLength
    });

    logger.debug('ENGAGEMENT METRICS', {
      ...logContext,
      totalLikes: result.engagementMetrics.totalLikes,
      totalComments: result.engagementMetrics.totalComments,
      avgLikesPerPost: result.engagementMetrics.avgLikesPerPost,
      avgCommentsPerPost: result.engagementMetrics.avgCommentsPerPost,
      engagementRate: result.engagementMetrics.engagementRate,
      commentToLikeRatio: result.engagementMetrics.commentToLikeRatio,
      engagementConsistency: result.engagementMetrics.engagementConsistency,
      _reason: result.engagementMetrics._reason
    });

    logger.debug('FREQUENCY METRICS', {
      ...logContext,
      postingFrequency: result.frequencyMetrics.postingFrequency,
      daysSinceLastPost: result.frequencyMetrics.daysSinceLastPost,
      postingConsistency: result.frequencyMetrics.postingConsistency,
      avgDaysBetweenPosts: result.frequencyMetrics.avgDaysBetweenPosts,
      postingPeriodDays: result.frequencyMetrics.postingPeriodDays,
      _reason: result.frequencyMetrics._reason
    });

    logger.debug('FORMAT METRICS', {
      ...logContext,
      reelsCount: result.formatMetrics.reelsCount,
      videoCount: result.formatMetrics.videoCount,
      nonReelsVideoCount: result.formatMetrics.nonReelsVideoCount,
      imageCount: result.formatMetrics.imageCount,
      carouselCount: result.formatMetrics.carouselCount,
      formatDiversity: result.formatMetrics.formatDiversity,
      dominantFormat: result.formatMetrics.dominantFormat,
      reelsRate: result.formatMetrics.reelsRate,
      _reason: result.formatMetrics._reason
    });

    logger.debug('CONTENT METRICS', {
      ...logContext,
      avgHashtagsPerPost: result.contentMetrics.avgHashtagsPerPost,
      uniqueHashtagCount: result.contentMetrics.uniqueHashtagCount,
      hashtagDiversity: result.contentMetrics.hashtagDiversity,
      avgCaptionLength: result.contentMetrics.avgCaptionLength,
      locationTaggingRate: result.contentMetrics.locationTaggingRate,
      altTextRate: result.contentMetrics.altTextRate,
      commentsEnabledRate: result.contentMetrics.commentsEnabledRate,
      _reason: result.contentMetrics._reason
    });

    logger.debug('VIDEO METRICS', {
      ...logContext,
      videoPostCount: result.videoMetrics.videoPostCount,
      totalVideoViews: result.videoMetrics.totalVideoViews,
      avgVideoViews: result.videoMetrics.avgVideoViews,
      videoViewToLikeRatio: result.videoMetrics.videoViewToLikeRatio,
      _reason: result.videoMetrics._reason
    });

    logger.debug('RISK SCORES', {
      ...logContext,
      fakeFollowerRiskScore: result.riskScores.fakeFollowerRiskScore,
      warnings: result.riskScores.fakeFollowerWarnings
    });

    logger.debug('DERIVED METRICS', {
      ...logContext,
      contentDensity: result.derivedMetrics.contentDensity,
      recentViralPostCount: result.derivedMetrics.recentViralPostCount,
      recentPostsSampled: result.derivedMetrics.recentPostsSampled,
      viralPostRate: result.derivedMetrics.viralPostRate
    });

    logger.debug('TEXT DATA FOR AI', {
      ...logContext,
      bioLength: result.textDataForAI.biography.length,
      captionCount: result.textDataForAI.recentCaptions.length,
      uniqueHashtagCount: result.textDataForAI.uniqueHashtags.length,
      uniqueMentionCount: result.textDataForAI.uniqueMentions.length,
      topHashtags: result.textDataForAI.hashtagFrequency.slice(0, 5),
      topMentions: result.textDataForAI.topMentions.slice(0, 3)
    });

    logger.debug('=== END DETAILED RESULTS ===', logContext);
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  private parseTimestamp(timestamp: string | null | undefined): number | null {
    if (!timestamp) return null;

    // Try ISO 8601 first
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date.getTime();
    }

    // Try Unix timestamp (seconds)
    const unixSeconds = Number(timestamp);
    if (!isNaN(unixSeconds)) {
      // If it's a reasonable Unix timestamp (after year 2000)
      if (unixSeconds > 946684800 && unixSeconds < 2000000000) {
        return unixSeconds * 1000; // Convert to milliseconds
      }
      // Already in milliseconds
      if (unixSeconds > 946684800000) {
        return unixSeconds;
      }
    }

    return null;
  }

  private calculateStdDev(values: number[]): number | null {
    if (values.length < 2) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;

    return this.round(Math.sqrt(avgSquaredDiff), 4);
  }

  private calculateMedian(sortedValues: number[]): number | null {
    if (sortedValues.length === 0) return null;

    const mid = Math.floor(sortedValues.length / 2);

    if (sortedValues.length % 2 === 0) {
      return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
    }

    return sortedValues[mid];
  }

  private round(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  private addSkippedReason(metricGroup: string, reason: string, affectedMetrics: string[]): void {
    this.skippedReasons.push({ metricGroup, reason, affectedMetrics });
  }

  /**
   * Clean hashtag text by removing:
   * - Leading/trailing whitespace
   * - Trailing punctuation (commas, periods, exclamation marks, etc.)
   * - Leading # symbol (if present, will be added back in display)
   * - Normalizes to lowercase for consistent deduplication
   */
  private cleanHashtag(tag: string): string {
    return tag
      .trim()
      .toLowerCase()                          // Normalize to lowercase
      .replace(/^#+/, '')                     // Remove leading # symbols
      .replace(/[,\.!?\)]+$/, '')             // Remove trailing punctuation
      .trim();
  }

  /**
   * Get time-based multiplier for post age.
   * Used to normalize engagement for recent posts that are still accumulating engagement.
   *
   * Multipliers:
   * - < 24 hours: 0.5 (engagement still growing rapidly, weight less)
   * - 1-7 days: 0.8 (some growth still happening)
   * - > 7 days: 1.0 (engagement stabilized)
   */
  private getPostAgeMultiplier(timestamp: string): number {
    try {
      const postDate = new Date(timestamp);
      const now = Date.now();
      const ageHours = (now - postDate.getTime()) / (1000 * 60 * 60);

      if (ageHours < 24) {
        // Very recent - engagement still growing rapidly
        return 0.5;
      } else if (ageHours < 168) { // < 1 week
        // Recent - some growth still happening
        return 0.8;
      } else {
        // Old enough - engagement stabilized
        return 1.0;
      }
    } catch {
      // If timestamp parsing fails, return neutral multiplier
      return 1.0;
    }
  }
}

// Export singleton factory
export function createProfileExtractionService(): ProfileExtractionService {
  return new ProfileExtractionService();
}
