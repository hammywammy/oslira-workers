// infrastructure/analysis-checks/pre-analysis-checks.service.ts

/**
 * PRE-ANALYSIS CHECKS SERVICE
 *
 * Centralized orchestrator for all pre-analysis checks.
 * Runs after profile scraping but before AI analysis to catch
 * profiles that cannot or should not be analyzed.
 *
 * Features:
 * - Modular check registration
 * - Priority-based execution order
 * - Configurable fail-fast or run-all behavior
 * - Comprehensive logging
 * - Easy extensibility for new checks
 *
 * Usage:
 * ```typescript
 * const checksService = new PreAnalysisChecksService();
 * const result = await checksService.runChecks({
 *   profile: scrapedProfile,
 *   username: 'someuser',
 *   accountId: '...',
 *   businessProfileId: '...',
 *   requestedAnalysisType: 'light'
 * });
 *
 * if (!result.allPassed) {
 *   // Handle failed check - refund, update status, etc.
 * }
 * ```
 */

import type {
  IPreAnalysisCheck,
  PreAnalysisCheckContext,
  PreAnalysisCheckResult,
  PreAnalysisChecksSummary,
  PreAnalysisChecksConfig
} from './types';
import { DEFAULT_CHECKS_CONFIG } from './types';

// Import all checks
import { PrivateProfileCheck } from './checks/private-profile.check';
import { ProfileNotFoundCheck } from './checks/profile-not-found.check';
import { ICPFollowerLimitCheck } from './checks/icp-follower-limit.check';

export class PreAnalysisChecksService {
  private checks: IPreAnalysisCheck[] = [];
  private config: PreAnalysisChecksConfig;

  constructor(config?: Partial<PreAnalysisChecksConfig>) {
    this.config = { ...DEFAULT_CHECKS_CONFIG, ...config };
    this.registerDefaultChecks();
  }

  /**
   * Register all default checks
   * Checks are registered in no particular order - they will be sorted by priority
   */
  private registerDefaultChecks(): void {
    // Register built-in checks
    this.registerCheck(new ProfileNotFoundCheck());
    this.registerCheck(new PrivateProfileCheck());
    this.registerCheck(new ICPFollowerLimitCheck());

    // Sort by priority after registration
    this.sortChecksByPriority();

    if (this.config.verbose) {
      console.log('[PreAnalysisChecks] Registered checks:', this.checks.map(c => ({
        name: c.name,
        priority: c.priority
      })));
    }
  }

  /**
   * Register a new check
   * @param check - The check implementation to register
   */
  registerCheck(check: IPreAnalysisCheck): void {
    // Prevent duplicate registration
    const existing = this.checks.find(c => c.name === check.name);
    if (existing) {
      console.warn(`[PreAnalysisChecks] Check '${check.name}' already registered, skipping`);
      return;
    }

    this.checks.push(check);
  }

  /**
   * Sort checks by priority (lower = first)
   */
  private sortChecksByPriority(): void {
    this.checks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Run all registered checks against the given context
   * @param context - The data needed for checks
   * @returns Summary of all check results
   */
  async runChecks(context: PreAnalysisCheckContext): Promise<PreAnalysisChecksSummary> {
    const startTime = Date.now();
    const results: PreAnalysisCheckResult[] = [];
    let failedCheck: PreAnalysisCheckResult | undefined;

    if (this.config.verbose) {
      console.log(`[PreAnalysisChecks] Running ${this.checks.length} checks for @${context.username}`);
    }

    for (const check of this.checks) {
      try {
        if (this.config.verbose) {
          console.log(`[PreAnalysisChecks] Running check: ${check.name}`);
        }

        const result = await check.run(context);
        results.push(result);

        if (!result.passed) {
          failedCheck = result;
          console.log(`[PreAnalysisChecks] Check '${check.name}' FAILED:`, {
            reason: result.reason,
            resultType: result.resultType,
            shouldRefund: result.shouldRefund
          });

          // Stop on first failure unless configured otherwise
          if (!this.config.continueOnFailure) {
            break;
          }
        } else if (this.config.verbose) {
          console.log(`[PreAnalysisChecks] Check '${check.name}' PASSED`);
        }
      } catch (error: any) {
        // Log error but don't let check failures break the flow
        console.error(`[PreAnalysisChecks] Check '${check.name}' threw error:`, error.message);

        // Treat check errors as passing (fail-open) to avoid blocking legitimate analyses
        results.push({
          passed: true,
          checkName: check.name,
          reason: `Check error: ${error.message}`,
          shouldRefund: false
        });
      }
    }

    const durationMs = Date.now() - startTime;

    const summary: PreAnalysisChecksSummary = {
      allPassed: !failedCheck,
      failedCheck,
      results,
      checksRun: results.length,
      durationMs
    };

    if (this.config.verbose) {
      console.log(`[PreAnalysisChecks] Complete:`, {
        allPassed: summary.allPassed,
        checksRun: summary.checksRun,
        durationMs: summary.durationMs,
        failedCheck: failedCheck?.checkName
      });
    }

    return summary;
  }

  /**
   * Get list of registered checks (for debugging/admin)
   */
  getRegisteredChecks(): Array<{ name: string; priority: number; description: string }> {
    return this.checks.map(c => ({
      name: c.name,
      priority: c.priority,
      description: c.description
    }));
  }

  /**
   * Clear all registered checks (for testing)
   */
  clearChecks(): void {
    this.checks = [];
  }
}
