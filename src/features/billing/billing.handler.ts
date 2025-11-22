// src/features/billing/billing.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { getSecret } from '@/infrastructure/config/secrets';
import { getStripePriceId, getTierOrder, getStripeConfig, type TierName } from '@/config/stripe.config';
import { z } from 'zod';
import Stripe from 'stripe';

// =============================================================================
// SCHEMAS
// =============================================================================

const UpgradeSchema = z.object({
  newTier: z.enum(['growth', 'pro', 'agency', 'enterprise']),
});

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * GET /api/billing/subscription
 * Get current subscription for authenticated user
 */
export async function getSubscription(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    // Get subscription with balance
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (subError || !subscription) {
      return errorResponse(c, 'Subscription not found', 'NOT_FOUND', 404);
    }

    // Get current balance
    const { data: balance } = await supabase
      .from('balances')
      .select('credit_balance, light_analyses_balance')
      .eq('account_id', accountId)
      .single();

    return successResponse(c, {
      id: subscription.id,
      accountId: subscription.account_id,
      tier: subscription.plan_type,
      status: subscription.status,
      stripeSubscriptionId: subscription.stripe_subscription_id,
      stripeCustomerId: subscription.stripe_customer_id,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      creditsRemaining: balance?.credit_balance ?? 0,
      lightRemaining: balance?.light_analyses_balance ?? 0,
      createdAt: subscription.created_at,
      updatedAt: subscription.updated_at,
    });

  } catch (error: any) {
    console.error('[GetSubscription] Error:', error);
    return errorResponse(c, 'Failed to get subscription', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/billing/upgrade
 * Create Stripe Checkout session for subscription upgrade
 */
export async function createUpgradeCheckout(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;

    // Validate request
    const body = await c.req.json();
    const { newTier } = validateBody(UpgradeSchema, body);

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    // Get current subscription
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('plan_type, stripe_customer_id')
      .eq('account_id', accountId)
      .single();

    if (subError || !subscription) {
      return errorResponse(c, 'Subscription not found', 'NOT_FOUND', 404);
    }

    // Validate upgrade (can't downgrade via this endpoint)
    const currentTierOrder = getTierOrder(subscription.plan_type as TierName);
    const newTierOrder = getTierOrder(newTier);

    if (newTierOrder <= currentTierOrder) {
      return errorResponse(
        c,
        'Cannot downgrade via upgrade endpoint. Contact support for downgrades.',
        'INVALID_UPGRADE',
        400
      );
    }

    // Get stripe_customer_id from accounts table if not on subscription
    let stripeCustomerId = subscription.stripe_customer_id;

    if (!stripeCustomerId) {
      const { data: account } = await supabase
        .from('accounts')
        .select('stripe_customer_id')
        .eq('id', accountId)
        .single();

      stripeCustomerId = account?.stripe_customer_id;
    }

    if (!stripeCustomerId) {
      return errorResponse(
        c,
        'No Stripe customer found. Please contact support.',
        'NO_STRIPE_CUSTOMER',
        400
      );
    }

    // Initialize Stripe
    const stripeKey = await getSecret('STRIPE_SECRET_KEY', c.env, c.env.APP_ENV);
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' });

    // Get environment-specific Stripe configuration
    const stripeConfig = getStripeConfig(c.env.APP_ENV as 'staging' | 'production');
    const priceId = getStripePriceId(newTier, c.env.APP_ENV as 'staging' | 'production');

    // Create Checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: stripeConfig.successUrl,
      cancel_url: stripeConfig.cancelUrl,
      metadata: {
        account_id: accountId,
        new_tier: newTier,
        previous_tier: subscription.plan_type,
      },
      subscription_data: {
        metadata: {
          account_id: accountId,
          tier: newTier,
        },
      },
      // Allow promotion codes
      allow_promotion_codes: true,
    });

    console.log('[Upgrade] Checkout session created', {
      session_id: session.id,
      account_id: accountId,
      from_tier: subscription.plan_type,
      to_tier: newTier,
    });

    return successResponse(c, {
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });

  } catch (error: any) {
    console.error('[CreateUpgradeCheckout] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid request', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to create checkout session', 'INTERNAL_ERROR', 500);
  }
}
