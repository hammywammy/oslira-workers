// config/analysis-types.config.ts

/**
 * CENTRALIZED ANALYSIS TYPES CONFIGURATION
 *
 * Single source of truth for ALL analysis type settings.
 * Adding a new analysis type requires ONLY adding a config object here.
 *
 * Features:
 * - Timing profiles for progress calculation
 * - AI model and token settings
 * - Data requirements (posts limit, features enabled)
 * - Pricing (credits, scraping costs)
 * - Cache-aware progress percentage calculation
 *
 * Last updated: 2025-01-30
 */

// ===============================================================================
// TYPES
// ===============================================================================

export type AnalysisType = 'light' | 'deep';

/**
 * Features enabled for each analysis type
 * Light = quick score + summary only
 * Deep = comprehensive analysis with Phase 2 AI
 */
export interface AnalysisFeatures {
  /** Run Phase 2 Lead Qualification AI (GPT-5 comprehensive analysis) */
  runLeadQualificationAI: boolean;
  /** Run niche detection AI */
  runNicheDetection: boolean;
  /** Include profile extraction (hashtags, mentions, metrics) */
  runProfileExtraction: boolean;
  /** Include detailed summary with recommendations */
  includeDetailedSummary: boolean;
}

export interface AnalysisTimingProfile {
  /** Setup time (steps 1-5): secrets, duplicate check, credits, business profile, cache */
  setup: number;
  /** Scraping time (step 6): Instagram profile scrape via Apify */
  scraping: number;
  /** AI analysis time (step 7): varies by type */
  ai_analysis: number;
  /** Teardown time (steps 8-11): save lead, save analysis, complete, log */
  teardown: number;
}

export interface AnalysisAIConfig {
  /** AI model to use for profile assessment */
  model: string;
  /** Max output tokens */
  maxTokens: number;
  /** Retry max tokens (increased on parse failure) */
  retryMaxTokens: number;
  /** Reasoning effort level */
  reasoningEffort: 'low' | 'medium' | 'high';
}

export interface AnalysisPromptConfig {
  /** Summary sentence range (e.g., "2-3" or "4-6") */
  summarySentences: string;
  /** Maximum caption length to include per post */
  captionTruncateLength: number;
  /** Include profile summary section in prompt */
  includeProfileSummary: boolean;
}

export interface AnalysisPricingConfig {
  /** Credit cost charged to user */
  creditCost: number;
  /** Fixed scraping cost per run (USD) */
  scrapingCostUsd: number;
}

export interface AnalysisDataConfig {
  /** Number of posts to scrape/analyze */
  postsLimit: number;
}

/**
 * Complete analysis type configuration
 */
export interface AnalysisTypeConfig {
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Timing profile for progress calculation */
  timing: AnalysisTimingProfile;
  /** AI configuration */
  ai: AnalysisAIConfig;
  /** Prompt configuration */
  prompt: AnalysisPromptConfig;
  /** Features enabled */
  features: AnalysisFeatures;
  /** Pricing */
  pricing: AnalysisPricingConfig;
  /** Data requirements */
  data: AnalysisDataConfig;
}

// ===============================================================================
// CONFIGURATION
// ===============================================================================

/**
 * ANALYSIS TYPE CONFIGURATIONS
 *
 * LIGHT ANALYSIS:
 * - Quick fit assessment (score + 2-3 sentence summary)
 * - Basic profile info returned
 * - NO Phase 2 AI (lead qualification, niche detection skipped)
 * - ~23-28s total
 *
 * DEEP ANALYSIS:
 * - Comprehensive psychographic profile
 * - Full Phase 2 AI (lead qualification, niche detection)
 * - Detailed insights, outreach strategies
 * - ~53-58s total
 */
export const ANALYSIS_TYPES: Record<AnalysisType, AnalysisTypeConfig> = {
  light: {
    name: 'Light Analysis',
    description: 'Quick fit assessment with score and brief summary',
    timing: {
      setup: 1,          // Steps 1-5: ~1 second
      scraping: 8.5,     // Step 6: ~6-11 seconds average
      ai_analysis: 15,   // Step 7: ~15 seconds (profile assessment only)
      teardown: 1        // Steps 8-11: ~1 second
    },
    ai: {
      model: 'gpt-5-nano',
      maxTokens: 800,
      retryMaxTokens: 1200,
      reasoningEffort: 'low'
    },
    prompt: {
      summarySentences: '2-3',
      captionTruncateLength: 200,
      includeProfileSummary: false  // Skip detailed profile section
    },
    features: {
      runLeadQualificationAI: false,   // Skip Phase 2 comprehensive AI
      runNicheDetection: false,        // Skip niche detection
      runProfileExtraction: false,     // Skip extraction - Light only needs score + summary
      includeDetailedSummary: false    // Only score + brief summary
    },
    pricing: {
      creditCost: 1,
      scrapingCostUsd: 0.003
    },
    data: {
      postsLimit: 12
    }
  },

  deep: {
    name: 'Deep Analysis',
    description: 'Comprehensive psychographic profile with detailed insights',
    timing: {
      setup: 1,          // Steps 1-5: ~1 second
      scraping: 8.5,     // Step 6: ~6-11 seconds average
      ai_analysis: 45,   // Step 7: ~45 seconds (both AI analyses in parallel)
      teardown: 1        // Steps 8-11: ~1 second
    },
    ai: {
      model: 'gpt-5',
      maxTokens: 2000,
      retryMaxTokens: 3000,
      reasoningEffort: 'low'
    },
    prompt: {
      summarySentences: '4-6',
      captionTruncateLength: 400,
      includeProfileSummary: true   // Include detailed profile metrics
    },
    features: {
      runLeadQualificationAI: true,    // Full Phase 2 comprehensive AI
      runNicheDetection: true,         // Detect niche
      runProfileExtraction: true,      // Full extraction
      includeDetailedSummary: true     // Detailed recommendations
    },
    pricing: {
      creditCost: 1,
      scrapingCostUsd: 0.003
    },
    data: {
      postsLimit: 12
    }
  }
};

// ===============================================================================
// PROGRESS CALCULATION (CACHE-AWARE)
// ===============================================================================

export interface ProgressStep {
  step: string;
  percentage: number;
  description: string;
}

/**
 * Calculate time-weighted progress percentages for an analysis type
 * This is the base calculation (no cache consideration)
 */
function calculateBaseProgressPercentages(timing: AnalysisTimingProfile): ProgressStep[] {
  const totalTime = timing.setup + timing.scraping + timing.ai_analysis + timing.teardown;

  // Calculate percentage weights
  const setupWeight = timing.setup / totalTime;
  const scrapingWeight = timing.scraping / totalTime;
  const aiWeight = timing.ai_analysis / totalTime;

  // Distribute setup percentage across steps 1-5
  const step2_pct = Math.round(setupWeight * 100 * 0.2);  // 20% of setup
  const step3_pct = Math.round(setupWeight * 100 * 0.4);  // 40% of setup
  const step4_pct = Math.round(setupWeight * 100 * 0.6);  // 60% of setup
  const step5_pct = Math.round(setupWeight * 100);        // 100% of setup

  // Major work steps
  const step6_pct = Math.round((setupWeight + scrapingWeight) * 100);
  const step7_pct = Math.round((setupWeight + scrapingWeight + aiWeight) * 100);

  // Final steps
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
    { step: 'log_operations', percentage: 100, description: 'Complete' }
  ];
}

/**
 * Calculate cache-adjusted progress percentages
 * When cache hits, scraping time = 0, so percentages shift
 */
function calculateCacheAdjustedProgressPercentages(timing: AnalysisTimingProfile): ProgressStep[] {
  // Cache hit = scraping time is 0
  const adjustedTiming = { ...timing, scraping: 0 };
  const totalTime = adjustedTiming.setup + adjustedTiming.ai_analysis + adjustedTiming.teardown;

  const setupWeight = adjustedTiming.setup / totalTime;
  const aiWeight = adjustedTiming.ai_analysis / totalTime;

  // Distribute setup percentage across steps 1-5
  const step2_pct = Math.round(setupWeight * 100 * 0.2);
  const step3_pct = Math.round(setupWeight * 100 * 0.4);
  const step4_pct = Math.round(setupWeight * 100 * 0.6);
  const step5_pct = Math.round(setupWeight * 100);

  // When cache hits, step 6 (scraping) is skipped, so AI gets more weight
  const step6_pct = step5_pct; // Same as cache check (no scraping time)
  const step7_pct = Math.round((setupWeight + aiWeight) * 100);

  const step8_pct = Math.min(97, step7_pct + 2);
  const step9_pct = Math.min(98, step8_pct + 1);

  return [
    { step: 'initialize_progress', percentage: 0, description: 'Initializing' },
    { step: 'check_duplicate', percentage: step2_pct, description: 'Checking for duplicates' },
    { step: 'deduct_credits', percentage: step3_pct, description: 'Verifying credits' },
    { step: 'get_business_profile', percentage: step4_pct, description: 'Loading business profile' },
    { step: 'check_cache', percentage: step5_pct, description: 'Checking cache' },
    { step: 'scrape_profile', percentage: step6_pct, description: 'Using cached profile' },
    { step: 'ai_analysis', percentage: step7_pct, description: 'Running AI analysis' },
    { step: 'upsert_lead', percentage: step8_pct, description: 'Saving lead data' },
    { step: 'save_analysis', percentage: step9_pct, description: 'Saving analysis results' },
    { step: 'complete_progress', percentage: 100, description: 'Complete' },
    { step: 'log_operations', percentage: 100, description: 'Complete' }
  ];
}

// Pre-calculate progress maps for each analysis type (base and cache-adjusted)
const BASE_PROGRESS_MAPS: Record<AnalysisType, Map<string, ProgressStep>> = {
  light: new Map(
    calculateBaseProgressPercentages(ANALYSIS_TYPES.light.timing)
      .map(step => [step.step, step])
  ),
  deep: new Map(
    calculateBaseProgressPercentages(ANALYSIS_TYPES.deep.timing)
      .map(step => [step.step, step])
  )
};

const CACHE_ADJUSTED_PROGRESS_MAPS: Record<AnalysisType, Map<string, ProgressStep>> = {
  light: new Map(
    calculateCacheAdjustedProgressPercentages(ANALYSIS_TYPES.light.timing)
      .map(step => [step.step, step])
  ),
  deep: new Map(
    calculateCacheAdjustedProgressPercentages(ANALYSIS_TYPES.deep.timing)
      .map(step => [step.step, step])
  )
};

// ===============================================================================
// HELPER FUNCTIONS
// ===============================================================================

/**
 * Get analysis type configuration
 */
export function getAnalysisConfig(analysisType: AnalysisType): AnalysisTypeConfig {
  const config = ANALYSIS_TYPES[analysisType];
  if (!config) {
    throw new Error(`Unknown analysis type: ${analysisType}`);
  }
  return config;
}

/**
 * Get progress info for a specific step (cache-aware)
 */
export function getStepProgressCacheAware(
  analysisType: AnalysisType,
  stepName: string,
  cacheHit: boolean
): ProgressStep {
  const progressMap = cacheHit
    ? CACHE_ADJUSTED_PROGRESS_MAPS[analysisType]
    : BASE_PROGRESS_MAPS[analysisType];

  const step = progressMap.get(stepName);
  if (!step) {
    throw new Error(`Unknown step: ${stepName} for analysis type: ${analysisType}`);
  }

  return step;
}

/**
 * Check if a feature is enabled for an analysis type
 */
export function isFeatureEnabled(
  analysisType: AnalysisType,
  feature: keyof AnalysisFeatures
): boolean {
  return ANALYSIS_TYPES[analysisType].features[feature];
}

/**
 * Get AI model for an analysis type
 */
export function getAnalysisAIModel(analysisType: AnalysisType): string {
  return ANALYSIS_TYPES[analysisType].ai.model;
}

/**
 * Get AI max tokens for an analysis type
 */
export function getAnalysisMaxTokens(analysisType: AnalysisType): number {
  return ANALYSIS_TYPES[analysisType].ai.maxTokens;
}

/**
 * Get posts limit for an analysis type
 */
export function getAnalysisPostsLimit(analysisType: AnalysisType): number {
  return ANALYSIS_TYPES[analysisType].data.postsLimit;
}

/**
 * Get prompt configuration for an analysis type
 */
export function getAnalysisPromptConfig(analysisType: AnalysisType): AnalysisPromptConfig {
  return ANALYSIS_TYPES[analysisType].prompt;
}

/**
 * Get estimated total duration for an analysis type (in seconds)
 */
export function getAnalysisEstimatedDuration(
  analysisType: AnalysisType,
  cacheHit: boolean = false
): number {
  const timing = ANALYSIS_TYPES[analysisType].timing;
  const scrapingTime = cacheHit ? 0 : timing.scraping;
  return timing.setup + scrapingTime + timing.ai_analysis + timing.teardown;
}

/**
 * Get credit cost for an analysis type
 */
export function getAnalysisCreditCost(analysisType: AnalysisType): number {
  return ANALYSIS_TYPES[analysisType].pricing.creditCost;
}

/**
 * Get scraping cost for an analysis type
 */
export function getAnalysisScrapingCost(analysisType: AnalysisType): number {
  return ANALYSIS_TYPES[analysisType].pricing.scrapingCostUsd;
}
