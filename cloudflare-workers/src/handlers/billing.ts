import type { Context } from 'hono';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { fetchJson } from '../utils/helpers.js';
import { getApiKey } from '../services/enhanced-config-manager.js';

export async function handleStripeWebhook(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json(createStandardResponse(false, undefined, 'Missing stripe signature', requestId), 400);
    }

    const body = await c.req.text();
    const event = JSON.parse(body);
    logger('info', 'Stripe webhook received', { eventType: event.type, requestId });

    const headers = {
      apikey: c.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json'
    };

    switch (event.type) {
      case 'checkout.session.completed':
        await fetch(`${c.env.SUPABASE_URL}/rest/v1/users`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            stripe_customer_id: event.data.object.customer,
            subscription_status: 'active',
            updated_at: new Date().toISOString()
          })
        });
        break;
        
      case 'customer.subscription.deleted':
        await fetch(`${c.env.SUPABASE_URL}/rest/v1/users`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            subscription_status: 'cancelled',
            updated_at: new Date().toISOString()
          })
        });
        break;
        
      default:
        logger('info', 'Unhandled webhook event', { eventType: event.type, requestId });
    }
    
    return c.json(createStandardResponse(true, { received: true }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Webhook processing failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 400);
  }
}

export async function handleCreateCheckoutSession(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const body = await c.req.json();
    const { priceId, user_id, successUrl, cancelUrl } = body;
    
    if (!priceId || !user_id) {
      return c.json(createStandardResponse(false, undefined, 'priceId and user_id are required', requestId), 400);
    }

// Get Stripe secret key based on environment
const environment = c.env.APP_ENV || 'production';
const stripeSecretKey = await getApiKey('STRIPE_SECRET_KEY', c.env, environment);

if (!stripeSecretKey) {
  logger('error', 'Stripe secret key not configured', { environment, requestId });
  return c.json(createStandardResponse(false, undefined, 'Stripe not configured', requestId), 500);
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
        'success_url': successUrl || `${c.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': cancelUrl || `${c.env.FRONTEND_URL}/pricing`
      })
    });

    if (!stripeResponse.ok) {
      throw new Error('Failed to create Stripe checkout session');
    }

    const session = await stripeResponse.json();
    
    return c.json(createStandardResponse(true, { 
      sessionId: session.id, 
      url: session.url 
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Checkout session creation failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

export async function handleCreatePortalSession(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    const body = await c.req.json();
    const { customerId, returnUrl } = body;
    
    if (!customerId) {
      return c.json(createStandardResponse(false, undefined, 'customerId is required', requestId), 400);
    }

const environment = c.env.APP_ENV || 'production';
const stripeSecretKey = await getApiKey('STRIPE_SECRET_KEY', c.env, environment);

    const stripeResponse = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'customer': customerId,
        'return_url': returnUrl || `${c.env.FRONTEND_URL}/dashboard`
      })
    });

    if (!stripeResponse.ok) {
      throw new Error('Failed to create Stripe portal session');
    }

    const session = await stripeResponse.json();
    
    return c.json(createStandardResponse(true, { url: session.url }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Portal session creation failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}
