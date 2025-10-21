// src/tests/middleware-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { authMiddleware, optionalAuthMiddleware, getAuthContext } from '@/shared/middleware/auth.middleware';
import { rateLimitMiddleware, RATE_LIMITS } from '@/shared/middleware/rate-limit.middleware';
import { AppError, asyncHandler } from '@/shared/middleware/error.middleware';
import { successResponse, errorResponse } from '@/shared/utils/response.util';

export function registerMiddlewareTests(app: Hono<{ Bindings: Env }>) {

  // Auth: Required
  app.get('/test/middleware/auth-required', authMiddleware, (c) => {
    const auth = getAuthContext(c);
    return successResponse(c, {
      test: 'Auth Required',
      authenticated: true,
      user: auth
    });
  });

  // Auth: Optional
  app.get('/test/middleware/auth-optional', optionalAuthMiddleware, (c) => {
    const auth = c.get('auth');
    return successResponse(c, {
      test: 'Auth Optional',
      authenticated: !!auth,
      user: auth || null
    });
  });

  // Rate Limiting: General API
  app.get(
    '/test/middleware/rate-limit-general',
    rateLimitMiddleware(RATE_LIMITS.API_GENERAL),
    (c) => successResponse(c, {
      test: 'Rate Limit General',
      limit: RATE_LIMITS.API_GENERAL.maxRequests,
      window: `${RATE_LIMITS.API_GENERAL.windowMs / 1000}s`
    })
  );

  // Rate Limiting: Strict
  app.get(
    '/test/middleware/rate-limit-strict',
    rateLimitMiddleware(RATE_LIMITS.WEBHOOK),
    (c) => successResponse(c, {
      test: 'Rate Limit Strict',
      limit: RATE_LIMITS.WEBHOOK.maxRequests,
      window: `${RATE_LIMITS.WEBHOOK.windowMs / 1000}s`
    })
  );

  // Error Handling: AppError
  app.get('/test/middleware/error-app-error', asyncHandler(async (c) => {
    throw new AppError('Test application error', 400, 'TEST_ERROR');
  }));

  // Error Handling: Unknown Error
  app.get('/test/middleware/error-unknown', asyncHandler(async (c) => {
    throw new Error('Test unknown error');
  }));
}
