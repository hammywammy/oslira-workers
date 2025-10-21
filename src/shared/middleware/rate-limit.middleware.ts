// src/shared/middleware/rate-limit.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';

export interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix: string;     // KV key prefix
}

/**
 * Rate limiting using Cloudflare KV
 * Stores request counts per user/IP with automatic expiration
 */
export async function rateLimitMiddleware(
  config: RateLimitConfig
) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Get identifier (user ID or IP address)
    const auth = c.get('auth') as { userId?: string } | undefined;
    const identifier = auth?.userId || c.req.header('cf-connecting-ip') || 'anonymous';
    
    const key = `${config.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    try {
      // Get current count from KV
      const stored = await c.env.OSLIRA_KV.get(key, 'json') as {
        count: number;
        resetAt: number;
      } | null;
      
      let count = 0;
      let resetAt = now + config.windowMs;
      
      if (stored && stored.resetAt > now) {
        // Within current window
        count = stored.count + 1;
        resetAt = stored.resetAt;
        
        if (count > config.maxRequests) {
          const retryAfter = Math.ceil((resetAt - now) / 1000);
          
          return c.json({
            success: false,
            error: 'Rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter
          }, 429, {
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Limit': config.maxRequests.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': resetAt.toString()
          });
        }
      } else {
        // New window
        count = 1;
        resetAt = now + config.windowMs;
      }
      
      // Update count in KV
      await c.env.OSLIRA_KV.put(
        key,
        JSON.stringify({ count, resetAt }),
        { expirationTtl: Math.ceil(config.windowMs / 1000) }
      );
      
      // Add rate limit headers
      c.header('X-RateLimit-Limit', config.maxRequests.toString());
      c.header('X-RateLimit-Remaining', Math.max(0, config.maxRequests - count).toString());
      c.header('X-RateLimit-Reset', resetAt.toString());
      
      await next();
    } catch (error) {
      console.error('Rate limit error:', error);
      // Fail open - allow request if rate limiting fails
      await next();
    }
  };
}

/**
 * Preset rate limit configurations
 */
export const RATE_LIMITS = {
  // Analysis endpoints - expensive operations
  ANALYSIS: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 100,
    keyPrefix: 'ratelimit:analysis'
  },
  
  // Anonymous analysis - stricter limits
  ANONYMOUS_ANALYSIS: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyPrefix: 'ratelimit:anon-analysis'
  },
  
  // API general - generous limits
  API_GENERAL: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyPrefix: 'ratelimit:api'
  },
  
  // Webhook endpoints - very strict
  WEBHOOK: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyPrefix: 'ratelimit:webhook'
  }
} as const;
