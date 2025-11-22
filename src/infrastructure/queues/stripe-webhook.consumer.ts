// infrastructure/queues/stripe-webhook.consumer.ts

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';

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
  console.log(`[StripeWebhookQueue] Processing batch of ${batch.messages.length} messages`);

  for (const message of batch.messages) {
    try {
      await processWebhookMessage(message, env);
      message.ack(); // Success - remove from queue
    } catch (error: any) {
      console.error(`[StripeWebhookQueue] Error processing message:`, error);
      
      // Retry logic
      if (message.attempts < 3) {
        message.retry(); // Retry with exponential backoff
      } else {
        console.error(`[StripeWebhookQueue] Max retries exceeded, moving to DLQ`);
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

  console.log(`[StripeWebhook] Processing: ${data.event_type} (${data.event_id})`);

  // Check idempotency - has this event been processed?
  const supabase = await SupabaseClientFactory.createAdminClient(env);
  const { data: existing } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('event_id', data.event_id)
    .eq('status', 'processed')
    .single();

  if (existing) {
    console.log(`[StripeWebhook] Event ${data.event_id} already processed, skipping`);
    return;
  }

  // Store webhook event
  await supabase.from('webhook_events').insert({
    event_id: data.event_id,
    event_type: data.event_type,
    payload: data.payload,
    status: 'processing',
    received_at: data.received_at
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
      console.log(`[StripeWebhook] Unhandled event type: ${data.event_type}`);
  }

  // Mark as processed
  await supabase
    .from('webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('event_id', data.event_id);
}

/**
 * Handle checkout.session.completed
 * Handles both:
 * - Subscription upgrades (mode: 'subscription')
 * - One-time credit purchases (mode: 'payment')
 */
async function handleCheckoutCompleted(data: StripeWebhookMessage, env: Env): Promise<void> {
  const session = data.payload;
  const accountId = session.metadata?.account_id || data.account_id;

  console.log('[StripeWebhook] checkout.session.completed', {
    session_id: session.id,
    account_id: accountId,
    mode: session.mode,
  });

  const supabase = await SupabaseClientFactory.createAdminClient(env);

  // Handle subscription checkout (upgrades)
  if (session.mode === 'subscription' && session.subscription) {
    const newTier = session.metadata?.new_tier;
    const stripeSubscriptionId = session.subscription;

    if (newTier && accountId) {
      // Update subscription in database
      const { error: updateError } = await supabase
        .from('subscriptions')
        .update({
          plan_type: newTier,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId);

      if (updateError) {
        console.error('[StripeWebhook] Failed to update subscription:', updateError);
        throw updateError;
      }

      // Get new tier limits from plans table
      const { data: plan } = await supabase
        .from('plans')
        .select('credits_per_month, features')
        .eq('name', newTier)
        .single();

      if (plan) {
        // Reset balances to new tier limits
        await supabase
          .from('balances')
          .update({
            credit_balance: plan.credits_per_month,
            light_analyses_balance: parseInt(plan.features?.light_analyses || '0'),
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId);
      }

      console.log(`[StripeWebhook] Upgraded account ${accountId} to ${newTier}`);
    }
  }

  // Handle one-time credit purchases (existing logic)
  const creditsAmount = session.metadata?.credits_amount;
  if (creditsAmount && parseInt(creditsAmount) > 0) {
    const creditsRepo = new CreditsRepository(supabase);
    await creditsRepo.addCredits(
      accountId,
      parseInt(creditsAmount),
      'purchase',
      `Credit purchase via Stripe: ${session.id}`
    );
    console.log(`[StripeWebhook] Granted ${creditsAmount} credits to account ${accountId}`);
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
    
    // Get subscription with plan details
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(`
        plan_type,
        plans!inner(
          credits_per_month,
          features
        )
      `)
      .eq('stripe_subscription_id', subscriptionId)
      .eq('status', 'active')
      .single();

    if (error || !subscription) {
      console.error('[StripeWebhook] Subscription not found:', error);
      return;
    }

    const plan = subscription.plans;
    const creditsQuota = plan.credits_per_month;
    const lightQuota = parseInt(plan.features.light_analyses);

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

    console.log(
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
  
  await supabase
    .from('subscriptions')
    .update({
      status: subscription.status,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id)
    .eq('account_id', accountId);

  console.log(`[StripeWebhook] Updated subscription ${subscription.id} status to ${subscription.status}`);
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(data: StripeWebhookMessage, env: Env): Promise<void> {
  const subscription = data.payload;
  const accountId = data.account_id;

  const supabase = await SupabaseClientFactory.createAdminClient(env);
  
  await supabase
    .from('subscriptions')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id)
    .eq('account_id', accountId);

  console.log(`[StripeWebhook] Cancelled subscription ${subscription.id}`);
}
