/**
 * STRIPE CONFIGURATION
 * Maps internal tier names to Stripe Price IDs
 *
 * Separate configs for staging (test mode) and production (live mode)
 */

export type TierName = 'free' | 'growth' | 'pro' | 'agency' | 'enterprise';
export type AppEnvironment = 'staging' | 'production';

/** Stripe Price IDs for staging (test mode) */
const STAGING_PRICE_IDS: Record<Exclude<TierName, 'free'>, string> = {
  growth: 'price_1SW21iFZyrcdK01tvTZ0ZbyJ',
  pro: 'price_1SW21tFZyrcdK01tVR91V4nW',
  agency: 'price_1SW220FZyrcdK01tja6a58UH',
  enterprise: 'price_1SW225FZyrcdK01tL0zd8t3A',
};

/** Stripe Price IDs for production (live mode) */
const PRODUCTION_PRICE_IDS: Record<Exclude<TierName, 'free'>, string> = {
  growth: 'price_1SW4DhJzvcRSqGG3560s1ZZG',
  pro: 'price_1SW4DgJzvcRSqGG3H2TvVGMK',
  agency: 'price_1SW4DeJzvcRSqGG3r6WDNhU6',
  enterprise: 'price_1SW4DbJzvcRSqGG3gcMITfUW',
};

export interface StripeConfig {
  priceIds: Record<Exclude<TierName, 'free'>, string>;
  successUrl: string;
  cancelUrl: string;
  webhookPath: string;
}

/**
 * Get environment-specific Stripe configuration
 */
export function getStripeConfig(appEnv: AppEnvironment): StripeConfig {
  const isProduction = appEnv === 'production';
  const baseUrl = isProduction ? 'https://app.oslira.com' : 'https://staging-app.oslira.com';
  const priceIds = isProduction ? PRODUCTION_PRICE_IDS : STAGING_PRICE_IDS;

  return {
    priceIds,
    successUrl: `${baseUrl}/upgrade?success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/upgrade?canceled=true`,
    webhookPath: '/api/webhooks/stripe',
  };
}

/**
 * Get Stripe Price ID for tier
 * @throws Error if tier is 'free' (no Stripe price)
 */
export function getStripePriceId(tier: TierName, appEnv: AppEnvironment): string {
  if (tier === 'free') {
    throw new Error('Free tier has no Stripe price');
  }
  const config = getStripeConfig(appEnv);
  return config.priceIds[tier];
}

/**
 * Get tier order for upgrade validation
 * Higher number = higher tier
 */
export function getTierOrder(tier: TierName): number {
  const tierOrder: Record<TierName, number> = {
    free: 0,
    growth: 1,
    pro: 2,
    agency: 3,
    enterprise: 4,
  };

  return tierOrder[tier] ?? 0;
}

/**
 * Validate if upgrade is allowed (can't downgrade)
 */
export function isValidUpgrade(fromTier: TierName, toTier: TierName): boolean {
  return getTierOrder(toTier) > getTierOrder(fromTier);
}
