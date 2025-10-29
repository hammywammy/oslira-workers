// features/onboarding/onboarding.schemas.ts

import { z } from 'zod';

/**
 * ONBOARDING VALIDATION - 4-STEP FLOW
 * 
 * Collects EXACTLY what the frontend sends, nothing more.
 */

// ===============================================================================
// FORM DATA (4-STEP FLOW)
// ===============================================================================

const OnboardingFormSchema = z.object({
  // Step 1: Identity
  full_name: z.string().min(2).max(100).trim(),

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
  ...OnboardingFormSchema.shape,
});

export type GenerateContextRequest = z.infer<typeof GenerateContextRequestSchema>;

// ===============================================================================
// PROGRESS PARAMS
// ===============================================================================

export const GetProgressParamsSchema = z.object({
  runId: z.string().uuid('Invalid run ID format')
});

export type GetProgressParams = z.infer<typeof GetProgressParamsSchema>;

// ===============================================================================
// TRANSFORM: Frontend → Workflow
// ===============================================================================

/**
 * Convert frontend form to workflow params
 * Only adds derived signature_name (first word of full_name)
 */
export function transformToWorkflowParams(input: OnboardingFormInput) {
  // Parse signature_name from full_name (first word)
  const signature_name = input.full_name.trim().split(/\s+/)[0];

  return {
    // Identity
    full_name: input.full_name,
    signature_name: signature_name,  // Derived
    
    // Business context
    business_summary: input.business_summary,
    communication_tone: input.communication_tone,
    
    // Target customer
    target_description: input.target_description,
    icp_min_followers: input.icp_min_followers,
    icp_max_followers: input.icp_max_followers,
    target_company_sizes: input.target_company_sizes,
  };
}
