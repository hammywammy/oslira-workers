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
import { clamp, round, safeNumber } from '@/shared/utils/number-format.util';
import type {
  ExtractionResult,
  CompositeScores,
  GapDetection
} from './extraction.types';

// Note: clamp, round, safeNumber are imported from centralized utility

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

  // Calculate profile health score from other quality scores
  // NOTE: This measures ACCOUNT QUALITY, not business fit!
  const profileHealthScore = calculateProfileHealthScore({
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
    profileHealthScore
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
 * Calculate Profile Health Score (0-100)
 *
 * Weighted combination of QUALITY scores to assess account health.
 *
 * IMPORTANT: This measures ACCOUNT QUALITY only - NOT business fit!
 * A high profile health score means the account is well-maintained,
 * but does NOT mean it's a good lead for the business.
 *
 * Formula: (engagementHealth * 0.3) + (contentSophistication * 0.25) + (accountMaturity * 0.25) + ((100 - fakeFollowerRisk) * 0.2)
 *
 * Weights:
 * - Engagement Health: 30% (shows active, real audience)
 * - Content Sophistication: 25% (shows effort and strategy)
 * - Account Maturity: 25% (shows commitment and professionalism)
 * - Trust Factor (inverse of risk): 20% (authenticity check)
 *
 * @renamed from calculateOpportunityScore to clarify what it measures
 */
function calculateProfileHealthScore(scores: Omit<CompositeScores, 'profileHealthScore'>): number {
  const trustFactor = 100 - scores.fakeFollowerRisk;

  const score = (scores.engagementHealth * 0.3) +
    (scores.contentSophistication * 0.25) +
    (scores.accountMaturity * 0.25) +
    (trustFactor * 0.2);

  const clamped = clamp(0, 100, score);

  logger.debug('[ScoreCalculator] Profile health score calculated', {
    engagementHealth: scores.engagementHealth,
    contentSophistication: scores.contentSophistication,
    accountMaturity: scores.accountMaturity,
    trustFactor,
    rawScore: score,
    finalScore: clamped,
    note: 'Measures account quality, NOT business fit'
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

// ============================================================================
// NEW SCORING SYSTEM (0-100 TOTAL)
// ============================================================================

/**
 * Calculate Readiness Score (0-25 points, 25% of total)
 *
 * Measures content quality, professionalism, and sophistication.
 * Based on contentSophistication score (0-100) scaled to 0-25.
 *
 * Components from contentSophistication:
 * - Hashtag usage and strategy
 * - Caption quality and length
 * - Location tagging
 * - Format diversity
 */
export function calculateReadinessScore(extraction: ExtractionResult): number {
  const contentSophistication = calculateContentSophistication(extraction);

  // Scale 0-100 score to 0-25
  const readinessScore = (contentSophistication / 100) * 25;

  logger.debug('[ScoreCalculator] Readiness score calculated', {
    contentSophistication,
    readinessScore: round(readinessScore)
  });

  return round(readinessScore);
}

/**
 * Calculate Partner Engagement Score (0-15 points, 15% of total)
 *
 * Measures active engaged audience quality.
 * Based on engagementHealth score (0-100) scaled to 0-15.
 *
 * Components from engagementHealth:
 * - Engagement rate
 * - Engagement consistency
 * - Comment to like ratio
 */
export function calculatePartnerEngagementScore(extraction: ExtractionResult): number {
  const engagementHealth = calculateEngagementHealth(extraction);

  // Scale 0-100 score to 0-15
  const partnerEngagementScore = (engagementHealth / 100) * 15;

  logger.debug('[ScoreCalculator] Partner engagement score calculated', {
    engagementHealth,
    partnerEngagementScore: round(partnerEngagementScore)
  });

  return round(partnerEngagementScore);
}

/**
 * Calculate Authority Score (0-10 points, 10% of total)
 *
 * Measures account maturity and credibility.
 * Combines accountMaturity (70%) and authorityRatio (30%) scaled to 0-10.
 *
 * Components:
 * - Account maturity: posting consistency, profile completeness
 * - Authority ratio: followers vs following ratio
 */
export function calculateAuthorityScore(extraction: ExtractionResult): number {
  const accountMaturity = calculateAccountMaturity(extraction);
  const { profileMetrics } = extraction;

  // Get authority ratio (0-100 scale) or 0 if null
  const authorityRatio = profileMetrics.authorityRatio ?? 0;

  // Weighted combination: 70% maturity, 30% authority ratio
  const combinedScore = (accountMaturity * 0.7) + (authorityRatio * 0.3);

  // Scale to 0-10
  const authorityScore = (combinedScore / 100) * 10;

  logger.debug('[ScoreCalculator] Authority score calculated', {
    accountMaturity,
    authorityRatio,
    combinedScore,
    authorityScore: round(authorityScore)
  });

  return round(authorityScore);
}

// Export is already done via the function declaration above
