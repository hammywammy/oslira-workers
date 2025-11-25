// infrastructure/analysis-checks/index.ts

/**
 * PRE-ANALYSIS CHECKS MODULE
 *
 * Centralized module for all pre-analysis validation checks.
 * These checks run after scraping but before AI analysis to
 * detect profiles that cannot be meaningfully analyzed.
 *
 * Current checks:
 * - ProfileNotFoundCheck: Detects deleted/non-existent profiles
 * - PrivateProfileCheck: Detects private accounts
 * - ICPFollowerLimitCheck: Validates follower count against ICP bounds
 *
 * To add a new check:
 * 1. Create a new file in ./checks/ implementing IPreAnalysisCheck
 * 2. Register it in PreAnalysisChecksService.registerDefaultChecks()
 * 3. Export it from this index file
 */

// Main service
export { PreAnalysisChecksService } from './pre-analysis-checks.service';

// Types
export type {
  IPreAnalysisCheck,
  PreAnalysisCheckContext,
  PreAnalysisCheckResult,
  PreAnalysisChecksSummary,
  PreAnalysisChecksConfig,
  AnalysisResultType,
  ExtendedAnalysisType,
  ApifyErrorResponse,
  ICPSettings
} from './types';
export { DEFAULT_CHECKS_CONFIG } from './types';

// Individual checks (for custom registration or testing)
export { PrivateProfileCheck } from './checks/private-profile.check';
export { ProfileNotFoundCheck } from './checks/profile-not-found.check';
export { ICPFollowerLimitCheck } from './checks/icp-follower-limit.check';
