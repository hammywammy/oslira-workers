// features/leads/leads.types.ts

import { z } from 'zod';
import { CommonSchemas } from '@/shared/utils/validation.util';

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

export const ListLeadsQuerySchema = z.object({
  businessProfileId: CommonSchemas.uuid.optional(),
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
  limit: z.coerce.number().int().min(1).max(50).default(10),
  analysisType: z.enum(['light', 'deep', 'xray']).optional()
});

export const DeleteLeadParamsSchema = z.object({
  leadId: CommonSchemas.uuid
});

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

export interface LeadListItem {
  id: string;
  instagram_username: string;
  display_name: string | null;
  follower_count: number;
  is_verified: boolean;
  is_business_account: boolean;
  profile_pic_url: string | null;
  last_analyzed_at: string;
  latest_analysis: {
    id: string;
    analysis_type: 'light' | 'deep' | 'xray';
    overall_score: number;
    completed_at: string;
  } | null;
  created_at: string;
}

export interface LeadDetail {
  id: string;
  account_id: string;
  business_profile_id: string | null;
  instagram_username: string;
  display_name: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  bio: string | null;
  external_url: string | null;
  profile_pic_url: string | null;
  is_verified: boolean;
  is_private: boolean;
  is_business_account: boolean;
  first_analyzed_at: string;
  last_analyzed_at: string;
  created_at: string;
  analyses_count: number;
  latest_analysis: {
    id: string;
    analysis_type: 'light' | 'deep' | 'xray';
    overall_score: number;
    niche_fit_score: number;
    engagement_score: number;
    confidence_level: number;
    completed_at: string;
  } | null;
}

export interface LeadAnalysis {
  id: string;
  analysis_type: 'light' | 'deep' | 'xray';
  overall_score: number;
  niche_fit_score: number;
  engagement_score: number;
  confidence_level: number;
  status: string;
  credits_charged: number;
  model_used: string;
  processing_duration_ms: number | null;
  completed_at: string | null;
  created_at: string;
}

// ===============================================================================
// TYPE EXPORTS
// ===============================================================================

export type ListLeadsQuery = z.infer<typeof ListLeadsQuerySchema>;
export type GetLeadParams = z.infer<typeof GetLeadParamsSchema>;
export type GetLeadAnalysesQuery = z.infer<typeof GetLeadAnalysesQuerySchema>;
export type DeleteLeadParams = z.infer<typeof DeleteLeadParamsSchema>;
