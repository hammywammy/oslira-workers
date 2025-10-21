// src/shared/middleware/auth.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { createUserClient } from '@/infrastructure/database/supabase.client';

export interface AuthContext {
  userId: string;
  email: string;
  accountIds: string[];
  primaryAccountId: string;
}

/**
 * Validates JWT and attaches user info to context
 * Use on all authenticated routes
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: 'Missing or invalid Authorization header',
      code: 'UNAUTHORIZED'
    }, 401);
  }
  
  const token = authHeader.substring(7);
  
  try {
    // Verify JWT with Supabase
    const supabase = await createUserClient(c.env);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return c.json({
        success: false,
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      }, 401);
    }
    
    // Get user's accounts
    const { data: memberships } = await supabase
      .from('account_members')
      .select('account_id, role')
      .eq('user_id', user.id);
    
    const accountIds = memberships?.map(m => m.account_id) || [];
    
    if (accountIds.length === 0) {
      return c.json({
        success: false,
        error: 'User has no associated accounts',
        code: 'NO_ACCOUNTS'
      }, 403);
    }
    
    // Attach auth context to request
    c.set('auth', {
      userId: user.id,
      email: user.email || '',
      accountIds,
      primaryAccountId: accountIds[0] // First account is primary
    } as AuthContext);
    
    await next();
  } catch (error: any) {
    console.error('Auth middleware error:', error);
    return c.json({
      success: false,
      error: 'Authentication failed',
      code: 'AUTH_ERROR'
    }, 500);
  }
}

/**
 * Optional auth - attaches user if token present, continues if not
 * Use for endpoints that work both authenticated and anonymous
 */
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No auth provided - continue without user context
    await next();
    return;
  }
  
  const token = authHeader.substring(7);
  
  try {
    const supabase = await createUserClient(c.env);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (!error && user) {
      const { data: memberships } = await supabase
        .from('account_members')
        .select('account_id, role')
        .eq('user_id', user.id);
      
      const accountIds = memberships?.map(m => m.account_id) || [];
      
      if (accountIds.length > 0) {
        c.set('auth', {
          userId: user.id,
          email: user.email || '',
          accountIds,
          primaryAccountId: accountIds[0]
        } as AuthContext);
      }
    }
  } catch (error) {
    // Fail silently for optional auth
    console.warn('Optional auth failed:', error);
  }
  
  await next();
}

/**
 * Helper to get auth context from request
 */
export function getAuthContext(c: Context): AuthContext {
  const auth = c.get('auth');
  if (!auth) {
    throw new Error('Auth context not found - did you forget authMiddleware?');
  }
  return auth as AuthContext;
}

/**
 * Helper to check if user has access to account
 */
export function hasAccountAccess(c: Context, accountId: string): boolean {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) return false;
  return auth.accountIds.includes(accountId);
}
