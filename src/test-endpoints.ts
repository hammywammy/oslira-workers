// src/test-endpoints.ts
import type { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getSecret } from '@/infrastructure/config/secrets';
import { registerInfrastructureTests } from './tests/infrastructure-tests';
import { registerMonitoringTests } from './tests/monitoring-tests';
import { registerMiddlewareTests } from './tests/middleware-tests';
import { registerRepositoryTests } from './tests/repository-tests';
import { registerUtilitiesTests } from './tests/utilities-tests';
import { registerIntegrationTests } from './tests/integration-tests';
import { registerTestDataEndpoints } from './tests/test-data';

/**
 * All test endpoints organized by suite
 */
const TEST_REGISTRY = {
  infrastructure: [
    '/test/infrastructure/secrets',
    '/test/infrastructure/supabase-user',
    '/test/infrastructure/supabase-admin',
    '/test/infrastructure/analytics',
    '/test/infrastructure/r2-cache',
    '/test/infrastructure/ai-gateway',
    '/test/infrastructure/apify'
  ],
  monitoring: [
    '/test/monitoring/cost-tracker',
    '/test/monitoring/performance-tracker'
  ],
  middleware: [
    '/test/middleware/auth-optional',
    '/test/middleware/rate-limit-general',
    '/test/middleware/rate-limit-strict'
  ],
  repository: [
    '/test/repository/credits'
  ],
  utilities: [
    '/test/utils/response-success',
    '/test/utils/response-paginated',
    '/test/utils/logger',
    '/test/utils/id-generators'
  ],
  integration: [
    '/test/integration/full-flow'
  ]
};

/**
 * Tests that need account_id parameter
 */
const REQUIRES_ACCOUNT_ID = [
  '/test/repository/credits',
  '/test/integration/full-flow'
];

/**
 * Register all test endpoints
 */
export function registerTestEndpoints(app: Hono<{ Bindings: Env }>) {
  
  // Protect test endpoints in production with admin token
  app.use('/test/*', async (c, next) => {
    if (c.env.APP_ENV === 'production') {
      const providedToken = c.req.header('X-Admin-Token');
      const adminToken = await getSecret('ADMIN_TOKEN', c.env, c.env.APP_ENV).catch(() => null);
      
      if (!providedToken || !adminToken || providedToken !== adminToken) {
        return c.json({
          success: false,
          error: 'Test endpoints require X-Admin-Token header in production',
          code: 'ADMIN_AUTH_REQUIRED'
        }, 403);
      }
    }
    await next();
  });

  // Register all individual test suites
  registerInfrastructureTests(app);
  registerMonitoringTests(app);
  registerMiddlewareTests(app);
  registerRepositoryTests(app);
  registerUtilitiesTests(app);
  registerIntegrationTests(app);
  registerTestDataEndpoints(app);

  // ===============================================================================
  // TEST ORCHESTRATION
  // ===============================================================================

  /**
   * GET /test - List all available tests
   */
  app.get('/test', (c) => {
    const allTests = Object.entries(TEST_REGISTRY).flatMap(([suite, endpoints]) => 
      endpoints.map(ep => ({ suite, endpoint: ep }))
    );

    return c.json({
      success: true,
      message: 'Oslira Test Suite',
      total_tests: allTests.length,
      usage: {
        list_all: 'GET /test',
        run_all: 'GET /test/run-all (requires X-Admin-Token + X-Account-Id headers)',
        run_suite: 'GET /test/run-suite/:suite (requires X-Admin-Token + X-Account-Id headers)'
      },
      required_headers: {
        all_environments: ['X-Admin-Token', 'X-Account-Id'],
        production_only: ['X-Admin-Token']
      },
      suites: Object.fromEntries(
        Object.entries(TEST_REGISTRY).map(([suite, endpoints]) => [
          suite,
          { count: endpoints.length, endpoints }
        ])
      )
    });
  });

  /**
   * GET /test/run-all - Run all tests sequentially
   * Requires: X-Admin-Token, X-Account-Id headers
   */
  app.get('/test/run-all', async (c) => {
    const accountId = c.req.header('X-Account-Id');
    
    if (!accountId) {
      return c.json({
        success: false,
        error: 'Missing required header: X-Account-Id',
        code: 'MISSING_ACCOUNT_ID',
        hint: 'Add header: X-Account-Id: <your-account-id>'
      }, 400);
    }

    const startTime = Date.now();
    const results: any[] = [];
    let passed = 0;
    let failed = 0;

    for (const [suite, endpoints] of Object.entries(TEST_REGISTRY)) {
      for (const endpoint of endpoints) {
        const testStart = Date.now();
        
        try {
          // Build URL with account_id if needed
          let url = endpoint;
          if (REQUIRES_ACCOUNT_ID.includes(endpoint)) {
            url = `${endpoint}?account_id=${accountId}`;
          }

          const response = await app.request(url, {
            headers: c.req.raw.headers
          }, c.env);
          
          const data = await response.json();
          const duration = Date.now() - testStart;
          
          if (response.ok && data.success !== false) {
            passed++;
            results.push({
              suite,
              endpoint,
              status: 'passed',
              duration_ms: duration
            });
          } else {
            failed++;
            results.push({
              suite,
              endpoint,
              status: 'failed',
              duration_ms: duration,
              error: data.error || data.message
            });
          }
        } catch (error: any) {
          failed++;
          results.push({
            suite,
            endpoint,
            status: 'failed',
            duration_ms: Date.now() - testStart,
            error: error.message
          });
        }
      }
    }

    const totalDuration = Date.now() - startTime;

    return c.json({
      success: failed === 0,
      summary: {
        total: results.length,
        passed,
        failed,
        duration_ms: totalDuration
      },
      results
    });
  });

  /**
   * GET /test/run-suite/:suite - Run specific test suite
   * Requires: X-Admin-Token, X-Account-Id headers
   */
  app.get('/test/run-suite/:suite', async (c) => {
    const suite = c.req.param('suite');
    const accountId = c.req.header('X-Account-Id');
    const endpoints = TEST_REGISTRY[suite as keyof typeof TEST_REGISTRY];

    if (!endpoints) {
      return c.json({
        success: false,
        error: `Unknown test suite: ${suite}`,
        available: Object.keys(TEST_REGISTRY)
      }, 404);
    }

    if (!accountId) {
      return c.json({
        success: false,
        error: 'Missing required header: X-Account-Id',
        code: 'MISSING_ACCOUNT_ID',
        hint: 'Add header: X-Account-Id: <your-account-id>'
      }, 400);
    }

    const startTime = Date.now();
    const results: any[] = [];
    let passed = 0;
    let failed = 0;

    for (const endpoint of endpoints) {
      const testStart = Date.now();
      
      try {
        // Build URL with account_id if needed
        let url = endpoint;
        if (REQUIRES_ACCOUNT_ID.includes(endpoint)) {
          url = `${endpoint}?account_id=${accountId}`;
        }

        const response = await app.request(url, {
          headers: c.req.raw.headers
        }, c.env);
        
        const data = await response.json();
        const duration = Date.now() - testStart;
        
        if (response.ok && data.success !== false) {
          passed++;
          results.push({
            endpoint,
            status: 'passed',
            duration_ms: duration
          });
        } else {
          failed++;
          results.push({
            endpoint,
            status: 'failed',
            duration_ms: duration,
            error: data.error || data.message
          });
        }
      } catch (error: any) {
        failed++;
        results.push({
          endpoint,
          status: 'failed',
          duration_ms: Date.now() - testStart,
          error: error.message
        });
      }
    }

    return c.json({
      success: failed === 0,
      suite,
      summary: {
        total: results.length,
        passed,
        failed,
        duration_ms: Date.now() - startTime
      },
      results
    });
  });
}
