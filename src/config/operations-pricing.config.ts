// config/operations-pricing.config.ts

/**
 * CENTRALIZED OPERATIONS PRICING & COST CONFIGURATION
 *
 * Single source of truth for ALL cost-related configuration.
 * This file controls pricing for operations_ledger tracking.
 *
 * Last updated: 2025-01-25
 *
 * Sections:
 * 1. Analysis Type Configuration (credits, posts limit, timing)
 * 2. AI Model Pricing (per 1M tokens)
 * 3. Scraping Pricing (fixed per-run costs)
 * 4. Credit Revenue Pricing (for margin calculations)
 * 5. Scraper Configuration (actor IDs, timeouts)
 * 6. Helper Functions
 */

// ===============================================================================
// TYPES
// ===============================================================================

/**
 * ANALYSIS TYPES
 * Add new analysis tiers here. Each type maps to a credit type.
 */
export type AnalysisType = 'light' | 'deep';

/**
 * CREDIT TYPES
 * Maps to database columns:
 * - light_analyses: light_analyses_balance (legacy, for light only)
 * - credits: credit_balance (for deep and all future analysis types)
 */
export type CreditType = 'light_analyses' | 'credits';

/**
 * Maps each analysis type to its corresponding credit type.
 * - Light uses dedicated light_analyses_balance
 * - Deep and all future types use credit_balance
 */
export const ANALYSIS_TO_CREDIT_TYPE: Record<AnalysisType, CreditType> = {
  light: 'light_analyses',
  deep: 'credits'
};

export type AIProvider = 'openai' | 'anthropic';
export type ScrapingVendor = 'apify';

export interface AnalysisTypeConfig {
  /** Credit cost charged to user */
  credit_cost: number;
  /** Number of posts to scrape */
  posts_limit: number;
  /** AI model to use */
  ai_model: string;
  /** Max output tokens for AI */
  ai_max_tokens: number;
  /** Expected duration estimates (seconds) */
  timing: {
    setup: number;
    scraping: number;
    ai_analysis: number;
    teardown: number;
  };
  /** Prompt configuration */
  prompt: {
    /** Summary sentence range (e.g., "2-3" or "4-6") */
    summary_sentences: string;
    /** Maximum caption length to include per post */
    caption_truncate_length: number;
  };
}

export interface AIModelPricing {
  /** Cost per 1M input tokens (USD) */
  per_1m_input: number;
  /** Cost per 1M output tokens (USD) */
  per_1m_output: number;
  /** Provider name */
  provider: AIProvider;
  /** Maximum output tokens */
  max_tokens: number;
  /** Whether model supports JSON schema */
  supports_json_schema: boolean;
  /** Reasoning effort level (OpenAI o1 only) */
  reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface ScrapingPricing {
  /** Fixed cost per scrape run (USD) - Apify costs are untrackable, so we set a fixed price */
  fixed_cost_per_run: number;
  /** Vendor name */
  vendor: ScrapingVendor;
}

export interface ScraperConfig {
  /** Human-readable name */
  name: string;
  /** Apify actor ID */
  actor_id: string;
  /** Timeout in milliseconds */
  timeout_ms: number;
  /** Max retry attempts */
  max_retries: number;
  /** Delay between retries in milliseconds */
  retry_delay_ms: number;
}

// ===============================================================================
// 1. ANALYSIS TYPE CONFIGURATION
// ===============================================================================

/**
 * Configuration for each analysis type.
 * Add new types here when implementing additional analysis tiers.
 *
 * MODULAR DESIGN:
 * - Each type defines its own credit cost, AI model, and prompt config
 * - Deep analysis = 2x summary length vs light
 * - Future types can have completely different configurations
 */
export const ANALYSIS_CONFIG: Record<AnalysisType, AnalysisTypeConfig> = {
  light: {
    credit_cost: 1,
    posts_limit: 6,
    ai_model: 'gpt-5-nano',
    ai_max_tokens: 800,
    timing: {
      setup: 1,        // Steps 1-5: ~1 second total
      scraping: 7.5,   // Step 6: ~7.5 seconds average
      ai_analysis: 9,  // Step 7: ~9 seconds average
      teardown: 1      // Steps 8-11: ~1 second total
    },
    prompt: {
      summary_sentences: '2-3',
      caption_truncate_length: 200
    }
  },
  deep: {
    credit_cost: 1,    // Uses deep_analyses credits, same cost per credit
    posts_limit: 6,    // Same posts for now, can be expanded
    ai_model: 'gpt-5',
    ai_max_tokens: 2000, // More tokens for deeper analysis with GPT-5
    timing: {
      setup: 1,
      scraping: 7.5,
      ai_analysis: 15,   // Longer due to GPT-5 and detailed output
      teardown: 1
    },
    prompt: {
      summary_sentences: '4-6',    // 2x longer summary (4-6 vs 2-3)
      caption_truncate_length: 400  // 2x more caption context
    }
  }
};

// ===============================================================================
// 2. AI MODEL PRICING
// ===============================================================================

/**
 * AI model pricing - update when providers change pricing.
 * Source: OpenAI/Anthropic pricing pages
 */
export const AI_MODEL_PRICING: Record<string, AIModelPricing> = {
  'gpt-5': {
    per_1m_input: 1.25,
    per_1m_output: 10.00,
    provider: 'openai',
    max_tokens: 16384,
    supports_json_schema: true
  },
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
  'claude-3-5-sonnet-20241022': {
    per_1m_input: 3.00,
    per_1m_output: 15.00,
    provider: 'anthropic',
    max_tokens: 8192,
    supports_json_schema: false
  }
};

// ===============================================================================
// 3. SCRAPING PRICING
// ===============================================================================

/**
 * Scraping costs - fixed per-run pricing.
 * Apify costs are untrackable at granular level, so we use fixed estimates.
 */
export const SCRAPING_PRICING: Record<AnalysisType, ScrapingPricing> = {
  light: {
    fixed_cost_per_run: 0.003,  // $0.003 per light analysis scrape
    vendor: 'apify'
  },
  deep: {
    fixed_cost_per_run: 0.003,  // Same scraping cost (same posts_limit for now)
    vendor: 'apify'
  }
};

// ===============================================================================
// 4. CREDIT REVENUE PRICING
// ===============================================================================

/**
 * Credit pricing for revenue/margin calculations.
 * Bulk discounts are handled in Supabase/billing logic.
 */
export const CREDIT_REVENUE = {
  /** Base price per credit (USD) */
  per_credit_usd: 0.97
};

// ===============================================================================
// 5. SCRAPER CONFIGURATION
// ===============================================================================

/**
 * Scraper configuration - actor IDs, timeouts, retries.
 */
export const SCRAPER_CONFIG: ScraperConfig = {
  name: 'dS_basic',
  actor_id: 'dSCLg0C3YEZ83HzYX',
  timeout_ms: 60000,      // 60 seconds
  max_retries: 3,
  retry_delay_ms: 2000    // 2 seconds
};

// ===============================================================================
// 6. HELPER FUNCTIONS
// ===============================================================================

/**
 * Calculate AI cost for a completed call
 */
export function calculateAICost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = AI_MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`[Pricing] Unknown model: ${model}, cost set to 0`);
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.per_1m_input;
  const outputCost = (outputTokens / 1_000_000) * pricing.per_1m_output;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Get scraping cost for an analysis type
 */
export function getScrapingCost(analysisType: AnalysisType): number {
  return SCRAPING_PRICING[analysisType].fixed_cost_per_run;
}

/**
 * Get credit cost for an analysis type
 */
export function getCreditCost(analysisType: AnalysisType): number {
  return ANALYSIS_CONFIG[analysisType].credit_cost;
}

/**
 * Get posts limit for an analysis type
 */
export function getPostsLimit(analysisType: AnalysisType): number {
  return ANALYSIS_CONFIG[analysisType].posts_limit;
}

/**
 * Get AI model for an analysis type
 */
export function getAIModel(analysisType: AnalysisType): string {
  return ANALYSIS_CONFIG[analysisType].ai_model;
}

/**
 * Get AI max tokens for an analysis type
 */
export function getAIMaxTokens(analysisType: AnalysisType): number {
  return ANALYSIS_CONFIG[analysisType].ai_max_tokens;
}

/**
 * Get AI model pricing
 */
export function getAIModelPricing(model: string): AIModelPricing | null {
  return AI_MODEL_PRICING[model] || null;
}

/**
 * Get the credit type for an analysis type
 * Used for routing to the correct credit balance column
 */
export function getCreditType(analysisType: AnalysisType): CreditType {
  return ANALYSIS_TO_CREDIT_TYPE[analysisType];
}

/**
 * Get prompt configuration for an analysis type
 */
export function getPromptConfig(analysisType: AnalysisType): {
  summary_sentences: string;
  caption_truncate_length: number;
} {
  return ANALYSIS_CONFIG[analysisType].prompt;
}

/**
 * Get estimated total duration for an analysis type (in seconds)
 */
export function getEstimatedDuration(analysisType: AnalysisType): number {
  const timing = ANALYSIS_CONFIG[analysisType].timing;
  return timing.setup + timing.scraping + timing.ai_analysis + timing.teardown;
}

/**
 * Calculate profit margin for an analysis
 */
export function calculateMargin(
  analysisType: AnalysisType,
  totalCostUsd: number
): {
  revenue_usd: number;
  cost_usd: number;
  profit_usd: number;
  margin_percent: number;
} {
  const creditCost = getCreditCost(analysisType);
  const revenue = creditCost * CREDIT_REVENUE.per_credit_usd;
  const profit = revenue - totalCostUsd;
  const marginPercent = revenue > 0 ? (profit / revenue) * 100 : 0;

  return {
    revenue_usd: parseFloat(revenue.toFixed(4)),
    cost_usd: parseFloat(totalCostUsd.toFixed(6)),
    profit_usd: parseFloat(profit.toFixed(4)),
    margin_percent: parseFloat(marginPercent.toFixed(2))
  };
}

/**
 * Build operations ledger metrics object
 * This is the standard format for the operations_ledger.metrics JSONB column
 */
export function buildOperationsMetrics(data: {
  analysisType: AnalysisType;
  aiCost: number;
  aiModel: string;
  tokensIn: number;
  tokensOut: number;
  cacheHit: boolean;
  timing: {
    cache_check: number;
    scraping?: number;
    ai_analysis: number;
    db_upsert: number;
    total_ms: number;
  };
}): {
  cost: {
    total_usd: number;
    items: {
      ai: {
        vendor: AIProvider;
        usd: number;
        model: string;
        tokens_in: number;
        tokens_out: number;
      };
      scraping: {
        vendor: ScrapingVendor;
        usd: number;
        cached: boolean;
        actor: string;
      };
    };
  };
  duration: {
    total_ms: number;
    steps: {
      cache_check: number;
      cache_hit: boolean;
      scraping?: number;
      ai_analysis: number;
      db_upsert: number;
    };
  };
} {
  const scrapingCost = data.cacheHit ? 0 : getScrapingCost(data.analysisType);
  const aiPricing = getAIModelPricing(data.aiModel);

  return {
    cost: {
      total_usd: parseFloat((scrapingCost + data.aiCost).toFixed(6)),
      items: {
        ai: {
          vendor: aiPricing?.provider || 'openai',
          usd: data.aiCost,
          model: data.aiModel,
          tokens_in: data.tokensIn,
          tokens_out: data.tokensOut
        },
        scraping: {
          vendor: 'apify',
          usd: scrapingCost,
          cached: data.cacheHit,
          actor: SCRAPER_CONFIG.actor_id
        }
      }
    },
    duration: {
      total_ms: data.timing.total_ms,
      steps: {
        cache_check: data.timing.cache_check,
        cache_hit: data.cacheHit,
        ...(data.timing.scraping !== undefined && data.timing.scraping > 0
          ? { scraping: data.timing.scraping }
          : {}),
        ai_analysis: data.timing.ai_analysis,
        db_upsert: data.timing.db_upsert
      }
    }
  };
}
