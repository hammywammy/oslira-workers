// infrastructure/ai/pricing.config.ts

/**
 * SINGLE SOURCE OF TRUTH - AI Model Pricing & Configuration
 * Update costs here when providers change pricing
 */

export interface ModelPricing {
  per_1m_input: number;   // Cost per 1M input tokens
  per_1m_output: number;  // Cost per 1M output tokens
  provider: 'openai' | 'anthropic';
  max_tokens: number;     // Maximum output tokens
  supports_json_schema: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high'; // OpenAI o1 only
}

/**
 * ALL MODEL COSTS
 * Last updated: 2025-01-20
 * Source: OpenAI pricing page, Anthropic pricing page
 */
export const AI_PRICING: Record<string, ModelPricing> = {

  'gpt-5-nano': {
    per_1m_input: 0.15,
    per_1m_output: 0.60,
    provider: 'openai',
    max_tokens: 16384,
    supports_json_schema: true,
    reasoning_effort: 'low'
  },

  'gpt-5-mini': {
    per_1m_input: 0.30,
    per_1m_output: 1.20,
    provider: 'openai',
    max_tokens: 16384,
    supports_json_schema: true,
    reasoning_effort: 'medium'
  },

  // Anthropic Models (kept for future use)
  'claude-3-5-sonnet-20241022': {
    per_1m_input: 3.00,
    per_1m_output: 15.00,
    provider: 'anthropic',
    max_tokens: 8192,
    supports_json_schema: false
  }
};

/**
 * ANALYSIS TYPE → MODEL MAPPING
 * Defines which model to use for each analysis type
 */
export interface AnalysisModelConfig {
  model: string;
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens: number;
}

export const ANALYSIS_MODEL_MAPPING: Record<string, AnalysisModelConfig> = {
  'light': {
    model: 'gpt-5-nano',
    reasoning_effort: 'low',
    max_tokens: 400
  }
};

/**
 * Calculate cost for a completed AI call
 */
export function calculateAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = AI_PRICING[model];
  if (!pricing) {
    console.warn(`Unknown model: ${model}, cost set to 0`);
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.per_1m_input;
  const outputCost = (outputTokens / 1_000_000) * pricing.per_1m_output;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Get model config for analysis type
 */
export function getModelConfig(analysisType: string): AnalysisModelConfig {
  const config = ANALYSIS_MODEL_MAPPING[analysisType];
  if (!config) {
    throw new Error(`Unknown analysis type: ${analysisType}`);
  }
  return config;
}

/**
 * Estimate cost before making call (rough estimate)
 * Assumes ~1000 input tokens + configured output tokens
 */
export function estimateCost(analysisType: string): number {
  const config = getModelConfig(analysisType);
  const pricing = AI_PRICING[config.model];

  const estimatedInput = 1000; // Rough estimate
  const estimatedOutput = config.max_tokens;

  return calculateAICost(config.model, estimatedInput, estimatedOutput);
}
