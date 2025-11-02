// infrastructure/database/repositories/business.repository.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface BusinessProfile {
  id: string;
  account_id: string;
  full_name: string;
  signature_name: string;
  business_one_liner: string | null;
  business_summary_generated: string | null;
  business_context: any;
  ideal_customer_profile: any;
  context_version: string;
  context_generated_at: string | null;
  context_manually_edited: boolean;
  context_updated_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ===============================================================================
// WORKFLOW-SPECIFIC CREATION INTERFACE
// ===============================================================================

export interface CreateBusinessProfileData {
  account_id: string;
  full_name: string;
  signature_name: string;
  business_name: string;
  business_one_liner: string;
  business_summary_generated: string;
  
  // User inputs for manual JSON construction
  business_summary: string;
  communication_tone: string;
  target_description: string;
  icp_min_followers: number;
  icp_max_followers: number;
  target_company_sizes: string[];
  
  // AI generation metadata
  ai_generation_metadata: {
    model_used: string;
    total_tokens: number;
    total_cost: number;
    generation_time_ms: number;
    generated_at: string;
  };
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
   * Get business by account_id and signature_name (idempotency check)
   */
  async getByAccountAndSignature(
    accountId: string,
    signatureName: string
  ): Promise<BusinessProfile | null> {
    const { data, error } = await this.supabase
      .from('business_profiles')
      .select('*')
      .eq('account_id', accountId)
      .eq('signature_name', signatureName)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[BusinessRepository] getByAccountAndSignature error:', error);
      throw error;
    }

    return data as BusinessProfile | null;
  }

  /**
   * IDEMPOTENT: Create business profile
   * 
   * - Checks for existing profile by account_id + signature_name
   * - Manually constructs business_context and ideal_customer_profile JSONs
   * - NO AI-generated structured data (zero hallucination risk)
   * - Safe for workflow retries
   */
  async createBusinessProfile(
    data: CreateBusinessProfileData
  ): Promise<{ business_profile_id: string; was_created: boolean }> {
    
    console.log('[BusinessRepository] createBusinessProfile ENTRY', {
      account_id: data.account_id,
      full_name: data.full_name,
      signature_name: data.signature_name
    });

    // =========================================================================
    // IDEMPOTENCY CHECK
    // =========================================================================
    
    const existing = await this.getByAccountAndSignature(
      data.account_id,
      data.signature_name
    );

    if (existing) {
      console.log('[BusinessRepository] IDEMPOTENCY: Profile already exists', {
        profile_id: existing.id,
        created_at: existing.created_at
      });
      
      return {
        business_profile_id: existing.id,
        was_created: false
      };
    }

    // =========================================================================
    // MANUALLY CONSTRUCT JSONs (no AI, no hallucination)
    // =========================================================================
    
    const business_context = {
      business_summary: data.business_summary,
      communication_tone: data.communication_tone,
      target_description: data.target_description,
      icp_min_followers: data.icp_min_followers,
      icp_max_followers: data.icp_max_followers,
      target_company_sizes: data.target_company_sizes,
      ai_generation: data.ai_generation_metadata
    };

    const ideal_customer_profile = {
      business_description: data.business_summary,
      target_audience: data.target_description,
      icp_min_followers: data.icp_min_followers,
      icp_max_followers: data.icp_max_followers,
      brand_voice: data.communication_tone
    };

    console.log('[BusinessRepository] JSONs constructed', {
      business_context_keys: Object.keys(business_context),
      icp_keys: Object.keys(ideal_customer_profile)
    });

    // =========================================================================
    // DATABASE INSERT
    // =========================================================================
    
    console.log('[BusinessRepository] Inserting into business_profiles...');

    const { data: profile, error } = await this.supabase
      .from('business_profiles')
      .insert({
        account_id: data.account_id,
        full_name: data.full_name,
        signature_name: data.signature_name,
        business_name: data.business_name,
        business_one_liner: data.business_one_liner,
        business_summary_generated: data.business_summary_generated,
        business_context: business_context,
        ideal_customer_profile: ideal_customer_profile,
        context_version: 'v1.0',
        context_generated_at: new Date().toISOString(),
        context_manually_edited: false,
        context_updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[BusinessRepository] Insert FAILED', {
        error_code: error.code,
        error_message: error.message,
        error_details: error.details,
        error_hint: error.hint
      });
      throw error;
    }

    console.log('[BusinessRepository] ✓ Profile created successfully', {
      profile_id: profile.id
    });

    return {
      business_profile_id: profile.id,
      was_created: true
    };
  }

  /**
   * Find business profile by ID
   */
  async findById(id: string): Promise<BusinessProfile | null> {
    return this.findOne({ id });
  }
}
