// infrastructure/monitoring/sentry.service.ts

import type { Env } from '@/shared/types/env.types';
import { getSecret } from '@/infrastructure/config/secrets';
import { SECRET_KEYS } from '@/config/secrets.constants';

/**
 * SENTRY ERROR TRACKING SERVICE
 * 
 * Captures exceptions and sends to Sentry for monitoring
 * 
 * Features:
 * - Automatic error capture
 * - Breadcrumb tracking
 * - User context
 * - Custom tags
 * - Performance monitoring
 */

export interface SentryEvent {
  message: string;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  exception?: Error;
  tags?: Record<string, string>;
  user?: {
    id: string;
    email?: string;
    account_id?: string;
  };
  extra?: Record<string, any>;
  breadcrumbs?: SentryBreadcrumb[];
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
}

export interface SentryBreadcrumb {
  timestamp: number;
  message: string;
  category: string;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  data?: Record<string, any>;
}

export class SentryService {
  private dsn: string | null = null;
  private environment: string;
  private breadcrumbs: SentryBreadcrumb[] = [];
  private maxBreadcrumbs = 20;

  constructor(private env: Env) {
    this.environment = env.APP_ENV;
  }

  /**
   * Initialize Sentry (fetches DSN from secrets)
   */
  async initialize(): Promise<void> {
    try {
      this.dsn = await getSecret(SECRET_KEYS.SENTRY_DSN, this.env, this.env.APP_ENV);
      console.log('[Sentry] Initialized for', this.environment);
    } catch (error) {
      console.warn('[Sentry] DSN not configured, error tracking disabled');
    }
  }

  /**
   * Add breadcrumb for debugging context
   */
  addBreadcrumb(
    message: string,
    category: string,
    level: 'info' | 'warning' | 'error' = 'info',
    data?: Record<string, any>
  ): void {
    this.breadcrumbs.push({
      timestamp: Date.now() / 1000,
      message,
      category,
      level,
      data
    });

    // Keep only last N breadcrumbs
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Capture exception
   */
  async captureException(
    error: Error,
    context?: {
      user?: { id: string; email?: string; account_id?: string };
      tags?: Record<string, string>;
      extra?: Record<string, any>;
      request?: { method: string; url: string; headers?: Record<string, string> };
    }
  ): Promise<void> {
    if (!this.dsn) {
      console.error('[Sentry] Error not sent (DSN not configured):', error.message);
      return;
    }

    const event: SentryEvent = {
      message: error.message,
      level: 'error',
      exception: error,
      tags: {
        environment: this.environment,
        ...context?.tags
      },
      user: context?.user,
      extra: {
        stack: error.stack,
        ...context?.extra
      },
      breadcrumbs: this.breadcrumbs,
      request: context?.request
    };

    await this.sendEvent(event);
  }

  /**
   * Capture message (non-exception)
   */
  async captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info',
    context?: {
      tags?: Record<string, string>;
      extra?: Record<string, any>;
    }
  ): Promise<void> {
    if (!this.dsn) {
      console.log('[Sentry] Message not sent (DSN not configured):', message);
      return;
    }

    const event: SentryEvent = {
      message,
      level,
      tags: {
        environment: this.environment,
        ...context?.tags
      },
      extra: context?.extra,
      breadcrumbs: this.breadcrumbs
    };

    await this.sendEvent(event);
  }

  /**
   * Send event to Sentry
   */
  private async sendEvent(event: SentryEvent): Promise<void> {
    if (!this.dsn) return;

    try {
      // Parse Sentry DSN
      const dsnMatch = this.dsn.match(/https:\/\/([^@]+)@([^\/]+)\/(\d+)/);
      if (!dsnMatch) {
        console.error('[Sentry] Invalid DSN format');
        return;
      }

      const [, publicKey, host, projectId] = dsnMatch;
      const sentryUrl = `https://${host}/api/${projectId}/store/`;

      // Build Sentry envelope format
      const sentryEvent = {
        event_id: this.generateEventId(),
        timestamp: Date.now() / 1000,
        platform: 'javascript',
        sdk: {
          name: 'oslira-worker',
          version: '1.0.0'
        },
        environment: this.environment,
        level: event.level,
        message: event.message,
        exception: event.exception ? {
          values: [{
            type: event.exception.name,
            value: event.exception.message,
            stacktrace: {
              frames: this.parseStackTrace(event.exception.stack || '')
            }
          }]
        } : undefined,
        tags: event.tags,
        user: event.user,
        extra: event.extra,
        breadcrumbs: event.breadcrumbs,
        request: event.request
      };

      // Send to Sentry
      const response = await fetch(sentryUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=oslira-worker/1.0.0`
        },
        body: JSON.stringify(sentryEvent)
      });

      if (!response.ok) {
        console.error('[Sentry] Failed to send event:', response.status);
      } else {
        console.log('[Sentry] Event sent successfully:', event.message);
      }
    } catch (error) {
      console.error('[Sentry] Error sending event:', error);
    }
  }

  /**
   * Parse stack trace into Sentry format
   */
  private parseStackTrace(stack: string): any[] {
    const frames = stack
      .split('\n')
      .slice(1) // Skip first line (error message)
      .map(line => {
        const match = line.match(/at (.+?) \((.+?):(\d+):(\d+)\)/);
        if (match) {
          const [, func, filename, lineno, colno] = match;
          return {
            function: func.trim(),
            filename,
            lineno: parseInt(lineno),
            colno: parseInt(colno)
          };
        }
        return null;
      })
      .filter(Boolean);

    return frames.reverse(); // Sentry wants oldest frame first
  }

  /**
   * Generate event ID
   */
  private generateEventId(): string {
    return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => 
      Math.floor(Math.random() * 16).toString(16)
    );
  }

  /**
   * Clear breadcrumbs
   */
  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }
}

/**
 * Singleton instance helper
 */
let sentryInstance: SentryService | null = null;

export async function getSentryService(env: Env): Promise<SentryService> {
  if (!sentryInstance) {
    sentryInstance = new SentryService(env);
    await sentryInstance.initialize();
  }
  return sentryInstance;
}
