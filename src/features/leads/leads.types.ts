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
 * Complete calculated metrics returned by API
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface CalculatedMetricsResponse {
  // ========== GROUP 1: Profile Metrics (17 fields) ==========
  authority_ratio_raw: number | null;
  authority_ratio: number | null;
  has_external_link: boolean | null;
  external_links_count: number | null;
  external_urls: ExternalLinkInfo[] | null;
  has_bio: boolean | null;
  bio_length: number | null;
  highlight_reel_count: number | null;
  igtv_video_count: number | null;
  has_channel: boolean | null;
  business_category_name: string | null;

  // ========== GROUP 2a: Engagement Metrics (11 fields) ==========
  total_likes: number | null;
  total_comments: number | null;
  total_engagement: number | null;
  avg_likes_per_post: number | null;
  avg_comments_per_post: number | null;
  avg_engagement_per_post: number | null;
  engagement_rate: number | null;
  comment_to_like_ratio: number | null;
  engagement_consistency: number | null;
  engagement_std_dev: number | null;

  // ========== GROUP 2b: Frequency Metrics (8 fields) ==========
  posting_frequency: number | null;
  days_since_last_post: number | null;
  posting_consistency: number | null;
  avg_days_between_posts: number | null;
  posting_period_days: number | null;
  oldest_post_timestamp: string | null;
  newest_post_timestamp: string | null;

  // ========== GROUP 2c: Format Metrics (11 fields) ==========
  reels_count: number | null;
  video_count: number | null;
  non_reels_video_count: number | null;
  image_count: number | null;
  carousel_count: number | null;
  format_diversity: number | null;
  dominant_format: string | null;
  reels_rate: number | null;
  image_rate: number | null;
  video_rate: number | null;
  carousel_rate: number | null;

  // ========== GROUP 2d: Content Metrics (14 fields) ==========
  total_hashtags: number | null;
  unique_hashtag_count: number | null;
  avg_hashtags_per_post: number | null;
  hashtag_diversity: number | null;
  top_hashtags: HashtagFrequency[] | null;
  avg_caption_length: number | null;
  avg_caption_length_non_empty: number | null;
  max_caption_length: number | null;
  location_tagging_rate: number | null;
  alt_text_rate: number | null;
  comments_enabled_rate: number | null;
  unique_mentions_count: number | null;
  top_mentions: MentionFrequency[] | null;

  // ========== GROUP 3: Video Metrics (4 fields) ==========
  video_post_count: number | null;
  total_video_views: number | null;
  avg_video_views: number | null;
  video_view_to_like_ratio: number | null;

  // ========== GROUP 4: Risk Scores (4 fields) ==========
  fake_follower_risk_score: number | null;
  fake_follower_interpretation: string | null;
  warnings_count: number | null;
  warnings: string[] | null;

  // ========== GROUP 5: Derived Metrics (4 fields) ==========
  content_density: number | null;
  recent_viral_post_count: number | null;
  recent_posts_sampled: number | null;
  viral_post_rate: number | null;

  // ========== GROUP 6: Composite Scores (5 fields) ==========
  profile_health_score: number | null;
  engagement_health: number | null;
  content_sophistication: number | null;
  account_maturity: number | null;
  fake_follower_risk: number | null;

  // ========== GROUP 7: Gap Detection (4 boolean flags) ==========
  engagement_gap: boolean | null;
  content_gap: boolean | null;
  conversion_gap: boolean | null;
  platform_gap: boolean | null;
}

/**
 * AI analysis results returned by API
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface AIAnalysisResponse {
  // ========== GROUP 8: AI Analysis Results (10 fields) ==========
  profile_assessment_score: number | null;
  lead_tier: 'hot' | 'warm' | 'cold' | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  opportunities: string[] | null;
  outreach_hooks: string[] | null;
  recommended_actions: string[] | null;
  risk_factors: string[] | null;
  fit_reasoning: string | null;
  partnership_assessment: string | null;
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
  summary: string | null;

  // ========== CALCULATED METRICS (from lead_analyses.calculated_metrics) ==========
  calculated_metrics: CalculatedMetricsResponse | null;

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
  summary: string | null;

  // ========== CALCULATED METRICS (from lead_analyses.calculated_metrics) ==========
  calculated_metrics: CalculatedMetricsResponse | null;

  // ========== AI ANALYSIS (from lead_analyses.ai_response.phase2) ==========
  ai_analysis: AIAnalysisResponse | null;
}

export interface LeadAnalysis {
  id: string;
  run_id: string;
  analysis_type: 'light' | 'deep' | 'private' | 'not_found';
  overall_score: number;
  summary: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;

  // ========== CALCULATED METRICS (from lead_analyses.calculated_metrics) ==========
  calculated_metrics: CalculatedMetricsResponse | null;

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
