// features/onboarding/onboarding.schemas.ts

import { z } from 'zod';

/**
 * ONBOARDING VALIDATION - FRONTEND-DRIVEN
 * 
 * This schema accepts EXACTLY what the frontend sends.
 * No transformation. No defaults. No bullshit.
 * 
 * Extensible: Add new fields when frontend adds new steps.
 */

// ===============================================================================
// CURRENT FORM DATA (4-STEP FLOW)
// ===============================================================================

const OnboardingFormSchema = z.object({
  // Step 1: Identity
  signature_name: z.string().min(2).max(50).trim(),

  // Step 2: Business Context
  business_summary: z.string().min(50).max(750).trim(),
  communication_tone: z.enum(['professional', 'friendly', 'casual']),

  // Step 3: Target Customer
  target_description: z.string().min(50).max(750).trim(),
  icp_min_followers: z.number().int().min(0),
  icp_max_followers: z.number().int().min(0),
  target_company_sizes: z.array(z.enum(['startup', 'smb', 'enterprise'])).default([]),
});

export type OnboardingFormInput = z.infer<typeof OnboardingFormSchema>;

// ===============================================================================
// REQUEST WRAPPER
// ===============================================================================

export const GenerateContextRequestSchema = z.object({
  // The frontend sends form data directly - no nesting, no transformation
  ...OnboardingFormSchema.shape,
});

export type GenerateContextRequest = z.infer<typeof GenerateContextRequestSchema>;

// ===============================================================================
// PROGRESS PARAMS (unchanged)
// ===============================================================================

export const GetProgressParamsSchema = z.object({
  runId: z.string().uuid('Invalid run ID format')
});

export type GetProgressParams = z.infer<typeof GetProgressParamsSchema>;

// ===============================================================================
// INTERNAL: Transform frontend data to backend workflow format
// ===============================================================================

/**
 * Convert frontend form to backend workflow params
 * This is where you handle the mapping, NOT in validation
 */
export function transformToWorkflowParams(input: OnboardingFormInput) {
  // Extract business name from business_summary
  const firstSentence = input.business_summary.split(/[.!?]/)[0];
  const match = firstSentence?.match(/^(.+?)\s+is\s+(a|an)\s+/i);
  const businessName = match?.[1]?.trim() || 
    input.business_summary.split(' ').slice(0, 5).join(' ').substring(0, 50) || 
    'Company';

  return {
    // Identity
    signature_name: input.signature_name,
    business_name: businessName, // Derived

    // Business
    business_summary: input.business_summary,
    industry: 'Not Specified', // Will be AI-derived from business_summary
    company_size: 'not-specified', // Not collected yet
    website: null, // Not collected yet

    // Goals - defaults until we collect them
    primary_objective: 'lead-generation',
    monthly_lead_goal: 0,

    // Challenges - empty until we collect them
    challenges: [],

    // Target audience
    target_description: input.target_description,
    icp_min_followers: input.icp_min_followers,
    icp_max_followers: input.icp_max_followers,
    target_company_sizes: input.target_company_sizes,

    // Communication
    communication_channels: ['instagram'], // Platform default
    brand_voice: input.communication_tone,

    // Team - defaults until we collect them
    team_size: 'not-specified',
    campaign_manager: 'not-specified',
  };
}
