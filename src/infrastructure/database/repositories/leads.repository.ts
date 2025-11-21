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
  external_url: string | null;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  first_analyzed_at: string;
  last_analyzed_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  external_url?: string;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
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
    const payload = {
      ...data,
      display_name: data.display_name || null,
      profile_pic_url: data.profile_pic_url || null,
      external_url: data.external_url || null,
      last_analyzed_at: now,
      ...(existing ? {} : {
        first_analyzed_at: now,
        created_at: now
      })
    };

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
