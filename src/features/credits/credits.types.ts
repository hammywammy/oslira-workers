// features/credits/credits.types.ts

import { z } from 'zod';

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

export const GetBalanceQuerySchema = z.object({
  // No parameters needed - uses auth context
});

export const ListTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  transactionType: z.enum([
    'signup_bonus',
    'referral_bonus',
    'admin_grant',
    'purchase',
    'subscription_renewal',
    'analysis',
    'refund'
  ]).optional()
});

export const PurchaseCreditsSchema = z.object({
  amount: z.number().int().min(10, 'Minimum purchase is 10 credits').max(10000),
  payment_method_id: z.string().min(1, 'Payment method required'),
  idempotency_key: z.string().uuid().optional()
});

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

export interface CreditBalance {
  account_id: string;
  credit_balance: number;
  light_analyses_balance: number;  // ADD THIS
  last_transaction_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreditTransaction {
  id: string;
  account_id: string;
  amount: number;
  balance_after: number;
  transaction_type: string;
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  metadata: any | null;
  created_by: string | null;
  created_at: string;
}

export interface PurchaseResult {
  transaction_id: string;
  amount: number;
  balance_after: number;
  stripe_payment_intent_id: string | null;
  status: 'succeeded' | 'processing' | 'failed';
}

// ===============================================================================
// PRICING
// ===============================================================================

export const CREDIT_PRICING = {
  per_credit: 0.97,  // $0.97 per credit
  bulk_discounts: [
    { min: 100, discount: 0.05 },   // 5% off for 100+
    { min: 500, discount: 0.10 },   // 10% off for 500+
    { min: 1000, discount: 0.15 }   // 15% off for 1000+
  ]
};

/**
 * Calculate price for credit purchase
 */
export function calculateCreditPrice(amount: number): {
  subtotal: number;
  discount: number;
  total: number;
  per_credit: number;
} {
  const basePrice = amount * CREDIT_PRICING.per_credit;
  
  // Find applicable discount
  const discount = CREDIT_PRICING.bulk_discounts
    .filter(d => amount >= d.min)
    .sort((a, b) => b.discount - a.discount)[0];
  
  const discountAmount = discount ? basePrice * discount.discount : 0;
  const total = basePrice - discountAmount;
  
  return {
    subtotal: parseFloat(basePrice.toFixed(2)),
    discount: parseFloat(discountAmount.toFixed(2)),
    total: parseFloat(total.toFixed(2)),
    per_credit: parseFloat((total / amount).toFixed(4))
  };
}

// ===============================================================================
// TYPE EXPORTS
// ===============================================================================

export type ListTransactionsQuery = z.infer<typeof ListTransactionsQuerySchema>;
export type PurchaseCreditsInput = z.infer<typeof PurchaseCreditsSchema>;
