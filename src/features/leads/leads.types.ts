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
  analysis_type: 'light' | null;
  analysis_status: string | null;
  analysis_completed_at: string | null;
  overall_score: number | null;
  summary: string | null;
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
  analysis_type: 'light' | null;
  analysis_status: string | null;
  analysis_completed_at: string | null;
  overall_score: number | null;
  summary: string | null;
}

export interface LeadAnalysis {
  id: string;
  run_id: string;
  analysis_type: 'light';
  overall_score: number;
  summary: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
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
