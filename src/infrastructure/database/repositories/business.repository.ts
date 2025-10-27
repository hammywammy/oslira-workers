// infrastructure/database/repositories/business.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * BUSINESS REPOSITORY - STREAMLINED 4-STEP
 * 
 * Database operations for business profiles
 * Uses full_name (e.g. "Hamza Williams") + signature_name (e.g. "Hamza")
 */

export interface CreateBusinessProfileInput {
  account_id: string;
  full_name: string;           // NEW: "Hamza Williams"
  signature_name: string;       // NEW: "Hamza" (first name only)
  business_name: string;
  business_one_liner: string;
  business_summary: string;
  business_summary_generated: string;
  website?: string | null;
  industry: string;
  company_size: string;
  target_audience: string;
  icp_min_followers: number;
  icp_max_followers: number;
  brand_voice: string;
  operational_metadata: any;
  ai_generation_metadata: any;
}

export interface BusinessProfile {
  id: string;
  account_id: string;
  full_name: string;
  signature_name: string;
  business_name: string;
  business_one_liner: string;
  business_summary: string;
  business_summary_generated: string;
  website: string | null;
  industry: string;
  company_size: string;
  target_audience: string;
  icp_min_followers: number;
  icp_max_followers: number;
  brand_voice: string;
  business_context_pack: any;
  created_at: string;
  updated_at: string;
}

export class BusinessRepository {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Create new business profile
   */
  async createBusinessProfile(input: CreateBusinessProfileInput): Promise<{
    business_profile_id: string;
  }> {
    console.log('[BusinessRepository] createBusinessProfile called', {
      account_id: input.account_id,
      full_name: input.full_name,
      signature_name: input.signature_name,
      business_name: input.business_name
    });

    console.log('[BusinessRepository] Creating new business profile...');

    const { data, error } = await this.supabase
      .from('business_profiles')
      .insert({
        account_id: input.account_id,
        full_name: input.full_name,
        signature_name: input.signature_name,
        business_name: input.business_name,
        business_one_liner: input.business_one_liner,
        business_summary: input.business_summary,
        business_summary_generated: input.business_summary_generated,
        website: input.website,
        industry: input.industry,
        company_size: input.company_size,
        target_audience: input.target_audience,
        business_context_pack: {
          // ICP data
          icp_min_followers: input.icp_min_followers,
          icp_max_followers: input.icp_max_followers,
          brand_voice: input.brand_voice,
          target_audience: input.target_audience,
          industry: input.industry,
          
          // Operational metadata
          ...input.operational_metadata,
          
          // AI generation metadata
          ai_generation_metadata: input.ai_generation_metadata
        }
      })
      .select('id')
      .single();

    if (error) {
      console.error('[BusinessRepository] Creation failed:', error);
      throw new Error(`Failed to create business profile: ${error.message}`);
    }

    console.log('[BusinessRepository] Profile created successfully', {
      profile_id: data.id
    });

    return {
      business_profile_id: data.id
    };
  }

  /**
   * Get business profile by ID
   */
  async getBusinessProfile(businessProfileId: string): Promise<BusinessProfile | null> {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('id', businessProfileId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw new Error(`Failed to get business profile: ${error.message}`);
    }

    return data;
  }

  /**
   * Get business profile by account ID
   */
  async getBusinessProfileByAccountId(accountId: string): Promise<BusinessProfile | null> {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw new Error(`Failed to get business profile: ${error.message}`);
    }

    return data;
  }

  /**
   * Update business profile
   */
  async updateBusinessProfile(
    businessProfileId: string,
    updates: Partial<CreateBusinessProfileInput>
  ): Promise<void> {
    const { error } = await this.supabase
      .from('business_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', businessProfileId);

    if (error) {
      throw new Error(`Failed to update business profile: ${error.message}`);
    }
  }

  /**
   * Delete business profile
   */
  async deleteBusinessProfile(businessProfileId: string): Promise<void> {
    const { error } = await this.supabase
      .from('business_profiles')
      .delete()
      .eq('id', businessProfileId);

    if (error) {
      throw new Error(`Failed to delete business profile: ${error.message}`);
    }
  }
}
