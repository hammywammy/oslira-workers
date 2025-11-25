// infrastructure/analysis-checks/checks/icp-follower-limit.check.ts

/**
 * ICP FOLLOWER LIMIT CHECK
 *
 * Validates that the Instagram profile's follower count is within
 * the user's configured ICP (Ideal Customer Profile) bounds.
 *
 * When triggered:
 * - Skips AI analysis
 * - Sets result type to 'icp_violation'
 * - Refunds the user's balance
 * - Stores descriptive summary about the mismatch
 */

import type {
  IPreAnalysisCheck,
  PreAnalysisCheckContext,
  PreAnalysisCheckResult
} from '../types';

export class ICPFollowerLimitCheck implements IPreAnalysisCheck {
  readonly name = 'icp_follower_limit';
  readonly priority = 15; // Run after profile checks, before AI analysis
  readonly description = 'Checks if the profile follower count is within ICP bounds';

  async run(context: PreAnalysisCheckContext): Promise<PreAnalysisCheckResult> {
    const { profile, username, icpSettings } = context;

    // If no profile data, let other checks handle it
    if (!profile) {
      return {
        passed: true,
        checkName: this.name,
        shouldRefund: false
      };
    }

    // If no ICP settings provided, skip this check
    if (!icpSettings) {
      return {
        passed: true,
        checkName: this.name,
        shouldRefund: false
      };
    }

    const followerCount = profile.followersCount;
    const maxFollowers = icpSettings.icp_max_followers;
    const minFollowers = icpSettings.icp_min_followers;

    // Check max follower limit
    if (maxFollowers != null && maxFollowers > 0 && followerCount > maxFollowers) {
      console.log(`[PreAnalysisCheck][${this.name}] Profile @${username} exceeds max followers: ${followerCount} > ${maxFollowers}`);

      return {
        passed: false,
        checkName: this.name,
        reason: `Follower count (${this.formatNumber(followerCount)}) exceeds ICP maximum (${this.formatNumber(maxFollowers)})`,
        resultType: 'icp_violation',
        summary: `This account (@${username}) has ${this.formatNumber(followerCount)} followers, which exceeds your ICP maximum of ${this.formatNumber(maxFollowers)} followers. This profile is outside your target audience range and was skipped. Your balance has been refunded.`,
        score: 0,
        shouldRefund: true
      };
    }

    // Check min follower limit
    if (minFollowers != null && minFollowers > 0 && followerCount < minFollowers) {
      console.log(`[PreAnalysisCheck][${this.name}] Profile @${username} below min followers: ${followerCount} < ${minFollowers}`);

      return {
        passed: false,
        checkName: this.name,
        reason: `Follower count (${this.formatNumber(followerCount)}) below ICP minimum (${this.formatNumber(minFollowers)})`,
        resultType: 'icp_violation',
        summary: `This account (@${username}) has ${this.formatNumber(followerCount)} followers, which is below your ICP minimum of ${this.formatNumber(minFollowers)} followers. This profile is outside your target audience range and was skipped. Your balance has been refunded.`,
        score: 0,
        shouldRefund: true
      };
    }

    return {
      passed: true,
      checkName: this.name,
      shouldRefund: false
    };
  }

  /**
   * Format large numbers for readability (e.g., 697477832 -> "697.5M")
   */
  private formatNumber(num: number): string {
    if (num >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(1)}B`;
    }
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
  }
}
