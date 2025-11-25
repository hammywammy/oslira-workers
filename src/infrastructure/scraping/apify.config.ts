// infrastructure/scraping/apify.config.ts

/**
 * @deprecated This file is deprecated. Use centralized config instead:
 * import { SCRAPER_CONFIG, getScrapingCost } from '@/config/operations-pricing.config';
 *
 * This file re-exports for backward compatibility only.
 */

// Re-export from centralized config for backward compatibility
export { SCRAPER_CONFIG } from '@/config/operations-pricing.config';

// Legacy interface kept for type compatibility
export interface ScraperConfig {
  name: string;
  actor_id: string;
  timeout: number;
  max_retries: number;
  retry_delay: number;
}

/**
 * @deprecated Use getScrapingCost() from centralized config instead.
 * Apify costs are now fixed per-run, not calculated from duration.
 */
export function calculateApifyCost(durationMs: number): number {
  console.warn('[DEPRECATED] calculateApifyCost() is deprecated. Use getScrapingCost() from @/config/operations-pricing.config');
  // Return fixed cost regardless of duration - Apify costs are untrackable
  const { getScrapingCost } = require('@/config/operations-pricing.config');
  return getScrapingCost('light');
}
