import type { Context } from 'hono';
import { getEnhancedConfigManager } from '../services/enhanced-config-manager.js';
import { generateRequestId, logger } from '../utils/logger.js';

/**
 * Handle public configuration requests
 * Returns environment-specific public configuration for frontend
 */
export async function handlePublicConfig(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Get requested environment from query parameter or use Worker's APP_ENV
    const requestedEnv = c.req.query('env') || c.env.APP_ENV || 'production';
    const workerEnv = c.env.APP_ENV || 'production';
    
    // Security check: Validate requested environment matches Worker environment
    if (requestedEnv !== workerEnv) {
      logger('warn', 'Environment mismatch in config request', {
        requestId,
        requestedEnv,
        workerEnv,
        deniedAccess: true
      });
      
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Environment mismatch: worker not authorized for requested environment'
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    logger('info', 'Processing public config request', {
      requestId,
      environment: requestedEnv,
      workerEnv
    });

    const configManager = getEnhancedConfigManager(c.env);
    
    // Fetch all public config with environment prefix
    const publicConfig = await configManager.getPublicConfig(requestedEnv);

    // Validate all required values are present
    const requiredKeys = ['supabaseUrl', 'supabaseAnonKey', 'stripePublishableKey', 'frontendUrl'];
    // Validate all required values are present
const missingKeys = [];
if (!publicConfig.SUPABASE_URL) missingKeys.push('supabaseUrl');
if (!publicConfig.SUPABASE_ANON_KEY) missingKeys.push('supabaseAnonKey');
if (!publicConfig.STRIPE_PUBLISHABLE_KEY) missingKeys.push('stripePublishableKey');
if (!publicConfig.FRONTEND_URL) missingKeys.push('frontendUrl');
    
    if (missingKeys.length > 0) {
      logger('error', 'Missing required public config keys', {
        requestId,
        environment: requestedEnv,
        missingKeys
      });
      
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Incomplete configuration',
          missing: missingKeys
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Build response object with camelCase keys for frontend
    const response = {
      success: true,
      data: {
        supabaseUrl: publicConfig.SUPABASE_URL,
        supabaseAnonKey: publicConfig.SUPABASE_ANON_KEY,
        stripePublishableKey: publicConfig.STRIPE_PUBLISHABLE_KEY,
        frontendUrl: publicConfig.FRONTEND_URL,
        environment: requestedEnv
      },
      timestamp: new Date().toISOString(),
      requestId
    };

    logger('info', 'Public config served successfully', {
      requestId,
      environment: requestedEnv,
      keysServed: Object.keys(response.data)
    });

    return new Response(
      JSON.stringify(response),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'public, max-age=60', // 1 minute cache
          'X-Request-ID': requestId
        }
      }
    );

  } catch (error: any) {
    logger('error', 'Failed to serve public config', {
      error: error.message,
      stack: error.stack,
      requestId
    });

    // Return minimal fallback config from environment variables
    // This allows system to degrade gracefully if AWS is unavailable
const fallbackConfig = {
  success: false,
  error: 'Configuration service temporarily unavailable - AWS Secrets Manager unreachable',
  environment: c.env.APP_ENV || 'production',
  timestamp: new Date().toISOString(),
  requestId
};
      timestamp: new Date().toISOString(),
      requestId
    };

    return new Response(
      JSON.stringify(fallbackConfig),
      {
        status: 200, // Return 200 with fallback to prevent frontend errors
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache', // Don't cache fallback responses
          'X-Request-ID': requestId,
          'X-Config-Source': 'fallback'
        }
      }
    );
  }


/**
 * Handle OPTIONS preflight requests for CORS
 */
export async function handlePublicConfigOptions(c: Context): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
