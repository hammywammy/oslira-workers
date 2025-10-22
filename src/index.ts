// src/index.ts

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@/shared/types/env.types';
import { registerTestEndpoints } from './test-endpoints';
import { registerLeadRoutes } from './features/leads/leads.routes';
import { registerBusinessRoutes } from './features/business/business.routes';
import { registerCreditsRoutes } from './features/credits/credits.routes';
import { registerAnalysisRoutes } from './features/analysis/analysis.routes';
import { handleStripeWebhookQueue } from './infrastructure/queues/stripe-webhook.consumer';
import { handleAnalysisQueue } from './infrastructure/queues/analysis.consumer';
import AnalysisWorkflow from './infrastructure/workflows/analysis.workflow';
import { AnalysisProgressDO } from './infrastructure/durable-objects/analysis-progress.do';

const app = new Hono<{ Bindings: Env }>();

// ===============================================================================
// MIDDLEWARE
// ===============================================================================

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));

// ===============================================================================
// HEALTH & INFO
// ===============================================================================

app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    service: 'OSLIRA Enterprise Analysis API',
    version: '7.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'async-workflows',
    phase: 'Phase 4B Complete - Async Infrastructure',
    features: {
      workflows: !!c.env.ANALYSIS_WORKFLOW,
      durable_objects: !!c.env.ANALYSIS_PROGRESS,
      queues: !!c.env.ANALYSIS_QUEUE,
      r2_cache: !!c.env.R2_CACHE_BUCKET,
      analytics: !!c.env.ANALYTICS_ENGINE
    }
  });
});

app.get('/health', async (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    bindings: {
      kv: !!c.env.OSLIRA_KV,
      r2: !!c.env.R2_CACHE_BUCKET,
      analytics: !!c.env.ANALYTICS_ENGINE,
      workflows: !!c.env.ANALYSIS_WORKFLOW,
      durable_objects: !!c.env.ANALYSIS_PROGRESS,
      queues: {
        stripe_webhooks: !!c.env.STRIPE_WEBHOOK_QUEUE,
        analysis: !!c.env.ANALYSIS_QUEUE
      }
    }
  });
});

// ===============================================================================
// PRODUCTION API ENDPOINTS
// ===============================================================================

// Phase 3 endpoints (CRUD)
registerLeadRoutes(app);           // 4 endpoints
registerBusinessRoutes(app);       // 4 endpoints
registerCreditsRoutes(app);        // 4 endpoints

// Phase 4B endpoints (Async Analysis)
registerAnalysisRoutes(app);       // 4 endpoints (analyze, progress, cancel, result)

// ===============================================================================
// TEST ENDPOINTS (Disabled in production)
// ===============================================================================

registerTestEndpoints(app);

// ===============================================================================
// ERROR HANDLING
// ===============================================================================

app.onError((err, c) => {
  console.error('Worker error:', err);
  
  return c.json({
    success: false,
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  }, 500);
});

app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Endpoint not found',
    path: c.req.path,
    method: c.req.method,
    timestamp: new Date().toISOString()
  }, 404);
});

// ===============================================================================
// EXPORT WORKER
// ===============================================================================

export default {
  /**
   * HTTP Request Handler
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  
  /**
   * Cron Trigger Handler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger:', event.cron);
    
    // Monthly renewal (1st of month, 3 AM UTC)
    if (event.cron === '0 3 1 * *') {
      console.log('[Cron] Monthly credit renewal');
      // TODO: Implement monthly renewal logic
    }
    
    // Daily cleanup (2 AM UTC)
    if (event.cron === '0 2 * * *') {
      console.log('[Cron] Daily cleanup');
      // TODO: Implement cleanup logic (old analyses, etc)
    }
    
    // Hourly failed analysis cleanup
    if (event.cron === '0 * * * *') {
      console.log('[Cron] Failed analysis cleanup');
      // TODO: Implement failed analysis retry/cleanup
    }
  },
  
  /**
   * Queue Consumer Handler - Stripe Webhooks
   */
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === 'stripe-webhooks' || batch.queue === 'stripe-webhooks-staging') {
      await handleStripeWebhookQueue(batch, env);
    } else if (batch.queue === 'analysis-jobs' || batch.queue === 'analysis-jobs-staging') {
      await handleAnalysisQueue(batch, env);
    }
  }
};

// ===============================================================================
// EXPORT WORKFLOW
// ===============================================================================

export { AnalysisWorkflow };

// ===============================================================================
// EXPORT DURABLE OBJECT
// ===============================================================================

export { AnalysisProgressDO };
