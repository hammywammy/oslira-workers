/**
 * WORKFLOW STEP CONSTANTS
 *
 * Centralized constants for all workflow step names.
 * Prevents typos and enables IDE autocomplete.
 *
 * Usage:
 * ```typescript
 * import { WORKFLOW_STEPS } from '@/config/workflow-steps.constants';
 * await step.do(WORKFLOW_STEPS.SCRAPE_PROFILE, async () => { ... });
 * ```
 */

export const WORKFLOW_STEPS = {
  // Analysis Workflow Steps
  FETCH_SECRETS: 'fetch_secrets',
  CHECK_DUPLICATE: 'check_duplicate',
  SETUP_PARALLEL: 'setup_parallel',
  CHECK_CACHE: 'check_cache',
  SCRAPE_PROFILE: 'scrape_profile',
  PRE_ANALYSIS_CHECKS: 'pre_analysis_checks',
  REFUND_FOR_BYPASS: 'refund_for_bypass',
  UPSERT_BYPASS_LEAD: 'upsert_bypass_lead',
  SAVE_BYPASS_ANALYSIS: 'save_bypass_analysis',
  COMPLETE_BYPASS_PROGRESS: 'complete_bypass_progress',
  EXTRACT_DATA: 'extract_data',
  DETECT_NICHE: 'detect_niche',
  PARALLEL_AI_ANALYSIS: 'parallel_ai_analysis',
  UPSERT_LEAD: 'upsert_lead',
  SAVE_ANALYSIS: 'save_analysis',
  COMPLETE_PROGRESS: 'complete_progress',
  LOG_OPERATIONS: 'log_operations',
  REFUND_BALANCE: 'refund_balance',

  // Business Context Workflow Steps
  GENERATE_AI_CONTENT: 'generate_ai_content',
  SAVE_TO_DATABASE: 'save_to_database',
  MARK_BUSINESS_ONBOARDED: 'mark_business_onboarded',
  LINK_STRIPE_TO_SUBSCRIPTION: 'link_stripe_to_subscription',
  MARK_COMPLETE: 'mark_complete'
} as const;

/**
 * Type for workflow step names (enables type checking)
 */
export type WorkflowStepName = typeof WORKFLOW_STEPS[keyof typeof WORKFLOW_STEPS];

/**
 * CRITICAL PROGRESS STEPS
 *
 * Only these steps send progress updates to reduce HTTP overhead.
 * Optimization: Reduces 11 HTTP calls → 4 HTTP calls (saves 700-1400ms)
 *
 * Rationale: Users only need to see progress on major, visible steps
 */
export const CRITICAL_PROGRESS_STEPS = new Set<string>([
  WORKFLOW_STEPS.SCRAPE_PROFILE,
  WORKFLOW_STEPS.PARALLEL_AI_ANALYSIS,
  WORKFLOW_STEPS.UPSERT_LEAD,
  WORKFLOW_STEPS.COMPLETE_PROGRESS
]);
