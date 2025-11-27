// infrastructure/extraction/tier-classification.util.ts

/**
 * TIER CLASSIFICATION UTILITIES
 *
 * Helper functions to calculate tier classifications for leads:
 * - Lead Tier: Based on overall_score (hot/warm/cool/cold)
 * - Audience Scale: Based on follower count (nano/micro/mid/macro/mega/enterprise)
 */

// ============================================================================
// LEAD TIER CALCULATION
// ============================================================================

/**
 * Calculate lead tier based on overall score
 *
 * Tiers:
 * 🔥 Hot: 80-100%
 * 🟡 Warm: 60-79%
 * 🔵 Cool: 40-59%
 * ⚫ Cold: <40%
 */
export function calculateLeadTier(overallScore: number): 'hot' | 'warm' | 'cool' | 'cold' {
  if (overallScore >= 80) {
    return 'hot';
  } else if (overallScore >= 60) {
    return 'warm';
  } else if (overallScore >= 40) {
    return 'cool';
  } else {
    return 'cold';
  }
}

// ============================================================================
// AUDIENCE SCALE CALCULATION
// ============================================================================

/**
 * Calculate audience scale based on follower count
 *
 * Scales:
 * - Nano: <10K
 * - Micro: 10K-50K
 * - Mid: 50K-250K
 * - Macro: 250K-1M
 * - Mega: 1M-3M
 * - Enterprise: 3M+
 */
export function calculateAudienceScale(followersCount: number): 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'enterprise' {
  if (followersCount >= 3_000_000) {
    return 'enterprise';
  } else if (followersCount >= 1_000_000) {
    return 'mega';
  } else if (followersCount >= 250_000) {
    return 'macro';
  } else if (followersCount >= 50_000) {
    return 'mid';
  } else if (followersCount >= 10_000) {
    return 'micro';
  } else {
    return 'nano';
  }
}
