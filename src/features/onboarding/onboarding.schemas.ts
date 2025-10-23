// features/onboarding/onboarding.schemas.ts

import { z } from 'zod';

/**
 * ONBOARDING VALIDATION SCHEMAS
 * 
 * Validates all 14 fields across 8 onboarding steps
 */

// ===============================================================================
// ENUMS
// ===============================================================================

const IndustryEnum = z.enum([
  'Technology',
  'Healthcare',
  'Finance',
  'Real Estate',
  'Retail',
  'Manufacturing',
  'Consulting',
  'Marketing',
  'Education',
  'Other'
]);

const CompanySizeEnum = z.enum(['1-10', '11-50', '51+']);

const PrimaryObjectiveEnum = z.enum([
  'lead-generation',
  'sales-automation',
  'market-research',
  'customer-retention'
]);

const ChallengesEnum = z.enum([
  'low-quality-leads',
  'time-consuming',
  'expensive-tools',
  'lack-personalization',
  'poor-data-quality',
  'difficult-scaling'
]);

const TargetSizeEnum = z.enum(['startup', 'smb', 'enterprise']);

const CommunicationChannelsEnum = z.enum(['email', 'instagram', 'sms']);

const BrandVoiceEnum = z.enum(['professional', 'friendly', 'casual']);

const TeamSizeEnum = z.enum(['just-me', 'small-team', 'large-team']);

const CampaignManagerEnum = z.enum([
  'myself',
  'sales-team',
  'marketing-team',
  'mixed-team'
]);

// ===============================================================================
// COMPLETE ONBOARDING FORM SCHEMA
// ===============================================================================

export const OnboardingFormSchema = z.object({
  // Step 1: Personal Identity
  signature_name: z
    .string()
    .min(2, 'Signature name must be at least 2 characters')
    .max(50, 'Signature name must be less than 50 characters')
    .trim(),

  // Step 2: Business Basics
  business_name: z
    .string()
    .min(2, 'Business name must be at least 2 characters')
    .max(100, 'Business name must be less than 100 characters')
    .trim(),

  business_summary: z
    .string()
    .min(50, 'Business description must be at least 50 characters')
    .max(500, 'Business description must be less than 500 characters')
    .trim(),

  industry: IndustryEnum,

  company_size: CompanySizeEnum,

  website: z
    .string()
    .url('Invalid website URL')
    .nullable()
    .optional()
    .transform((val) => val || null),

  // Step 3: Goals
  primary_objective: PrimaryObjectiveEnum,

  monthly_lead_goal: z
    .number()
    .int()
    .min(1, 'Lead goal must be at least 1')
    .max(10000, 'Lead goal must be less than 10,000'),

  // Step 4: Challenges
  challenges: z
    .array(ChallengesEnum)
    .min(0)
    .max(6)
    .default([]),

  // Step 5: Target Audience
  target_description: z
    .string()
    .min(20, 'Target description must be at least 20 characters')
    .max(500, 'Target description must be less than 500 characters')
    .trim(),

  icp_min_followers: z
    .number()
    .int()
    .min(0, 'Minimum followers must be 0 or greater'),

  icp_max_followers: z
    .number()
    .int()
    .min(0, 'Maximum followers must be 0 or greater'),

  target_company_sizes: z
    .array(TargetSizeEnum)
    .min(0)
    .max(3)
    .default([]),

  // Step 6: Communication
  communication_channels: z
    .array(CommunicationChannelsEnum)
    .min(1, 'Select at least one communication channel')
    .max(3),

  brand_voice: BrandVoiceEnum,

  // Step 7: Team
  team_size: TeamSizeEnum,

  campaign_manager: CampaignManagerEnum
}).refine(
  (data) => data.icp_max_followers >= data.icp_min_followers,
  {
    message: 'Maximum followers must be greater than or equal to minimum followers',
    path: ['icp_max_followers']
  }
);

export type OnboardingFormInput = z.infer<typeof OnboardingFormSchema>;

// ===============================================================================
// GENERATE CONTEXT REQUEST SCHEMA
// ===============================================================================

export const GenerateContextRequestSchema = z.object({
  user_inputs: OnboardingFormSchema
});

export type GenerateContextRequest = z.infer<typeof GenerateContextRequestSchema>;

// ===============================================================================
// PROGRESS PARAMS SCHEMA
// ===============================================================================

export const GetProgressParamsSchema = z.object({
  runId: z.string().uuid('Invalid run ID format')
});

export type GetProgressParams = z.infer<typeof GetProgressParamsSchema>;
