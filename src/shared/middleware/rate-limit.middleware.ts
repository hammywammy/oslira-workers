// src/shared/middleware/rate-limit.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';

/**
 * Re-export rate limit types and configs from centralized config
 */
export type { RateLimitConfig } from '@/config/rate-limits.config';

/**
 * Rate limiting using Cloudflare KV
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Get identifier (user ID or IP address)
    const auth = c.get('auth') as { userId?: string } | undefined;
    const ip = c.req.header('cf-connecting-ip');
    const identifier = auth?.userId || ip || 'anonymous';
    
    const key = `ratelimit:${identifier}`;
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;
    const expirationTtl = Math.max(1, Math.ceil(config.windowSeconds));
    
    try {
      const stored = await c.env.OSLIRA_KV.get(key, 'json') as {
        count: number;
        resetAt: number;
      } | null;
      
      let count = 0;
      let resetAt = now + windowMs;
      
      if (stored && stored.resetAt > now) {
        // Within current window
        count = stored.count + 1;
        resetAt = stored.resetAt;
        
        if (count > config.requests) {
          const retryAfter = Math.ceil((resetAt - now) / 1000);
          
          console.warn(`[RateLimit] BLOCKED`, {
            identifier: identifier.substring(0, 8),
            path: c.req.path,
            count,
            limit: config.requests
          });
          
          return c.json({
            success: false,
            error: 'Rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter
          }, 429, {
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Limit': config.requests.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': resetAt.toString()
          });
        }
      } else {
        // New window
        count = 1;
        resetAt = now + windowMs;
      }
      
      // Update count in KV
      await c.env.OSLIRA_KV.put(
        key,
        JSON.stringify({ count, resetAt }),
        { expirationTtl }
      );
      
      // Add rate limit headers
      const remaining = Math.max(0, config.requests - count);
      c.header('X-RateLimit-Limit', config.requests.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', resetAt.toString());
      
      await next();
      
    } catch (error: any) {
      console.error(`[RateLimit] ERROR:`, {
        identifier: identifier.substring(0, 8),
        error: error.message
      });
      
      // Fail open - allow request if rate limiting fails
      await next();
    }
  };
}

/**
 * Re-export rate limit configurations from centralized config
 * for backward compatibility
 */
export { RATE_LIMITS } from '@/config/rate-limits.config';
