// features/credits/credits.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type { 
  CreditBalance, 
  CreditTransaction, 
  ListTransactionsQuery,
  PurchaseCreditsInput,
  PurchaseResult
} from './credits.types';
import { calculateCreditPrice } from './credits.types';
import { getSecret } from '@/infrastructure/config/secrets';
import type { Env } from '@/shared/types/env.types';
import Stripe from 'stripe';

export class CreditsService {
  constructor(
    private supabase: SupabaseClient,
    private env?: Env
  ) {}

  /**
   * Get current credit balance for account
   */
  async getBalance(accountId: string): Promise<CreditBalance> {
    const { data, error } = await this.supabase
      .from('balances')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No balance record yet - return zero balance
        return {
          account_id: accountId,
          credit_balance: 0,
          light_analyses_balance: 0,
          last_transaction_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
      }
      throw error;
    }

    return data as CreditBalance;
  }

  /**
   * Get transaction history
   */
  async getTransactions(
    accountId: string,
    query: ListTransactionsQuery
  ): Promise<{ transactions: CreditTransaction[]; total: number }> {
    const { page, pageSize, transactionType } = query;
    const offset = (page - 1) * pageSize;

    let queryBuilder = this.supabase
      .from('credit_ledger')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (transactionType) {
      queryBuilder = queryBuilder.eq('transaction_type', transactionType);
    }

    const { data, error, count } = await queryBuilder;

    if (error) throw error;

    return {
      transactions: (data || []) as CreditTransaction[],
      total: count || 0
    };
  }

  /**
   * Purchase credits via Stripe
   * NOTE: This is a simplified implementation
   * Full Stripe integration should be in a separate webhook handler
   */
  async purchaseCredits(
    accountId: string,
    userId: string,
    input: PurchaseCreditsInput
  ): Promise<PurchaseResult> {
    if (!this.env) {
      throw new Error('Environment not configured for purchases');
    }

    // Calculate pricing
    const pricing = calculateCreditPrice(input.amount);

    // Initialize Stripe
    const stripeKey = await getSecret('STRIPE_SECRET_KEY', this.env, this.env.APP_ENV);
    const stripe = new Stripe(stripeKey, {
      apiVersion: '2024-12-18.acacia'
    });

    try {
      // Create payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(pricing.total * 100), // Convert to cents
        currency: 'usd',
        payment_method: input.payment_method_id,
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        },
        metadata: {
          account_id: accountId,
          user_id: userId,
          credits_amount: input.amount.toString(),
          transaction_type: 'purchase'
        },
        idempotency_key: input.idempotency_key
      });

      // If payment succeeded immediately, grant credits
      if (paymentIntent.status === 'succeeded') {
        // Use RPC to grant credits atomically
        const { data: transactionId, error } = await this.supabase
          .rpc('deduct_credits', {
            p_account_id: accountId,
            p_amount: input.amount, // Positive = grant
            p_transaction_type: 'purchase',
            p_description: `Purchased ${input.amount} credits for $${pricing.total}`,
            p_reference_type: 'stripe_payment_intent',
            p_reference_id: paymentIntent.id,
            p_created_by: userId
          });

        if (error) throw error;

        // Get updated balance
        const balance = await this.getBalance(accountId);

        return {
          transaction_id: transactionId,
          amount: input.amount,
          balance_after: balance.credit_balance,
          stripe_payment_intent_id: paymentIntent.id,
          status: 'succeeded'
        };
      }

      // Payment is processing
      return {
        transaction_id: '', // Will be created by webhook
        amount: input.amount,
        balance_after: 0,
        stripe_payment_intent_id: paymentIntent.id,
        status: 'processing'
      };

    } catch (error: any) {
      console.error('[PurchaseCredits] Stripe error:', error);
      
      return {
        transaction_id: '',
        amount: 0,
        balance_after: 0,
        stripe_payment_intent_id: null,
        status: 'failed'
      };
    }
  }

  /**
   * Check if account has sufficient credits
   */
  async hasSufficientCredits(accountId: string, required: number): Promise<boolean> {
    const balance = await this.getBalance(accountId);
    return balance.credit_balance >= required;
  }
}
