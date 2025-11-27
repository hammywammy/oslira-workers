// infrastructure/extraction/output-transformer.service.ts

/**
 * OUTPUT TRANSFORMER SERVICE
 *
 * Transforms ExtractionResult into the structured ExtractedData format
 * for database storage in the extracted_data JSONB column.
 *
 * Organizes data into:
 * - static: Raw profile data
 * - calculated: Computed scores
 * - metadata: Extraction metadata
 */

import { logger } from '@/shared/utils/logger.util';
import type {
  ExtractionResult,
  ExtractedData
} from './extraction.types';
import {
  calculateScores,
  calculateReadinessScore,
  calculatePartnerEngagementScore,
  calculateAuthorityScore
} from './score-calculator.service';

// ============================================================================
// TRANSFORMER SERVICE
// ============================================================================

/**
 * Transform ExtractionResult into ExtractedData for database storage
 */
export function transformToExtractedData(extraction: ExtractionResult): ExtractedData {
  const startTime = Date.now();

  logger.debug('[OutputTransformer] Starting transformation', {
    username: extraction.profileMetrics.username
  });

  const {
    engagementMetrics,
    frequencyMetrics,
    profileMetrics,
    formatMetrics,
    riskScores,
    textDataForAI,
    metadata
  } = extraction;

  // Calculate composite scores
  const { scores } = calculateScores(extraction);

  // Calculate new scoring system components
  const readinessScore = calculateReadinessScore(extraction);
  const partnerEngagementScore = calculatePartnerEngagementScore(extraction);
  const authorityScore = calculateAuthorityScore(extraction);

  // Generate soft warning from fake follower risk
  const fakeFollowerWarning = generateFakeFollowerWarning(
    riskScores.fakeFollowerRiskScore,
    riskScores.fakeFollowerWarnings
  );

  const extractedData: ExtractedData = {
    metadata: {
      version: '1.0',
      sampleSize: metadata.samplePostCount,
      extractedAt: new Date().toISOString()
    },

    static: {
      // Content signals
      topHashtags: textDataForAI.hashtagFrequency.slice(0, 10),
      topMentions: textDataForAI.topMentions.slice(0, 5),

      // Activity signals
      daysSinceLastPost: frequencyMetrics.daysSinceLastPost,

      // Profile attributes
      businessCategoryName: profileMetrics.businessCategoryName,
      externalUrl: profileMetrics.externalUrl,
      followersCount: profileMetrics.followersCount,
      postsCount: profileMetrics.postsCount,
      isBusinessAccount: profileMetrics.isBusinessAccount,
      verified: profileMetrics.verified,

      // Content patterns
      dominantFormat: formatMetrics.dominantFormat,
      formatDiversity: formatMetrics.formatDiversity,
      postingConsistency: frequencyMetrics.postingConsistency,

      // Engagement averages
      avgLikesPerPost: engagementMetrics.avgLikesPerPost,
      avgCommentsPerPost: engagementMetrics.avgCommentsPerPost,
      avgVideoViews: extraction.videoMetrics.avgVideoViews
    },

    calculated: {
      // Core engagement metrics
      engagementScore: engagementMetrics.engagementRate,
      engagementRate: engagementMetrics.engagementRate,
      engagementConsistency: engagementMetrics.engagementConsistency,
      postingFrequency: frequencyMetrics.postingFrequency,

      // Risk assessment
      fakeFollowerWarning,

      // Profile quality scores
      authorityRatio: profileMetrics.authorityRatio,
      accountMaturity: scores.accountMaturity,
      engagementHealth: scores.engagementHealth,
      profileHealthScore: scores.profileHealthScore,
      contentSophistication: scores.contentSophistication,

      // New scoring system (0-100 total)
      readinessScore,             // 0-25 points: Content quality, professionalism, sophistication
      partnerEngagementScore,     // 0-15 points: Active engaged audience
      authorityScore              // 0-10 points: Account maturity and credibility
    }
  };

  const processingTime = Date.now() - startTime;

  logger.info('[OutputTransformer] Transformation complete', {
    username: profileMetrics.username,
    sampleSize: extractedData.metadata.sampleSize,
    hasHashtags: extractedData.static.topHashtags.length > 0,
    hasMentions: extractedData.static.topMentions.length > 0,
    newScores: {
      readinessScore: extractedData.calculated.readinessScore,
      partnerEngagementScore: extractedData.calculated.partnerEngagementScore,
      authorityScore: extractedData.calculated.authorityScore,
      subtotal: extractedData.calculated.readinessScore + extractedData.calculated.partnerEngagementScore + extractedData.calculated.authorityScore
    },
    processingTimeMs: processingTime
  });

  return extractedData;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a soft, human-readable warning about fake followers
 * Never gives a definitive "this account has fake followers" statement
 */
function generateFakeFollowerWarning(
  riskScore: number | null,
  warnings: string[]
): string | null {
  if (riskScore === null || riskScore === undefined) {
    return null;
  }

  // Low risk (0-20): Account appears authentic
  if (riskScore <= 20) {
    return 'Engagement patterns look healthy and authentic';
  }

  // Medium risk (21-50): Some patterns look inconsistent
  if (riskScore <= 50) {
    if (warnings.length > 0) {
      return `Some engagement patterns to note: ${warnings[0].toLowerCase()}`;
    }
    return 'Some engagement patterns could be stronger';
  }

  // High risk (51+): Multiple concerning patterns
  if (warnings.length > 0) {
    const primaryWarning = warnings[0].toLowerCase();
    return `Worth reviewing: ${primaryWarning}`;
  }
  return 'Several engagement patterns worth reviewing before outreach';
}

// Export is already done via the function declaration above
