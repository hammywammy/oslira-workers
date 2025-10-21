// infrastructure/database/repositories/business.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface BusinessProfile {
  id: string;
  account_id: string;
  business_name: string;
  business_slug: string;
  business_one_liner: string | null;
  business_niche: string | null;
  target_audience: string;
  industry: string | null;
  icp_min_followers: number | null;
  icp_max_followers: number | null;
  icp_min_engagement_rate: number | null;
  icp_content_themes: string[] | null;
  icp_geographic_focus: string | null;
  icp_industry_niche: string | null;
  selling_points: string[] | null;
  brand_voice: string | null;
  outreach_goals: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class BusinessRepository extends BaseRepository<BusinessProfile> {
  constructor(supabase: SupabaseClient) {
    super(supabase, 'business_profiles');
  }

  /**
   * Get all business profiles for account
   */
  async getBusinessesForAccount(accountId: string): Promise<BusinessProfile[]> {
    return this.findMany(
      { account_id: accountId },
      {
        orderBy: 'created_at',
        ascending: false
      }
    );
  }

  /**
   * Get business by slug
   */
  async getBySlug(accountId: string, slug: string): Promise<BusinessProfile | null> {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('account_id', accountId)
      .eq('business_slug', slug)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return data as BusinessProfile;
  }

  /**
   * Create business profile with generated slug
   */
  async createBusiness(
    accountId: string,
    data: Omit<BusinessProfile, 'id' | 'account_id' | 'business_slug' | 'created_at' | 'updated_at' | 'deleted_at'>
  ): Promise<BusinessProfile> {
    // Generate slug using Supabase RPC
    const { data: slug, error: slugError } = await this.supabase
      .rpc('generate_slug', { input_text: data.business_name });

    if (slugError) throw slugError;

    return this.create({
      ...data,
      account_id: accountId,
      business_slug: slug
    } as any);
  }
}
