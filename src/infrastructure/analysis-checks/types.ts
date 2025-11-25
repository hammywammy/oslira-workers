// infrastructure/analysis-checks/types.ts

/**
 * PRE-ANALYSIS CHECKS TYPE DEFINITIONS
 *
 * Centralized types for the modular pre-analysis check system.
 * These checks run after scraping but before AI analysis to catch
 * profiles that cannot be properly analyzed (private, not found, etc.)
 */

import type { ProfileData } from '@/infrastructure/cache/r2-cache.service';
import type { AnalysisType } from '@/config/operations-pricing.config';

/**
 * Result types that bypass AI analysis
 * These represent terminal states where analysis cannot proceed normally
 */
export type AnalysisResultType = 'private' | 'not_found';

/**
 * All valid analysis types including bypassed results
 */
export type ExtendedAnalysisType = AnalysisType | AnalysisResultType;

/**
 * Context passed to each pre-analysis check
 * Contains all data needed to evaluate if analysis should proceed
 */
export interface PreAnalysisCheckContext {
  /** The scraped profile data (may be null if scrape failed) */
  profile: ProfileData | null;
  /** The raw Apify response (for detecting errors) */
  rawApifyResponse?: ApifyErrorResponse | null;
  /** Username being analyzed */
  username: string;
  /** Account performing the analysis */
  accountId: string;
  /** Business profile context */
  businessProfileId: string;
  /** Original analysis type requested */
  requestedAnalysisType: AnalysisType;
}

/**
 * Apify error response structure
 * When a profile doesn't exist or has issues
 */
export interface ApifyErrorResponse {
  url?: string;
  username?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Result of a single pre-analysis check
 */
export interface PreAnalysisCheckResult {
  /** Whether the check passed (analysis can proceed) */
  passed: boolean;
  /** Unique identifier for this check */
  checkName: string;
  /** Human-readable reason if check failed */
  reason?: string;
  /** Override analysis type when check fails (e.g., 'private', 'not_found') */
  resultType?: AnalysisResultType;
  /** Summary text to store instead of AI-generated summary */
  summary?: string;
  /** Score to assign (typically 0 for failed checks) */
  score?: number;
  /** Whether to refund the user's balance */
  shouldRefund: boolean;
}

/**
 * Combined result from all pre-analysis checks
 */
export interface PreAnalysisChecksSummary {
  /** Whether all checks passed */
  allPassed: boolean;
  /** The first failing check result (if any) */
  failedCheck?: PreAnalysisCheckResult;
  /** All check results for logging/debugging */
  results: PreAnalysisCheckResult[];
  /** Total checks executed */
  checksRun: number;
  /** Execution time in milliseconds */
  durationMs: number;
}

/**
 * Interface for implementing a pre-analysis check
 * Checks are executed in priority order (lower = first)
 */
export interface IPreAnalysisCheck {
  /** Unique name identifying this check */
  readonly name: string;
  /** Execution priority (lower runs first) */
  readonly priority: number;
  /** Human-readable description */
  readonly description: string;
  /**
   * Execute the check
   * @param context - All data needed for the check
   * @returns Check result indicating pass/fail and metadata
   */
  run(context: PreAnalysisCheckContext): Promise<PreAnalysisCheckResult>;
}

/**
 * Configuration for the pre-analysis checks service
 */
export interface PreAnalysisChecksConfig {
  /** Whether to continue running checks after first failure */
  continueOnFailure: boolean;
  /** Enable detailed logging */
  verbose: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CHECKS_CONFIG: PreAnalysisChecksConfig = {
  continueOnFailure: false, // Stop on first failure (most common use case)
  verbose: true
};
