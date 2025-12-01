/**
 * SECRET KEY CONSTANTS
 *
 * Centralized constants for all secret key names used with getSecret().
 * Prevents typos and enables IDE autocomplete.
 *
 * Usage:
 * ```typescript
 * import { SECRET_KEYS } from '@/config/secrets.constants';
 * const apiKey = await getSecret(SECRET_KEYS.OPENAI_API_KEY, env, env.APP_ENV);
 * ```
 */

export const SECRET_KEYS = {
  // AI Provider Keys
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  CLOUDFLARE_AI_GATEWAY_TOKEN: 'CLOUDFLARE_AI_GATEWAY_TOKEN',

  // Payment Processing
  STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',

  // Scraping
  APIFY_API_TOKEN: 'APIFY_API_TOKEN',

  // Database
  SUPABASE_URL: 'SUPABASE_URL',
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  SUPABASE_SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',

  // Authentication
  JWT_SECRET: 'JWT_SECRET',
  GOOGLE_OAUTH: 'GOOGLE_OAUTH',

  // Monitoring
  SENTRY_DSN: 'SENTRY_DSN'
} as const;

/**
 * Type for secret key names (enables type checking)
 */
export type SecretKeyName = typeof SECRET_KEYS[keyof typeof SECRET_KEYS];
