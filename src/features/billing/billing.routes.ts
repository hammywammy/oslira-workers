// src/features/billing/billing.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { getSubscription, createUpgradeCheckout } from './billing.handler';

export function registerBillingRoutes(app: Hono<{ Bindings: Env }>) {
  // All billing routes require authentication
  app.use('/api/billing/*', authMiddleware);
  app.use('/api/billing/*', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));

  /**
   * GET /api/billing/subscription
   * Get current subscription details
   */
  app.get('/api/billing/subscription', getSubscription);

  /**
   * POST /api/billing/upgrade
   * Create Stripe Checkout session for upgrade
   * Body: { newTier: 'growth' | 'pro' | 'agency' | 'enterprise' }
   */
  app.post('/api/billing/upgrade', createUpgradeCheckout);
}
