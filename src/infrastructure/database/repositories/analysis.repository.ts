// infrastructure/database/repositories/analysis.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface Analysis {
  id: string;
  run_id: string;
  lead_id: string;
  account_id: string;
  business_profile_id: string;
  analysis_type: 'light';
  overall_score: number;
  ai_response: any;
  status: 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateAnalysisData {
  run_id: string;
  lead_id: string;
  account_id: string;
  business_profile_id: string;
  analysis_type: 'light';
  status?: 'pending' | 'processing';
}

export interface UpdateAnalysisData {
  overall_score?: number;
  ai_response?: any;
  status?: 'complete' | 'failed' | 'cancelled';
  error_message?: string;
  completed_at?: string;
}

export class AnalysisRepository extends BaseRepository<Analysis> {
  constructor(supabase: SupabaseClient) {
    super(supabase, 'lead_analyses');
  }

  /**
   * Create new analysis record
   */
  async createAnalysis(data: CreateAnalysisData): Promise<Analysis> {
    return this.create({
      ...data,
      status: data.status || 'pending',
      started_at: new Date().toISOString()
    } as any);
  }

  /**
   * Update analysis results
   */
  async updateAnalysis(runId: string, data: UpdateAnalysisData): Promise<Analysis> {
    const { data: result, error } = await this.supabase
      .from('lead_analyses')
      .update({
        ...data,
        updated_at: new Date().toISOString()
      })
      .eq('run_id', runId)
      .select()
      .single();

    if (error) throw error;
    return result as Analysis;
  }

  /**
   * Get analysis by run_id
   */
  async getByRunId(runId: string): Promise<Analysis | null> {
    const { data, error } = await this.supabase
      .from('lead_analyses')
      .select('*')
      .eq('run_id', runId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return data as Analysis;
  }

  /**
   * Check for duplicate in-progress analysis
   */
  async findInProgressAnalysis(
    leadId: string,
    accountId: string,
    excludeRunId?: string
  ): Promise<Analysis | null> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    let query = this.supabase
      .from('lead_analyses')
      .select('*')
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .in('status', ['pending', 'processing'])
      .gte('created_at', fiveMinutesAgo)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (excludeRunId) {
      query = query.neq('run_id', excludeRunId);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    return data as Analysis | null;
  }

  /**
   * Get analyses for lead
   */
  async getAnalysesForLead(
    leadId: string,
    options?: {
      limit?: number;
    }
  ): Promise<Analysis[]> {
    let query = this.supabase
      .from('lead_analyses')
      .select('*')
      .eq('lead_id', leadId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) throw error;
    return (data || []) as Analysis[];
  }

  /**
   * Get latest analysis for lead
   */
  async getLatestAnalysis(leadId: string): Promise<Analysis | null> {
    const analyses = await this.getAnalysesForLead(leadId, { limit: 1 });
    return analyses[0] || null;
  }

  /**
   * Mark analysis as failed
   */
  async markAsFailed(runId: string, errorMessage: string): Promise<void> {
    await this.updateAnalysis(runId, {
      status: 'failed',
      error_message: errorMessage,
      completed_at: new Date().toISOString()
    });
  }

  /**
   * Get all active analyses for an account (pending or processing)
   * Also includes recently-completed jobs (within 3 seconds) so frontend receives final status
   */
  async getActiveAnalyses(accountId: string): Promise<Analysis[]> {
    // Include recently-completed jobs (within 3 seconds) so frontend receives final status
    const threeSecondsAgo = new Date(Date.now() - 3000).toISOString();

    const { data, error } = await this.supabase
      .from('lead_analyses')
      .select('*')
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .or(`status.in.(pending,processing),and(status.eq.complete,completed_at.gte.${threeSecondsAgo}),and(status.eq.failed,completed_at.gte.${threeSecondsAgo})`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []) as Analysis[];
  }
}
