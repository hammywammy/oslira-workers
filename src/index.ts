// src/index.ts - Phase 3 Update (Business Context Generation)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@/shared/types/env.types';
import type { MessageBatch } from '@cloudflare/workers-types';
import { registerAuthRoutes } from './features/auth/auth.routes';
import { registerLeadRoutes } from './features/leads/leads.routes';
import { registerBusinessRoutes } from './features/business/business.routes';
import { registerCreditsRoutes } from './features/credits/credits.routes';
import { registerAnalysisRoutes } from './features/analysis/analysis.routes';
import { registerBulkAnalysisRoutes } from './features/analysis/bulk-analysis.routes';
import { registerProfileRefreshRoutes } from './features/leads/profile-refresh.routes';
import { registerOnboardingRoutes } from './features/onboarding/onboarding.routes';
import { registerBillingRoutes } from './features/billing/billing.routes';
import { handleStripeWebhookQueue } from './infrastructure/queues/stripe-webhook.consumer';
import { handleBusinessContextQueue } from './infrastructure/queues/business-context.consumer';
import AnalysisWorkflow from './infrastructure/workflows/analysis.workflow';
import BusinessContextWorkflow from './infrastructure/workflows/business-context.workflow';
import { GlobalBroadcasterDO } from './infrastructure/durable-objects/global-broadcaster.do';
import { BusinessContextProgressDO } from './infrastructure/durable-objects/business-context-progress.do';
import { executeCronJob } from './infrastructure/cron/cron-jobs.handler';
import { getSentryService } from './infrastructure/monitoring/sentry.service';
import { errorHandler } from './shared/middleware/error.middleware';


const app = new Hono<{ Bindings: Env }>();

// ===============================================================================
// MIDDLEWARE
// ===============================================================================

app.use('*', cors({
  origin: (origin) => {
    const allowedOrigins = [
      'https://app.oslira.com',
      'https://oslira.com',
      'https://staging-app.oslira.com',
      'https://staging.oslira.com',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5173',
    ];

    if (origin && allowedOrigins.includes(origin)) {
      return origin;
    }

    if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return origin;
    }

    return 'https://app.oslira.com';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400,
}));

// ===============================================================================
// HEALTH & INFO
// ===============================================================================

app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    service: 'OSLIRA Enterprise Analysis API',
    version: '10.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'async-workflows',
    phase: 'Phase 3 Complete - Business Context Generation',
    features: {
      workflows: !!c.env.ANALYSIS_WORKFLOW && !!c.env.BUSINESS_CONTEXT_WORKFLOW,
      durable_objects: !!c.env.GLOBAL_BROADCASTER && !!c.env.BUSINESS_CONTEXT_PROGRESS,
      queues: !!c.env.BUSINESS_CONTEXT_QUEUE,
      r2_cache: !!c.env.R2_CACHE_BUCKET,
      analytics: !!c.env.ANALYTICS_ENGINE,
      sentry: true,
      cron_jobs: true,
      prompt_caching: true,
      bulk_analysis: true,
      smart_cache_ttl: true,
      batch_processor: true,
      profile_refresh: true,
      business_context_generation: true
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
      workflows: {
        analysis: !!c.env.ANALYSIS_WORKFLOW,
        business_context: !!c.env.BUSINESS_CONTEXT_WORKFLOW
      },
      durable_objects: {
        global_broadcaster: !!c.env.GLOBAL_BROADCASTER,
        business_context_progress: !!c.env.BUSINESS_CONTEXT_PROGRESS
      },
      queues: {
        stripe_webhooks: !!c.env.STRIPE_WEBHOOK_QUEUE,
        business_context: !!c.env.BUSINESS_CONTEXT_QUEUE
      }
    }
  });
});

// ===============================================================================
// PRODUCTION API ENDPOINTS
// ===============================================================================

registerAuthRoutes(app);

// Phase 3 endpoints (CRUD)
registerLeadRoutes(app);
registerBusinessRoutes(app);
registerCreditsRoutes(app);

// Phase 4 endpoints (Async Analysis)
registerAnalysisRoutes(app);

// Phase 5 endpoints (Bulk Analysis)
registerBulkAnalysisRoutes(app);

// Phase 6-7 endpoints (Cache & Refresh)
registerProfileRefreshRoutes(app);

// Phase 3 endpoints (Onboarding - NEW)
registerOnboardingRoutes(app);

// Billing endpoints
registerBillingRoutes(app);

// ===============================================================================
// ERROR HANDLING
// ===============================================================================

app.onError(async (err, c) => {
  console.error('Worker error:', err);

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
   * Cron Trigger Handler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('[Cron] Trigger:', event.cron);

    try {
      await executeCronJob(event.cron, env);
    } catch (error: any) {
      console.error('[Cron] Job execution failed:', error);

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
    } else if (batch.queue === 'business-context-jobs' || batch.queue === 'business-context-jobs-staging') {
      await handleBusinessContextQueue(batch, env);
    }
  }
};

// ===============================================================================
// EXPORT WORKFLOWS
// ===============================================================================

export { AnalysisWorkflow };
export { BusinessContextWorkflow };

// ===============================================================================
// EXPORT DURABLE OBJECTS
// ===============================================================================

export { GlobalBroadcasterDO };
export { BusinessContextProgressDO };
