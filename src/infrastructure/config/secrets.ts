import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Env } from '@/shared/types/env.types';

// Cache secrets for 5 minutes (balance between freshness and performance)
const secretsCache = new Map<string, { value: string; cachedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch secret from AWS Secrets Manager with caching
 * 
 * @param secretName - Name of the secret (without environment prefix)
 * @param env - Cloudflare Worker environment
 * @param appEnv - 'production' or 'staging'
 * @returns Secret value
 * 
 * @example
 * const supabaseUrl = await getSecret('SUPABASE_URL', env, 'production');
 */
export async function getSecret(
  secretName: string,
  env: Env,
  appEnv: string
): Promise<string> {
  const cacheKey = `${appEnv}/${secretName}`;
  const cached = secretsCache.get(cacheKey);
  
  // Return cached value if still valid
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
    return cached.value;
  }
  
  // Fetch from AWS Secrets Manager
  const client = new SecretsManagerClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY
    }
  });
  
  const command = new GetSecretValueCommand({
    SecretId: `${appEnv}/${secretName}`
  });
  
  try {
    const response = await client.send(command);
    
    if (!response.SecretString) {
      throw new Error(`Secret ${secretName} has no value`);
    }
    
    const value = response.SecretString;
    
    // Cache the value
    secretsCache.set(cacheKey, { value, cachedAt: Date.now() });
    
    return value;
  } catch (error: any) {
    console.error(`Failed to fetch secret ${secretName}:`, error.message);
    throw new Error(`Secret ${secretName} not found in AWS Secrets Manager`);
  }
}

/**
 * Fetch multiple secrets at once (more efficient)
 * 
 * @example
 * const secrets = await getSecrets(['SUPABASE_URL', 'SUPABASE_ANON_KEY'], env, 'production');
 */
export async function getSecrets(
  secretNames: string[],
  env: Env,
  appEnv: string
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  
  await Promise.all(
    secretNames.map(async (name) => {
      results[name] = await getSecret(name, env, appEnv);
    })
  );
  
  return results;
}
