// infrastructure/extraction/output-transformer.service.ts

/**
 * OUTPUT TRANSFORMER SERVICE
 *
 * Transforms ExtractionResult into the flat CalculatedMetrics format
 * for database storage in the calculated_metrics JSONB column.
 *
 * This service:
 * 1. Flattens nested metric groups into a single RawMetricsFlat object
 * 2. Integrates composite scores from ScoreCalculatorService
 * 3. Integrates gap detection flags
 * 4. Adds metadata (version, timestamp, sample size)
 */

import { logger } from '@/shared/utils/logger.util';
import type {
  ExtractionResult,
  CalculatedMetrics,
  RawMetricsFlat,
  CompositeScores,
  GapDetection
} from './extraction.types';
import { calculateScores } from './score-calculator.service';

// ============================================================================
// TRANSFORMER SERVICE
// ============================================================================

/**
 * Transform ExtractionResult into CalculatedMetrics for database storage
 */
export function transformToCalculatedMetrics(extraction: ExtractionResult): CalculatedMetrics {
  const startTime = Date.now();

  logger.debug('[OutputTransformer] Starting transformation', {
    username: extraction.profileMetrics.username
  });

  // Flatten all raw metrics
  const raw = flattenRawMetrics(extraction);

  // Calculate scores and gaps
  const { scores, gaps } = calculateScores(extraction);

  const calculatedMetrics: CalculatedMetrics = {
    version: '1.0',
    calculatedAt: new Date().toISOString(),
    sampleSize: extraction.metadata.samplePostCount,
    raw,
    scores,
    gaps
  };

  const processingTime = Date.now() - startTime;

  logger.info('[OutputTransformer] Transformation complete', {
    username: extraction.profileMetrics.username,
    sampleSize: calculatedMetrics.sampleSize,
    scores: calculatedMetrics.scores,
    gaps: calculatedMetrics.gaps,
    processingTimeMs: processingTime
  });

  return calculatedMetrics;
}

// ============================================================================
// METRIC FLATTENING
// ============================================================================

/**
 * Flatten nested extraction result metrics into a single flat object
 */
function flattenRawMetrics(extraction: ExtractionResult): RawMetricsFlat {
  const {
    profileMetrics,
    engagementMetrics,
    frequencyMetrics,
    formatMetrics,
    contentMetrics,
    videoMetrics,
    riskScores,
    derivedMetrics
  } = extraction;

  return {
    // Profile metrics (16)
    followersCount: profileMetrics.followersCount,
    followsCount: profileMetrics.followsCount,
    postsCount: profileMetrics.postsCount,
    authorityRatio: profileMetrics.authorityRatio,
    isBusinessAccount: profileMetrics.isBusinessAccount,
    verified: profileMetrics.verified,
    hasChannel: profileMetrics.hasChannel,
    businessCategoryName: profileMetrics.businessCategoryName,
    hasExternalLink: profileMetrics.hasExternalLink,
    externalUrl: profileMetrics.externalUrl,
    externalLinksCount: profileMetrics.externalLinksCount,
    highlightReelCount: profileMetrics.highlightReelCount,
    igtvVideoCount: profileMetrics.igtvVideoCount,
    hasBio: profileMetrics.hasBio,
    bioLength: profileMetrics.bioLength,
    username: profileMetrics.username,

    // Engagement metrics (11)
    totalLikes: engagementMetrics.totalLikes,
    totalComments: engagementMetrics.totalComments,
    totalEngagement: engagementMetrics.totalEngagement,
    avgLikesPerPost: engagementMetrics.avgLikesPerPost,
    avgCommentsPerPost: engagementMetrics.avgCommentsPerPost,
    avgEngagementPerPost: engagementMetrics.avgEngagementPerPost,
    engagementRate: engagementMetrics.engagementRate,
    commentToLikeRatio: engagementMetrics.commentToLikeRatio,
    engagementStdDev: engagementMetrics.engagementStdDev,
    engagementConsistency: engagementMetrics.engagementConsistency,
    engagementRatePerPost: engagementMetrics.engagementRatePerPost,

    // Frequency metrics (8)
    oldestPostTimestamp: frequencyMetrics.oldestPostTimestamp,
    newestPostTimestamp: frequencyMetrics.newestPostTimestamp,
    postingPeriodDays: frequencyMetrics.postingPeriodDays,
    postingFrequency: frequencyMetrics.postingFrequency,
    daysSinceLastPost: frequencyMetrics.daysSinceLastPost,
    avgDaysBetweenPosts: frequencyMetrics.avgDaysBetweenPosts,
    timeBetweenPostsDays: frequencyMetrics.timeBetweenPostsDays,
    postingConsistency: frequencyMetrics.postingConsistency,

    // Format metrics (10)
    reelsCount: formatMetrics.reelsCount,
    videoCount: formatMetrics.videoCount,
    imageCount: formatMetrics.imageCount,
    carouselCount: formatMetrics.carouselCount,
    reelsRate: formatMetrics.reelsRate,
    videoRate: formatMetrics.videoRate,
    imageRate: formatMetrics.imageRate,
    carouselRate: formatMetrics.carouselRate,
    formatDiversity: formatMetrics.formatDiversity,
    dominantFormat: formatMetrics.dominantFormat,

    // Content metrics (17)
    totalHashtags: contentMetrics.totalHashtags,
    avgHashtagsPerPost: contentMetrics.avgHashtagsPerPost,
    uniqueHashtagCount: contentMetrics.uniqueHashtagCount,
    hashtagDiversity: contentMetrics.hashtagDiversity,
    totalMentions: contentMetrics.totalMentions,
    avgMentionsPerPost: contentMetrics.avgMentionsPerPost,
    uniqueMentionCount: contentMetrics.uniqueMentionCount,
    totalCaptionLength: contentMetrics.totalCaptionLength,
    avgCaptionLength: contentMetrics.avgCaptionLength,
    maxCaptionLength: contentMetrics.maxCaptionLength,
    postsWithLocation: contentMetrics.postsWithLocation,
    locationTaggingRate: contentMetrics.locationTaggingRate,
    postsWithAltText: contentMetrics.postsWithAltText,
    altTextRate: contentMetrics.altTextRate,
    postsWithCommentsDisabled: contentMetrics.postsWithCommentsDisabled,
    commentsDisabledRate: contentMetrics.commentsDisabledRate,
    commentsEnabledRate: contentMetrics.commentsEnabledRate,

    // Video metrics (5)
    videoPostCount: videoMetrics.videoPostCount,
    totalVideoViews: videoMetrics.totalVideoViews,
    avgVideoViews: videoMetrics.avgVideoViews,
    videoViewsPerFollower: videoMetrics.videoViewsPerFollower,
    videoViewToLikeRatio: videoMetrics.videoViewToLikeRatio,

    // Risk scores (2)
    fakeFollowerRiskScore: riskScores.fakeFollowerRiskScore,
    fakeFollowerWarnings: riskScores.fakeFollowerWarnings,

    // Derived metrics (3)
    contentDensity: derivedMetrics.contentDensity,
    viralPostCount: derivedMetrics.viralPostCount,
    viralPostRate: derivedMetrics.viralPostRate
  };
}

// Export is already done via the function declaration above
