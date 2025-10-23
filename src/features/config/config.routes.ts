// features/config/config.routes.ts

import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';

/**
 * PUBLIC CONFIG ROUTES
 * 
 * Provides environment-specific configuration to frontend
 * No authentication required (public endpoint)
 */

export function registerConfigRoutes(app: Hono<{ Bindings: Env }>) {
  
  /**
   * GET /api/public-config
   * Returns public configuration for frontend initialization
   * 
   * Query params:
   * - env: 'production' | 'staging' (optional, defaults to worker env)
   * 
   * Returns:
   * - apiUrl: Base URL for API calls
   * - environment: Current environment
   * - googleClientId: OAuth client ID
   */
  app.get('/api/public-config', async (c) => {
    const requestedEnv = c.req.query('env');
    const currentEnv = c.env.APP_ENV;

    // Determine URLs based on environment
    const config = {
      apiUrl: currentEnv === 'production' 
        ? 'https://api.oslira.com'
        : 'https://api-staging.oslira.com',
      
      frontendUrl: currentEnv === 'production'
        ? 'https://app.oslira.com'
        : 'https://staging-app.oslira.com',
      
      environment: currentEnv,
      
      // Note: Google Client ID should be fetched from secrets if needed
      // For now, frontend will use env var VITE_GOOGLE_CLIENT_ID
    };

    return c.json(config, 200, {
      'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
    });
  });
}
