import type { Context } from 'hono';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { getApiKey } from '../services/enhanced-config-manager.js';

const PLAN_CREDITS = {
  free: 25,        // ← Changed from 'starter: 100'
  pro: 500,
  agency: 1000,
  enterprise: 5000
} as const;

// Map Stripe Price IDs to plan types
const STRIPE_PRICE_TO_PLAN: Record<string, keyof typeof PLAN_CREDITS> = {
  'price_pro_monthly': 'pro',
  'price_agency_monthly': 'agency',
  'price_enterprise_monthly': 'enterprise'
  // Add your actual Stripe Price IDs here
};

export async function handleStripeWebhook(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json(createStandardResponse(false, undefined, 'Missing stripe signature', requestId), 400);
    }

    const body = await c.req.text();
    const event = JSON.parse(body);
    
    logger('info', 'Stripe webhook received', { 
      eventType: event.type, 
      requestId 
    });

    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };

    switch (event.type) {
      
      // NEW SUBSCRIPTION CREATED
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id;
        
        if (!userId) {
          logger('warn', 'No user_id in checkout session', { requestId });
          break;
        }

        // Fetch subscription details from Stripe
        const subscriptionId = session.subscription;
        const stripeKey = await getApiKey('STRIPE_SECRET_KEY', c.env, c.env.APP_ENV);
        
        const subResponse = await fetch(
          `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
          {
            headers: { 'Authorization': `Bearer ${stripeKey}` }
          }
        );
        
        const subscription = await subResponse.json();
        const priceId = subscription.items.data[0].price.id;
        const planType = STRIPE_PRICE_TO_PLAN[priceId] || 'free';

        // Update subscriptions table
        await fetch(`${supabaseUrl}/rest/v1/subscriptions?user_id=eq.${userId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            stripe_customer_id: session.customer,
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            plan_type: planType,
            credits_remaining: PLAN_CREDITS[planType],
            status: 'active',
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        logger('info', 'Subscription created', { 
          userId, 
          planType, 
          subscriptionId,
          requestId 
        });
        break;
      }

      // SUBSCRIPTION RENEWED (MONTHLY BILLING)
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        
        if (invoice.billing_reason === 'subscription_cycle') {
          const subscriptionId = invoice.subscription;
          
          // Fetch current subscription data
          const currentSubResponse = await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}&select=credits_remaining,plan_type`,
            { headers }
          );
          
          const currentSubs = await currentSubResponse.json();
          if (!currentSubs || currentSubs.length === 0) {
            logger('warn', 'Subscription not found for renewal', { subscriptionId, requestId });
            break;
          }

          const currentSub = currentSubs[0];
          const planType = currentSub.plan_type as keyof typeof PLAN_CREDITS;
          
          // ROLLOVER LOGIC: Add new credits to existing balance (paid users only)
          const newCredits = (currentSub.credits_remaining || 0) + PLAN_CREDITS[planType];

          // Get subscription period from Stripe
          const stripeKey = await getApiKey('STRIPE_SECRET_KEY', c.env, c.env.APP_ENV);
          const subResponse = await fetch(
            `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
            {
              headers: { 'Authorization': `Bearer ${stripeKey}` }
            }
          );
          
          const subscription = await subResponse.json();

          // Update subscription with rollover credits and new period
          await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`,
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                credits_remaining: newCredits,
                current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
                updated_at: new Date().toISOString()
              })
            }
          );

          logger('info', 'Subscription renewed with rollover', { 
            subscriptionId,
            planType,
            previousCredits: currentSub.credits_remaining,
            addedCredits: PLAN_CREDITS[planType],
            newTotal: newCredits,
            requestId 
          });
        }
        break;
      }

      // SUBSCRIPTION CANCELED
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        
        await fetch(
          `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscription.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              status: 'canceled',
              updated_at: new Date().toISOString()
              // Keep credits_remaining until period_end (grace period)
            })
          }
        );

        logger('info', 'Subscription canceled', { 
          subscriptionId: subscription.id,
          requestId 
        });
        break;
      }

      // SUBSCRIPTION UPDATED (Plan change)
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const priceId = subscription.items.data[0].price.id;
        const newPlanType = STRIPE_PRICE_TO_PLAN[priceId];

        if (newPlanType) {
          await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscription.id}`,
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                plan_type: newPlanType,
                stripe_price_id: priceId,
                current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
                current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
                updated_at: new Date().toISOString()
              })
            }
          );

          logger('info', 'Subscription plan updated', { 
            subscriptionId: subscription.id,
            newPlanType,
            requestId 
          });
        }
        break;
      }

      default:
        logger('info', 'Unhandled webhook event', { 
          eventType: event.type, 
          requestId 
        });
    }
    
    return c.json(createStandardResponse(true, { received: true }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Webhook processing failed', { 
      error: error.message, 
      stack: error.stack,
      requestId 
    });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 400);
  }
}

export async function handleCreateCheckoutSession(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const body = await c.req.json();
    const { priceId, user_id, successUrl, cancelUrl } = body;
    
    if (!priceId || !user_id) {
      return c.json(
        createStandardResponse(false, undefined, 'priceId and user_id required', requestId), 
        400
      );
    }

    const environment = c.env.APP_ENV || 'production';
    const stripeSecretKey = await getApiKey('STRIPE_SECRET_KEY', c.env, environment);
    const frontendUrl = await getApiKey('FRONTEND_URL', c.env, environment);

    if (!stripeSecretKey) {
      logger('error', 'Stripe secret key not configured', { environment, requestId });
      return c.json(
        createStandardResponse(false, undefined, 'Stripe not configured', requestId), 
        500
      );
    }

    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'mode': 'subscription',
        'client_reference_id': user_id,
        'success_url': successUrl || `${frontendUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': cancelUrl || `${frontendUrl}/pricing`
      })
    });

    if (!stripeResponse.ok) {
      const errorText = await stripeResponse.text();
      throw new Error(`Stripe API error: ${errorText}`);
    }

    const session = await stripeResponse.json();
    
    return c.json(createStandardResponse(true, { 
      sessionId: session.id, 
      url: session.url 
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Checkout session creation failed', { 
      error: error.message, 
      requestId 
    });
    return c.json(
      createStandardResponse(false, undefined, error.message, requestId), 
      500
    );
  }
}

export async function handleCreatePortalSession(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const body = await c.req.json();
    const { customerId, returnUrl } = body;
    
    if (!customerId) {
      return c.json(
        createStandardResponse(false, undefined, 'customerId required', requestId), 
        400
      );
    }

    const environment = c.env.APP_ENV || 'production';
    const stripeSecretKey = await getApiKey('STRIPE_SECRET_KEY', c.env, environment);
    const frontendUrl = await getApiKey('FRONTEND_URL', c.env, environment);

    const stripeResponse = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'customer': customerId,
        'return_url': returnUrl || `${frontendUrl}/dashboard`
      })
    });

    if (!stripeResponse.ok) {
      const errorText = await stripeResponse.text();
      throw new Error(`Stripe API error: ${errorText}`);
    }

    const session = await stripeResponse.json();
    
    return c.json(createStandardResponse(true, { url: session.url }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Portal session creation failed', { 
      error: error.message, 
      requestId 
    });
    return c.json(
      createStandardResponse(false, undefined, error.message, requestId), 
      500
    );
  }
}
