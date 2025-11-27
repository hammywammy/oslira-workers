// features/leads/leads.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ListLeadsQuery,
  LeadListItem,
  LeadDetail,
  LeadAnalysis,
  GetLeadAnalysesQuery,
  ExtractedDataResponse,
  AIAnalysisResponse
} from './leads.types';
import type { ExtractedData, AILeadAnalysis } from '@/infrastructure/extraction/extraction.types';

export class LeadsService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Transform extracted_data JSONB from database to API response format
   * Converts camelCase to snake_case for structured data sections
   */
  private transformExtractedData(data: ExtractedData | null): ExtractedDataResponse | null {
    if (!data) return null;

    return {
      metadata: data.metadata ? {
        version: data.metadata.version,
        sample_size: data.metadata.sampleSize,
        extracted_at: data.metadata.extractedAt
      } : null,

      static: data.static ? {
        // Content signals
        top_hashtags: data.static.topHashtags ?? [],
        top_mentions: data.static.topMentions ?? [],

        // Activity signals
        days_since_last_post: data.static.daysSinceLastPost ?? null,

        // Profile attributes
        business_category_name: data.static.businessCategoryName ?? null,
        external_url: data.static.externalUrl ?? null,
        followers_count: data.static.followersCount ?? 0,
        posts_count: data.static.postsCount ?? 0,
        is_business_account: data.static.isBusinessAccount ?? false,
        verified: data.static.verified ?? false,

        // Content patterns
        dominant_format: data.static.dominantFormat ?? null,
        format_diversity: data.static.formatDiversity ?? 0,
        posting_consistency: data.static.postingConsistency ?? null,

        // Engagement averages
        avg_likes_per_post: data.static.avgLikesPerPost ?? null,
        avg_comments_per_post: data.static.avgCommentsPerPost ?? null,
        avg_video_views: data.static.avgVideoViews ?? null
      } : null,

      calculated: data.calculated ? {
        // Core engagement metrics
        engagement_score: data.calculated.engagementScore ?? null,
        engagement_consistency: data.calculated.engagementConsistency ?? null,

        // Risk assessment
        fake_follower_warning: data.calculated.fakeFollowerWarning ?? null,

        // Profile quality scores
        authority_ratio: data.calculated.authorityRatio ?? null,
        account_maturity: data.calculated.accountMaturity ?? 0,
        engagement_health: data.calculated.engagementHealth ?? 0,
        profile_health_score: data.calculated.profileHealthScore ?? 0,
        content_sophistication: data.calculated.contentSophistication ?? 0
      } : null
    };
  }

  /**
   * Transform ai_response JSONB from database to API response format
   * Reads flattened AI analysis fields from top level of ai_response
   */
  private transformAIAnalysis(aiResponse: any, overallScore: number | null): AIAnalysisResponse | null {
    // Check if AI analysis fields exist (leadTier is required field)
    if (!aiResponse?.leadTier) {
      // No AI analysis available
      return null;
    }

    return {
      profile_assessment_score: overallScore,
      lead_tier: aiResponse.leadTier ?? null,
      niche: aiResponse.niche ?? null,
      strengths: aiResponse.strengths ?? null,
      weaknesses: aiResponse.weaknesses ?? null,
      opportunities: aiResponse.opportunities ?? null,
      recommended_actions: aiResponse.recommendedActions ?? null,
      risk_factors: aiResponse.riskFactors ?? null,
      fit_reasoning: aiResponse.fitReasoning ?? null
    };
  }

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
      // Include extracted_data and full ai_response for actionable insights
      const { data: analysesData } = await this.supabase
        .from('lead_analyses')
        .select('lead_id, analysis_type, status, completed_at, overall_score, ai_response, extracted_data')
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
        // Include lean extracted data (actionable signals only)
        extracted_data: this.transformExtractedData(analysis?.extracted_data),
        // Include AI analysis (leadTier, strengths, etc.)
        ai_analysis: this.transformAIAnalysis(analysis?.ai_response, analysis?.overall_score)
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

    // Get latest analysis with full data
    const { data: latestAnalysisData } = await this.supabase
      .from('lead_analyses')
      .select('analysis_type, status, completed_at, overall_score, ai_response, extracted_data')
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
      // Include lean extracted data (actionable signals only)
      extracted_data: this.transformExtractedData(latestAnalysisData?.extracted_data),
      // Include AI analysis (leadTier, strengths, etc.)
      ai_analysis: this.transformAIAnalysis(latestAnalysisData?.ai_response, latestAnalysisData?.overall_score)
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
      status: analysis.status,
      error_message: analysis.error_message,
      started_at: analysis.started_at,
      completed_at: analysis.completed_at,
      created_at: analysis.created_at,
      // Include lean extracted data (actionable signals only)
      extracted_data: this.transformExtractedData(analysis.extracted_data),
      // Include AI analysis (leadTier, strengths, etc.)
      ai_analysis: this.transformAIAnalysis(analysis.ai_response, analysis.overall_score)
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
