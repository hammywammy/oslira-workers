// src/test-endpoints.ts
import type { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getSecret } from '@/infrastructure/config/secrets';
import { registerApiTests } from './tests/api-tests';

// Import existing test suites (you'll need to create these or they're in your actual project)
// import { registerInfrastructureTests } from './tests/infrastructure-tests';
// import { registerMonitoringTests } from './tests/monitoring-tests';
// import { registerMiddlewareTests } from './tests/middleware-tests';
// import { registerRepositoryTests } from './tests/repository-tests';
// import { registerUtilitiesTests } from './tests/utilities-tests';
// import { registerIntegrationTests } from './tests/integration-tests';
// import { registerTestDataEndpoints } from './tests/test-data';

/**
 * All test endpoints organized by suite
 */
const TEST_REGISTRY = {
  api: [
    '/test/api/leads/list',
    '/test/api/leads/get-single',
    '/test/api/leads/get-analyses',
    '/test/api/leads/delete',
    '/test/api/business/list',
    '/test/api/business/get-single',
    '/test/api/business/create',
    '/test/api/business/update',
    '/test/api/credits/balance',
    '/test/api/credits/transactions',
    '/test/api/credits/pricing',
    '/test/api/credits/purchase',
    '/test/api/full-journey'
  ],
  // Uncomment as you add other test suites:
  // infrastructure: [
  //   '/test/infrastructure/secrets',
  //   '/test/infrastructure/supabase-user',
  //   '/test/infrastructure/supabase-admin',
  //   '/test/infrastructure/analytics',
  //   '/test/infrastructure/r2-cache',
  //   '/test/infrastructure/ai-gateway',
  //   '/test/infrastructure/apify'
  // ],
  // monitoring: [
  //   '/test/monitoring/cost-tracker',
  //   '/test/monitoring/performance-tracker'
  // ],
  // middleware: [
  //   '/test/middleware/auth-required',
  //   '/test/middleware/auth-optional',
  //   '/test/middleware/rate-limit-general',
  //   '/test/middleware/rate-limit-strict',
  //   '/test/middleware/error-app-error',
  //   '/test/middleware/error-unknown'
  // ],
  // repository: [
  //   '/test/repository/credits'
  // ],
  // utilities: [
  //   '/test/utils/response-success',
  //   '/test/utils/response-created',
  //   '/test/utils/response-paginated',
  //   '/test/utils/response-error',
  //   '/test/utils/validation-success',
  //   '/test/utils/validation-fail',
  //   '/test/utils/logger',
  //   '/test/utils/id-generators'
  // ],
  // integration: [
  //   '/test/integration/full-flow'
  // ]
};

/**
 * Tests that need account_id parameter
 */
const REQUIRES_ACCOUNT_ID = [
  '/test/api/leads/list',
  '/test/repository/credits',
  '/test/integration/full-flow'
];

/**
 * Tests that need lead_id parameter
 */
const REQUIRES_LEAD_ID = [
  '/test/api/leads/get-single',
  '/test/api/leads/get-analyses',
  '/test/api/leads/delete'
];

/**
 * Tests that need profile_id parameter
 */
const REQUIRES_PROFILE_ID = [
  '/test/api/business/get-single',
  '/test/api/business/update'
];

/**
 * Tests that are expected to fail (validation tests, error handling)
 */
const EXPECTED_TO_FAIL = [
  '/test/middleware/auth-required',
  '/test/middleware/error-app-error',
  '/test/middleware/error-unknown',
  '/test/utils/response-error'
];

/**
 * Tests that should be skipped (Stripe purchases, etc.)
 */
const SKIP_TESTS = [
  '/test/api/credits/purchase'  // Requires valid Stripe test card
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
  registerApiTests(app);
  
  // Uncomment as you add them:
  // registerInfrastructureTests(app);
  // registerMonitoringTests(app);
  // registerMiddlewareTests(app);
  // registerRepositoryTests(app);
  // registerUtilitiesTests(app);
  // registerIntegrationTests(app);
  // registerTestDataEndpoints(app);

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
        run_all: 'GET /test/run-all (requires Authorization + X-Account-Id + X-Lead-Id + X-Profile-Id headers)',
        run_suite: 'GET /test/run-suite/:suite (same headers)'
      },
      required_headers: {
        all_tests: ['Authorization: Bearer <jwt-token>'],
        with_params: [
          'X-Account-Id: <uuid> (for account-specific tests)',
          'X-Lead-Id: <uuid> (for lead-specific tests)',
          'X-Profile-Id: <uuid> (for profile-specific tests)'
        ],
        production_only: ['X-Admin-Token: <secret>']
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
   */
  app.get('/test/run-all', async (c) => {
    const startTime = Date.now();
    const authToken = c.req.header('Authorization');
    const accountId = c.req.header('X-Account-Id');
    const leadId = c.req.header('X-Lead-Id');
    const profileId = c.req.header('X-Profile-Id');

    if (!authToken) {
      return c.json({
        success: false,
        error: 'Missing Authorization header',
        hint: 'Add header: Authorization: Bearer <jwt-token>'
      }, 401);
    }

    // Build test promises
    const testPromises = Object.entries(TEST_REGISTRY).flatMap(([suite, endpoints]) =>
      endpoints.map(endpoint => {
        const testStart = Date.now();
        
        return (async () => {
          try {
            // Skip certain tests
            if (SKIP_TESTS.includes(endpoint)) {
              return {
                suite,
                endpoint,
                status: 'skipped',
                duration_ms: 0,
                note: 'Skipped by configuration'
              };
            }

            // Build URL with query params
            let url = endpoint;
            const params = new URLSearchParams();
            
            if (REQUIRES_ACCOUNT_ID.includes(endpoint) && accountId) {
              params.append('account_id', accountId);
            }
            if (REQUIRES_LEAD_ID.includes(endpoint) && leadId) {
              params.append('lead_id', leadId);
            }
            if (REQUIRES_PROFILE_ID.includes(endpoint) && profileId) {
              params.append('profile_id', profileId);
            }

            if (params.toString()) {
              url += `?${params.toString()}`;
            }

            // Build headers
            const headers: Record<string, string> = {
              'Authorization': authToken
            };

            // Copy admin token if present
            const adminToken = c.req.header('X-Admin-Token');
            if (adminToken) {
              headers['X-Admin-Token'] = adminToken;
            }

            // Determine method
            const method = endpoint.includes('/delete') ? 'DELETE' :
                          endpoint.includes('/create') || endpoint.includes('/purchase') ? 'POST' :
                          endpoint.includes('/update') ? 'PUT' : 'GET';

            const response = await app.request(url, { method, headers }, c.env);
            const data = await response.json();
            const duration = Date.now() - testStart;

            // Determine pass/fail
            const isExpectedToFail = EXPECTED_TO_FAIL.includes(endpoint);
            const actuallyFailed = !response.ok || data.success === false;
            
            let testPassed: boolean;
            let resultStatus: 'passed' | 'failed';
            
            if (isExpectedToFail) {
              testPassed = actuallyFailed;
              resultStatus = testPassed ? 'passed' : 'failed';
            } else {
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
    const skipped = results.filter(r => r.status === 'skipped').length;
    const totalDuration = Date.now() - startTime;

    return c.json({
      success: failed === 0,
      summary: {
        total: results.length,
        passed,
        failed,
        skipped,
        duration_ms: totalDuration,
        note: 'Tests executed in parallel'
      },
      results
    });
  });

  /**
   * GET /test/run-suite/:suite - Run specific test suite
   */
  app.get('/test/run-suite/:suite', async (c) => {
    const suite = c.req.param('suite');
    const endpoints = TEST_REGISTRY[suite as keyof typeof TEST_REGISTRY];

    if (!endpoints) {
      return c.json({
        success: false,
        error: `Unknown test suite: ${suite}`,
        available: Object.keys(TEST_REGISTRY)
      }, 404);
    }

    const startTime = Date.now();
    const authToken = c.req.header('Authorization');
    const accountId = c.req.header('X-Account-Id');
    const leadId = c.req.header('X-Lead-Id');
    const profileId = c.req.header('X-Profile-Id');

    if (!authToken) {
      return c.json({
        success: false,
        error: 'Missing Authorization header'
      }, 401);
    }

    // Similar logic to run-all but for single suite
    const testPromises = endpoints.map(endpoint => {
      const testStart = Date.now();
      
      return (async () => {
        try {
          if (SKIP_TESTS.includes(endpoint)) {
            return {
              endpoint,
              status: 'skipped',
              duration_ms: 0,
              note: 'Skipped by configuration'
            };
          }

          let url = endpoint;
          const params = new URLSearchParams();
          
          if (REQUIRES_ACCOUNT_ID.includes(endpoint) && accountId) {
            params.append('account_id', accountId);
          }
          if (REQUIRES_LEAD_ID.includes(endpoint) && leadId) {
            params.append('lead_id', leadId);
          }
          if (REQUIRES_PROFILE_ID.includes(endpoint) && profileId) {
            params.append('profile_id', profileId);
          }

          if (params.toString()) {
            url += `?${params.toString()}`;
          }

          const headers: Record<string, string> = {
            'Authorization': authToken
          };

          const adminToken = c.req.header('X-Admin-Token');
          if (adminToken) {
            headers['X-Admin-Token'] = adminToken;
          }

          const method = endpoint.includes('/delete') ? 'DELETE' :
                        endpoint.includes('/create') || endpoint.includes('/purchase') ? 'POST' :
                        endpoint.includes('/update') ? 'PUT' : 'GET';

          const response = await app.request(url, { method, headers }, c.env);
          const data = await response.json();
          const duration = Date.now() - testStart;

          const isExpectedToFail = EXPECTED_TO_FAIL.includes(endpoint);
          const actuallyFailed = !response.ok || data.success === false;
          
          let resultStatus: 'passed' | 'failed';
          if (isExpectedToFail) {
            resultStatus = actuallyFailed ? 'passed' : 'failed';
          } else {
            resultStatus = actuallyFailed ? 'failed' : 'passed';
          }

          return {
            endpoint,
            status: resultStatus,
            duration_ms: duration,
            ...(resultStatus === 'failed' && { error: data.error || data.message })
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

    const results = await Promise.all(testPromises);
    
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    return c.json({
      success: failed === 0,
      suite,
      summary: {
        total: results.length,
        passed,
        failed,
        skipped,
        duration_ms: Date.now() - startTime
      },
      results
    });
  });
}
