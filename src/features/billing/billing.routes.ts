// features/billing/billing.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware } from '@/shared/middleware/rate-limit.middleware';
import { API_RATE_LIMITS, WEBHOOK_RATE_LIMITS } from '@/config/rate-limits.config';
import {
  getSubscription,
  createUpgradeCheckout,
  handleStripeWebhook
} from './billing.handler';

export function registerBillingRoutes(app: Hono) {
  console.log('[Routes] Registering billing routes');

  // ===============================================================================
  // STRIPE WEBHOOK (NO AUTH - signature verified in handler)
  // ===============================================================================
  app.post(
    '/api/webhooks/stripe',
    rateLimitMiddleware(WEBHOOK_RATE_LIMITS.STRIPE),
    handleStripeWebhook
  );

  // ===============================================================================
  // AUTHENTICATED BILLING ROUTES
  // ===============================================================================
  app.use('/api/billing/*', authMiddleware);
  app.use('/api/billing/*', rateLimitMiddleware(API_RATE_LIMITS.GENERAL));

  app.get('/api/billing/subscription', getSubscription);
  app.post('/api/billing/upgrade', createUpgradeCheckout);

  console.log('[Routes] Billing routes registered');
}
