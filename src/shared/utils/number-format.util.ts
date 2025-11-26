// src/shared/utils/number-format.util.ts

/**
 * CENTRALIZED NUMBER FORMATTING UTILITY
 *
 * Provides consistent number formatting across the entire codebase.
 * Use the appropriate context to ensure consistent display everywhere:
 *
 * - 'storage': Raw number for database storage
 * - 'display': Abbreviated with proper rounding (6,550,041 → "6.6M")
 * - 'ai': Exact with locale formatting for AI prompts (6,550,041 → "6,550,041")
 * - 'log': Raw number for debugging
 *
 * Rounding Rules:
 * - Uses standard rounding (round half up)
 * - 1 decimal place for M (millions)
 * - 1 decimal place for K (thousands)
 * - Whole numbers below 1K
 */

export type FormatContext = 'storage' | 'display' | 'ai' | 'log';

/**
 * Format a follower/number count based on context
 *
 * @param count - The raw number
 * @param context - Where the number will be used
 * @returns Formatted string or raw number
 *
 * @example
 * formatCount(6550041, 'storage')  // 6550041 (raw number)
 * formatCount(6550041, 'display')  // "6.6M"
 * formatCount(6550041, 'ai')       // "6,550,041"
 * formatCount(6550041, 'log')      // 6550041 (raw number)
 */
export function formatCount(
  count: number | null | undefined,
  context: FormatContext
): string | number {
  if (count === null || count === undefined) {
    return context === 'storage' || context === 'log' ? 0 : 'N/A';
  }

  switch (context) {
    case 'storage':
    case 'log':
      return count; // Always store/log exact number

    case 'display':
      return formatAbbreviated(count, 1); // 6,550,041 → "6.6M"

    case 'ai':
      return count.toLocaleString(); // 6,550,041 → "6,550,041" (exact for AI)

    default:
      return count;
  }
}

/**
 * Format number with K/M suffix and proper rounding
 *
 * Uses standard rounding (round half up):
 * - 6,550,041 → "6.6M" (rounds up from 6.55)
 * - 6,449,999 → "6.4M" (rounds down from 6.449...)
 * - 45,300 → "45.3K"
 * - 999 → "999"
 *
 * @param num - The number to format
 * @param decimals - Number of decimal places (default 1)
 */
export function formatAbbreviated(num: number, decimals: number = 1): string {
  if (num === null || num === undefined) return 'N/A';

  if (num >= 1_000_000) {
    // Use standard rounding (toFixed does round half up)
    return `${(num / 1_000_000).toFixed(decimals)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(decimals)}K`;
  }
  return num.toString();
}

/**
 * Format percentage with smart decimal handling
 *
 * - Value = 0: "0%"
 * - Values < 0.01%: "<0.01%"
 * - Values < 1%: 2 decimals (e.g., "0.14%")
 * - Values < 10%: 1 decimal (e.g., "7.1%")
 * - Values >= 10%: whole number (e.g., "12%")
 */
export function formatPercentage(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  if (value === 0) return '0%';
  if (value < 0.01) return '<0.01%';
  if (value < 1) return `${value.toFixed(2)}%`;
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

/**
 * Format currency with proper decimals
 *
 * @param amount - Amount in dollars
 * @param decimals - Decimal places (default 2 for display, 6 for cost tracking)
 */
export function formatCurrency(amount: number, decimals: number = 2): string {
  return `$${amount.toFixed(decimals)}`;
}

/**
 * Format duration in human-readable format
 *
 * @param ms - Duration in milliseconds
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Safe number getter - returns default if null/undefined/NaN
 */
export function safeNumber(
  value: number | null | undefined,
  defaultValue: number = 0
): number {
  if (value === null || value === undefined || isNaN(value)) {
    return defaultValue;
  }
  return value;
}

/**
 * Clamp a value between min and max
 */
export function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to specified decimal places
 */
export function round(value: number, decimals: number = 2): number {
  return Number(value.toFixed(decimals));
}
