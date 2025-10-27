// infrastructure/database/repositories/business.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CreateBusinessProfileInput {
  account_id: string;
  full_name: string;
  signature_name: string;
  business_one_liner: string;
  business_summary_generated: string;
  business_context: any; // JSON with all onboarding data
}

export class BusinessRepository {
  constructor(private supabase: SupabaseClient) {}

  async createBusinessProfile(input: CreateBusinessProfileInput): Promise<{
    business_profile_id: string;
  }> {
    console.log('[BusinessRepository] Creating profile for:', input.full_name);

    const { data, error } = await this.supabase
      .from('business_profiles')
      .insert({
        account_id: input.account_id,
        full_name: input.full_name,
        signature_name: input.signature_name,
        business_one_liner: input.business_one_liner,
        business_summary_generated: input.business_summary_generated,
        business_context: input.business_context
      })
      .select('id')
      .single();

    if (error) {
      console.error('[BusinessRepository] Insert failed:', error);
      throw new Error(`Failed to create profile: ${error.message}`);
    }

    console.log('[BusinessRepository] Success:', data.id);
    return { business_profile_id: data.id };
  }

  async getBusinessProfile(businessProfileId: string) {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('id', businessProfileId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get profile: ${error.message}`);
    }

    return data;
  }

  async getBusinessProfileByAccountId(accountId: string) {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get profile: ${error.message}`);
    }

    return data;
  }
}
