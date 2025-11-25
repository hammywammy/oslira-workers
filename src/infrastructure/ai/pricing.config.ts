// infrastructure/ai/pricing.config.ts

/**
 * @deprecated This file is deprecated. Use centralized config instead:
 * import { AI_MODEL_PRICING, calculateAICost, getAIModel } from '@/config/operations-pricing.config';
 *
 * This file re-exports for backward compatibility only.
 */

// Re-export from centralized config for backward compatibility
export {
  AI_MODEL_PRICING as AI_PRICING,
  calculateAICost,
  getAIModel,
  getAIMaxTokens,
  type AIModelPricing as ModelPricing
} from '@/config/operations-pricing.config';

// Legacy interface alias
export interface AnalysisModelConfig {
  model: string;
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens: number;
}

// NOTE: ANALYSIS_MODEL_MAPPING removed - use ANALYSIS_CONFIG from centralized config instead
// import { ANALYSIS_CONFIG } from '@/config/operations-pricing.config';
// const model = ANALYSIS_CONFIG.light.ai_model;
// const maxTokens = ANALYSIS_CONFIG.light.ai_max_tokens;

/**
 * @deprecated Use getAIModel() from centralized config
 */
export function getModelConfig(analysisType: string): AnalysisModelConfig {
  // Import dynamically to avoid circular deps
  const { ANALYSIS_CONFIG } = require('@/config/operations-pricing.config');
  const config = ANALYSIS_CONFIG[analysisType];
  if (!config) {
    throw new Error(`Unknown analysis type: ${analysisType}`);
  }
  return {
    model: config.ai_model,
    max_tokens: config.ai_max_tokens
  };
}

/**
 * @deprecated Use calculateAICost() from centralized config
 */
export function estimateCost(analysisType: string): number {
  const config = getModelConfig(analysisType);
  const { calculateAICost: calcCost } = require('@/config/operations-pricing.config');

  const estimatedInput = 1000;
  const estimatedOutput = config.max_tokens;

  return calcCost(config.model, estimatedInput, estimatedOutput);
}
