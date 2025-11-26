// infrastructure/extraction/score-calculator.service.ts

/**
 * SCORE CALCULATOR SERVICE
 *
 * Calculates composite scores and gap detection from raw extraction metrics.
 * All scores are on a 0-100 scale with research-backed formulas.
 *
 * Score Formulas:
 * 1. engagementHealth: Combines engagement rate, consistency, and comment ratio
 * 2. contentSophistication: Evaluates hashtag usage, caption quality, locations, format diversity
 * 3. accountMaturity: Measures posting consistency, profile completeness, business features
 * 4. fakeFollowerRisk: Detects suspicious patterns (higher = more risky)
 * 5. opportunityScore: Weighted combination for lead qualification
 *
 * Gap Detection:
 * - engagementGap: Low engagement despite audience size
 * - contentGap: Basic content strategy indicators
 * - conversionGap: Missing conversion pathways
 * - platformGap: Not leveraging Reels algorithm
 */

import { logger } from '@/shared/utils/logger.util';
import type {
  ExtractionResult,
  CompositeScores,
  GapDetection
} from './extraction.types';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Clamp a value between min and max
 */
function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to specified decimal places
 */
function round(value: number, decimals: number = 2): number {
  return Number(value.toFixed(decimals));
}

/**
 * Safe number getter - returns default if null/undefined/NaN
 */
function safeNumber(value: number | null | undefined, defaultValue: number = 0): number {
  if (value === null || value === undefined || isNaN(value)) {
    return defaultValue;
  }
  return value;
}

// ============================================================================
// SCORE CALCULATION SERVICE
// ============================================================================

export interface ScoreCalculationResult {
  scores: CompositeScores;
  gaps: GapDetection;
}

/**
 * Calculate all composite scores from extraction result
 */
export function calculateScores(extraction: ExtractionResult): ScoreCalculationResult {
  const startTime = Date.now();

  logger.debug('[ScoreCalculator] Starting score calculation', {
    username: extraction.profileMetrics.username
  });

  // Calculate individual scores
  const engagementHealth = calculateEngagementHealth(extraction);
  const contentSophistication = calculateContentSophistication(extraction);
  const accountMaturity = calculateAccountMaturity(extraction);
  const fakeFollowerRisk = calculateFakeFollowerRisk(extraction);

  // Calculate opportunity score from other scores
  const opportunityScore = calculateOpportunityScore({
    engagementHealth,
    contentSophistication,
    accountMaturity,
    fakeFollowerRisk
  });

  const scores: CompositeScores = {
    engagementHealth,
    contentSophistication,
    accountMaturity,
    fakeFollowerRisk,
    opportunityScore
  };

  // Calculate gap detection
  const gaps = detectGaps(extraction);

  const processingTime = Date.now() - startTime;

  logger.info('[ScoreCalculator] Score calculation complete', {
    username: extraction.profileMetrics.username,
    scores,
    gaps,
    processingTimeMs: processingTime
  });

  return { scores, gaps };
}

// ============================================================================
// INDIVIDUAL SCORE CALCULATORS
// ============================================================================

/**
 * Calculate Engagement Health Score (0-100)
 *
 * Formula: clamp(0, 100, (engagementRate * 15) + (engagementConsistency * 0.3) + (commentToLikeRatio * 200))
 *
 * Components:
 * - engagementRate * 15: Good ER (3-5%) contributes 45-75 points
 * - engagementConsistency * 0.3: Consistent posting adds up to 30 points
 * - commentToLikeRatio * 200: Higher comments vs likes indicates real engagement (up to ~20 points)
 */
function calculateEngagementHealth(extraction: ExtractionResult): number {
  const { engagementMetrics } = extraction;

  const engagementRate = safeNumber(engagementMetrics.engagementRate);
  const engagementConsistency = safeNumber(engagementMetrics.engagementConsistency);
  const commentToLikeRatio = safeNumber(engagementMetrics.commentToLikeRatio);

  const score = (engagementRate * 15) +
    (engagementConsistency * 0.3) +
    (commentToLikeRatio * 200);

  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Engagement health calculated', {
    engagementRate,
    engagementConsistency,
    commentToLikeRatio,
    rawScore: score,
    finalScore: clamped
  });

  return round(clamped);
}

/**
 * Calculate Content Sophistication Score (0-100)
 *
 * Formula: clamp(0, 100, (avgHashtagsPerPost * 3) + (avgCaptionLength / 10) + (locationTaggingRate * 0.3) + (formatDiversity * 10))
 *
 * Components:
 * - avgHashtagsPerPost * 3: 10 hashtags = 30 points (optimal range)
 * - avgCaptionLength / 10: 300 char avg = 30 points
 * - locationTaggingRate * 0.3: Full location usage (100%) = 30 points
 *   Note: locationTaggingRate is 0-100%, so multiply by 0.3 not 30
 * - formatDiversity * 10: Using all 4 formats = 40 points (bonus for variety)
 */
function calculateContentSophistication(extraction: ExtractionResult): number {
  const { contentMetrics, formatMetrics } = extraction;

  const avgHashtagsPerPost = safeNumber(contentMetrics.avgHashtagsPerPost);
  const avgCaptionLength = safeNumber(contentMetrics.avgCaptionLength);
  const locationTaggingRate = safeNumber(contentMetrics.locationTaggingRate);
  const formatDiversity = safeNumber(formatMetrics.formatDiversity);

  // Note: locationTaggingRate is already 0-100, so multiply by 0.3 to get max 30 points
  const score = (avgHashtagsPerPost * 3) +
    (avgCaptionLength / 10) +
    (locationTaggingRate * 0.3) +
    (formatDiversity * 10);

  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Content sophistication calculated', {
    avgHashtagsPerPost,
    avgCaptionLength,
    locationTaggingRate,
    formatDiversity,
    rawScore: score,
    finalScore: clamped
  });

  return round(clamped);
}

/**
 * Calculate Account Maturity Score (0-100)
 *
 * Formula: clamp(0, 100, (postingConsistency * 0.4) + (highlightReelCount * 5) + (hasBio ? 10 : 0) + (hasExternalLink ? 15 : 0) + (isBusinessAccount ? 10 : 0))
 *
 * Components:
 * - postingConsistency * 0.4: Consistent posting = up to 40 points
 * - highlightReelCount * 5: Curated highlights = up to 25 points (5 highlights)
 * - hasBio: Profile completeness = 10 points
 * - hasExternalLink: Business intent = 15 points
 * - isBusinessAccount: Professional setup = 10 points
 */
function calculateAccountMaturity(extraction: ExtractionResult): number {
  const { profileMetrics, frequencyMetrics } = extraction;

  const postingConsistency = safeNumber(frequencyMetrics.postingConsistency);
  const highlightReelCount = safeNumber(profileMetrics.highlightReelCount);
  const hasBio = profileMetrics.hasBio ? 10 : 0;
  const hasExternalLink = profileMetrics.hasExternalLink ? 15 : 0;
  const isBusinessAccount = profileMetrics.isBusinessAccount ? 10 : 0;

  // Cap highlight contribution at 25 points (5 highlights)
  const highlightContribution = Math.min(highlightReelCount * 5, 25);

  const score = (postingConsistency * 0.4) +
    highlightContribution +
    hasBio +
    hasExternalLink +
    isBusinessAccount;

  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Account maturity calculated', {
    postingConsistency,
    highlightReelCount,
    hasBio: profileMetrics.hasBio,
    hasExternalLink: profileMetrics.hasExternalLink,
    isBusinessAccount: profileMetrics.isBusinessAccount,
    rawScore: score,
    finalScore: clamped
  });

  return round(clamped);
}

/**
 * Calculate Fake Follower Risk Score (0-100)
 *
 * Higher score = MORE suspicious/risky
 *
 * IMPORTANT: The comprehensive fake follower risk calculation is now performed
 * in ProfileExtractionService.calculateRiskScores() with:
 * - Tiered engagement rate thresholds based on account size
 * - Authority ratio analysis with multiple tiers
 * - Content-to-follower ratio analysis
 * - Engagement consistency anomaly detection
 *
 * This function now passes through the extraction service's score directly.
 * The extraction service's calculation is more nuanced and avoids
 * double-counting the same risk factors.
 *
 * See ProfileExtractionService for detailed factor documentation.
 */
function calculateFakeFollowerRisk(extraction: ExtractionResult): number {
  const { riskScores } = extraction;

  // Use the comprehensive score from extraction service directly
  // No additional adjustments needed - extraction service now handles all factors
  const score = safeNumber(riskScores.fakeFollowerRiskScore);
  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Fake follower risk (from extraction)', {
    score: clamped,
    warnings: riskScores.fakeFollowerWarnings?.length || 0
  });

  return round(clamped);
}

/**
 * Calculate Opportunity Score (0-100)
 *
 * Weighted combination of other scores for lead qualification.
 *
 * Formula: (engagementHealth * 0.3) + (contentSophistication * 0.25) + (accountMaturity * 0.25) + ((100 - fakeFollowerRisk) * 0.2)
 *
 * Weights:
 * - Engagement Health: 30% (most important - shows active audience)
 * - Content Sophistication: 25% (shows effort and strategy)
 * - Account Maturity: 25% (shows commitment)
 * - Trust Factor (inverse of risk): 20% (authenticity check)
 */
function calculateOpportunityScore(scores: Omit<CompositeScores, 'opportunityScore'>): number {
  const trustFactor = 100 - scores.fakeFollowerRisk;

  const score = (scores.engagementHealth * 0.3) +
    (scores.contentSophistication * 0.25) +
    (scores.accountMaturity * 0.25) +
    (trustFactor * 0.2);

  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Opportunity score calculated', {
    engagementHealth: scores.engagementHealth,
    contentSophistication: scores.contentSophistication,
    accountMaturity: scores.accountMaturity,
    trustFactor,
    rawScore: score,
    finalScore: clamped
  });

  return round(clamped);
}

// ============================================================================
// GAP DETECTION
// ============================================================================

/**
 * Detect gaps in the ICP's Instagram strategy
 *
 * Gaps represent opportunities where the business can offer value.
 * Each gap has a specific threshold based on industry benchmarks.
 */
function detectGaps(extraction: ExtractionResult): GapDetection {
  const { profileMetrics, engagementMetrics, contentMetrics, formatMetrics } = extraction;

  // Engagement Gap: Low engagement rate despite decent audience
  // Threshold: ER < 1% AND followers > 1000
  const engagementGap = (safeNumber(engagementMetrics.engagementRate) < 1) &&
    (profileMetrics.followersCount > 1000);

  // Content Gap: Basic content strategy indicators
  // Any of: avg hashtags < 3, avg caption < 100 chars, location rate < 10%
  // Note: locationTaggingRate is already a percentage (0-100), so compare to 10 not 0.1
  const avgHashtags = safeNumber(contentMetrics.avgHashtagsPerPost);
  const avgCaption = safeNumber(contentMetrics.avgCaptionLength);
  const locationRate = safeNumber(contentMetrics.locationTaggingRate);
  const contentGap = (avgHashtags < 3) || (avgCaption < 100) || (locationRate < 10);

  // Conversion Gap: Missing funnel despite business potential
  // No external link AND (is business account OR has 5000+ followers)
  const conversionGap = !profileMetrics.hasExternalLink &&
    (profileMetrics.isBusinessAccount || profileMetrics.followersCount > 5000);

  // Platform Gap: Not leveraging Reels algorithm
  // Reels rate < 20% of content
  // Note: reelsRate is already a percentage (0-100), so compare to 20 not 0.2
  const platformGap = safeNumber(formatMetrics.reelsRate) < 20;

  const gaps: GapDetection = {
    engagementGap,
    contentGap,
    conversionGap,
    platformGap
  };

  logger.debug('[ScoreCalculator] Gap detection complete', {
    gaps,
    details: {
      engagementRate: engagementMetrics.engagementRate,
      followersCount: profileMetrics.followersCount,
      avgHashtags,
      avgCaption,
      locationRate,
      hasExternalLink: profileMetrics.hasExternalLink,
      isBusinessAccount: profileMetrics.isBusinessAccount,
      reelsRate: formatMetrics.reelsRate
    }
  });

  return gaps;
}

// Export is already done via the function declaration above
