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
  bio_text: string | null;
  profile_picture_url: string | null;
  external_url: string | null;
  is_verified_account: boolean;
  is_private_account: boolean;
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
  bio_text?: string;
  profile_picture_url?: string;
  external_url?: string;
  is_verified_account: boolean;
  is_private_account: boolean;
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
   * Uses Supabase RPC function for atomic operation
   */
  async upsertLead(data: UpsertLeadData): Promise<UpsertLeadResult> {
    const { data: result, error } = await this.supabase
      .rpc('upsert_lead', {
        p_username: data.username,
        p_account_id: data.account_id,
        p_business_profile_id: data.business_profile_id,
        p_follower_count: data.follower_count,
        p_following_count: data.following_count,
        p_bio_text: data.bio_text || null,
        p_profile_picture_url: data.profile_picture_url || null,
        p_external_url: data.external_url || null,
        p_is_verified_account: data.is_verified_account,
        p_is_private_account: data.is_private_account,
        p_is_business_account: data.is_business_account,
        p_display_name: data.display_name || null
      });

    if (error) throw error;

    return {
      lead_id: result.id,
      is_new: result.is_new
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
