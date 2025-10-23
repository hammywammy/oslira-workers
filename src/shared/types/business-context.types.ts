// shared/types/business-context.types.ts

/**
 * BUSINESS CONTEXT GENERATION TYPES
 * 
 * Phase 3: Onboarding business context AI generation
 */

// ===============================================================================
// WORKFLOW PARAMETERS
// ===============================================================================

export interface BusinessContextWorkflowParams {
  run_id: string;
  account_id: string;
  user_inputs: OnboardingFormData;
  requested_at: string;
}

// ===============================================================================
// ONBOARDING FORM DATA
// ===============================================================================

export interface OnboardingFormData {
  // Step 1: Personal Identity
  signature_name: string;
  
  // Step 2: Business Basics
  business_name: string;
  business_summary: string; // User's raw description (50-500 chars)
  industry: string;
  company_size: '1-10' | '11-50' | '51+';
  website?: string | null;
  
  // Step 3: Goals
  primary_objective: 'lead-generation' | 'sales-automation' | 'market-research' | 'customer-retention';
  monthly_lead_goal: number;
  
  // Step 4: Challenges
  challenges: string[]; // ['low-quality-leads', 'time-consuming', etc.]
  
  // Step 5: Target Audience
  target_description: string; // 20-500 chars
  icp_min_followers: number;
  icp_max_followers: number;
  target_company_sizes: string[]; // ['startup', 'smb', 'enterprise']
  
  // Step 6: Communication
  communication_channels: string[]; // ['email', 'instagram', 'sms']
  brand_voice: 'professional' | 'friendly' | 'casual';
  
  // Step 7: Team
  team_size: 'just-me' | 'small-team' | 'large-team';
  campaign_manager: 'myself' | 'sales-team' | 'marketing-team' | 'mixed-team';
}

// ===============================================================================
// AI GENERATION RESULTS
// ===============================================================================

export interface BusinessContextResult {
  business_one_liner: string; // 140 char max
  business_summary_generated: string; // 4 sentences
  ideal_customer_profile: IdealCustomerProfile;
  operational_metadata: OperationalMetadata;
  
  // Metadata
  ai_metadata: {
    model_used: string;
    total_tokens: number;
    total_cost: number;
    generation_time_ms: number;
  };
}

export interface IdealCustomerProfile {
  business_description: string; // From user input
  target_audience: string; // From user input
  industry: string;
  icp_min_followers: number;
  icp_max_followers: number;
  brand_voice: string;
}

export interface OperationalMetadata {
  business_summary: string; // User's raw input (stored here too)
  company_size: string;
  monthly_lead_goal: number;
  primary_objective: string;
  challenges: string[];
  target_company_sizes: string[];
  communication_channels: string[];
  communication_tone: string;
  team_size: string;
  campaign_manager: string;
}

// ===============================================================================
// PROGRESS STATE (Durable Object)
// ===============================================================================

export interface BusinessContextProgressState {
  run_id: string;
  account_id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  progress: number; // 0-100
  current_step: string;
  total_steps: number; // Always 3
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error_message?: string;
  result?: BusinessContextResult;
}

// ===============================================================================
// QUEUE MESSAGE
// ===============================================================================

export interface BusinessContextQueueMessage {
  run_id: string;
  account_id: string;
  user_inputs: OnboardingFormData;
  requested_at: string;
}
