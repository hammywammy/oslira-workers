// src/shared/middleware/auth.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { createUserClient, createAdminClient } from '@/infrastructure/database/supabase.client';
import { getSecret } from '@/infrastructure/config/secrets';

export interface AuthContext {
  userId: string;
  email: string;
  accountIds: string[];
  primaryAccountId: string;
  isTestMode?: boolean;
}

/**
 * Validates JWT and attaches user info to context
 * Use on all authenticated routes
 * 
 * TESTING BYPASS: In non-production environments, allows X-Admin-Token + X-Account-Id
 * to bypass JWT authentication for easier API testing
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  
  // ============================================================================
  // TESTING BYPASS (Non-Production Only)
  // ============================================================================
  if (c.env.APP_ENV !== 'production') {
    const adminToken = c.req.header('X-Admin-Token');
    const testAccountId = c.req.header('X-Account-Id');
    
    if (adminToken && testAccountId) {
      try {
        const storedAdminToken = await getSecret('ADMIN_TOKEN', c.env, c.env.APP_ENV).catch(() => null);
        
        if (storedAdminToken && adminToken === storedAdminToken) {
          // Verify account exists
          const supabase = await createAdminClient(c.env);
          const { data: account, error } = await supabase
            .from('accounts')
            .select('id')
            .eq('id', testAccountId)
            .is('deleted_at', null)
            .single();
          
          if (!error && account) {
            // Bypass JWT - use test account
            c.set('auth', {
              userId: 'test-user-bypass',
              email: 'test@oslira.com',
              accountIds: [testAccountId],
              primaryAccountId: testAccountId,
              isTestMode: true
            } as AuthContext);
            
            await next();
            return;
          }
        }
      } catch (error) {
        console.warn('Admin token bypass failed:', error);
        // Fall through to normal JWT auth
      }
    }
  }
  
  // ============================================================================
  // NORMAL JWT AUTHENTICATION
  // ============================================================================
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: 'Missing or invalid Authorization header',
      code: 'UNAUTHORIZED',
      hint: c.env.APP_ENV !== 'production' 
        ? 'For testing: use X-Admin-Token + X-Account-Id headers'
        : undefined
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
      primaryAccountId: accountIds[0], // First account is primary
      isTestMode: false
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
          primaryAccountId: accountIds[0],
          isTestMode: false
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
