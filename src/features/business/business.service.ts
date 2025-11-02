// features/business/business.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type { 
  ListBusinessProfilesQuery,
  CreateBusinessProfileInput,
  UpdateBusinessProfileInput,
  BusinessProfileListItem,
  BusinessProfileDetail
} from './business.types';

export class BusinessService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * List all business profiles for account
   * FIXED: Uses actual database column names
   */
  async listProfiles(
    accountId: string,
    query: ListBusinessProfilesQuery
  ): Promise<{ profiles: BusinessProfileListItem[]; total: number }> {
    const { page, pageSize } = query;
    const offset = (page - 1) * pageSize;

    console.log('[BusinessService] listProfiles ENTRY', {
      accountId,
      page,
      pageSize,
      offset
    });

    // Query with ACTUAL database columns
    const { data, error, count } = await this.supabase
      .from('business_profiles')
      .select(`
        id,
        full_name,
        signature_name,
        business_name,
        business_one_liner,
        created_at,
        updated_at
      `, { count: 'exact' })
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    console.log('[BusinessService] Query executed', {
      has_error: !!error,
      data_length: data?.length || 0,
      count,
      error_code: error?.code,
      error_message: error?.message,
      error_details: error?.details,
      error_hint: error?.hint
    });

    if (error) {
      console.error('[BusinessService] listProfiles query error:', {
        error_code: error.code,
        error_message: error.message,
        error_details: error.details,
        error_hint: error.hint,
        full_error: JSON.stringify(error)
      });
      throw error;
    }

    // Check if we got data
    if (!data || data.length === 0) {
      console.log('[BusinessService] No profiles found', {
        accountId,
        count
      });
      return { profiles: [], total: 0 };
    }

    console.log('[BusinessService] listProfiles query success', {
      profiles_count: data?.length || 0,
      total: count
    });

    // Get leads and analyses counts for each profile
    const profiles: BusinessProfileListItem[] = await Promise.all(
      (data || []).map(async (profile) => {
        // Count leads
        const { count: leadsCount } = await this.supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('business_profile_id', profile.id)
          .is('deleted_at', null);

        // Count analyses
        const { count: analysesCount } = await this.supabase
          .from('analyses')
          .select('id', { count: 'exact', head: true })
          .eq('business_profile_id', profile.id)
          .is('deleted_at', null);

        return {
          id: profile.id,
          business_name: profile.business_name || profile.full_name, // Use business_name, fallback to full_name
          website: null, // Column doesn't exist in DB
          business_one_liner: profile.business_one_liner,
          leads_count: leadsCount || 0,
          analyses_count: analysesCount || 0,
          created_at: profile.created_at,
          updated_at: profile.updated_at
        };
      })
    );

    return { profiles, total: count || 0 };
  }

  /**
   * Get single business profile with full details
   * FIXED: Uses actual database column names
   */
  async getProfileById(
    accountId: string,
    profileId: string
  ): Promise<BusinessProfileDetail | null> {
    const { data: profile, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('id', profileId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    // Get counts
    const { count: leadsCount } = await this.supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('business_profile_id', profileId)
      .is('deleted_at', null);

    const { count: analysesCount } = await this.supabase
      .from('analyses')
      .select('id', { count: 'exact', head: true })
      .eq('business_profile_id', profileId)
      .is('deleted_at', null);

    return {
      id: profile.id,
      account_id: profile.account_id,
      business_name: profile.business_name || profile.full_name, // Use business_name, fallback to full_name
      website: null, // Column doesn't exist
      business_one_liner: profile.business_one_liner,
      business_context_pack: profile.business_context || {}, // Map business_context to business_context_pack
      context_version: profile.context_version,
      context_generated_at: profile.context_generated_at,
      context_manually_edited: profile.context_manually_edited,
      context_updated_at: profile.context_updated_at,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      leads_count: leadsCount || 0,
      analyses_count: analysesCount || 0
    };
  }

  /**
   * Create new business profile
   */
  async createProfile(
    accountId: string,
    input: CreateBusinessProfileInput
  ): Promise<BusinessProfileDetail> {
    const { data: profile, error } = await this.supabase
      .from('business_profiles')
      .insert({
        account_id: accountId,
        business_name: input.business_name, // Use business_name directly
        full_name: input.business_name, // Also set full_name for backwards compatibility
        signature_name: input.business_name.toLowerCase().replace(/\s+/g, '_'),
        business_one_liner: input.business_one_liner,
        business_context: input.business_context_pack, // Map business_context_pack to business_context
        context_version: 'v1.0',
        context_manually_edited: true,
        context_updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return {
      id: profile.id,
      account_id: profile.account_id,
      business_name: profile.business_name || profile.full_name,
      website: null,
      business_one_liner: profile.business_one_liner,
      business_context_pack: profile.business_context || {},
      context_version: profile.context_version,
      context_generated_at: profile.context_generated_at,
      context_manually_edited: profile.context_manually_edited,
      context_updated_at: profile.context_updated_at,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      leads_count: 0,
      analyses_count: 0
    };
  }

  /**
   * Update business profile
   */
  async updateProfile(
    accountId: string,
    profileId: string,
    input: UpdateBusinessProfileInput
  ): Promise<BusinessProfileDetail> {
    // First verify ownership
    const exists = await this.verifyProfileOwnership(accountId, profileId);
    if (!exists) {
      throw new Error('Business profile not found');
    }

    const updateData: any = {
      updated_at: new Date().toISOString()
    };

    if (input.business_name !== undefined) {
      updateData.business_name = input.business_name;
      updateData.full_name = input.business_name; // Keep full_name in sync
    }
    if (input.business_one_liner !== undefined) {
      updateData.business_one_liner = input.business_one_liner;
    }
    if (input.business_context_pack !== undefined) {
      // Merge with existing context
      const { data: current } = await this.supabase
        .from('business_profiles')
        .select('business_context')
        .eq('id', profileId)
        .single();

      updateData.business_context = {
        ...(current?.business_context || {}),
        ...input.business_context_pack
      };
      updateData.context_manually_edited = true;
      updateData.context_updated_at = new Date().toISOString();
    }

    const { data: profile, error } = await this.supabase
      .from('business_profiles')
      .update(updateData)
      .eq('id', profileId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .select()
      .single();

    if (error) throw error;

    // Get counts
    const { count: leadsCount } = await this.supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('business_profile_id', profileId)
      .is('deleted_at', null);

    const { count: analysesCount } = await this.supabase
      .from('analyses')
      .select('id', { count: 'exact', head: true })
      .eq('business_profile_id', profileId)
      .is('deleted_at', null);

    return {
      id: profile.id,
      account_id: profile.account_id,
      business_name: profile.business_name || profile.full_name,
      website: null,
      business_one_liner: profile.business_one_liner,
      business_context_pack: profile.business_context || {},
      context_version: profile.context_version,
      context_generated_at: profile.context_generated_at,
      context_manually_edited: profile.context_manually_edited,
      context_updated_at: profile.context_updated_at,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      leads_count: leadsCount || 0,
      analyses_count: analysesCount || 0
    };
  }

  /**
   * Verify profile belongs to account (authorization check)
   */
  async verifyProfileOwnership(accountId: string, profileId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('id')
      .eq('id', profileId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return false;
      throw error;
    }

    return !!data;
  }
}
