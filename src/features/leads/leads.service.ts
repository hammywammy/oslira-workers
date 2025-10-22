// features/leads/leads.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type { 
  ListLeadsQuery, 
  LeadListItem, 
  LeadDetail, 
  LeadAnalysis,
  GetLeadAnalysesQuery 
} from './leads.types';

export class LeadsService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * List all leads for account with pagination
   */
  async listLeads(
    accountId: string,
    query: ListLeadsQuery
  ): Promise<{ leads: LeadListItem[]; total: number }> {
    const { businessProfileId, page, pageSize, sortBy, sortOrder, search } = query;
    const offset = (page - 1) * pageSize;

    // Build base query
    let queryBuilder = this.supabase
      .from('leads')
      .select(`
        id,
        instagram_username,
        display_name,
        follower_count,
        is_verified,
        is_business_account,
        profile_pic_url,
        last_analyzed_at,
        created_at,
        analyses!inner (
          id,
          analysis_type,
          overall_score,
          completed_at
        )
      `, { count: 'exact' })
      .eq('account_id', accountId)
      .is('deleted_at', null);

    // Filter by business profile if provided
    if (businessProfileId) {
      queryBuilder = queryBuilder.eq('business_profile_id', businessProfileId);
    }

    // Search by username
    if (search) {
      queryBuilder = queryBuilder.ilike('instagram_username', `%${search}%`);
    }

    // Sort
    queryBuilder = queryBuilder.order(sortBy, { ascending: sortOrder === 'asc' });

    // Paginate
    queryBuilder = queryBuilder.range(offset, offset + pageSize - 1);

    const { data, error, count } = await queryBuilder;

    if (error) throw error;

    // Transform results - get latest analysis per lead
    const leads: LeadListItem[] = (data || []).map((lead: any) => {
      const analyses = Array.isArray(lead.analyses) ? lead.analyses : [lead.analyses];
      const latestAnalysis = analyses
        .filter((a: any) => a.completed_at)
        .sort((a: any, b: any) => 
          new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
        )[0] || null;

      return {
        id: lead.id,
        instagram_username: lead.instagram_username,
        display_name: lead.display_name,
        follower_count: lead.follower_count,
        is_verified: lead.is_verified,
        is_business_account: lead.is_business_account,
        profile_pic_url: lead.profile_pic_url,
        last_analyzed_at: lead.last_analyzed_at,
        latest_analysis: latestAnalysis ? {
          id: latestAnalysis.id,
          analysis_type: latestAnalysis.analysis_type,
          overall_score: latestAnalysis.overall_score,
          completed_at: latestAnalysis.completed_at
        } : null,
        created_at: lead.created_at
      };
    });

    return { leads, total: count || 0 };
  }

  /**
   * Get single lead with full details
   */
  async getLeadById(accountId: string, leadId: string): Promise<LeadDetail | null> {
    // Get lead with latest analysis
    const { data: lead, error } = await this.supabase
      .from('leads')
      .select(`
        *,
        analyses!inner (
          id,
          analysis_type,
          overall_score,
          niche_fit_score,
          engagement_score,
          confidence_level,
          completed_at
        )
      `)
      .eq('id', leadId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    // Get analyses count
    const { count } = await this.supabase
      .from('analyses')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .is('deleted_at', null);

    // Get latest analysis
    const analyses = Array.isArray(lead.analyses) ? lead.analyses : [lead.analyses];
    const latestAnalysis = analyses
      .filter((a: any) => a.completed_at)
      .sort((a: any, b: any) => 
        new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
      )[0] || null;

    return {
      id: lead.id,
      account_id: lead.account_id,
      business_profile_id: lead.business_profile_id,
      instagram_username: lead.instagram_username,
      display_name: lead.display_name,
      follower_count: lead.follower_count,
      following_count: lead.following_count,
      post_count: lead.post_count,
      bio: lead.bio,
      external_url: lead.external_url,
      profile_pic_url: lead.profile_pic_url,
      is_verified: lead.is_verified,
      is_private: lead.is_private,
      is_business_account: lead.is_business_account,
      first_analyzed_at: lead.first_analyzed_at,
      last_analyzed_at: lead.last_analyzed_at,
      created_at: lead.created_at,
      analyses_count: count || 0,
      latest_analysis: latestAnalysis ? {
        id: latestAnalysis.id,
        analysis_type: latestAnalysis.analysis_type,
        overall_score: latestAnalysis.overall_score,
        niche_fit_score: latestAnalysis.niche_fit_score,
        engagement_score: latestAnalysis.engagement_score,
        confidence_level: latestAnalysis.confidence_level,
        completed_at: latestAnalysis.completed_at
      } : null
    };
  }

  /**
   * Get analysis history for lead
   */
  async getLeadAnalyses(
    accountId: string,
    query: GetLeadAnalysesQuery
  ): Promise<LeadAnalysis[]> {
    const { leadId, limit, analysisType } = query;

    let queryBuilder = this.supabase
      .from('analyses')
      .select('*')
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (analysisType) {
      queryBuilder = queryBuilder.eq('analysis_type', analysisType);
    }

    const { data, error } = await queryBuilder;

    if (error) throw error;

    return (data || []).map(analysis => ({
      id: analysis.id,
      analysis_type: analysis.analysis_type,
      overall_score: analysis.overall_score,
      niche_fit_score: analysis.niche_fit_score,
      engagement_score: analysis.engagement_score,
      confidence_level: analysis.confidence_level,
      status: analysis.status,
      credits_charged: analysis.credits_charged,
      model_used: analysis.model_used,
      processing_duration_ms: analysis.processing_duration_ms,
      completed_at: analysis.completed_at,
      created_at: analysis.created_at
    }));
  }

  /**
   * Soft delete lead
   */
  async deleteLead(accountId: string, leadId: string): Promise<void> {
    const { error } = await this.supabase
      .from('leads')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', leadId)
      .eq('account_id', accountId)
      .is('deleted_at', null);

    if (error) throw error;
  }

  /**
   * Verify lead belongs to account (authorization check)
   */
  async verifyLeadOwnership(accountId: string, leadId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
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
