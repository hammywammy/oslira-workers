// features/credits/credits.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { CreditsService } from './credits.service';
import {
  ListTransactionsQuerySchema,
  PurchaseCreditsSchema,
  calculateCreditPrice
} from './credits.types';
import { validateQuery, validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse, paginatedResponse, createdResponse } from '@/shared/utils/response.util';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { createUserClient } from '@/infrastructure/database/supabase.client';

/**
 * GET /api/credits/balance
 * Get current credit balance
 */
export async function getCreditBalance(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;

    // Get balance
    const supabase = await createUserClient(c.env);
    const service = new CreditsService(supabase);
    const balance = await service.getBalance(accountId);

    return successResponse(c, balance);

  } catch (error: any) {
    console.error('[GetCreditBalance] Error:', error);
    return errorResponse(c, 'Failed to get credit balance', 'INTERNAL_ERROR', 500);
  }
}

/**
 * GET /api/credits/transactions
 * Get transaction history
 */
export async function getTransactions(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;

    // Validate query params
    const query = validateQuery(ListTransactionsQuerySchema, {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      transactionType: c.req.query('transactionType')
    });

    // Get transactions
    const supabase = await createUserClient(c.env);
    const service = new CreditsService(supabase);
    const { transactions, total } = await service.getTransactions(accountId, query);

    return paginatedResponse(c, transactions, {
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: (query.page * query.pageSize) < total
    });

  } catch (error: any) {
    console.error('[GetTransactions] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid query parameters', 'VALIDATION_ERROR', 400, error.errors);
    }

    return errorResponse(c, 'Failed to get transactions', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/credits/purchase
 * Purchase credits via Stripe
 */
export async function purchaseCredits(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;
    const userId = auth.userId;

    // Validate body
    const body = await c.req.json();
    const input = validateBody(PurchaseCreditsSchema, body);

    // Calculate pricing (for response)
    const pricing = calculateCreditPrice(input.amount);

    // Process purchase
    const supabase = await createUserClient(c.env);
    const service = new CreditsService(supabase, c.env);
    const result = await service.purchaseCredits(accountId, userId, input);

    if (result.status === 'failed') {
      return errorResponse(
        c,
        'Payment failed. Please check your payment method.',
        'PAYMENT_FAILED',
        402
      );
    }

    return createdResponse(c, {
      ...result,
      pricing: {
        subtotal: pricing.subtotal,
        discount: pricing.discount,
        total: pricing.total,
        per_credit: pricing.per_credit
      }
    });

  } catch (error: any) {
    console.error('[PurchaseCredits] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid request body', 'VALIDATION_ERROR', 400, error.errors);
    }

    if (error.message.includes('payment_method')) {
      return errorResponse(c, 'Invalid payment method', 'INVALID_PAYMENT_METHOD', 400);
    }

    return errorResponse(c, 'Failed to process purchase', 'INTERNAL_ERROR', 500);
  }
}

/**
 * GET /api/credits/pricing
 * Get pricing calculator (no auth required)
 */
export async function getCreditPricing(c: Context<{ Bindings: Env }>) {
  try {
    const amount = parseInt(c.req.query('amount') || '100');

    if (isNaN(amount) || amount < 10 || amount > 10000) {
      return errorResponse(c, 'Amount must be between 10 and 10,000', 'VALIDATION_ERROR', 400);
    }

    const pricing = calculateCreditPrice(amount);

    return successResponse(c, {
      amount,
      ...pricing,
      breakdown: {
        base_price: 0.97,
        bulk_discounts: [
          { min: 100, discount: '5%' },
          { min: 500, discount: '10%' },
          { min: 1000, discount: '15%' }
        ]
      }
    });

  } catch (error: any) {
    console.error('[GetCreditPricing] Error:', error);
    return errorResponse(c, 'Failed to calculate pricing', 'INTERNAL_ERROR', 500);
  }
}
