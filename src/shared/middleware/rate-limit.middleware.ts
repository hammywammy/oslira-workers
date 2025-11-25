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
    // Skip rate limiting in staging
    if (c.env.APP_ENV === 'staging') {
      console.log('[RateLimit] Skipped (staging environment)');
      return await next();
    }

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
      let shouldWrite = false;

      if (stored && stored.resetAt > now) {
        // Within window - increment in-memory only (no write)
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
        // New window - write once
        count = 1;
        resetAt = now + windowMs;
        shouldWrite = true;
      }

      // Only write to KV for new windows
      if (shouldWrite) {
        try {
          await c.env.OSLIRA_KV.put(
            key,
            JSON.stringify({ count, resetAt }),
            { expirationTtl }
          );
          console.log(`[RateLimit] New window started for ${identifier.substring(0, 8)}`);
        } catch (kvError: any) {
          console.error(`[RateLimit] KV PUT failed (non-fatal):`, {
            identifier: identifier.substring(0, 8),
            error: kvError.message
          });
        }
      }

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

      // Fail open
      await next();
    }
  };
}

/**
 * Re-export rate limit configurations from centralized config
 * for backward compatibility
 */
export { RATE_LIMITS } from '@/config/rate-limits.config';
