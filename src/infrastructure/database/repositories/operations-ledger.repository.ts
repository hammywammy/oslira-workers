// infrastructure/database/repositories/operations-ledger.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface OperationMetrics {
  cost: {
    total_usd: number;
    items: {
      [key: string]: {
        vendor: string;
        usd: number;
        [key: string]: any;
      };
    };
  };
  duration?: {
    total_ms: number;
    steps?: {
      [key: string]: number | boolean;
    };
  };
}

export interface OperationLedgerEntry {
  id: string;
  account_id: string | null;
  operation_type: string;
  operation_id: string | null;
  metrics: OperationMetrics;
  analysis_type: string | null;
  username: string | null;
  created_at: string;
}

export interface LogOperationData {
  account_id?: string;
  operation_type: string;
  operation_id?: string;
  metrics: OperationMetrics;
  analysis_type?: string;
  username?: string;
}

export class OperationsLedgerRepository extends BaseRepository<OperationLedgerEntry> {
  constructor(supabase: SupabaseClient) {
    super(supabase, 'operations_ledger');
  }

  /**
   * Log an operation with cost and performance metrics
   */
  async logOperation(data: LogOperationData): Promise<void> {
    const { error } = await this.supabase
      .from('operations_ledger')
      .insert({
        account_id: data.account_id || null,
        operation_type: data.operation_type,
        operation_id: data.operation_id || null,
        metrics: data.metrics,
        analysis_type: data.analysis_type || null,
        username: data.username || null
      });

    if (error) {
      console.error('[OperationsLedger] Failed to log operation:', error);
      // Don't throw - logging failures shouldn't break the main flow
    }
  }
}
