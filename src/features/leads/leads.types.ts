// features/leads/leads.types.ts

import { z } from 'zod';
import { CommonSchemas } from '@/shared/utils/validation.util';

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

export const ListLeadsQuerySchema = z.object({
  businessProfileId: CommonSchemas.uuid,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  sortBy: z.enum(['last_analyzed_at', 'follower_count', 'created_at']).default('last_analyzed_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional()
});

export const GetLeadParamsSchema = z.object({
  leadId: CommonSchemas.uuid
});

export const GetLeadAnalysesQuerySchema = z.object({
  leadId: CommonSchemas.uuid,
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const DeleteLeadParamsSchema = z.object({
  leadId: CommonSchemas.uuid
});

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

/**
 * Hashtag frequency data
 */
export interface HashtagFrequency {
  hashtag: string;
  count: number;
}

/**
 * Mention frequency data
 */
export interface MentionFrequency {
  username: string;
  count: number;
}

/**
 * External link info
 */
export interface ExternalLinkInfo {
  url: string;
  title: string;
  linkType: string;
}

/**
 * Structured extracted data returned by API
 * Organized into static, calculated, and metadata sections
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface ExtractedDataResponse {
  metadata: {
    version: string;
    sample_size: number;
    extracted_at: string;
  } | null;

  static: {
    // Content signals
    top_hashtags: HashtagFrequency[];
    top_mentions: MentionFrequency[];

    // Activity signals
    days_since_last_post: number | null;

    // Profile attributes
    business_category_name: string | null;
    external_url: string | null;
    followers_count: number;
    posts_count: number;
    is_business_account: boolean;
    verified: boolean;

    // Content patterns
    dominant_format: string | null;
    format_diversity: number;
    posting_consistency: number | null;

    // Engagement averages
    avg_likes_per_post: number | null;
    avg_comments_per_post: number | null;
    avg_video_views: number | null;
  } | null;

  calculated: {
    // Core engagement metrics
    engagement_score: number | null;
    engagement_consistency: number | null;

    // Risk assessment
    fake_follower_warning: string | null;

    // Profile quality scores
    authority_ratio: number | null;
    account_maturity: number;
    engagement_health: number;
    profile_health_score: number;
    content_sophistication: number;
  } | null;
}

/**
 * AI analysis results returned by API
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface AIAnalysisResponse {
  profile_assessment_score: number | null;
  lead_tier: 'hot' | 'warm' | 'cold' | null;
  niche: string | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  opportunities: string[] | null;
  recommended_actions: string[] | null;
  risk_factors: string[] | null;
  fit_reasoning: string | null;
}

export interface LeadListItem {
  id: string;
  username: string;
  display_name: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  platform: string;
  profile_pic_url: string | null;
  profile_url: string;
  external_url: string | null;
  last_analyzed_at: string;
  created_at: string;
  // Latest analysis fields (null if no analysis)
  analysis_type: 'light' | 'deep' | 'private' | 'not_found' | null;
  analysis_status: string | null;
  analysis_completed_at: string | null;
  overall_score: number | null;

  // ========== EXTRACTED DATA (from lead_analyses.extracted_data) ==========
  extracted_data: ExtractedDataResponse | null;

  // ========== AI ANALYSIS (from lead_analyses.ai_response.phase2) ==========
  ai_analysis: AIAnalysisResponse | null;
}

export interface LeadDetail {
  id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  display_name: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  external_url: string | null;
  profile_pic_url: string | null;
  profile_url: string;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  platform: string;
  first_analyzed_at: string;
  last_analyzed_at: string;
  created_at: string;
  analyses_count: number;
  // Latest analysis fields (null if no analysis)
  analysis_type: 'light' | 'deep' | 'private' | 'not_found' | null;
  analysis_status: string | null;
  analysis_completed_at: string | null;
  overall_score: number | null;

  // ========== EXTRACTED DATA (from lead_analyses.extracted_data) ==========
  extracted_data: ExtractedDataResponse | null;

  // ========== AI ANALYSIS (from lead_analyses.ai_response.phase2) ==========
  ai_analysis: AIAnalysisResponse | null;
}

export interface LeadAnalysis {
  id: string;
  run_id: string;
  analysis_type: 'light' | 'deep' | 'private' | 'not_found';
  overall_score: number;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;

  // ========== EXTRACTED DATA (from lead_analyses.extracted_data) ==========
  extracted_data: ExtractedDataResponse | null;

  // ========== AI ANALYSIS (from lead_analyses.ai_response.phase2) ==========
  ai_analysis: AIAnalysisResponse | null;
}

// ===============================================================================
// TYPE EXPORTS
// ===============================================================================

export type ListLeadsQuery = z.infer<typeof ListLeadsQuerySchema>;
export type GetLeadParams = z.infer<typeof GetLeadParamsSchema>;
export type GetLeadAnalysesQuery = z.infer<typeof GetLeadAnalysesQuerySchema>;
export type DeleteLeadParams = z.infer<typeof DeleteLeadParamsSchema>;
