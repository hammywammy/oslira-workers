// src/index.ts

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@/shared/types/env.types';
import { registerTestEndpoints } from './test-endpoints';
import { registerLeadRoutes } from './features/leads/leads.routes';
import { registerBusinessRoutes } from './features/business/business.routes';
import { registerCreditsRoutes } from './features/credits/credits.routes';

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
    version: '6.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'feature-first',
    phase: 'Phase 3 Complete - Full CRUD Endpoints'
  });
});

app.get('/health', async (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    bindings: {
      kv: !!c.env.OSLIRA_KV,
      r2: !!c.env.R2_CACHE_BUCKET,
      analytics: !!c.env.ANALYTICS_ENGINE
    }
  });
});

// ===============================================================================
// PRODUCTION API ENDPOINTS (Phase 3)
// ===============================================================================

// Register feature routes
registerLeadRoutes(app);           // 4 endpoints
registerBusinessRoutes(app);       // 4 endpoints (3 + GET /:id)
registerCreditsRoutes(app);        // 4 endpoints (3 + GET /pricing)

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger:', event.cron);
    // Cron jobs will be implemented in Phase 6
  }
};
