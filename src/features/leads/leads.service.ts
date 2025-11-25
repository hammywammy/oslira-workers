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
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .eq('business_profile_id', businessProfileId)
      .is('deleted_at', null);

    // Search by username
    if (search) {
      queryBuilder = queryBuilder.ilike('username', `%${search}%`);
    }

    // Sort
    queryBuilder = queryBuilder.order(sortBy, { ascending: sortOrder === 'asc' });

    // Paginate
    queryBuilder = queryBuilder.range(offset, offset + pageSize - 1);

    const { data: leads, error, count } = await queryBuilder;

    if (error) throw error;

    // Get latest analysis for each lead
    const leadIds = (leads || []).map((l: any) => l.id);

    let latestAnalyses: any[] = [];
    if (leadIds.length > 0) {
      // Get most recent completed analysis for each lead
      const { data: analysesData } = await this.supabase
        .from('lead_analyses')
        .select('lead_id, analysis_type, status, completed_at, overall_score, ai_response')
        .in('lead_id', leadIds)
        .eq('account_id', accountId)
        .eq('status', 'complete')
        .is('deleted_at', null)
        .order('completed_at', { ascending: false });

      // Group by lead_id and take first (most recent) for each
      const analysisMap = new Map();
      (analysesData || []).forEach((a: any) => {
        if (!analysisMap.has(a.lead_id)) {
          analysisMap.set(a.lead_id, a);
        }
      });
      latestAnalyses = Array.from(analysisMap.values());
    }

    // Merge lead data with analysis data
    const leadsWithAnalysis: LeadListItem[] = (leads || []).map((lead: any) => {
      const analysis = latestAnalyses.find((a: any) => a.lead_id === lead.id);

      return {
        id: lead.id,
        username: lead.username,
        display_name: lead.display_name,
        follower_count: lead.follower_count,
        following_count: lead.following_count,
        post_count: lead.post_count,
        is_verified: lead.is_verified,
        is_private: lead.is_private,
        is_business_account: lead.is_business_account,
        platform: lead.platform,
        profile_pic_url: lead.profile_pic_url,
        profile_url: lead.profile_url,
        external_url: lead.external_url,
        last_analyzed_at: lead.last_analyzed_at,
        created_at: lead.created_at,
        analysis_type: analysis?.analysis_type || null,
        analysis_status: analysis?.status || null,
        analysis_completed_at: analysis?.completed_at || null,
        overall_score: analysis?.overall_score || null,
        summary: analysis?.ai_response?.summary || null
      };
    });

    return { leads: leadsWithAnalysis, total: count || 0 };
  }

  /**
   * Get single lead with full details
   */
  async getLeadById(accountId: string, leadId: string): Promise<LeadDetail | null> {
    // Get lead
    const { data: lead, error } = await this.supabase
      .from('leads')
      .select('*')
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
      .from('lead_analyses')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .is('deleted_at', null);

    // Get latest analysis
    const { data: latestAnalysisData } = await this.supabase
      .from('lead_analyses')
      .select('analysis_type, status, completed_at, overall_score, ai_response')
      .eq('lead_id', leadId)
      .eq('account_id', accountId)
      .eq('status', 'complete')
      .is('deleted_at', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      id: lead.id,
      account_id: lead.account_id,
      business_profile_id: lead.business_profile_id,
      username: lead.username,
      display_name: lead.display_name,
      follower_count: lead.follower_count,
      following_count: lead.following_count,
      post_count: lead.post_count,
      external_url: lead.external_url,
      profile_pic_url: lead.profile_pic_url,
      profile_url: lead.profile_url,
      is_verified: lead.is_verified,
      is_private: lead.is_private,
      is_business_account: lead.is_business_account,
      platform: lead.platform,
      first_analyzed_at: lead.first_analyzed_at,
      last_analyzed_at: lead.last_analyzed_at,
      created_at: lead.created_at,
      analyses_count: count || 0,
      analysis_type: latestAnalysisData?.analysis_type || null,
      analysis_status: latestAnalysisData?.status || null,
      analysis_completed_at: latestAnalysisData?.completed_at || null,
      overall_score: latestAnalysisData?.overall_score || null,
      summary: latestAnalysisData?.ai_response?.summary || null
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
      .from('lead_analyses')
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
      run_id: analysis.run_id,
      analysis_type: analysis.analysis_type,
      overall_score: analysis.overall_score,
      summary: analysis.ai_response?.summary || null,
      status: analysis.status,
      error_message: analysis.error_message,
      started_at: analysis.started_at,
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
