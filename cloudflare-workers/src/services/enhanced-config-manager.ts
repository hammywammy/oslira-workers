import type { Env } from '../types/interfaces.js';
import { getAWSSecretsManager } from './aws-secrets-manager.js';

// Local logging function to avoid import issues in Worker environment
function logger(level: 'info' | 'warn' | 'error', message: string, data?: any, requestId?: string) {
  const timestamp = new Date().toISOString();
  const logData = { timestamp, level, message, requestId, ...data };
  console.log(JSON.stringify(logData));
}

class EnhancedConfigManager {
  private cache: Map<string, { value: string; expires: number; source: string }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private awsSecrets: any;
  
  // Keys that should be stored in AWS Secrets Manager (public + private)
private readonly AWS_MANAGED_KEYS = [
  'SUPABASE_URL',
  'FRONTEND_URL',
  'APIFY_API_TOKEN',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE',
  'SUPABASE_ANON_KEY',
  'ADMIN_TOKEN'
];

  constructor(private env: Env) {
    try {
      this.awsSecrets = getAWSSecretsManager(env);
      if (this.awsSecrets.isConfigured()) {
        logger('info', 'AWS Secrets Manager initialized successfully');
      } else {
        logger('warn', 'AWS Secrets Manager not configured, using fallback mode');
      }
    } catch (error: any) {
      logger('error', 'AWS Secrets Manager initialization failed', { 
        error: error.message,
        hasAccessKey: !!env.AWS_ACCESS_KEY_ID,
        hasSecretKey: !!env.AWS_SECRET_ACCESS_KEY,
        region: env.AWS_REGION
      });
      this.awsSecrets = null;
    }
  }

  /**
   * Get configuration value with environment-aware AWS path
   * @param keyName - Config key name (e.g., "SUPABASE_URL")
   * @param environment - Environment prefix (e.g., "production" or "staging")
   */
async getConfig(keyName: string, environment?: string): Promise<string> {
  // For AWS-managed keys, environment is REQUIRED
  // Auto-detect from worker environment if not provided
  if (this.AWS_MANAGED_KEYS.includes(keyName) && !environment) {
    environment = this.env.APP_ENV || 'production';
    logger('info', `Auto-detected environment for ${keyName}`, { environment });
  }
  
  // Build cache key with environment if provided
  const cacheKey = environment ? `${environment}/${keyName}` : keyName;
  
  // Check cache first
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    logger('info', `Config cache hit for ${cacheKey}`, { source: cached.source });
    return cached.value;
  }

  try {
    let value: string = '';
    let source: string = 'env';

    // For AWS-managed keys, try AWS first
    if (this.AWS_MANAGED_KEYS.includes(keyName) && this.awsSecrets?.isConfigured()) {
      try {
        // Build AWS path with environment prefix (now guaranteed to exist)
        const awsPath = `${environment}/${keyName}`;
    value = await this.awsSecrets.getSecret(awsPath);
    source = 'aws';
    logger('info', `Retrieved ${awsPath} from AWS Secrets Manager`);
} catch (awsError: any) {
    logger('error', `AWS retrieval failed for ${keyName} - NO FALLBACK AVAILABLE`, { 
      error: awsError.message,
      environment 
    });
    // AWS-managed keys should NEVER fall back to env vars
    // They exist ONLY in AWS with environment prefix
    throw new Error(`Failed to retrieve AWS-managed key ${keyName}: ${awsError.message}`);
  }
} else {
  // Non-AWS-managed keys MUST be in Cloudflare environment variables
  // Examples: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, ADMIN_TOKEN
  value = this.env[keyName as keyof Env] || '';
  source = 'env';
  
  if (!value) {
    logger('error', `Non-AWS key not found in environment: ${keyName}`);
  }
}

      if (!value) {
        logger('error', `No value found for config key: ${cacheKey}`);
        return '';
      }

      // Cache the result
      this.cache.set(cacheKey, {
        value,
        expires: Date.now() + this.CACHE_TTL,
        source
      });

      logger('info', `Config retrieved successfully`, { 
        keyName, 
        environment,
        source,
        hasValue: !!value,
        valueLength: value?.length || 0
      });

      return value;

    } catch (error: any) {
      logger('error', `Failed to retrieve config for ${cacheKey}`, { error: error.message });
      
      // Last resort: environment variable
      const envValue = this.env[keyName as keyof Env] || '';
      if (envValue) {
        logger('info', `Using environment fallback for ${keyName}`);
        return envValue;
      }
      
      return '';
    }
  }

  /**
   * Update configuration value in AWS
   * @param keyName - Config key name
   * @param newValue - New value
   * @param environment - Environment to update (production/staging)
   * @param updatedBy - Who/what updated the config
   */
  async updateConfig(
    keyName: string, 
    newValue: string, 
    environment: string,
    updatedBy: string = 'system'
  ): Promise<void> {
    if (!this.AWS_MANAGED_KEYS.includes(keyName)) {
      throw new Error(`${keyName} is not configured for AWS management`);
    }

    if (!this.awsSecrets?.isConfigured()) {
      throw new Error('AWS Secrets Manager not configured');
    }

    try {
      // Update AWS with environment prefix
      const awsPath = `${environment}/${keyName}`;
      await this.awsSecrets.putSecret(awsPath, newValue, updatedBy);
      logger('info', `Updated ${awsPath} in AWS Secrets Manager`);

      // Clear cache for this key in this environment
      this.cache.delete(`${environment}/${keyName}`);
      
      logger('info', `Config update complete for ${awsPath}`);

    } catch (error: any) {
      logger('error', `Failed to update config: ${keyName}`, { 
        error: error.message,
        environment 
      });
      throw error;
    }
  }

  /**
   * Get all public configuration for a specific environment
   * Used by the /config endpoint for frontend
   */
async getPublicConfig(environment: string): Promise<Record<string, string>> {
  // ALL public keys are in AWS with environment prefix
  const publicKeys = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'FRONTEND_URL'
  ];

  const config: Record<string, string> = {};

  for (const key of publicKeys) {
    try {
      // ALWAYS pass environment for AWS-managed keys
      config[key] = await this.getConfig(key, environment);
      } catch (error: any) {
        logger('warn', `Failed to load public config key: ${key}`, { 
          error: error.message,
          environment 
        });
        // Set empty string for missing keys
        config[key] = '';
      }
    }

    return config;
  }

  /**
   * Validate that all required config exists for an environment
   */
  async validateEnvironmentConfig(environment: string): Promise<{
    valid: boolean;
    missing: string[];
    present: string[];
  }> {
// All these keys MUST exist in AWS with environment prefix
const requiredKeys = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'FRONTEND_URL',
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'APIFY_API_TOKEN'
];

    const missing: string[] = [];
    const present: string[] = [];

    for (const key of requiredKeys) {
      try {
        const value = await this.getConfig(key, environment);
        if (value) {
          present.push(key);
        } else {
          missing.push(key);
        }
      } catch {
        missing.push(key);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      present
    };
  }

  /**
   * Clear cache for specific key or all cache
   */
  clearCache(keyName?: string, environment?: string): void {
    if (keyName && environment) {
      this.cache.delete(`${environment}/${keyName}`);
      logger('info', `Cleared cache for ${environment}/${keyName}`);
    } else if (keyName) {
      // Clear all environment versions of this key
      const keysToDelete = Array.from(this.cache.keys()).filter(k => k.endsWith(`/${keyName}`) || k === keyName);
      keysToDelete.forEach(k => this.cache.delete(k));
      logger('info', `Cleared cache for all environments of ${keyName}`);
    } else {
      this.cache.clear();
      logger('info', 'Cleared all config cache');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    keys: string[];
    ttl: number;
  } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      ttl: this.CACHE_TTL
    };
  }
}

// Singleton instance
let enhancedConfigManager: EnhancedConfigManager | null = null;

export function getEnhancedConfigManager(env: Env): EnhancedConfigManager {
  if (!enhancedConfigManager) {
    enhancedConfigManager = new EnhancedConfigManager(env);
  }
  return enhancedConfigManager;
}

// Backward compatibility aliases
export const getConfigManager = getEnhancedConfigManager;

export async function getApiKey(keyName: string, env: Env, environment?: string): Promise<string> {
  const manager = getEnhancedConfigManager(env);
  return await manager.getConfig(keyName, environment);
}
