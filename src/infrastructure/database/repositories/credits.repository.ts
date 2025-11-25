// infrastructure/database/repositories/credits.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';
import {
  type CreditType,
  type AnalysisType,
  getCreditType
} from '@/config/operations-pricing.config';

export interface CreditBalance {
  account_id: string;
  credit_balance: number;
  light_analyses_balance: number;
  deep_analyses_balance: number;
  last_transaction_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Maps credit types to their database RPC functions.
 * - light_analyses: Uses dedicated light_analyses_balance (legacy)
 * - credits: Uses credit_balance (for deep and all future analysis types)
 */
const CREDIT_TYPE_RPC_MAP: Record<CreditType, {
  deductRpc: string;
  balanceColumn: string;
}> = {
  light_analyses: {
    deductRpc: 'deduct_light_analyses',
    balanceColumn: 'light_analyses_balance'
  },
  credits: {
    deductRpc: 'deduct_credits',
    balanceColumn: 'credit_balance'
  }
};

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
    return this.getBalanceByType(accountId, 'light_analyses');
  }

  /**
   * MODULAR: Get balance by credit type
   * Use this for any credit type - routes to correct column automatically
   */
  async getBalanceByType(accountId: string, creditType: CreditType): Promise<number> {
    const { balanceColumn } = CREDIT_TYPE_RPC_MAP[creditType];

    const { data, error } = await this.supabase
      .from('balances')
      .select(balanceColumn)
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return 0;
      throw error;
    }

    return (data as Record<string, number>)?.[balanceColumn] || 0;
  }

  /**
   * MODULAR: Get balance for an analysis type
   * Automatically routes to the correct credit type
   */
  async getBalanceForAnalysisType(accountId: string, analysisType: AnalysisType): Promise<number> {
    const creditType = getCreditType(analysisType);
    return this.getBalanceByType(accountId, creditType);
  }

  /**
   * Deduct credits (MUST use RPC function for safety)
   * Note: RPC does balance + p_amount, so we pass negative to deduct
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
        p_amount: -amount, // Negate: RPC adds p_amount, so negative = deduct
        p_transaction_type: transactionType,
        p_description: description
      });

    if (error) throw error;
    return data;
  }

  /**
   * Deduct light analyses (uses RPC function)
   * Note: RPC does balance + p_amount, so we pass negative to deduct
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
        p_amount: -amount, // Negate: RPC adds p_amount, so negative = deduct
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

  // ===============================================================================
  // MODULAR ANALYSIS TYPE METHODS
  // ===============================================================================

  /**
   * MODULAR: Deduct credits for any analysis type
   * Automatically routes to the correct credit type RPC
   */
  async deductForAnalysis(
    accountId: string,
    analysisType: AnalysisType,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    const creditType = getCreditType(analysisType);
    const { deductRpc } = CREDIT_TYPE_RPC_MAP[creditType];

    const { data, error } = await this.supabase
      .rpc(deductRpc, {
        p_account_id: accountId,
        p_amount: -amount, // Negate: RPC adds p_amount, so negative = deduct
        p_transaction_type: transactionType,
        p_description: description
      });

    if (error) throw error;
    return data;
  }

  /**
   * MODULAR: Add credits for any analysis type (refunds)
   * Automatically routes to the correct credit type RPC
   */
  async addForAnalysis(
    accountId: string,
    analysisType: AnalysisType,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    return this.deductForAnalysis(accountId, analysisType, -amount, transactionType, description);
  }

  /**
   * MODULAR: Check if account has sufficient balance for an analysis type
   * Automatically routes to the correct credit type
   */
  async hasSufficientBalanceForAnalysis(
    accountId: string,
    analysisType: AnalysisType,
    required: number
  ): Promise<boolean> {
    const balance = await this.getBalanceForAnalysisType(accountId, analysisType);
    return balance >= required;
  }

  /**
   * Deduct deep analyses (uses RPC function)
   * Note: RPC does balance + p_amount, so we pass negative to deduct
   */
  async deductDeepAnalyses(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    const { data, error } = await this.supabase
      .rpc('deduct_deep_analyses', {
        p_account_id: accountId,
        p_amount: -amount, // Negate: RPC adds p_amount, so negative = deduct
        p_transaction_type: transactionType,
        p_description: description
      });

    if (error) throw error;
    return data;
  }

  /**
   * Add deep analyses (for refunds)
   */
  async addDeepAnalyses(
    accountId: string,
    amount: number,
    transactionType: string,
    description: string
  ): Promise<string> {
    return this.deductDeepAnalyses(accountId, -amount, transactionType, description);
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
