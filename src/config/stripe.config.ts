// src/config/stripe.config.ts

/**
 * STRIPE CONFIGURATION
 * Maps internal tier names to Stripe Price IDs
 *
 * SANDBOX Price IDs (test mode)
 * Replace with production IDs when going live
 */

// =============================================================================
// TYPES
// =============================================================================

export type TierName = 'free' | 'growth' | 'pro' | 'agency' | 'enterprise';

// =============================================================================
// STRIPE PRICE IDS
// =============================================================================

export const STRIPE_PRICE_IDS: Record<Exclude<TierName, 'free'>, string> = {
  growth: 'price_1SW21iFZyrcdK01tvTZ0ZbyJ',
  pro: 'price_1SW21tFZyrcdK01tVR91V4nW',
  agency: 'price_1SW220FZyrcdK01tja6a58UH',
  enterprise: 'price_1SW225FZyrcdK01tL0zd8t3A',
};

// =============================================================================
// REDIRECT URLS
// =============================================================================

export const STRIPE_CONFIG = {
  // Redirect URLs after checkout
  successUrl: 'https://app.oslira.com/upgrade?success=true&session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.oslira.com/upgrade?canceled=true',

  // Webhook endpoint
  webhookPath: '/api/webhooks/stripe',
};

// =============================================================================
// TIER UTILITIES
// =============================================================================

/**
 * Get Stripe Price ID for tier
 * @throws Error if tier is 'free' (no Stripe price)
 */
export function getStripePriceId(tier: TierName): string {
  if (tier === 'free') {
    throw new Error('Free tier has no Stripe price');
  }
  return STRIPE_PRICE_IDS[tier];
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
