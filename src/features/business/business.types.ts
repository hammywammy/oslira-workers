// features/business/business.types.ts

import { z } from 'zod';
import { CommonSchemas } from '@/shared/utils/validation.util';

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

export const ListBusinessProfilesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

export const CreateBusinessProfileSchema = z.object({
  business_name: z.string().min(1, 'Business name required').max(200),
  website: z.string().url('Invalid URL').optional().nullable(),
  business_one_liner: z.string().min(1).max(500).optional().nullable(),
  business_context_pack: z.object({
    target_audience: z.string().min(1, 'Target audience required'),
    industry: z.string().optional().nullable(),
    offering: z.string().optional().nullable(),
    icp_min_followers: z.number().int().min(0).optional().nullable(),
    icp_max_followers: z.number().int().min(0).optional().nullable(),
    icp_min_engagement_rate: z.number().min(0).max(100).optional().nullable(),
    icp_content_themes: z.array(z.string()).optional().nullable(),
    icp_geographic_focus: z.string().optional().nullable(),
    icp_industry_niche: z.string().optional().nullable(),
    selling_points: z.array(z.string()).optional().nullable(),
    brand_voice: z.string().optional().nullable(),
    outreach_goals: z.string().optional().nullable()
  })
});

export const UpdateBusinessProfileSchema = z.object({
  business_name: z.string().min(1).max(200).optional(),
  website: z.string().url('Invalid URL').optional().nullable(),
  business_one_liner: z.string().min(1).max(500).optional().nullable(),
  business_context_pack: z.object({
    target_audience: z.string().min(1).optional(),
    industry: z.string().optional().nullable(),
    offering: z.string().optional().nullable(),
    icp_min_followers: z.number().int().min(0).optional().nullable(),
    icp_max_followers: z.number().int().min(0).optional().nullable(),
    icp_min_engagement_rate: z.number().min(0).max(100).optional().nullable(),
    icp_content_themes: z.array(z.string()).optional().nullable(),
    icp_geographic_focus: z.string().optional().nullable(),
    icp_industry_niche: z.string().optional().nullable(),
    selling_points: z.array(z.string()).optional().nullable(),
    brand_voice: z.string().optional().nullable(),
    outreach_goals: z.string().optional().nullable()
  }).optional()
});

export const GetBusinessProfileParamsSchema = z.object({
  profileId: CommonSchemas.uuid
});

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

export interface BusinessProfileListItem {
  id: string;
  business_name: string;
  website: string | null;
  business_one_liner: string | null;
  leads_count: number;
  analyses_count: number;
  created_at: string;
  updated_at: string;
}

export interface BusinessProfileDetail {
  id: string;
  account_id: string;
  business_name: string;
  website: string | null;
  business_one_liner: string | null;
  business_context_pack: {
    target_audience: string;
    industry?: string | null;
    offering?: string | null;
    icp_min_followers?: number | null;
    icp_max_followers?: number | null;
    icp_min_engagement_rate?: number | null;
    icp_content_themes?: string[] | null;
    icp_geographic_focus?: string | null;
    icp_industry_niche?: string | null;
    selling_points?: string[] | null;
    brand_voice?: string | null;
    outreach_goals?: string | null;
  };
  context_version: string;
  context_generated_at: string | null;
  context_manually_edited: boolean;
  context_updated_at: string | null;
  created_at: string;
  updated_at: string;
  leads_count: number;
  analyses_count: number;
}

// ===============================================================================
// TYPE EXPORTS
// ===============================================================================

export type ListBusinessProfilesQuery = z.infer<typeof ListBusinessProfilesQuerySchema>;
export type CreateBusinessProfileInput = z.infer<typeof CreateBusinessProfileSchema>;
export type UpdateBusinessProfileInput = z.infer<typeof UpdateBusinessProfileSchema>;
export type GetBusinessProfileParams = z.infer<typeof GetBusinessProfileParamsSchema>;
