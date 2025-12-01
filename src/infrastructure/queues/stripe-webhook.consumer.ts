// infrastructure/queues/stripe-webhook.consumer.ts

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import Stripe from 'stripe';
import { getSecret } from '@/infrastructure/config/secrets';
import { SECRET_KEYS } from '@/config/secrets.constants';
import { logger } from '@/shared/utils/logger.util';

/**
 * STRIPE WEBHOOK CONSUMER
 * 
 * Processes Stripe webhook events from queue
 * Queue ensures idempotency and retry logic for failed webhooks
 * 
 * Events handled:
 * - checkout.session.completed → Grant initial credits
 * - invoice.payment_succeeded → Grant subscription credits
 * - customer.subscription.updated → Update subscription status
 * - customer.subscription.deleted → Cancel subscription
 */

export interface StripeWebhookMessage {
  event_id: string;
  event_type: string;
  customer_id: string;
  account_id: string;
  payload: any;
  received_at: string;
}

/**
 * Queue consumer handler
 */
export async function handleStripeWebhookQueue(
  batch: MessageBatch<StripeWebhookMessage>,
  env: Env
): Promise<void> {
  logger.info('Processing Stripe webhook batch', { batchSize: batch.messages.length });

  for (const message of batch.messages) {
    try {
      await processWebhookMessage(message, env);
      message.ack(); // Success - remove from queue
    } catch (error: any) {
      logger.error('Stripe webhook message processing failed', { error: error instanceof Error ? error.message : String(error) });
      
      // Retry logic
      if (message.attempts < 3) {
        message.retry(); // Retry with exponential backoff
      } else {
        logger.error('Max retries exceeded for Stripe webhook message');
        message.ack(); // Remove from queue (would send to Dead Letter Queue in production)
      }
    }
  }
}

/**
 * Process individual webhook message
 */
async function processWebhookMessage(
  message: Message<StripeWebhookMessage>,
  env: Env
): Promise<void> {
  const data = message.body;

  logger.info('Processing Stripe webhook event', { eventType: data.event_type, eventId: data.event_id });

  // Check idempotency - has this event been processed?
  const supabase = await SupabaseClientFactory.createAdminClient(env);
  const { data: existing } = await supabase
    .from('webhook_events')
    .select('stripe_event_id')
    .eq('stripe_event_id', data.event_id)
    .not('processed_at', 'is', null)
    .single();

  if (existing) {
    logger.info('Event already processed, skipping', { eventId: data.event_id });
    return;
  }

  // Store webhook event
  await supabase.from('webhook_events').insert({
    stripe_event_id: data.event_id,
    event_type: data.event_type,
    account_id: data.account_id,
    payload: data.payload
  });

  // Route to appropriate handler
  switch (data.event_type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(data, env);
      break;

    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(data, env);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(data, env);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(data, env);
      break;

    default:
      logger.warn('Unhandled Stripe event type', { eventType: data.event_type });
  }

  // Mark as processed
  await supabase
    .from('webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('stripe_event_id', data.event_id);
}

/**
 * Handle checkout.session.completed
 * Handles both subscription upgrades and one-time credit purchases
 */
async function handleCheckoutCompleted(data: StripeWebhookMessage, env: Env): Promise<void> {
  const session = data.payload;
  const accountId = session.metadata?.account_id || data.account_id;

  logger.info('Checkout session completed', {
    session_id: session.id,
    account_id: accountId,
    mode: session.mode,
  });

  if (!accountId) {
    logger.error('No account_id in session metadata');
    return;
  }

  const supabase = await SupabaseClientFactory.createAdminClient(env);

  // ===============================================================================
  // HANDLE SUBSCRIPTION UPGRADES (mode: 'subscription')
  // ===============================================================================
  if (session.mode === 'subscription' && session.subscription) {
    const newTier = session.metadata?.new_tier;
    const stripeSubscriptionId = session.subscription as string;

    if (!newTier) {
      logger.error('No new_tier in session metadata');
      return;
    }

    // Fetch full subscription details from Stripe API
    const stripeKey = await getSecret(SECRET_KEYS.STRIPE_SECRET_KEY, env, env.APP_ENV);
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' });

    const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

    // Extract subscription details
    const subscriptionItem = stripeSubscription.items.data[0];
    const priceId = subscriptionItem?.price?.id || null;
    const priceCents = subscriptionItem?.price?.unit_amount || 0;
    const periodStart = new Date(stripeSubscription.current_period_start * 1000).toISOString();
    const periodEnd = new Date(stripeSubscription.current_period_end * 1000).toISOString();

    logger.info('Subscription details from Stripe', {
      subscription_id: stripeSubscriptionId,
      price_id: priceId,
      price_cents: priceCents,
      period_start: periodStart,
      period_end: periodEnd,
      new_tier: newTier,
    });

    // UPDATE 1: subscriptions table
    // Determine environment-specific subscription ID column
    const isProduction = env.APP_ENV === 'production';
    const subscriptionUpdateData: any = {
      plan_type: newTier,
      stripe_price_id: priceId,
      price_cents: priceCents,
      status: 'active',
      current_period_start: periodStart,
      current_period_end: periodEnd,
      updated_at: new Date().toISOString(),
    };

    // Write to environment-specific column
    if (isProduction) {
      subscriptionUpdateData.stripe_subscription_id_live = stripeSubscriptionId;
    } else {
      subscriptionUpdateData.stripe_subscription_id_test = stripeSubscriptionId;
    }

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update(subscriptionUpdateData)
      .eq('account_id', accountId);

    if (updateError) {
      logger.error('Failed to update subscriptions table', { error: updateError });
      throw updateError;
    }

    logger.info('Subscriptions table updated');

    // UPDATE 2: balances table (get quotas from plans table)
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('credits_per_month, light_analyses_per_month')
      .ilike('name', newTier)
      .single();

    if (planError || !plan) {
      logger.error('Failed to fetch plan details', { error: planError });
      throw new Error(`Plan not found: ${newTier}`);
    }

    const creditsQuota = plan.credits_per_month;
    const lightQuota = plan.light_analyses_per_month;

    const { error: balanceError } = await supabase
      .from('balances')
      .update({
        credit_balance: creditsQuota,
        light_analyses_balance: lightQuota,
        last_transaction_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);

    if (balanceError) {
      logger.error('Failed to update balances table', { error: balanceError });
      throw balanceError;
    }

    logger.info('Balances table updated', {
      credit_balance: creditsQuota,
      light_analyses_balance: lightQuota,
    });

    logger.info('Account upgraded successfully', { accountId, newTier });
  }

  // ===============================================================================
  // HANDLE ONE-TIME CREDIT PURCHASES (mode: 'payment')
  // ===============================================================================
  const creditsAmount = session.metadata?.credits_amount;
  if (creditsAmount && parseInt(creditsAmount) > 0) {
    const creditsRepo = new CreditsRepository(supabase);
    await creditsRepo.addCredits(
      accountId,
      parseInt(creditsAmount),
      'purchase',
      `Credit purchase via Stripe: ${session.id}`
    );
    logger.info('Credits granted', { accountId, credits: creditsAmount });
  }
}

/**
 * Handle invoice.payment_succeeded
 * Grant monthly subscription credits
 */
async function handleInvoicePaymentSucceeded(data: StripeWebhookMessage, env: Env): Promise<void> {
  const invoice = data.payload;
  const accountId = data.account_id;
  
  // Only process subscription invoices (not one-time purchases)
  if (invoice.subscription) {
    const subscriptionId = invoice.subscription;

    const supabase = await SupabaseClientFactory.createAdminClient(env);

    // Determine environment-specific column for subscription ID lookup
    const isProduction = env.APP_ENV === 'production';
    const subscriptionIdColumn = isProduction ? 'stripe_subscription_id_live' : 'stripe_subscription_id_test';

    // Get subscription with plan details
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(`
        plan_type,
        plans!inner(
          credits_per_month,
          light_analyses_per_month
        )
      `)
      .eq(subscriptionIdColumn, subscriptionId)
      .eq('status', 'active')
      .single();

    if (error || !subscription) {
      logger.error('Subscription not found', { error });
      return;
    }

    const plan = subscription.plans as any;
    const creditsQuota = plan.credits_per_month as number;
    const lightQuota = plan.light_analyses_per_month as number;

    // Reset balances (monthly renewal via Stripe invoice)
    await supabase
      .from('balances')
      .update({
        credit_balance: creditsQuota,
        light_analyses_balance: lightQuota,
        last_transaction_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('account_id', accountId);

    // Update subscription period dates
    await supabase
      .from('subscriptions')
      .update({
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq(subscriptionIdColumn, subscriptionId);

    logger.info(
      `[StripeWebhook] Reset balances for ${accountId} (${subscription.plan_type}): ` +
      `${creditsQuota} credits + ${lightQuota} light analyses`
    );
  }
}

/**
 * Handle customer.subscription.updated
 */
async function handleSubscriptionUpdated(data: StripeWebhookMessage, env: Env): Promise<void> {
  const subscription = data.payload;
  const accountId = data.account_id;

  const supabase = await SupabaseClientFactory.createAdminClient(env);

  // Determine environment-specific column for subscription ID lookup
  const isProduction = env.APP_ENV === 'production';
  const subscriptionIdColumn = isProduction ? 'stripe_subscription_id_live' : 'stripe_subscription_id_test';

  // Build update object with safe date conversions
  const updateData: any = {
    status: subscription.status,
    updated_at: new Date().toISOString()
  };

  // Only update dates if they exist (avoid "Invalid time value" errors)
  if (subscription.current_period_start) {
    updateData.current_period_start = new Date(subscription.current_period_start * 1000).toISOString();
  }

  if (subscription.current_period_end) {
    updateData.current_period_end = new Date(subscription.current_period_end * 1000).toISOString();
  }

  if (subscription.canceled_at) {
    updateData.canceled_at = new Date(subscription.canceled_at * 1000).toISOString();
  }

  await supabase
    .from('subscriptions')
    .update(updateData)
    .eq(subscriptionIdColumn, subscription.id)
    .eq('account_id', accountId);

  logger.info(`[StripeWebhook] Updated subscription ${subscription.id} status to ${subscription.status}`);
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(data: StripeWebhookMessage, env: Env): Promise<void> {
  const subscription = data.payload;
  const accountId = data.account_id;

  const supabase = await SupabaseClientFactory.createAdminClient(env);

  // Determine environment-specific column for subscription ID lookup
  const isProduction = env.APP_ENV === 'production';
  const subscriptionIdColumn = isProduction ? 'stripe_subscription_id_live' : 'stripe_subscription_id_test';

  await supabase
    .from('subscriptions')
    .update({
      status: 'cancelled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq(subscriptionIdColumn, subscription.id)
    .eq('account_id', accountId);

  logger.info(`[StripeWebhook] Cancelled subscription ${subscription.id}`);
}

/**
 * Default export for queue binding
 */
export default {
  async queue(batch: MessageBatch<StripeWebhookMessage>, env: Env): Promise<void> {
    return handleStripeWebhookQueue(batch, env);
  }
};
