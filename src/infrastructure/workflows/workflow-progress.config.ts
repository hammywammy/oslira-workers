// infrastructure/workflows/workflow-progress.config.ts

/**
 * WORKFLOW PROGRESS CONFIGURATION
 *
 * Configuration for workflow step progress percentages ONLY.
 * Percentages are time-weighted based on actual step execution times.
 *
 * NOTE: Pricing/costs/limits are in centralized config:
 * - Credit costs: @/config/operations-pricing.config → getCreditCost()
 * - Posts limits: @/config/operations-pricing.config → getPostsLimit()
 * - Scraping costs: @/config/operations-pricing.config → getScrapingCost()
 */

import { ANALYSIS_CONFIG, type AnalysisType } from '@/config/operations-pricing.config';

// Re-export AnalysisType for convenience
export type { AnalysisType };

export interface StepProgress {
  step: string;
  percentage: number;
  description: string;
}

interface TimingProfile {
  setup: number;
  scraping: number;
  ai_analysis: number;
  teardown: number;
}

/**
 * Calculate time-weighted progress percentages for an analysis type
 */
function calculateProgressPercentages(timing: TimingProfile): StepProgress[] {
  const totalTime =
    timing.setup +
    timing.scraping +
    timing.ai_analysis +
    timing.teardown;

  // Calculate percentage weights
  const setupWeight = (timing.setup / totalTime);
  const scrapingWeight = (timing.scraping / totalTime);
  const aiWeight = (timing.ai_analysis / totalTime);

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
 * MODULAR: Add new maps here when implementing additional analysis tiers
 *
 * Each analysis type gets its own progress percentages based on timing profile
 */
export const WORKFLOW_PROGRESS: Record<AnalysisType, Map<string, StepProgress>> = {
  light: new Map(
    calculateProgressPercentages(ANALYSIS_CONFIG.light.timing)
      .map(step => [step.step, step])
  ),
  deep: new Map(
    calculateProgressPercentages(ANALYSIS_CONFIG.deep.timing)
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

// NOTE: Cost/duration functions moved to centralized config
// Use the following from '@/config/operations-pricing.config':
// - getCreditCost(analysisType)
// - getPostsLimit(analysisType)
// - getEstimatedDuration(analysisType)

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
