// src/shared/middleware/rate-limit.middleware.ts
import type { Context, Next } from 'hono';
import type { Env } from '@/shared/types/env.types';

/**
 * RATE LIMIT CONFIGURATION
 * 
 * CRITICAL FIX: Renamed 'window' to 'windowSeconds' to prevent
 * naming conflict with browser's global window object during bundling
 */
export interface RateLimitConfig {
  requests: number;          // Max requests per window
  windowSeconds: number;     // Time window in seconds (RENAMED from 'window')
}

/**
 * Rate limiting using Cloudflare KV
 * Stores request counts per user/IP with automatic expiration
 * 
 * COMPREHENSIVE LOGGING:
 * - All rate limit decisions logged
 * - Request identifiers tracked
 * - KV storage operations logged
 * - Errors captured with full context
 */
export function rateLimitMiddleware(
  config: RateLimitConfig
) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const startTime = Date.now();
    const path = c.req.path;
    const method = c.req.method;
    
    console.log(`[RateLimit] START ${method} ${path}`, {
      config: {
        requests: config.requests,
        windowSeconds: config.windowSeconds
      }
    });

    // Get identifier (user ID or IP address)
    const auth = c.get('auth') as { userId?: string } | undefined;
    const ip = c.req.header('cf-connecting-ip');
    const identifier = auth?.userId || ip || 'anonymous';
    
    console.log(`[RateLimit] Identifier: ${identifier}`, {
      hasAuth: !!auth,
      userId: auth?.userId,
      ip,
      identifierType: auth?.userId ? 'user' : ip ? 'ip' : 'anonymous'
    });
    
    const keyPrefix = 'ratelimit';
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000; // Convert to milliseconds
    
    // CRITICAL: Ensure TTL is always positive (minimum 1 second)
    const expirationTtl = Math.max(1, Math.ceil(config.windowSeconds));
    
    console.log(`[RateLimit] KV Config`, {
      key,
      windowMs,
      expirationTtl,
      now: new Date(now).toISOString()
    });
    
    try {
      // Get current count from KV
      console.log(`[RateLimit] Fetching from KV: ${key}`);
      const stored = await c.env.OSLIRA_KV.get(key, 'json') as {
        count: number;
        resetAt: number;
      } | null;
      
      console.log(`[RateLimit] KV Result:`, stored ? {
        count: stored.count,
        resetAt: new Date(stored.resetAt).toISOString(),
        isExpired: stored.resetAt <= now
      } : 'null (new window)');
      
      let count = 0;
      let resetAt = now + windowMs;
      
      if (stored && stored.resetAt > now) {
        // Within current window
        count = stored.count + 1;
        resetAt = stored.resetAt;
        
        console.log(`[RateLimit] Within window`, {
          previousCount: stored.count,
          newCount: count,
          limit: config.requests,
          remaining: Math.max(0, config.requests - count),
          resetAt: new Date(resetAt).toISOString()
        });
        
        if (count > config.requests) {
          const retryAfter = Math.ceil((resetAt - now) / 1000);
          
          console.warn(`[RateLimit] LIMIT EXCEEDED`, {
            identifier,
            path,
            method,
            count,
            limit: config.requests,
            retryAfter,
            resetAt: new Date(resetAt).toISOString()
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
        
        console.log(`[RateLimit] New window started`, {
          count,
          limit: config.requests,
          remaining: config.requests - 1,
          resetAt: new Date(resetAt).toISOString(),
          reason: stored ? 'window expired' : 'first request'
        });
      }
      
      // Update count in KV with validated TTL
      console.log(`[RateLimit] Updating KV`, {
        key,
        count,
        resetAt: new Date(resetAt).toISOString(),
        expirationTtl
      });
      
      await c.env.OSLIRA_KV.put(
        key,
        JSON.stringify({ count, resetAt }),
        { expirationTtl } // ← Always positive, minimum 1 second
      );
      
      console.log(`[RateLimit] KV updated successfully`);
      
      // Add rate limit headers
      const remaining = Math.max(0, config.requests - count);
      c.header('X-RateLimit-Limit', config.requests.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', resetAt.toString());
      
      const elapsed = Date.now() - startTime;
      console.log(`[RateLimit] PASS ${method} ${path}`, {
        identifier,
        count,
        limit: config.requests,
        remaining,
        elapsed: `${elapsed}ms`
      });
      
      await next();
      
    } catch (error: any) {
      const elapsed = Date.now() - startTime;
      console.error(`[RateLimit] ERROR ${method} ${path}`, {
        identifier,
        error: error.message,
        stack: error.stack,
        elapsed: `${elapsed}ms`
      });
      
      // Fail open - allow request if rate limiting fails
      console.warn(`[RateLimit] Failing open due to error`);
      await next();
    }
  };
}

/**
 * Preset rate limit configurations
 * 
 * UPDATED: All 'window' properties renamed to 'windowSeconds'
 */
export const RATE_LIMITS = {
  // Analysis endpoints - expensive operations
  ANALYSIS: {
    requests: 100,
    windowSeconds: 3600 // 1 hour
  },
  
  // Analysis creation - stricter to prevent spam
  ANALYSIS_CREATE: {
    requests: 20,
    windowSeconds: 3600 // 1 hour
  },
  
  // Anonymous analysis - stricter limits
  ANONYMOUS_ANALYSIS: {
    requests: 5,
    windowSeconds: 3600 // 1 hour
  },
  
  // API general - generous limits
  API_GENERAL: {
    requests: 60,
    windowSeconds: 60 // 1 minute
  },
  
  // Webhook endpoints - very strict
  WEBHOOK: {
    requests: 10,
    windowSeconds: 60 // 1 minute
  },
  
  // Auth endpoints - moderate limits
  AUTH: {
    requests: 10,
    windowSeconds: 600 // 10 minutes
  }
} as const;
