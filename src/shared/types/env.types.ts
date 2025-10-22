// shared/types/env.types.ts

import type { KVNamespace, R2Bucket, AnalyticsEngineDataset, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import type { Workflow } from 'cloudflare:workers';

/**
 * CLOUDFLARE WORKER ENVIRONMENT TYPES
 * 
 * Phase 1-3: KV, R2, Analytics Engine
 * Phase 4B: Workflows, Durable Objects, Queues
 */

export interface Env {
  // ===============================================================================
  // ENVIRONMENT
  // ===============================================================================
  APP_ENV: 'production' | 'staging';
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;

  // ===============================================================================
  // PHASE 1-3 BINDINGS
  // ===============================================================================
  
  // KV Namespace (rate limiting)
  OSLIRA_KV: KVNamespace;
  
  // R2 Bucket (profile caching)
  R2_CACHE_BUCKET: R2Bucket;
  
  // Analytics Engine (cost/performance tracking)
  ANALYTICS_ENGINE: AnalyticsEngineDataset;

  // ===============================================================================
  // PHASE 4B BINDINGS (NEW)
  // ===============================================================================
  
  // Workflows (async orchestration)
  ANALYSIS_WORKFLOW: Workflow;
  
  // Durable Objects (progress tracking)
  ANALYSIS_PROGRESS: DurableObjectNamespace;
  
  // Queues (async message processing)
  STRIPE_WEBHOOK_QUEUE: Queue;
  ANALYSIS_QUEUE: Queue;
}

/**
 * Analysis Workflow Parameters
 */
export interface AnalysisWorkflowParams {
  run_id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  analysis_type: 'light' | 'deep' | 'xray';
  requested_at: string;
}

/**
 * Analysis Progress State (stored in Durable Object)
 */
export interface AnalysisProgressState {
  run_id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  progress: number; // 0-100
  current_step: string;
  total_steps: number;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  error_message?: string;
  result?: {
    overall_score: number;
    niche_fit_score: number;
    engagement_score: number;
    confidence_level: number;
    summary_text: string;
    outreach_message?: string;
  };
}
