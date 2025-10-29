// shared/types/business-context.types.ts

/**
 * BUSINESS CONTEXT GENERATION TYPES
 * 
 * Phase 3: Onboarding business context AI generation (4-step flow)
 * 
 * This system collects 7 fields from users and generates 2 AI-enhanced strings:
 * - business_one_liner (140 chars)
 * - business_summary_generated (4 sentences)
 * 
 * All other data is stored as-is in manually constructed JSONB columns.
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
// ONBOARDING FORM DATA (4-STEP FLOW)
// ===============================================================================

/**
 * Data collected from 4-step onboarding
 * 
 * Step 1: Identity (full_name)
 * Step 2: Business Context (business_summary, communication_tone)
 * Step 3: Target Customer (target_description, followers, company_sizes)
 * Step 4: Review & Submit
 */
export interface OnboardingFormData {
  // Step 1: Identity
  full_name: string;              // User's complete name (e.g., "Hamza Williams")
  signature_name: string;         // Derived: First word of full_name (e.g., "Hamza")
  
  // Step 2: Business Context
  business_summary: string;       // 50-750 chars: User's raw business description
  communication_tone: 'professional' | 'friendly' | 'casual';
  
  // Step 3: Target Customer
  target_description: string;     // 50-750 chars: Who they want to reach
  icp_min_followers: number;      // Minimum follower count for ideal customers
  icp_max_followers: number;      // Maximum follower count for ideal customers
  target_company_sizes: ('startup' | 'smb' | 'enterprise')[];
}

// ===============================================================================
// AI GENERATION RESULTS
// ===============================================================================

/**
 * Result of AI generation workflow
 * 
 * Contains 2 AI-generated strings + metadata
 * NO structured data generation (manual JSON construction only)
 */
export interface BusinessContextResult {
  // AI-generated content
  business_one_liner: string;           // 140 char tagline
  business_summary_generated: string;   // 4 polished sentences
  
  // Cost tracking
  ai_metadata: AIGenerationMetadata;
}

/**
 * AI generation cost and performance tracking
 */
export interface AIGenerationMetadata {
  model_used: string;           // e.g., "gpt-5-mini"
  total_tokens: number;         // Combined input + output tokens
  total_cost: number;           // USD (e.g., 0.00276)
  generation_time_ms: number;   // Milliseconds for parallel AI calls
  generated_at: string;         // ISO timestamp
}

// ===============================================================================
// PROGRESS STATE (Durable Object)
// ===============================================================================

/**
 * Real-time progress tracking for async workflow
 * 
 * Polled by frontend every 1-2 seconds during onboarding
 */
export interface BusinessContextProgressState {
  run_id: string;
  account_id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  progress: number;           // 0-100 percentage
  current_step: string;       // Human-readable status (e.g., "Generating business tagline")
  total_steps: number;        // Always 3: (1) AI generation, (2) Database save, (3) Complete
  started_at: string;         // ISO timestamp
  updated_at: string;         // ISO timestamp
  completed_at?: string;      // ISO timestamp (only when status = 'complete')
  error_message?: string;     // Only when status = 'failed'
  result?: BusinessContextResult;  // Only when status = 'complete'
}

// ===============================================================================
// QUEUE MESSAGE
// ===============================================================================

/**
 * Message sent to Cloudflare Queue for async processing
 * 
 * Queue config:
 * - max_batch_size: 1 (immediate processing)
 * - max_batch_timeout: 5 seconds
 * - max_retries: 3
 */
export interface BusinessContextQueueMessage {
  run_id: string;
  account_id: string;
  user_inputs: OnboardingFormData;
  requested_at: string;         // ISO timestamp
}
