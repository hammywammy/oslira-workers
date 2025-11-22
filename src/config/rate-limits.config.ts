// src/config/rate-limits.config.ts

/**
 * RATE LIMITING CONFIGURATION - SINGLE SOURCE OF TRUTH
 *
 * All rate limit settings in one place for easy tuning.
 * Used by rate-limit.middleware.ts across all routes.
 *
 * NAMING CONVENTION:
 * - requests: Maximum requests allowed in window
 * - windowSeconds: Time window in seconds
 *
 * TUNING GUIDE:
 * - Auth endpoints: Moderate (prevent brute force, allow retries)
 * - API endpoints: Standard (60/min is industry standard)
 * - Webhooks: Strict (external sources, potential abuse)
 * - Analysis: Credit-based (already limited by credits)
 */

export interface RateLimitConfig {
  requests: number;
  windowSeconds: number;
}

// =============================================================================
// AUTH RATE LIMITS
// =============================================================================

export const AUTH_RATE_LIMITS = {
  /**
   * Google OAuth callback
   * - Users may retry if page doesn't load
   * - Browser refreshes during OAuth
   * - Multiple devices signing in
   */
  OAUTH_CALLBACK: {
    requests: 20,
    windowSeconds: 60, // 20 per minute (was 10 per 10 min - too strict)
  },

  /**
   * Token refresh
   * - Called automatically by frontend
   * - Multiple tabs = multiple refreshes
   * - Should be generous
   */
  TOKEN_REFRESH: {
    requests: 60,
    windowSeconds: 3600, // 60 per hour (was 30 - doubled)
  },

  /**
   * Logout
   * - Should always work
   * - No abuse vector
   */
  LOGOUT: {
    requests: 30,
    windowSeconds: 60, // 30 per minute
  },

  /**
   * Session check
   * - Called on page load
   * - Multiple tabs
   */
  SESSION: {
    requests: 60,
    windowSeconds: 60, // 60 per minute
  },
} as const;

// =============================================================================
// API RATE LIMITS
// =============================================================================

export const API_RATE_LIMITS = {
  /**
   * General API endpoints
   * - Standard CRUD operations
   * - Industry standard: 60/min
   */
  GENERAL: {
    requests: 60,
    windowSeconds: 60,
  },

  /**
   * Read-heavy endpoints (listings, searches)
   * - More lenient for browsing
   */
  READ: {
    requests: 120,
    windowSeconds: 60, // 120 per minute
  },

  /**
   * Write endpoints (create, update, delete)
   * - Slightly stricter
   */
  WRITE: {
    requests: 30,
    windowSeconds: 60, // 30 per minute
  },

  /**
   * Public endpoints (no auth)
   * - Pricing calculator, etc.
   */
  PUBLIC: {
    requests: 30,
    windowSeconds: 60, // 30 per minute
  },
} as const;

// =============================================================================
// ANALYSIS RATE LIMITS
// =============================================================================

export const ANALYSIS_RATE_LIMITS = {
  /**
   * Single analysis creation
   * - Already limited by credits
   * - Rate limit is backup protection
   */
  CREATE: {
    requests: 30,
    windowSeconds: 3600, // 30 per hour
  },

  /**
   * Bulk analysis
   * - Heavy operation
   * - Strict limit
   */
  BULK: {
    requests: 10,
    windowSeconds: 3600, // 10 per hour
  },

  /**
   * Analysis progress/status checks
   * - Polling endpoint
   * - Generous for UX
   */
  PROGRESS: {
    requests: 300,
    windowSeconds: 60, // 300 per minute (5/sec)
  },

  /**
   * Anonymous/unauthenticated analysis
   * - Demo purposes
   * - Very strict
   */
  ANONYMOUS: {
    requests: 5,
    windowSeconds: 3600, // 5 per hour
  },
} as const;

// =============================================================================
// WEBHOOK RATE LIMITS
// =============================================================================

export const WEBHOOK_RATE_LIMITS = {
  /**
   * Stripe webhooks
   * - External source
   * - Should be generous (Stripe retries)
   */
  STRIPE: {
    requests: 100,
    windowSeconds: 60, // 100 per minute
  },

  /**
   * Generic webhooks
   * - Unknown sources
   * - Moderate protection
   */
  GENERIC: {
    requests: 30,
    windowSeconds: 60, // 30 per minute
  },
} as const;

// =============================================================================
// BILLING RATE LIMITS
// =============================================================================

export const BILLING_RATE_LIMITS = {
  /**
   * Subscription read
   */
  READ: {
    requests: 30,
    windowSeconds: 60,
  },

  /**
   * Upgrade/checkout creation
   * - Sensitive operation
   * - Moderate limit
   */
  UPGRADE: {
    requests: 10,
    windowSeconds: 3600, // 10 per hour
  },

  /**
   * Credit purchase
   * - Financial operation
   * - Moderate limit
   */
  PURCHASE: {
    requests: 10,
    windowSeconds: 3600, // 10 per hour
  },
} as const;

// =============================================================================
// LEGACY EXPORT (for backward compatibility)
// =============================================================================

/**
 * @deprecated Use specific rate limit configs instead
 * Kept for backward compatibility during migration
 */
export const RATE_LIMITS = {
  // Auth
  AUTH: AUTH_RATE_LIMITS.OAUTH_CALLBACK,
  TOKEN_REFRESH: AUTH_RATE_LIMITS.TOKEN_REFRESH,

  // API
  API_GENERAL: API_RATE_LIMITS.GENERAL,

  // Analysis
  ANALYSIS: ANALYSIS_RATE_LIMITS.PROGRESS,
  ANALYSIS_CREATE: ANALYSIS_RATE_LIMITS.CREATE,
  ANONYMOUS_ANALYSIS: ANALYSIS_RATE_LIMITS.ANONYMOUS,

  // Webhooks
  WEBHOOK: WEBHOOK_RATE_LIMITS.GENERIC,
} as const;
