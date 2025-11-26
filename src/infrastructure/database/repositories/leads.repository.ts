// infrastructure/database/repositories/leads.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface Lead {
  id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  display_name: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  profile_pic_url: string | null;
  profile_url: string;
  external_url: string | null;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  first_analyzed_at: string;
  last_analyzed_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Phase 2: Calculated metrics JSONB
  calculated_metrics: any | null;
}

export interface UpsertLeadData {
  account_id: string;
  business_profile_id: string;
  username: string;
  display_name?: string;
  follower_count: number;
  following_count: number;
  post_count: number;
  profile_pic_url?: string;
  profile_url?: string;
  external_url?: string;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  // Phase 2: Calculated metrics JSONB (optional)
  calculated_metrics?: any;
}

export interface UpsertLeadResult {
  lead_id: string;
  is_new: boolean;
}

export class LeadsRepository extends BaseRepository<Lead> {
  constructor(supabase: SupabaseClient) {
    super(supabase, 'leads');
  }

  /**
   * Upsert lead (insert or update if exists)
   * Uses native Supabase upsert with conflict resolution
   */
  async upsertLead(data: UpsertLeadData): Promise<UpsertLeadResult> {
    // Check if lead exists
    const existing = await this.findByUsername(
      data.account_id,
      data.business_profile_id,
      data.username
    );

    const now = new Date().toISOString();

    // Build payload with timestamps
    const payload: any = {
      account_id: data.account_id,
      business_profile_id: data.business_profile_id,
      username: data.username,
      display_name: data.display_name || null,
      follower_count: data.follower_count,
      following_count: data.following_count,
      post_count: data.post_count,
      profile_pic_url: data.profile_pic_url || null,
      profile_url: data.profile_url || `https://instagram.com/${data.username}`,
      external_url: data.external_url || null,
      is_verified: data.is_verified,
      is_private: data.is_private,
      is_business_account: data.is_business_account,
      last_analyzed_at: now,
      ...(existing ? {} : {
        first_analyzed_at: now,
        created_at: now
      })
    };

    // Phase 2: Include calculated_metrics if provided
    if (data.calculated_metrics !== undefined) {
      payload.calculated_metrics = data.calculated_metrics;
    }

    const { data: result, error } = await this.supabase
      .from('leads')
      .upsert(payload, {
        onConflict: 'account_id,username',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    return {
      lead_id: result.id,
      is_new: !existing
    };
  }

  /**
   * Get leads for business profile
   */
  async getLeadsForBusiness(
    accountId: string,
    businessProfileId: string,
    options?: {
      limit?: number;
      offset?: number;
      orderBy?: 'last_analyzed_at' | 'follower_count' | 'created_at';
    }
  ): Promise<Lead[]> {
    return this.findMany(
      {
        account_id: accountId,
        business_profile_id: businessProfileId
      },
      {
        limit: options?.limit || 50,
        offset: options?.offset || 0,
        orderBy: options?.orderBy || 'last_analyzed_at',
        ascending: false
      }
    );
  }

  /**
   * Find lead by username for specific business
   */
  async findByUsername(
    accountId: string,
    businessProfileId: string,
    username: string
  ): Promise<Lead | null> {
    const { data, error } = await this.supabase
      .from('leads')
      .select('*')
      .eq('account_id', accountId)
      .eq('business_profile_id', businessProfileId)
      .eq('username', username)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return data as Lead;
  }

  /**
   * Search leads by username pattern
   */
  async searchByUsername(
    accountId: string,
    businessProfileId: string,
    searchTerm: string,
    limit: number = 20
  ): Promise<Lead[]> {
    const { data, error } = await this.supabase
      .from('leads')
      .select('*')
      .eq('account_id', accountId)
      .eq('business_profile_id', businessProfileId)
      .ilike('username', `%${searchTerm}%`)
      .is('deleted_at', null)
      .order('last_analyzed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []) as Lead[];
  }
}
