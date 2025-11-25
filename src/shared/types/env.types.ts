// shared/types/env.types.ts

import type { KVNamespace, R2Bucket, AnalyticsEngineDataset, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import type { Workflow } from 'cloudflare:workers';

/**
 * CLOUDFLARE WORKER ENVIRONMENT TYPES
 * 
 * Phase 1-3: KV, R2, Analytics Engine
 * Phase 4B: Workflows, Durable Objects, Queues
 * Phase 3 (Onboarding): Business Context Generation
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

  // R2 Bucket (media storage)
  R2_MEDIA_BUCKET: R2Bucket;

  // Analytics Engine (cost/performance tracking)
  ANALYTICS_ENGINE: AnalyticsEngineDataset;

  // ===============================================================================
  // PHASE 4B BINDINGS
  // ===============================================================================
  
  // Workflows (async orchestration)
  ANALYSIS_WORKFLOW: Workflow;
  BUSINESS_CONTEXT_WORKFLOW: Workflow;
  
  // Durable Objects (progress tracking)
  ANALYSIS_PROGRESS: DurableObjectNamespace;
  BUSINESS_CONTEXT_PROGRESS: DurableObjectNamespace;
  
  // Queues (async message processing)
  STRIPE_WEBHOOK_QUEUE: Queue;
  BUSINESS_CONTEXT_QUEUE: Queue;
}

/**
 * Analysis Workflow Parameters
 * MODULAR: Supports multiple analysis types
 */
export interface AnalysisWorkflowParams {
  run_id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  analysis_type: 'light' | 'deep';
  requested_at: string;
}

/**
 * Analysis Progress State (stored in Durable Object)
 */
export interface AnalysisProgressState {
  run_id: string;
  account_id?: string;
  username?: string;
  analysis_type?: string;
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
    summary_text: string;
  };
}
