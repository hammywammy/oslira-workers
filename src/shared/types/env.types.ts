import type { KVNamespace, R2Bucket, AnalyticsEngineDataset, DurableObjectNamespace, Queue } from '@cloudflare/workers-types';
import type { Workflow } from 'cloudflare:workers';

/**
 * Cloudflare Worker Environment Types
 */
export interface Env {
  /** Environment settings */
  APP_ENV: 'production' | 'staging';
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;

  /** KV Namespace for rate limiting */
  OSLIRA_KV: KVNamespace;

  /** R2 Bucket for profile caching */
  R2_CACHE_BUCKET: R2Bucket;

  /** R2 Bucket for media storage */
  R2_MEDIA_BUCKET: R2Bucket;

  /** Analytics Engine for cost/performance tracking */
  ANALYTICS_ENGINE: AnalyticsEngineDataset;

  /** Workflows for async orchestration */
  ANALYSIS_WORKFLOW: Workflow;
  BUSINESS_CONTEXT_WORKFLOW: Workflow;

  /** Durable Objects for progress tracking & broadcasting */
  GLOBAL_BROADCASTER: DurableObjectNamespace;
  BUSINESS_CONTEXT_PROGRESS: DurableObjectNamespace;

  /** Queues for async message processing */
  STRIPE_WEBHOOK_QUEUE: Queue;
  BUSINESS_CONTEXT_QUEUE: Queue;
}

/** Analysis Workflow Parameters */
export interface AnalysisWorkflowParams {
  run_id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  analysis_type: 'light' | 'deep';
  requested_at: string;
}

/** Analysis Progress State (stored in Durable Object) */
export interface AnalysisProgressState {
  run_id: string;
  account_id?: string;
  username?: string;
  analysis_type?: string;
  status: 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  progress: number;
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
