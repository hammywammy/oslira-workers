// infrastructure/analysis-checks/checks/private-profile.check.ts

/**
 * PRIVATE PROFILE CHECK
 *
 * Detects Instagram profiles set to private.
 * Private profiles cannot be meaningfully analyzed as their
 * content is not accessible to non-followers.
 *
 * When triggered:
 * - Skips AI analysis
 * - Sets result type to 'private'
 * - Refunds the user's balance
 * - Stores descriptive summary
 */

import type {
  IPreAnalysisCheck,
  PreAnalysisCheckContext,
  PreAnalysisCheckResult
} from '../types';

export class PrivateProfileCheck implements IPreAnalysisCheck {
  readonly name = 'private_profile';
  readonly priority = 10; // Run early - private profiles are common
  readonly description = 'Checks if the Instagram profile is set to private';

  async run(context: PreAnalysisCheckContext): Promise<PreAnalysisCheckResult> {
    const { profile, username } = context;

    // If no profile data, let other checks handle it
    if (!profile) {
      return {
        passed: true,
        checkName: this.name,
        shouldRefund: false
      };
    }

    // Check the isPrivate flag from the scraped profile
    if (profile.isPrivate === true) {
      console.log(`[PreAnalysisCheck][${this.name}] Profile @${username} is private`);

      return {
        passed: false,
        checkName: this.name,
        reason: 'Profile is set to private',
        resultType: 'private',
        summary: `This account (@${username}) is private. Unable to analyze content effectively as posts and detailed profile information are not publicly accessible. Consider requesting to follow this account for a complete analysis.`,
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
}
