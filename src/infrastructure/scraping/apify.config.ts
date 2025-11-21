// infrastructure/scraping/apify.config.ts

/**
 * APIFY SCRAPER CONFIGURATION
 *
 * Currently using single scraper (ds_basic).
 * Future: Can add multiple scrapers for fallback or different channels (Brightdata, etc)
 */

export interface ScraperConfig {
  name: string;
  actor_id: string;
  timeout: number;
  max_retries: number;
  retry_delay: number;
}

/**
 * PRIMARY SCRAPER CONFIGURATION
 * Updated: 2025-01-20
 */
export const SCRAPER_CONFIG: ScraperConfig = {
  name: 'dS_basic',
  actor_id: 'dSCLg0C3YEZ83HzYX',
  timeout: 60000,      // 60 seconds
  max_retries: 3,
  retry_delay: 2000    // 2 seconds
};

/**
 * Calculate Apify cost from duration
 * Apify charges $0.25 per compute unit (1 CU = 1 hour)
 */
export function calculateApifyCost(durationMs: number): number {
  const computeUnits = durationMs / (1000 * 60 * 60);  // ms to hours
  const cost = computeUnits * 0.25;
  return parseFloat(cost.toFixed(6));
}
