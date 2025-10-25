// src/shared/utils/auth.util.ts

/**
 * AUTH UTILITIES
 * 
 * Helper functions for working with authentication context
 * Extracted from middleware for reuse across handlers
 */

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { AuthContext } from '@/features/auth/auth.types';

/**
 * Get authentication context from request
 * 
 * Extracts auth context that was attached by authMiddleware
 * Throws error if context is missing (middleware not applied)
 * 
 * Usage:
 * ```typescript
 * export async function myHandler(c: Context<{ Bindings: Env }>) {
 *   const auth = getAuthContext(c);
 *   console.log(auth.userId, auth.accountId);
 * }
 * ```
 * 
 * @param c - Hono context
 * @returns Auth context with userId, accountId, email, onboardingCompleted
 * @throws Error if auth context not found
 */
export function getAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;
  
  if (!auth) {
    throw new Error('Auth context not found - ensure authMiddleware is applied to this route');
  }

  return auth;
}

/**
 * Get optional authentication context
 * 
 * Like getAuthContext but returns null instead of throwing
 * Useful for endpoints that work with or without auth
 * 
 * Usage:
 * ```typescript
 * export async function myHandler(c: Context<{ Bindings: Env }>) {
 *   const auth = getOptionalAuthContext(c);
 *   if (auth) {
 *     // User is authenticated
 *   } else {
 *     // Anonymous user
 *   }
 * }
 * ```
 */
export function getOptionalAuthContext(c: Context<{ Bindings: Env }>): AuthContext | null {
  const auth = c.get('auth') as AuthContext | undefined;
  return auth || null;
}

/**
 * Check if request is authenticated
 * 
 * Quick boolean check without extracting full context
 * 
 * Usage:
 * ```typescript
 * if (isAuthenticated(c)) {
 *   // Show authenticated content
 * } else {
 *   // Show public content
 * }
 * ```
 */
export function isAuthenticated(c: Context<{ Bindings: Env }>): boolean {
  const auth = c.get('auth') as AuthContext | undefined;
  return !!auth;
}
