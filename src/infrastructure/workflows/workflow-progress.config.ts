// infrastructure/workflows/workflow-progress.config.ts

/**
 * WORKFLOW PROGRESS CONFIGURATION
 *
 * Centralized configuration for workflow step progress percentages.
 * Percentages are time-weighted based on actual step execution times.
 *
 * Usage:
 * - Each analysis type has its own timing profile
 * - Update percentages here when adding new analysis types
 * - Progress percentages should sum to a flow that ends at 100%
 */

export type AnalysisType = 'light' | 'deep' | 'xray';

export interface StepProgress {
  step: string;
  percentage: number;
  description: string;
}

export interface AnalysisTimingProfile {
  /** Expected time for steps 1-5 (DB checks, cache) in seconds */
  setup_time: number;
  /** Expected time for scraping (step 6) in seconds */
  scraping_time: number;
  /** Expected time for AI analysis (step 7) in seconds */
  ai_analysis_time: number;
  /** Expected time for steps 8-11 (DB saves, logging) in seconds */
  teardown_time: number;
  /** Number of posts to scrape */
  posts_limit: number;
  /** Credit cost for this analysis type */
  credit_cost: number;
}

/**
 * Timing profiles for each analysis type
 * Update these when adding new analysis types or when timing changes
 */
export const ANALYSIS_TIMING_PROFILES: Record<AnalysisType, AnalysisTimingProfile> = {
  light: {
    setup_time: 1,        // Steps 1-5: ~1 second total
    scraping_time: 7.5,   // Step 6: ~7.5 seconds average
    ai_analysis_time: 9,  // Step 7: ~9 seconds average
    teardown_time: 1,     // Steps 8-11: ~1 second total
    posts_limit: 6,
    credit_cost: 1
  },
  deep: {
    setup_time: 1,        // Steps 1-5: ~1 second total
    scraping_time: 10,    // Step 6: ~10 seconds (more posts)
    ai_analysis_time: 15, // Step 7: ~15 seconds (deeper analysis)
    teardown_time: 1,     // Steps 8-11: ~1 second total
    posts_limit: 12,
    credit_cost: 3
  },
  xray: {
    setup_time: 1,        // Steps 1-5: ~1 second total
    scraping_time: 10,    // Step 6: ~10 seconds (more posts)
    ai_analysis_time: 25, // Step 7: ~25 seconds (comprehensive analysis)
    teardown_time: 1,     // Steps 8-11: ~1 second total
    posts_limit: 12,
    credit_cost: 5
  }
};

/**
 * Calculate time-weighted progress percentages for an analysis type
 */
function calculateProgressPercentages(profile: AnalysisTimingProfile): StepProgress[] {
  const totalTime =
    profile.setup_time +
    profile.scraping_time +
    profile.ai_analysis_time +
    profile.teardown_time;

  // Calculate percentage weights
  const setupWeight = (profile.setup_time / totalTime);
  const scrapingWeight = (profile.scraping_time / totalTime);
  const aiWeight = (profile.ai_analysis_time / totalTime);

  // Distribute setup percentage across steps 1-5
  const step2_pct = Math.round(setupWeight * 100 * 0.2);  // 20% of setup time
  const step3_pct = Math.round(setupWeight * 100 * 0.4);  // 40% of setup time
  const step4_pct = Math.round(setupWeight * 100 * 0.6);  // 60% of setup time
  const step5_pct = Math.round(setupWeight * 100);        // 100% of setup time

  // Major work steps
  const step6_pct = Math.round((setupWeight + scrapingWeight) * 100);
  const step7_pct = Math.round((setupWeight + scrapingWeight + aiWeight) * 100);

  // Final steps (ensure we end at 100%)
  const step8_pct = Math.min(97, step7_pct + 2);
  const step9_pct = Math.min(98, step8_pct + 1);

  return [
    { step: 'initialize_progress', percentage: 0, description: 'Initializing' },
    { step: 'check_duplicate', percentage: step2_pct, description: 'Checking for duplicates' },
    { step: 'deduct_credits', percentage: step3_pct, description: 'Verifying credits' },
    { step: 'get_business_profile', percentage: step4_pct, description: 'Loading business profile' },
    { step: 'check_cache', percentage: step5_pct, description: 'Checking cache' },
    { step: 'scrape_profile', percentage: step6_pct, description: 'Scraping Instagram profile' },
    { step: 'ai_analysis', percentage: step7_pct, description: 'Running AI analysis' },
    { step: 'upsert_lead', percentage: step8_pct, description: 'Saving lead data' },
    { step: 'save_analysis', percentage: step9_pct, description: 'Saving analysis results' },
    { step: 'complete_progress', percentage: 100, description: 'Complete' },
    { step: 'log_operations', percentage: 100, description: 'Complete' } // Silent logging
  ];
}

/**
 * Pre-calculated progress maps for each analysis type
 */
export const WORKFLOW_PROGRESS: Record<AnalysisType, Map<string, StepProgress>> = {
  light: new Map(
    calculateProgressPercentages(ANALYSIS_TIMING_PROFILES.light)
      .map(step => [step.step, step])
  ),
  deep: new Map(
    calculateProgressPercentages(ANALYSIS_TIMING_PROFILES.deep)
      .map(step => [step.step, step])
  ),
  xray: new Map(
    calculateProgressPercentages(ANALYSIS_TIMING_PROFILES.xray)
      .map(step => [step.step, step])
  )
};

/**
 * Get progress info for a specific step and analysis type
 */
export function getStepProgress(
  analysisType: AnalysisType,
  stepName: string
): StepProgress {
  const progressMap = WORKFLOW_PROGRESS[analysisType];
  const step = progressMap.get(stepName);

  if (!step) {
    throw new Error(`Unknown step: ${stepName} for analysis type: ${analysisType}`);
  }

  return step;
}

/**
 * Get credit cost for an analysis type
 */
export function getCreditCost(analysisType: AnalysisType): number {
  return ANALYSIS_TIMING_PROFILES[analysisType].credit_cost;
}

/**
 * Get posts limit for an analysis type
 */
export function getPostsLimit(analysisType: AnalysisType): number {
  return ANALYSIS_TIMING_PROFILES[analysisType].posts_limit;
}

/**
 * Get estimated total time for an analysis type (in seconds)
 */
export function getEstimatedDuration(analysisType: AnalysisType): number {
  const profile = ANALYSIS_TIMING_PROFILES[analysisType];
  return profile.setup_time + profile.scraping_time + profile.ai_analysis_time + profile.teardown_time;
}

/**
 * REFERENCE: Light Analysis Progress Flow (18.5s total)
 *
 * Step 1 (0%):   Initialize progress tracker
 * Step 2 (2%):   Checking for duplicates         (~0.2s)
 * Step 3 (3%):   Verifying credits               (~0.2s)
 * Step 4 (4%):   Loading business profile        (~0.2s)
 * Step 5 (5%):   Checking cache                  (~0.4s)
 * Step 6 (45%):  Scraping Instagram profile      (~7.5s) - 40.5% of time
 * Step 7 (95%):  Running AI analysis             (~9s)   - 48.6% of time
 * Step 8 (97%):  Saving lead data                (~0.3s)
 * Step 9 (98%):  Saving analysis results         (~0.3s)
 * Step 10 (100%): Complete                       (~0.4s)
 * Step 11 (100%): Logging (silent)
 */
