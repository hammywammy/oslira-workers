// infrastructure/database/repositories/credits.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface CreditBalance {
  account_id: string;
  credit_balance: number;
  light_analyses_balance: number;
  last_transaction_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreditTransaction {
  id: string;
  account_id: string;
  amount: number;
  balance_after: number;
  transaction_type: string;
  description: string;
  created_by: string | null;
  created_at: string;
}

export class CreditsRepository extends BaseRepository<CreditBalance> {
  constructor(supabase: SupabaseClient) {
    super(supabase, 'balances');
  }

  /**
   * Get current credit balance for account
   */
  async getBalance(accountId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('balances')
      .select('credit_balance')
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return 0;
      throw error;
    }

    return data?.credit_balance || 0;
  }

  /**
   * Get light analyses balance for account
   */
  async getLightBalance(accountId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('balances')
      .select('light_analyses_balance')
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return 0;
      throw error;
    }

    return data?.light_analyses_balance || 0;
  }

  /**
   * Deduct credits (MUST use RPC function for safety)
   */
  async deductCredits(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    const { data, error } = await this.supabase
      .rpc('deduct_credits', {
        p_account_id: accountId,
        p_amount: amount,
        p_transaction_type: transactionType,
        p_description: description
      });

    if (error) throw error;
    return data;
  }

  /**
   * Deduct light analyses (uses RPC function)
   */
  async deductLightAnalyses(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    const { data, error } = await this.supabase
      .rpc('deduct_light_analyses', {
        p_account_id: accountId,
        p_amount: amount,
        p_transaction_type: transactionType,
        p_description: description
      });

    if (error) throw error;
    return data;
  }

  /**
   * Add credits (for purchases/refunds)
   */
  async addCredits(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    return this.deductCredits(accountId, -amount, transactionType, description);
  }

  /**
   * Add light analyses (for refunds)
   */
  async addLightAnalyses(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    return this.deductLightAnalyses(accountId, -amount, transactionType, description);
  }

  /**
   * Check if account has sufficient credits
   */
  async hasSufficientCredits(accountId: string, required: number): Promise<boolean> {
    const balance = await this.getBalance(accountId);
    return balance >= required;
  }

  /**
   * Check if account has sufficient light analyses
   */
  async hasSufficientLightAnalyses(accountId: string, required: number): Promise<boolean> {
    const balance = await this.getLightBalance(accountId);
    return balance >= required;
  }

  /**
   * Get transaction history
   */
  async getTransactions(
    accountId: string,
    options?: {
      limit?: number;
      offset?: number;
    }
  ): Promise<CreditTransaction[]> {
    let query = this.supabase
      .from('credit_ledger')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    }

    const { data, error } = await query;

    if (error) throw error;
    return (data || []) as CreditTransaction[];
  }
}
