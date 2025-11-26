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
  ExtractionMetadata,
  SkippedMetricReason,
  ExtractionResult,
  ExtractionOutput
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
  private static readonly VERSION = '1.1.0';
  private static readonly MIN_POSTS_FOR_CONFIDENCE = 5;

  // Tracking for metrics calculation
  private metricsCalculated = 0;
  private metricsSkipped = 0;
  private skippedReasons: SkippedMetricReason[] = [];
  private startTime = 0;

  /**
   * Main entry point - extract all metrics from an Apify profile response
   */
  extract(rawProfile: unknown): ExtractionOutput {
    this.startTime = Date.now();
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
        processingTimeMs: Date.now() - this.startTime
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

    const postCount = profile.latestPosts?.length || 0;
    if (postCount > 0 && postCount < ProfileExtractionService.MIN_POSTS_FOR_CONFIDENCE) {
      warnings.push({
        code: 'LOW_SAMPLE_SIZE',
        message: `Only ${postCount} posts available - statistical confidence is low`
      });
      logger.warn('Warning: Low sample size', {
        service: 'ProfileExtraction',
        username: profile.username,
        postCount,
        minRequired: ProfileExtractionService.MIN_POSTS_FOR_CONFIDENCE
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

    // Check engagement data in posts
    const hasEngagementData = hasPosts && posts.some(
      p => p.likesCount !== undefined && p.commentsCount !== undefined
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

    // Authority ratio (followers / following)
    let authorityRatio: number | null = null;
    if (profile.followsCount > 0) {
      authorityRatio = this.round(profile.followersCount / profile.followsCount, 2);
      this.metricsCalculated++;
      logger.debug('authorityRatio calculated', { ...logContext, authorityRatio });
    } else {
      logger.debug('authorityRatio skipped: followsCount is 0', logContext);
      this.metricsSkipped++;
    }

    const externalLinksCount =
      (profile.externalUrls?.length || 0) +
      (profile.externalUrl ? 1 : 0);

    const metrics: ProfileMetrics = {
      followersCount: profile.followersCount,
      followsCount: profile.followsCount,
      postsCount: profile.postsCount,
      authorityRatio,
      isBusinessAccount: profile.isBusinessAccount || false,
      verified: profile.verified || false,
      hasChannel: profile.hasChannel || false,
      businessCategoryName: profile.businessCategoryName || null,
      hasExternalLink: profile.externalUrl !== null || externalLinksCount > 0,
      externalUrl: profile.externalUrl || null,
      externalLinksCount,
      highlightReelCount: profile.highlightReelCount || 0,
      igtvVideoCount: profile.igtvVideoCount || 0,
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

    // Engagement rate (INDUSTRY STANDARD: per-post average / followers)
    let engagementRate: number | null = null;
    if (profile.followersCount > 0) {
      engagementRate = this.round((avgEngagementPerPost / profile.followersCount) * 100, 4);
    }

    logger.debug('Engagement rate calculated', {
      ...logContext,
      avgEngagementPerPost,
      followersCount: profile.followersCount,
      engagementRate
    });

    // Comment to like ratio
    let commentToLikeRatio: number | null = null;
    if (avgLikesPerPost > 0) {
      commentToLikeRatio = this.round(avgCommentsPerPost / avgLikesPerPost, 4);
    }

    // Per-post engagement rates for consistency calculation
    const engagementRatePerPost = posts.map(p => {
      const postEngagement = (p.likesCount || 0) + (p.commentsCount || 0);
      return profile.followersCount > 0
        ? this.round((postEngagement / profile.followersCount) * 100, 4)
        : 0;
    });

    // Calculate statistics
    const engagementStdDev = this.calculateStdDev(engagementRatePerPost);
    const engagementConsistency = engagementStdDev !== null
      ? this.round(100 / (1 + (engagementStdDev * 10)), 2)
      : null;

    logger.debug('Engagement consistency calculated', {
      ...logContext,
      engagementStdDev,
      engagementConsistency
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

    // Count by format
    const reelsCount = posts.filter(p => p.productType === 'clips').length;
    const videoCount = posts.filter(p => p.type === 'Video').length;
    const imageCount = posts.filter(p => p.type === 'Image').length;
    const carouselCount = posts.filter(p => p.type === 'Sidecar').length;

    logger.debug('Format counts', {
      ...logContext,
      reelsCount,
      videoCount,
      imageCount,
      carouselCount,
      total: postCount
    });

    // Calculate rates
    const reelsRate = this.round((reelsCount / postCount) * 100, 2);
    const videoRate = this.round((videoCount / postCount) * 100, 2);
    const imageRate = this.round((imageCount / postCount) * 100, 2);
    const carouselRate = this.round((carouselCount / postCount) * 100, 2);

    // Format diversity (1-4 scale)
    let formatDiversity = 0;
    if (reelsCount > 0) formatDiversity++;
    if (videoCount > 0 && videoCount !== reelsCount) formatDiversity++; // Don't double count if all videos are reels
    if (imageCount > 0) formatDiversity++;
    if (carouselCount > 0) formatDiversity++;

    // Determine dominant format
    const formatCounts = [
      { format: 'reels' as const, count: reelsCount },
      { format: 'video' as const, count: videoCount },
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

    this.metricsCalculated += 10;

    const metrics: FormatMetrics = {
      reelsCount,
      videoCount,
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

    // Hashtag analysis
    const allHashtags = posts.flatMap(p => p.hashtags || []);
    const totalHashtags = allHashtags.length;
    const uniqueHashtags = [...new Set(allHashtags)];
    const uniqueHashtagCount = uniqueHashtags.length;
    const avgHashtagsPerPost = this.round(totalHashtags / postCount, 2);
    const hashtagDiversity = totalHashtags > 0
      ? this.round(uniqueHashtagCount / totalHashtags, 4)
      : null;

    logger.debug('Hashtag analysis', {
      ...logContext,
      totalHashtags,
      uniqueHashtagCount,
      avgHashtagsPerPost,
      hashtagDiversity
    });

    // Mention analysis
    const allMentions = posts.flatMap(p => p.mentions || []);
    const totalMentions = allMentions.length;
    const uniqueMentionCount = new Set(allMentions).size;
    const avgMentionsPerPost = this.round(totalMentions / postCount, 2);

    // Caption analysis
    const captions = posts.map(p => p.caption || '');
    const captionLengths = captions.map(c => c.length);
    const totalCaptionLength = captionLengths.reduce((a, b) => a + b, 0);
    const avgCaptionLength = this.round(totalCaptionLength / postCount, 2);
    const maxCaptionLength = Math.max(...captionLengths);

    logger.debug('Caption analysis', {
      ...logContext,
      avgCaptionLength,
      maxCaptionLength
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
        'avgVideoViews', 'videoViewRate', 'videoViewToLikeRatio'
      ]);
      this.metricsSkipped += 5;
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
      this.metricsSkipped += 5;
      return this.buildNullVideoMetrics('No posts with video view count');
    }

    // Calculate view totals
    const totalVideoViews = videoPosts.reduce((sum, p) => sum + (p.videoViewCount || 0), 0);
    const avgVideoViews = this.round(totalVideoViews / videoPostCount, 2);

    // Video view rate (views / followers)
    let videoViewRate: number | null = null;
    if (profile.followersCount > 0) {
      videoViewRate = this.round((avgVideoViews / profile.followersCount) * 100, 4);
    }

    // Video view to like ratio
    const videoLikes = videoPosts.reduce((sum, p) => sum + (p.likesCount || 0), 0);
    const avgVideoLikes = videoLikes / videoPostCount;
    let videoViewToLikeRatio: number | null = null;
    if (avgVideoLikes > 0) {
      videoViewToLikeRatio = this.round(avgVideoViews / avgVideoLikes, 2);
    }

    this.metricsCalculated += 5;

    const metrics: VideoMetrics = {
      videoPostCount,
      totalVideoViews,
      avgVideoViews,
      videoViewRate,
      videoViewToLikeRatio,
      _reason: null
    };

    logger.info('Video metrics calculated', {
      ...logContext,
      videoPostCount,
      avgVideoViews,
      videoViewRate
    });

    return metrics;
  }

  private buildNullVideoMetrics(reason: string): VideoMetrics {
    return {
      videoPostCount: 0,
      totalVideoViews: null,
      avgVideoViews: null,
      videoViewRate: null,
      videoViewToLikeRatio: null,
      _reason: reason
    };
  }

  // ===========================================================================
  // GROUP 4: RISK SCORES & DERIVED METRICS
  // ===========================================================================

  private calculateRiskScores(
    profile: ApifyFullProfile,
    engagementMetrics: EngagementMetrics,
    flags: DataAvailabilityFlags
  ): RiskScores {
    const logContext = { service: 'ProfileExtraction', group: 'RiskScores', username: profile.username };

    logger.info('Calculating risk scores...', logContext);

    const warnings: string[] = [];

    // Fake Follower Risk Score (0-100)
    let fakeFollowerRiskScore: number | null = 0;

    // Factor 1: Very low engagement rate (<0.5%)
    if (engagementMetrics.engagementRate !== null && engagementMetrics.engagementRate < 0.5) {
      fakeFollowerRiskScore += 40;
      warnings.push('Very low engagement rate (<0.5%)');
      logger.debug('Risk factor: Low engagement rate', {
        ...logContext,
        engagementRate: engagementMetrics.engagementRate,
        riskAdded: 40
      });
    }

    // Factor 2: High following-to-follower ratio (>0.8)
    const followRatio = profile.followersCount > 0
      ? profile.followsCount / profile.followersCount
      : 0;
    if (followRatio > 0.8) {
      fakeFollowerRiskScore += 30;
      warnings.push('High following-to-follower ratio (>0.8)');
      logger.debug('Risk factor: High follow ratio', {
        ...logContext,
        followRatio,
        riskAdded: 30
      });
    }

    // Factor 3: Low authority ratio (<1.0)
    const authorityRatio = profile.followsCount > 0
      ? profile.followersCount / profile.followsCount
      : null;
    if (authorityRatio !== null && authorityRatio < 1.0) {
      fakeFollowerRiskScore += 20;
      warnings.push('Low authority ratio (<1.0)');
      logger.debug('Risk factor: Low authority ratio', {
        ...logContext,
        authorityRatio,
        riskAdded: 20
      });
    }

    // Factor 4: High followers but low post count
    if (profile.followersCount > 10000 && profile.postsCount < 50) {
      fakeFollowerRiskScore += 10;
      warnings.push('High followers (>10k) with low post count (<50)');
      logger.debug('Risk factor: High followers/low posts', {
        ...logContext,
        followersCount: profile.followersCount,
        postsCount: profile.postsCount,
        riskAdded: 10
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
      warningsCount: warnings.length
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
    let viralPostCount = 0;
    let viralPostRate: number | null = null;

    if (flags.hasPosts && engagementMetrics.avgEngagementPerPost !== null) {
      const viralThreshold = engagementMetrics.avgEngagementPerPost * 2;
      const posts = profile.latestPosts;

      viralPostCount = posts.filter(p => {
        const engagement = (p.likesCount || 0) + (p.commentsCount || 0);
        return engagement >= viralThreshold;
      }).length;

      viralPostRate = this.round((viralPostCount / posts.length) * 100, 2);

      logger.debug('Viral post analysis', {
        ...logContext,
        viralThreshold,
        viralPostCount,
        viralPostRate
      });
    }

    this.metricsCalculated += 3;

    const metrics: DerivedMetrics = {
      contentDensity,
      viralPostCount,
      viralPostRate,
      _reason: null
    };

    logger.info('Derived metrics calculated', {
      ...logContext,
      contentDensity,
      viralPostCount,
      viralPostRate
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

    // All hashtags
    const allHashtags = posts.flatMap(p => p.hashtags || []);
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

    // All mentions
    const allMentions = posts.flatMap(p => p.mentions || []);
    const uniqueMentions = [...new Set(allMentions)];

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
      hashtagFrequency,
      allMentions,
      uniqueMentions,
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
    const processingTimeMs = Date.now() - this.startTime;
    const postCount = profile.latestPosts?.length || 0;

    // Calculate data completeness
    const totalPossibleMetrics = 74; // Total number of metrics defined
    const dataCompleteness = this.round((this.metricsCalculated / totalPossibleMetrics) * 100, 2);

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
      extractionVersion: ProfileExtractionService.VERSION,
      lowConfidenceWarning: postCount > 0 && postCount < ProfileExtractionService.MIN_POSTS_FOR_CONFIDENCE
    };

    return metadata;
  }

  private buildErrorResult(validation: ValidationResult, rawProfile: unknown): ExtractionOutput {
    const processingTimeMs = Date.now() - this.startTime;
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

    logger.info('='.repeat(80), logContext);
    logger.info('EXTRACTION COMPLETE - SUMMARY', logContext);
    logger.info('='.repeat(80), logContext);

    logger.info('METADATA', {
      ...logContext,
      username: result.metadata.username,
      processingTimeMs: result.metadata.processingTimeMs,
      samplePostCount: result.metadata.samplePostCount,
      totalPostCount: result.metadata.totalPostCount,
      dataCompleteness: `${result.metadata.dataCompleteness}%`,
      metricsCalculated: result.metadata.metricsCalculated,
      metricsSkipped: result.metadata.metricsSkipped,
      lowConfidenceWarning: result.metadata.lowConfidenceWarning,
      extractionVersion: result.metadata.extractionVersion
    });

    logger.info('VALIDATION FLAGS', {
      ...logContext,
      ...result.validation.flags
    });

    if (result.validation.warnings.length > 0) {
      logger.warn('VALIDATION WARNINGS', {
        ...logContext,
        warnings: result.validation.warnings
      });
    }

    logger.info('PROFILE METRICS (Group 1)', {
      ...logContext,
      followersCount: result.profileMetrics.followersCount,
      followsCount: result.profileMetrics.followsCount,
      postsCount: result.profileMetrics.postsCount,
      authorityRatio: result.profileMetrics.authorityRatio,
      verified: result.profileMetrics.verified,
      isBusinessAccount: result.profileMetrics.isBusinessAccount
    });

    logger.info('ENGAGEMENT METRICS (Group 2a)', {
      ...logContext,
      engagementRate: result.engagementMetrics.engagementRate,
      avgLikesPerPost: result.engagementMetrics.avgLikesPerPost,
      avgCommentsPerPost: result.engagementMetrics.avgCommentsPerPost,
      engagementConsistency: result.engagementMetrics.engagementConsistency,
      _reason: result.engagementMetrics._reason
    });

    logger.info('FREQUENCY METRICS (Group 2b)', {
      ...logContext,
      postingFrequency: result.frequencyMetrics.postingFrequency,
      daysSinceLastPost: result.frequencyMetrics.daysSinceLastPost,
      postingConsistency: result.frequencyMetrics.postingConsistency,
      _reason: result.frequencyMetrics._reason
    });

    logger.info('FORMAT METRICS (Group 2c)', {
      ...logContext,
      formatDiversity: result.formatMetrics.formatDiversity,
      dominantFormat: result.formatMetrics.dominantFormat,
      reelsRate: result.formatMetrics.reelsRate,
      imageRate: result.formatMetrics.imageRate,
      _reason: result.formatMetrics._reason
    });

    logger.info('CONTENT METRICS (Group 2d)', {
      ...logContext,
      avgHashtagsPerPost: result.contentMetrics.avgHashtagsPerPost,
      avgCaptionLength: result.contentMetrics.avgCaptionLength,
      locationTaggingRate: result.contentMetrics.locationTaggingRate,
      commentsEnabledRate: result.contentMetrics.commentsEnabledRate,
      _reason: result.contentMetrics._reason
    });

    logger.info('VIDEO METRICS (Group 3)', {
      ...logContext,
      videoPostCount: result.videoMetrics.videoPostCount,
      avgVideoViews: result.videoMetrics.avgVideoViews,
      videoViewRate: result.videoMetrics.videoViewRate,
      _reason: result.videoMetrics._reason
    });

    logger.info('RISK SCORES (Group 4)', {
      ...logContext,
      fakeFollowerRiskScore: result.riskScores.fakeFollowerRiskScore,
      warnings: result.riskScores.fakeFollowerWarnings
    });

    logger.info('DERIVED METRICS (Group 4)', {
      ...logContext,
      contentDensity: result.derivedMetrics.contentDensity,
      viralPostCount: result.derivedMetrics.viralPostCount,
      viralPostRate: result.derivedMetrics.viralPostRate
    });

    logger.info('TEXT DATA FOR AI (Group 5)', {
      ...logContext,
      bioLength: result.textDataForAI.biography.length,
      captionCount: result.textDataForAI.recentCaptions.length,
      uniqueHashtagCount: result.textDataForAI.uniqueHashtags.length,
      uniqueMentionCount: result.textDataForAI.uniqueMentions.length,
      topHashtags: result.textDataForAI.hashtagFrequency.slice(0, 5)
    });

    if (this.skippedReasons.length > 0) {
      logger.info('SKIPPED METRICS', {
        ...logContext,
        reasons: this.skippedReasons
      });
    }

    logger.info('='.repeat(80), logContext);
    logger.info(`EXTRACTION FINISHED: ${result.metadata.metricsCalculated} metrics calculated, ${result.metadata.metricsSkipped} skipped`, logContext);
    logger.info('='.repeat(80), logContext);
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
}

// Export singleton factory
export function createProfileExtractionService(): ProfileExtractionService {
  return new ProfileExtractionService();
}
