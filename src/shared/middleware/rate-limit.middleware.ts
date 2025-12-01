import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { logger } from '@/shared/utils/logger.util';

export type { RateLimitConfig } from '@/config/rate-limits.config';

import type { RateLimitConfig } from '@/config/rate-limits.config';

/** Rate limiting middleware using Cloudflare KV */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    if (c.env.APP_ENV === 'staging') {
      return await next();
    }

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
        count = stored.count + 1;
        resetAt = stored.resetAt;

        if (count > config.requests) {
          const retryAfter = Math.ceil((resetAt - now) / 1000);

          logger.warn('Rate limit exceeded', {
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
        count = 1;
        resetAt = now + windowMs;
        shouldWrite = true;
      }

      if (shouldWrite) {
        try {
          await c.env.OSLIRA_KV.put(
            key,
            JSON.stringify({ count, resetAt }),
            { expirationTtl }
          );
        } catch (kvError: unknown) {
          logger.warn('Rate limit KV PUT failed', {
            identifier: identifier.substring(0, 8),
            error: kvError instanceof Error ? kvError.message : String(kvError)
          });
        }
      }

      const remaining = Math.max(0, config.requests - count);
      c.header('X-RateLimit-Limit', config.requests.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', resetAt.toString());

      await next();

    } catch (error: unknown) {
      logger.error('Rate limit middleware error', {
        identifier: identifier.substring(0, 8),
        error: error instanceof Error ? error.message : String(error)
      });

      await next();
    }
  };
}

export { RATE_LIMITS } from '@/config/rate-limits.config';
