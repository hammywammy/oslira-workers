// infrastructure/extraction/output-transformer.service.ts

/**
 * OUTPUT TRANSFORMER SERVICE
 *
 * Transforms ExtractionResult into the lean ExtractedData format
 * for database storage in the extracted_data JSONB column.
 *
 * This service extracts ONLY actionable signals for lead qualification:
 * - Is this lead warm?
 * - Is this account real?
 * - Is this worth contacting?
 */

import { logger } from '@/shared/utils/logger.util';
import type {
  ExtractionResult,
  ExtractedData
} from './extraction.types';

// ============================================================================
// TRANSFORMER SERVICE
// ============================================================================

/**
 * Transform ExtractionResult into ExtractedData for database storage
 * Only extracts essential, actionable signals - no vanity metrics
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
    riskScores,
    textDataForAI
  } = extraction;

  // Generate soft warning from fake follower risk
  const fakeFollowerWarning = generateFakeFollowerWarning(
    riskScores.fakeFollowerRiskScore,
    riskScores.fakeFollowerWarnings
  );

  const extractedData: ExtractedData = {
    version: '1.0',
    extractedAt: new Date().toISOString(),
    sampleSize: extraction.metadata.samplePostCount,

    // Engagement signals
    engagementScore: engagementMetrics.engagementRate,
    engagementConsistency: engagementMetrics.engagementConsistency,

    // Recency signals
    daysSinceLastPost: frequencyMetrics.daysSinceLastPost,

    // Content signals
    topHashtags: textDataForAI.hashtagFrequency.slice(0, 10),
    topMentions: textDataForAI.topMentions.slice(0, 5),

    // Business signals
    businessCategoryName: profileMetrics.businessCategoryName,

    // Risk signals
    fakeFollowerWarning
  };

  const processingTime = Date.now() - startTime;

  logger.info('[OutputTransformer] Transformation complete', {
    username: profileMetrics.username,
    sampleSize: extractedData.sampleSize,
    hasHashtags: extractedData.topHashtags.length > 0,
    hasMentions: extractedData.topMentions.length > 0,
    fakeFollowerWarning: extractedData.fakeFollowerWarning,
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
