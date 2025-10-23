// src/shared/middleware/rate-limit.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';

export interface RateLimitConfig {
  requests: number;  // Max requests per window
  window: number;    // Time window in seconds
}

/**
 * Rate limiting using Cloudflare KV
 * Stores request counts per user/IP with automatic expiration
 */
export function rateLimitMiddleware(
  config: RateLimitConfig
) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Get identifier (user ID or IP address)
    const auth = c.get('auth') as { userId?: string } | undefined;
    const identifier = auth?.userId || c.req.header('cf-connecting-ip') || 'anonymous';
    
    const keyPrefix = 'ratelimit';
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowMs = config.window * 1000; // Convert to milliseconds
    
    // CRITICAL: Ensure TTL is always positive (minimum 1 second)
    const expirationTtl = Math.max(1, Math.ceil(config.window));
    
    try {
      // Get current count from KV
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
          
          console.warn(`[RateLimit] Limit exceeded for ${identifier}`, {
            count,
            limit: config.requests,
            retryAfter
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
      
      // Update count in KV with validated TTL
      await c.env.OSLIRA_KV.put(
        key,
        JSON.stringify({ count, resetAt }),
        { expirationTtl } // ← Always positive, minimum 1 second
      );
      
      // Add rate limit headers
      c.header('X-RateLimit-Limit', config.requests.toString());
      c.header('X-RateLimit-Remaining', Math.max(0, config.requests - count).toString());
      c.header('X-RateLimit-Reset', resetAt.toString());
      
      await next();
    } catch (error) {
      console.error('[RateLimit] Error:', error);
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
    requests: 100,
    window: 3600 // 1 hour in seconds
  },
  
  // Anonymous analysis - stricter limits
  ANONYMOUS_ANALYSIS: {
    requests: 5,
    window: 3600 // 1 hour in seconds
  },
  
  // API general - generous limits
  API_GENERAL: {
    requests: 60,
    window: 60 // 1 minute in seconds
  },
  
  // Webhook endpoints - very strict
  WEBHOOK: {
    requests: 10,
    window: 60 // 1 minute in seconds
  },
  
  // Auth endpoints - moderate limits
  AUTH: {
    requests: 10,
    window: 600 // 10 minutes in seconds
  }
} as const;
