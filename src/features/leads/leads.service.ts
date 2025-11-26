// features/leads/leads.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ListLeadsQuery,
  LeadListItem,
  LeadDetail,
  LeadAnalysis,
  GetLeadAnalysesQuery,
  CalculatedMetricsResponse,
  AIAnalysisResponse
} from './leads.types';
import type { CalculatedMetrics, AILeadAnalysis } from '@/infrastructure/extraction/extraction.types';

export class LeadsService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Transform calculated_metrics JSONB from database to API response format
   * Converts camelCase to snake_case and flattens the nested structure
   */
  private transformCalculatedMetrics(metrics: CalculatedMetrics | null): CalculatedMetricsResponse | null {
    if (!metrics?.raw) return null;

    const raw = metrics.raw;
    const scores = metrics.scores;
    const gaps = metrics.gaps;

    return {
      // GROUP 1: Profile Metrics
      authority_ratio_raw: raw.authorityRatioRaw ?? null,
      authority_ratio: raw.authorityRatio ?? null,
      has_external_link: raw.hasExternalLink ?? null,
      external_links_count: raw.externalLinksCount ?? null,
      external_urls: raw.externalUrls ?? null,
      has_bio: raw.hasBio ?? null,
      bio_length: raw.bioLength ?? null,
      highlight_reel_count: raw.highlightReelCount ?? null,
      igtv_video_count: raw.igtvVideoCount ?? null,
      has_channel: raw.hasChannel ?? null,
      business_category_name: raw.businessCategoryName ?? null,

      // GROUP 2a: Engagement Metrics
      total_likes: raw.totalLikes ?? null,
      total_comments: raw.totalComments ?? null,
      total_engagement: raw.totalEngagement ?? null,
      avg_likes_per_post: raw.avgLikesPerPost ?? null,
      avg_comments_per_post: raw.avgCommentsPerPost ?? null,
      avg_engagement_per_post: raw.avgEngagementPerPost ?? null,
      engagement_rate: raw.engagementRate ?? null,
      comment_to_like_ratio: raw.commentToLikeRatio ?? null,
      engagement_consistency: raw.engagementConsistency ?? null,
      engagement_std_dev: raw.engagementStdDev ?? null,

      // GROUP 2b: Frequency Metrics
      posting_frequency: raw.postingFrequency ?? null,
      days_since_last_post: raw.daysSinceLastPost ?? null,
      posting_consistency: raw.postingConsistency ?? null,
      avg_days_between_posts: raw.avgDaysBetweenPosts ?? null,
      posting_period_days: raw.postingPeriodDays ?? null,
      oldest_post_timestamp: raw.oldestPostTimestamp ?? null,
      newest_post_timestamp: raw.newestPostTimestamp ?? null,

      // GROUP 2c: Format Metrics
      reels_count: raw.reelsCount ?? null,
      video_count: raw.videoCount ?? null,
      non_reels_video_count: raw.nonReelsVideoCount ?? null,
      image_count: raw.imageCount ?? null,
      carousel_count: raw.carouselCount ?? null,
      format_diversity: raw.formatDiversity ?? null,
      dominant_format: raw.dominantFormat ?? null,
      reels_rate: raw.reelsRate ?? null,
      image_rate: raw.imageRate ?? null,
      video_rate: raw.videoRate ?? null,
      carousel_rate: raw.carouselRate ?? null,

      // GROUP 2d: Content Metrics
      total_hashtags: raw.totalHashtags ?? null,
      unique_hashtag_count: raw.uniqueHashtagCount ?? null,
      avg_hashtags_per_post: raw.avgHashtagsPerPost ?? null,
      hashtag_diversity: raw.hashtagDiversity ?? null,
      top_hashtags: raw.topHashtags ?? null,
      avg_caption_length: raw.avgCaptionLength ?? null,
      avg_caption_length_non_empty: raw.avgCaptionLengthNonEmpty ?? null,
      max_caption_length: raw.maxCaptionLength ?? null,
      location_tagging_rate: raw.locationTaggingRate ?? null,
      alt_text_rate: raw.altTextRate ?? null,
      comments_enabled_rate: raw.commentsEnabledRate ?? null,
      unique_mentions_count: raw.uniqueMentionCount ?? null,
      top_mentions: raw.topMentions ?? null,

      // GROUP 3: Video Metrics
      video_post_count: raw.videoPostCount ?? null,
      total_video_views: raw.totalVideoViews ?? null,
      avg_video_views: raw.avgVideoViews ?? null,
      video_view_to_like_ratio: raw.videoViewToLikeRatio ?? null,

      // GROUP 4: Risk Scores
      fake_follower_risk_score: raw.fakeFollowerRiskScore ?? null,
      fake_follower_interpretation: this.interpretFakeFollowerRisk(raw.fakeFollowerRiskScore),
      warnings_count: raw.fakeFollowerWarnings?.length ?? null,
      warnings: raw.fakeFollowerWarnings ?? null,

      // GROUP 5: Derived Metrics
      content_density: raw.contentDensity ?? null,
      recent_viral_post_count: raw.recentViralPostCount ?? null,
      recent_posts_sampled: raw.recentPostsSampled ?? null,
      viral_post_rate: raw.viralPostRate ?? null,

      // GROUP 6: Composite Scores
      profile_health_score: scores?.profileHealthScore ?? null,
      engagement_health: scores?.engagementHealth ?? null,
      content_sophistication: scores?.contentSophistication ?? null,
      account_maturity: scores?.accountMaturity ?? null,
      fake_follower_risk: scores?.fakeFollowerRisk ?? null,

      // GROUP 7: Gap Detection
      engagement_gap: gaps?.engagementGap ?? null,
      content_gap: gaps?.contentGap ?? null,
      conversion_gap: gaps?.conversionGap ?? null,
      platform_gap: gaps?.platformGap ?? null
    };
  }

  /**
   * Interpret fake follower risk score into human-readable category
   */
  private interpretFakeFollowerRisk(score: number | null | undefined): string | null {
    if (score === null || score === undefined) return null;
    if (score <= 20) return 'LOW_RISK';
    if (score <= 50) return 'MEDIUM_RISK';
    return 'HIGH_RISK';
  }

  /**
   * Transform ai_response.phase2 JSONB from database to API response format
   * Extracts the Phase 2 AI analysis results
   */
  private transformAIAnalysis(aiResponse: any, overallScore: number | null): AIAnalysisResponse | null {
    // Check if Phase 2 AI response exists
    const phase2 = aiResponse?.phase2?.analysis as AILeadAnalysis | undefined;

    if (!phase2) {
      // No Phase 2 analysis available
      return null;
    }

    return {
      profile_assessment_score: overallScore,
      lead_tier: phase2.leadTier ?? null,
      strengths: phase2.strengths ?? null,
      weaknesses: phase2.weaknesses ?? null,
      opportunities: phase2.opportunities ?? null,
      outreach_hooks: phase2.outreachHooks ?? null,
      recommended_actions: phase2.recommendedActions ?? null,
      risk_factors: phase2.riskFactors ?? null,
      fit_reasoning: phase2.fitReasoning ?? null,
      partnership_assessment: phase2.partnershipAssessment ?? null
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
      // Include calculated_metrics and full ai_response for comprehensive data
      const { data: analysesData } = await this.supabase
        .from('lead_analyses')
        .select('lead_id, analysis_type, status, completed_at, overall_score, ai_response, calculated_metrics')
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
        summary: analysis?.ai_response?.summary || null,
        // Include all calculated metrics (80+ fields)
        calculated_metrics: this.transformCalculatedMetrics(analysis?.calculated_metrics),
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

    // Get latest analysis with full metrics
    const { data: latestAnalysisData } = await this.supabase
      .from('lead_analyses')
      .select('analysis_type, status, completed_at, overall_score, ai_response, calculated_metrics')
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
      summary: latestAnalysisData?.ai_response?.summary || null,
      // Include all calculated metrics (80+ fields)
      calculated_metrics: this.transformCalculatedMetrics(latestAnalysisData?.calculated_metrics),
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
      summary: analysis.ai_response?.summary || null,
      status: analysis.status,
      error_message: analysis.error_message,
      started_at: analysis.started_at,
      completed_at: analysis.completed_at,
      created_at: analysis.created_at,
      // Include all calculated metrics (80+ fields)
      calculated_metrics: this.transformCalculatedMetrics(analysis.calculated_metrics),
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
