import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { AuthContext } from '@/features/auth/auth.types';
import { JWTService } from '@/infrastructure/auth/jwt.service';
import { logger } from '@/shared/utils/logger.util';

/**
 * Auth middleware - validates JWT access token and attaches auth context
 *
 * Features:
 * - Validates JWT signature + expiry
 * - Enforces onboarding completion (except for auth/onboarding endpoints)
 * - Attaches auth context: { userId, accountId, email, onboardingCompleted }
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  try {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({
        error: 'Missing or invalid Authorization header',
        message: 'Format: Authorization: Bearer <token>'
      }, 401);
    }

    const token = authHeader.substring(7);
    const jwtService = new JWTService(c.env);
    const payload = await jwtService.verify(token);

    if (!payload) {
      return c.json({
        error: 'Invalid or expired token',
        message: 'Please refresh your token or log in again'
      }, 401);
    }

    const path = c.req.path;
    const isAuthEndpoint = path.includes('/api/auth/');
    const isOnboardingEndpoint = path.includes('/api/onboarding/');
    const isBusinessEndpoint = path.startsWith('/api/business/');

    if (!isAuthEndpoint && !isOnboardingEndpoint && !isBusinessEndpoint && !payload.onboardingCompleted) {
      return c.json({
        error: 'Onboarding not completed',
        message: 'Please complete onboarding to access this resource',
        redirect: '/onboarding'
      }, 403);
    }

    const authContext: AuthContext = {
      userId: payload.userId,
      accountId: payload.accountId,
      email: payload.email,
      onboardingCompleted: payload.onboardingCompleted
    };

    c.set('auth', authContext);
    await next();

  } catch (error: unknown) {
    logger.error('Auth middleware error', {
      error: error instanceof Error ? error.message : String(error),
      path: c.req.path
    });
    return c.json({
      error: 'Authentication failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 401);
  }
}

/**
 * Optional auth middleware - attempts to authenticate but doesn't fail if token is missing/invalid
 * Useful for endpoints that work for both authenticated and anonymous users
 */
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  try {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      await next();
      return;
    }

    const token = authHeader.substring(7);
    const jwtService = new JWTService(c.env);
    const payload = await jwtService.verify(token);

    if (payload) {
      const authContext: AuthContext = {
        userId: payload.userId,
        accountId: payload.accountId,
        email: payload.email,
        onboardingCompleted: payload.onboardingCompleted
      };
      c.set('auth', authContext);
    }

    await next();

  } catch {
    await next();
  }
}

/**
 * Get auth context from request
 * @throws Error if auth context is missing
 */
export function getAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;

  if (!auth) {
    throw new Error('Auth context not found - ensure authMiddleware is applied');
  }

  return auth;
}

/** Check if request has valid admin token */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const adminToken = c.req.header('X-Admin-Token');
  return adminToken === c.env.ADMIN_TOKEN;
}

/** Admin middleware - requires valid admin token in X-Admin-Token header */
export async function adminMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  if (!isAdmin(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
}
