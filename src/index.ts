// src/index.ts - Phase 5 Complete

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@/shared/types/env.types';
import { registerTestEndpoints } from './test-endpoints';
import { registerLeadRoutes } from './features/leads/leads.routes';
import { registerBusinessRoutes } from './features/business/business.routes';
import { registerCreditsRoutes } from './features/credits/credits.routes';
import { registerAnalysisRoutes } from './features/analysis/analysis.routes';
import { registerBulkAnalysisRoutes } from './features/analysis/bulk-analysis.routes';
import { handleStripeWebhookQueue } from './infrastructure/queues/stripe-webhook.consumer';
import { handleAnalysisQueue } from './infrastructure/queues/analysis.consumer';
import AnalysisWorkflow from './infrastructure/workflows/analysis.workflow';
import { AnalysisProgressDO } from './infrastructure/durable-objects/analysis-progress.do';
import { executeCronJob } from './infrastructure/cron/cron-jobs.handler';
import { getSentryService } from './infrastructure/monitoring/sentry.service';
import { errorHandler } from './shared/middleware/error.middleware';

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
    version: '8.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'async-workflows',
    phase: 'Phase 5 Complete - Production Features',
    features: {
      workflows: !!c.env.ANALYSIS_WORKFLOW,
      durable_objects: !!c.env.ANALYSIS_PROGRESS,
      queues: !!c.env.ANALYSIS_QUEUE,
      r2_cache: !!c.env.R2_CACHE_BUCKET,
      analytics: !!c.env.ANALYTICS_ENGINE,
      sentry: true,
      cron_jobs: true,
      prompt_caching: true,
      bulk_analysis: true
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

// Phase 4 endpoints (Async Analysis)
registerAnalysisRoutes(app);       // 4 endpoints (analyze, progress, cancel, result)

// Phase 5 endpoints (Bulk Analysis)
registerBulkAnalysisRoutes(app);   // 3 endpoints (bulk, progress, cancel)

// ===============================================================================
// TEST ENDPOINTS (Disabled in production)
// ===============================================================================

registerTestEndpoints(app);

// ===============================================================================
// ERROR HANDLING (Phase 5 - Sentry Integration)
// ===============================================================================

app.onError(async (err, c) => {
  console.error('Worker error:', err);
  
  // Send to Sentry
  try {
    const sentry = await getSentryService(c.env);
    await sentry.captureException(err, {
      request: {
        method: c.req.method,
        url: c.req.url
      },
      tags: {
        environment: c.env.APP_ENV,
        endpoint: c.req.path
      }
    });
  } catch (sentryError) {
    console.error('Sentry error:', sentryError);
  }
  
  return errorHandler(err, c);
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
   * Cron Trigger Handler (Phase 5 - Complete Implementation)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('[Cron] Trigger:', event.cron);
    
    try {
      await executeCronJob(event.cron, env);
    } catch (error: any) {
      console.error('[Cron] Job execution failed:', error);
      
      // Report to Sentry
      try {
        const sentry = await getSentryService(env);
        await sentry.captureException(error, {
          tags: {
            cron_expression: event.cron,
            environment: env.APP_ENV
          }
        });
      } catch (sentryError) {
        console.error('Sentry error:', sentryError);
      }
    }
  },
  
  /**
   * Queue Consumer Handler
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
