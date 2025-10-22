// features/credits/credits.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware, optionalAuthMiddleware } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { 
  getCreditBalance, 
  getTransactions, 
  purchaseCredits,
  getCreditPricing
} from './credits.handler';

export function registerCreditsRoutes(app: Hono<{ Bindings: Env }>) {
  
  /**
   * GET /api/credits/pricing
   * Get pricing calculator (public endpoint)
   * Query params: ?amount=100
   */
  app.get('/api/credits/pricing', getCreditPricing);

  // All other credit routes require authentication
  app.use('/api/credits/balance', authMiddleware);
  app.use('/api/credits/transactions', authMiddleware);
  app.use('/api/credits/purchase', authMiddleware);
  
  // Apply general API rate limiting
  app.use('/api/credits/*', rateLimitMiddleware(RATE_LIMITS.API_GENERAL));

  /**
   * GET /api/credits/balance
   * Get current credit balance
   */
  app.get('/api/credits/balance', getCreditBalance);

  /**
   * GET /api/credits/transactions
   * Get transaction history with pagination
   * Query params: ?page=1&pageSize=50&transactionType=analysis
   */
  app.get('/api/credits/transactions', getTransactions);

  /**
   * POST /api/credits/purchase
   * Purchase credits via Stripe
   * Body: { amount: 100, payment_method_id: "pm_xxx", idempotency_key?: "uuid" }
   */
  app.post('/api/credits/purchase', purchaseCredits);
}
