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
 * Lean extracted data returned by API
 * Contains ONLY actionable signals for lead qualification
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface ExtractedDataResponse {
  // ========== ENGAGEMENT SIGNALS ==========
  engagement_score: number | null;
  engagement_consistency: number | null;

  // ========== RECENCY SIGNALS ==========
  days_since_last_post: number | null;

  // ========== CONTENT SIGNALS ==========
  top_hashtags: HashtagFrequency[] | null;
  top_mentions: MentionFrequency[] | null;

  // ========== BUSINESS SIGNALS ==========
  business_category_name: string | null;

  // ========== RISK SIGNALS ==========
  fake_follower_warning: string | null;
}

/**
 * AI analysis results returned by API
 * All fields are nullable to handle cases where analysis hasn't been run
 */
export interface AIAnalysisResponse {
  profile_assessment_score: number | null;
  lead_tier: 'hot' | 'warm' | 'cold' | null;
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
