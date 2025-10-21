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
    '/test/middleware/auth-required',
    '/test/middleware/auth-optional',
    '/test/middleware/rate-limit-general',
    '/test/middleware/rate-limit-strict',
    '/test/middleware/error-app-error',
    '/test/middleware/error-unknown'
  ],
  repository: [
    '/test/repository/credits'
  ],
  utilities: [
    '/test/utils/response-success',
    '/test/utils/response-created',
    '/test/utils/response-paginated',
    '/test/utils/response-error',
    '/test/utils/validation-success',
    '/test/utils/validation-fail',
    '/test/utils/logger',
    '/test/utils/id-generators'
  ],
  integration: [
    '/test/integration/full-flow'
  ]
};

/**
 * Tests that are EXPECTED to fail (auth rejection, error throwing, etc.)
 * These tests "pass" when they return an error response
 */
const EXPECTED_TO_FAIL = [
  '/test/middleware/auth-required',        // Should reject with 401
  '/test/middleware/error-app-error',      // Should throw AppError
  '/test/middleware/error-unknown',        // Should throw unknown error
  '/test/utils/response-error'             // Should return error response
];

/**
 * Tests that need account_id parameter
 */
const REQUIRES_ACCOUNT_ID = [
  '/test/repository/credits',
  '/test/integration/full-flow'
];

/**
 * POST endpoints with their required bodies
 */
const POST_ENDPOINTS: Record<string, { method: string; body?: any }> = {
  '/test/utils/response-created': { method: 'POST' },
  '/test/utils/validation-success': { 
    method: 'POST',
    body: { username: 'testuser', analysisType: 'deep' }
  },
  '/test/utils/validation-fail': { 
    method: 'POST',
    body: { username: '', analysisType: 'invalid' }
  }
};

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
   * GET /test/run-all - Run all tests in parallel
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

    // Build all test promises
    const testPromises = Object.entries(TEST_REGISTRY).flatMap(([suite, endpoints]) =>
      endpoints.map(endpoint => {
        const testStart = Date.now();
        
        return (async () => {
          try {
            // Build URL with account_id if needed
            let url = endpoint;
            if (REQUIRES_ACCOUNT_ID.includes(endpoint)) {
              url = `${endpoint}?account_id=${accountId}`;
            }

            // Determine method and body
            const postConfig = POST_ENDPOINTS[endpoint];
            const method = postConfig?.method || 'GET';
            const headers: Record<string, string> = {};
            
            // Copy headers from request
            c.req.raw.headers.forEach((value, key) => {
              headers[key] = value;
            });

            let requestInit: any = { headers };
            
            if (method === 'POST') {
              headers['Content-Type'] = 'application/json';
              requestInit.method = 'POST';
              if (postConfig?.body) {
                requestInit.body = JSON.stringify(postConfig.body);
              }
            }

            const response = await app.request(url, requestInit, c.env);
            const data = await response.json();
            const duration = Date.now() - testStart;

            // Determine if test passed based on expectations
            const isExpectedToFail = EXPECTED_TO_FAIL.includes(endpoint);
            const actuallyFailed = !response.ok || data.success === false;
            
            let testPassed: boolean;
            let resultStatus: 'passed' | 'failed';
            
            if (isExpectedToFail) {
              // Test SHOULD fail - passes if it actually failed
              testPassed = actuallyFailed;
              resultStatus = testPassed ? 'passed' : 'failed';
            } else {
              // Test SHOULD pass - passes if it actually passed
              testPassed = !actuallyFailed;
              resultStatus = testPassed ? 'passed' : 'failed';
            }

            return {
              suite,
              endpoint,
              status: resultStatus,
              duration_ms: duration,
              ...(resultStatus === 'failed' && { error: data.error || data.message }),
              ...(isExpectedToFail && { note: 'Expected to fail' })
            };
          } catch (error: any) {
            return {
              suite,
              endpoint,
              status: 'failed',
              duration_ms: Date.now() - testStart,
              error: error.message
            };
          }
        })();
      })
    );

    // Execute all tests in parallel
    const results = await Promise.all(testPromises);
    
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const totalDuration = Date.now() - startTime;

    return c.json({
      success: failed === 0,
      summary: {
        total: results.length,
        passed,
        failed,
        duration_ms: totalDuration,
        note: 'Tests executed in parallel'
      },
      results
    });
  });

  /**
   * GET /test/run-suite/:suite - Run specific test suite in parallel
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

    // Build all test promises
    const testPromises = endpoints.map(endpoint => {
      const testStart = Date.now();
      
      return (async () => {
        try {
          // Build URL with account_id if needed
          let url = endpoint;
          if (REQUIRES_ACCOUNT_ID.includes(endpoint)) {
            url = `${endpoint}?account_id=${accountId}`;
          }

          // Determine method and body
          const postConfig = POST_ENDPOINTS[endpoint];
          const method = postConfig?.method || 'GET';
          const headers: Record<string, string> = {};
          
          // Copy headers from request
          c.req.raw.headers.forEach((value, key) => {
            headers[key] = value;
          });

          let requestInit: any = { headers };
          
          if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
            requestInit.method = 'POST';
            if (postConfig?.body) {
              requestInit.body = JSON.stringify(postConfig.body);
            }
          }

          const response = await app.request(url, requestInit, c.env);
          const data = await response.json();
          const duration = Date.now() - testStart;

          // Determine if test passed based on expectations
          const isExpectedToFail = EXPECTED_TO_FAIL.includes(endpoint);
          const actuallyFailed = !response.ok || data.success === false;
          
          let testPassed: boolean;
          let resultStatus: 'passed' | 'failed';
          
          if (isExpectedToFail) {
            // Test SHOULD fail - passes if it actually failed
            testPassed = actuallyFailed;
            resultStatus = testPassed ? 'passed' : 'failed';
          } else {
            // Test SHOULD pass - passes if it actually passed
            testPassed = !actuallyFailed;
            resultStatus = testPassed ? 'passed' : 'failed';
          }

          return {
            endpoint,
            status: resultStatus,
            duration_ms: duration,
            ...(resultStatus === 'failed' && { error: data.error || data.message }),
            ...(isExpectedToFail && { note: 'Expected to fail' })
          };
        } catch (error: any) {
          return {
            endpoint,
            status: 'failed',
            duration_ms: Date.now() - testStart,
            error: error.message
          };
        }
      })();
    });

    // Execute all tests in parallel
    const results = await Promise.all(testPromises);
    
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    return c.json({
      success: failed === 0,
      suite,
      summary: {
        total: results.length,
        passed,
        failed,
        duration_ms: Date.now() - startTime,
        note: 'Tests executed in parallel'
      },
      results
    });
  });
}
