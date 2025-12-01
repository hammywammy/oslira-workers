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
import { logger } from '@/shared/utils/logger.util';

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
  const auth = getAuthContext(c);
  const accountId = auth.accountId;

  try {
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

    // Determine environment-specific Stripe IDs
    const isProduction = c.env.APP_ENV === 'production';

    return successResponse(c, {
      id: subscription.id,
      accountId: subscription.account_id,
      tier: subscription.plan_type,
      status: subscription.status,
      stripeSubscriptionId: isProduction
        ? subscription.stripe_subscription_id_live
        : subscription.stripe_subscription_id_test,
      stripeCustomerId: isProduction
        ? subscription.stripe_customer_id_live
        : subscription.stripe_customer_id_test,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      creditsRemaining: balance?.credit_balance ?? 0,
      lightRemaining: balance?.light_analyses_balance ?? 0,
      createdAt: subscription.created_at,
      updatedAt: subscription.updated_at,
    });

  } catch (error) {
    logger.error('Failed to get subscription', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      accountId
    });
    return errorResponse(c, 'Failed to get subscription', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/billing/upgrade
 * Create Stripe Checkout session for subscription upgrade
 */
export async function createUpgradeCheckout(c: Context<{ Bindings: Env }>) {
  const auth = getAuthContext(c);
  const accountId = auth.accountId;

  try {
    // Validate request
    const body = await c.req.json();
    const { newTier } = validateBody(UpgradeSchema, body);

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    // Determine environment-specific customer ID column
    const isProduction = c.env.APP_ENV === 'production';

    // Get current subscription
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select(`plan_type, stripe_customer_id_test, stripe_customer_id_live`)
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

    // Get environment-specific customer ID
    let stripeCustomerId = isProduction
      ? subscription.stripe_customer_id_live
      : subscription.stripe_customer_id_test;

    if (!stripeCustomerId) {
      const { data: account } = await supabase
        .from('accounts')
        .select('stripe_customer_id_test, stripe_customer_id_live')
        .eq('id', accountId)
        .single();

      stripeCustomerId = isProduction
        ? account?.stripe_customer_id_live
        : account?.stripe_customer_id_test;
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

    logger.info('Checkout session created for upgrade', {
      sessionId: session.id,
      accountId,
      fromTier: subscription.plan_type,
      toTier: newTier
    });

    return successResponse(c, {
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });

  } catch (error) {
    logger.error('Failed to create upgrade checkout session', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      accountId
    });

    if (error instanceof Error && error.name === 'ZodError') {
      return errorResponse(c, 'Invalid request', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to create checkout session', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/webhooks/stripe
 * Receive and queue Stripe webhook events
 *
 * Authentication: Stripe signature verification (no auth middleware)
 * Rate limit: WEBHOOK_RATE_LIMITS.STRIPE (100/min)
 *
 * CRITICAL: Uses constructEventAsync() for Cloudflare Workers compatibility
 */
export async function handleStripeWebhook(c: Context<{ Bindings: Env }>) {
  logger.info('Stripe webhook received');

  try {
    // Fetch secrets
    const stripeKey = await getSecret('STRIPE_SECRET_KEY', c.env, c.env.APP_ENV);
    const webhookSecret = await getSecret('STRIPE_WEBHOOK_SECRET', c.env, c.env.APP_ENV);

    const stripe = new Stripe(stripeKey, {
      apiVersion: '2024-12-18.acacia'
    });

    // Get signature header
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      logger.error('Stripe webhook missing signature header');
      return c.json({ error: 'Missing signature' }, 400);
    }

    // Get raw body (Stripe needs exact bytes for signature verification)
    const body = await c.req.text();

    // Verify signature - USE ASYNC VERSION FOR CLOUDFLARE WORKERS
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret
      );
    } catch (err) {
      logger.error('Stripe webhook signature verification failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      return c.json({ error: 'Invalid signature' }, 400);
    }

    logger.info('Stripe webhook event verified', {
      eventType: event.type,
      eventId: event.id
    });

    // Extract metadata
    const eventObject = event.data.object as any;
    const accountId = eventObject.metadata?.account_id || null;
    const customerId = eventObject.customer || null;

    logger.info('Stripe webhook event details', {
      eventType: event.type,
      accountId,
      customerId,
      mode: eventObject.mode
    });

    // Queue event for async processing
    try {
      await c.env.STRIPE_WEBHOOK_QUEUE.send({
        event_id: event.id,
        event_type: event.type,
        customer_id: customerId,
        account_id: accountId,
        payload: eventObject,
        received_at: new Date().toISOString(),
      });

      logger.info('Stripe webhook event queued for processing', {
        eventId: event.id,
        eventType: event.type,
        accountId
      });
    } catch (queueError) {
      logger.error('Failed to queue Stripe webhook event', {
        error: queueError instanceof Error ? queueError.message : String(queueError),
        eventId: event.id,
        eventType: event.type
      });
      // Return 500 so Stripe retries
      return c.json({ error: 'Failed to queue webhook' }, 500);
    }

    // Return 200 immediately - processing happens async in queue consumer
    return c.json({ received: true, event_id: event.id });

  } catch (error) {
    logger.error('Unexpected error in Stripe webhook handler', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
}
