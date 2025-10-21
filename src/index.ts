import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@/shared/types/env.types';
import { createUserClient, createAdminClient } from '@/infrastructure/database/supabase.client';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));

// ===============================================================================
// HEALTH CHECK ENDPOINTS
// ===============================================================================

app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    service: 'OSLIRA Enterprise Analysis API',
    version: '6.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'feature-first',
    phase: 'Phase 0.2 - Foundation Complete'
  });
});

app.get('/health', async (c) => {
  const checks: Record<string, boolean | string> = {
    worker: true,
    timestamp: new Date().toISOString()
  };
  
  // Check AWS credentials
  checks.aws_credentials = !!(
    c.env.AWS_ACCESS_KEY_ID && 
    c.env.AWS_SECRET_ACCESS_KEY
  );
  
  // Check Analytics Engine
  checks.analytics_engine = !!c.env.ANALYTICS_ENGINE;
  
  // Check environment
  checks.app_env = c.env.APP_ENV || 'NOT_SET';
  
  // Try to connect to Supabase (tests AWS Secrets + Supabase)
  try {
    const supabase = await createAdminClient(c.env);
    const { error } = await supabase.from('plans').select('id').limit(1);
    
    checks.supabase = !error;
    if (error) {
      checks.supabase_error = error.message;
    }
  } catch (error: any) {
    checks.supabase = false;
    checks.supabase_error = error.message;
  }
  
  // Determine overall health
  const isHealthy = checks.worker && checks.aws_credentials && checks.supabase;
  const statusCode = isHealthy ? 200 : 503;
  
  return c.json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    checks,
    environment: c.env.APP_ENV
  }, statusCode);
});

// ===============================================================================
// TEST ENDPOINTS (Phase 0.2 only - remove in production)
// ===============================================================================

app.get('/test/secrets', async (c) => {
  try {
    const { getSecret } = await import('@/infrastructure/config/secrets');
    
    // Test fetching a secret (don't return the actual value)
    const supabaseUrl = await getSecret('SUPABASE_URL', c.env, c.env.APP_ENV);
    
    return c.json({
      success: true,
      message: 'AWS Secrets Manager connection successful',
      supabase_url_length: supabaseUrl.length,
      cache_working: true
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/supabase/user', async (c) => {
  try {
    const supabase = await createUserClient(c.env);
    const { data, error } = await supabase.from('plans').select('id, name').limit(2);
    
    if (error) throw error;
    
    return c.json({
      success: true,
      message: 'Supabase user client (anon key) working',
      client_type: 'anon_key_with_rls',
      data
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/supabase/admin', async (c) => {
  try {
    const supabase = await createAdminClient(c.env);
    
    // Test RPC function
    const { data, error } = await supabase.rpc('generate_slug', { 
      input_text: 'Test User' 
    });
    
    if (error) throw error;
    
    return c.json({
      success: true,
      message: 'Supabase admin client (service role) working',
      client_type: 'service_role_bypasses_rls',
      test_slug: data
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/analytics', async (c) => {
  try {
    // Write test data point
    c.env.ANALYTICS_ENGINE.writeDataPoint({
      blobs: ['test_event', 'phase_0_2'],
      doubles: [1, Date.now()],
      indexes: ['test']
    });
    
    return c.json({
      success: true,
      message: 'Analytics Engine working',
      note: 'Data will appear in Cloudflare Analytics dashboard in ~1 minute'
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

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
    available_endpoints: [
      'GET / - Service info',
      'GET /health - Health check with binding verification',
      'GET /test/secrets - Test AWS Secrets Manager',
      'GET /test/supabase/user - Test Supabase user client',
      'GET /test/supabase/admin - Test Supabase admin client',
      'GET /test/analytics - Test Analytics Engine'
    ],
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
  
  // Cron handler (placeholder for Phase 6)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger:', event.cron);
    // Cron jobs will be implemented in Phase 6
  }
};
