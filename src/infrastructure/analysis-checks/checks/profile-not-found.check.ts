// infrastructure/analysis-checks/checks/profile-not-found.check.ts

/**
 * PROFILE NOT FOUND CHECK
 *
 * Detects Instagram profiles that don't exist or have been deleted.
 * This check handles Apify error responses where the profile lookup failed.
 *
 * Common scenarios:
 * - Username doesn't exist
 * - Account was deleted
 * - Account was suspended
 * - Username changed
 *
 * When triggered:
 * - Skips AI analysis
 * - Sets result type to 'not_found'
 * - Refunds the user's balance
 * - Stores descriptive summary
 */

import type {
  IPreAnalysisCheck,
  PreAnalysisCheckContext,
  PreAnalysisCheckResult,
  ApifyErrorResponse
} from '../types';

export class ProfileNotFoundCheck implements IPreAnalysisCheck {
  readonly name = 'profile_not_found';
  readonly priority = 5; // Run first - no point checking anything else if profile doesn't exist
  readonly description = 'Checks if the Instagram profile exists';

  /**
   * Error patterns that indicate profile doesn't exist
   */
  private readonly notFoundPatterns = [
    'not_found',
    'does not exist',
    'user not found',
    'page not found',
    'account deleted',
    'account suspended'
  ];

  async run(context: PreAnalysisCheckContext): Promise<PreAnalysisCheckResult> {
    const { profile, rawApifyResponse, username } = context;

    // Check 1: Explicit error in raw Apify response
    if (rawApifyResponse && this.isNotFoundError(rawApifyResponse)) {
      console.log(`[PreAnalysisCheck][${this.name}] Profile @${username} not found (Apify error)`);

      return {
        passed: false,
        checkName: this.name,
        reason: rawApifyResponse.errorDescription || rawApifyResponse.error || 'Profile not found',
        resultType: 'not_found',
        summary: `This profile (@${username}) does not exist or is no longer available. The account may have been deleted, suspended, or the username may have changed.`,
        score: 0,
        shouldRefund: true
      };
    }

    // Check 2: No profile data returned (scrape returned nothing)
    if (!profile) {
      console.log(`[PreAnalysisCheck][${this.name}] Profile @${username} returned null/empty`);

      return {
        passed: false,
        checkName: this.name,
        reason: 'No profile data returned',
        resultType: 'not_found',
        summary: `Unable to find profile @${username}. The account may not exist, or there was an issue retrieving the profile data.`,
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
   * Check if the Apify response indicates a not found error
   */
  private isNotFoundError(response: ApifyErrorResponse): boolean {
    // Check explicit error field
    if (response.error) {
      const errorLower = response.error.toLowerCase();
      if (this.notFoundPatterns.some(pattern => errorLower.includes(pattern))) {
        return true;
      }
    }

    // Check errorDescription field
    if (response.errorDescription) {
      const descLower = response.errorDescription.toLowerCase();
      if (this.notFoundPatterns.some(pattern => descLower.includes(pattern))) {
        return true;
      }
    }

    return false;
  }
}
