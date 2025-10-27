// src/shared/middleware/auth.middleware.ts
// UPDATED FOR CUSTOM JWT AUTHENTICATION

import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { AuthContext } from '@/features/auth/auth.types';
import { JWTService } from '@/infrastructure/auth/jwt.service';

/**
 * AUTH MIDDLEWARE
 * 
 * Validates JWT access token and attaches auth context to request
 * 
 * Features:
 * - Validates JWT signature + expiry
 * - Enforces onboarding completion (except for auth/onboarding endpoints)
 * - Attaches auth context: { userId, accountId, email, onboardingCompleted }
 * 
 * Usage:
 * app.get('/api/leads', authMiddleware, handler);
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    // Extract token from Authorization header
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ 
        error: 'Missing or invalid Authorization header',
        message: 'Format: Authorization: Bearer <token>' 
      }, 401);
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT
    const jwtService = new JWTService(c.env);
    const payload = await jwtService.verify(token);

    if (!payload) {
      return c.json({ 
        error: 'Invalid or expired token',
        message: 'Please refresh your token or log in again' 
      }, 401);
    }

    // Check onboarding completion
    // Skip check for auth and onboarding endpoints
const path = c.req.path;
const isAuthEndpoint = path.includes('/api/auth/');
const isOnboardingEndpoint = path.includes('/api/onboarding/');
const isBusinessEndpoint = path.includes('/api/business/'); // ✅ ADDED: Allow business endpoints during onboarding

if (!isAuthEndpoint && !isOnboardingEndpoint && !isBusinessEndpoint && !payload.onboardingCompleted) {
  return c.json({
    error: 'Onboarding not completed',
    message: 'Please complete onboarding to access this resource',
    redirect: '/onboarding'
  }, 403);
}

    // Attach auth context to request
    const authContext: AuthContext = {
      userId: payload.userId,
      accountId: payload.accountId,
      email: payload.email,
      onboardingCompleted: payload.onboardingCompleted
    };

    c.set('auth', authContext);

    await next();

  } catch (error: any) {
    console.error('[AuthMiddleware] Error:', error);
    return c.json({ 
      error: 'Authentication failed',
      message: error.message 
    }, 401);
  }
}

/**
 * OPTIONAL AUTH MIDDLEWARE
 * 
 * Attempts to authenticate but doesn't fail if token is missing/invalid
 * Useful for endpoints that work for both authenticated and anonymous users
 * 
 * Usage:
 * app.get('/api/public-data', optionalAuthMiddleware, handler);
 */
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    const authHeader = c.req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth provided - continue without auth context
      await next();
      return;
    }

    const token = authHeader.substring(7);
    const jwtService = new JWTService(c.env);
    const payload = await jwtService.verify(token);

    if (payload) {
      // Valid token - attach auth context
      const authContext: AuthContext = {
        userId: payload.userId,
        accountId: payload.accountId,
        email: payload.email,
        onboardingCompleted: payload.onboardingCompleted
      };
      c.set('auth', authContext);
    }

    await next();

  } catch (error) {
    // Ignore errors - proceed without auth
    await next();
  }
}

/**
 * GET AUTH CONTEXT
 * 
 * Helper to extract auth context from request
 * Throws error if auth context is missing
 * 
 * Usage:
 * const auth = getAuthContext(c);
 * console.log(auth.userId, auth.accountId);
 */
export function getAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;
  
  if (!auth) {
    throw new Error('Auth context not found - ensure authMiddleware is applied');
  }

  return auth;
}

/**
 * CHECK ADMIN
 * 
 * Verify if request has valid admin token
 * Used for admin-only endpoints
 * 
 * Usage:
 * if (!isAdmin(c)) return c.json({ error: 'Unauthorized' }, 403);
 */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const adminToken = c.req.header('X-Admin-Token');
  return adminToken === c.env.ADMIN_TOKEN;
}

/**
 * ADMIN MIDDLEWARE
 * 
 * Requires valid admin token in X-Admin-Token header
 * 
 * Usage:
 * app.post('/api/admin/cleanup', adminMiddleware, handler);
 */
export async function adminMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAdmin(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
}
