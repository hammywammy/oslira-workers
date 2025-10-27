// infrastructure/database/repositories/business.repository.ts
// FIXED: Added idempotent createBusinessProfile method for workflow

import type { SupabaseClient } from '@supabase/supabase-js';
import { BaseRepository } from './base.repository';

export interface BusinessProfile {
  id: string;
  account_id: string;
  business_name: string;
  website: string | null;
  business_one_liner: string | null;
  ideal_customer_profile: any;
  context_version: string;
  context_generated_at: string | null;
  context_manually_edited: boolean;
  context_updated_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  signature_name: string | null;
  operational_metadata: any;
  business_summary_generated: string | null;
}

// NEW: Interface for workflow-specific creation
export interface CreateBusinessProfileData {
  account_id: string;
  business_name: string;
  signature_name: string;
  business_one_liner: string;
  business_summary: string; // User's raw input (not stored in table directly)
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
   * Get business by account_id and signature_name (for idempotency check)
   * This is our "unique key" for workflow retries
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
   * IDEMPOTENT: Create business profile (for workflow use)
   * 
   * CRITICAL: This method is idempotent and safe for workflow retries.
   * - First checks if profile already exists (by account_id + signature_name)
   * - Returns existing profile if found (idempotency)
   * - Only inserts if truly new
   * 
   * This follows Cloudflare Workflows best practices:
   * "Check if operation already completed before executing non-idempotent actions"
   */
  async createBusinessProfile(
    data: CreateBusinessProfileData
  ): Promise<{ business_profile_id: string; was_created: boolean }> {
    console.log('[BusinessRepository] createBusinessProfile called', {
      account_id: data.account_id,
      business_name: data.business_name,
      signature_name: data.signature_name
    });

    // =========================================================================
    // STEP 1: IDEMPOTENCY CHECK
    // Check if this profile was already created (retry scenario)
    // =========================================================================
    
    const existing = await this.getByAccountAndSignature(
      data.account_id,
      data.signature_name
    );

    if (existing) {
      console.log('[BusinessRepository] IDEMPOTENCY: Profile already exists, returning existing', {
        existing_id: existing.id,
        created_at: existing.created_at
      });

      return {
        business_profile_id: existing.id,
        was_created: false
      };
    }

    // =========================================================================
    // STEP 2: INSERT NEW PROFILE
    // Only reached if profile doesn't exist
    // =========================================================================

    console.log('[BusinessRepository] Creating new business profile...');

    const { data: profile, error } = await this.supabase
      .from('business_profiles')
      .insert({
        account_id: data.account_id,
        business_name: data.business_name,
        signature_name: data.signature_name,
        website: data.website || null,
        business_one_liner: data.business_one_liner,
        ideal_customer_profile: {
          business_description: data.business_summary, // Store raw summary
          target_audience: data.target_audience,
          industry: data.industry,
          icp_min_followers: data.icp_min_followers,
          icp_max_followers: data.icp_max_followers,
          brand_voice: data.brand_voice
        },
        operational_metadata: {
          ...data.operational_metadata,
          company_size: data.company_size,
          ai_generation_metadata: data.ai_generation_metadata
        },
        business_summary_generated: data.business_summary_generated,
        context_version: 'v1.0',
        context_generated_at: new Date().toISOString(),
        context_manually_edited: false,
        context_updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[BusinessRepository] Insert failed:', {
        error_code: error.code,
        error_message: error.message,
        error_details: error.details
      });
      throw error;
    }

    console.log('[BusinessRepository] Profile created successfully', {
      profile_id: profile.id
    });

    return {
      business_profile_id: profile.id,
      was_created: true
    };
  }

  /**
   * LEGACY: Create business profile with generated slug (not used by workflow)
   */
  async createBusiness(
    accountId: string,
    data: Omit<BusinessProfile, 'id' | 'account_id' | 'created_at' | 'updated_at' | 'deleted_at'>
  ): Promise<BusinessProfile> {
    return this.create({
      ...data,
      account_id: accountId
    } as any);
  }
}
