import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Env } from '@/shared/types/env.types';

// Cache secrets for 5 minutes
const secretsCache = new Map<string, { value: string; cachedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch secret from AWS Secrets Manager with caching
 * 
 * Your naming convention: Oslira/production/SECRET_NAME
 */
export async function getSecret(
  secretName: string,
  env: Env,
  appEnv: string
): Promise<string> {
  const fullSecretPath = `Oslira/${appEnv}/${secretName}`;
  const cacheKey = fullSecretPath;
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
    SecretId: fullSecretPath
  });
  
  try {
    const response = await client.send(command);
    
    if (!response.SecretString) {
      throw new Error(`Secret ${fullSecretPath} has no value`);
    }
    
    // CRITICAL: Trim whitespace and newlines
    const value = response.SecretString.trim();
    
    // Cache the value
    secretsCache.set(cacheKey, { value, cachedAt: Date.now() });
    
    return value;
  } catch (error: any) {
    console.error(`Failed to fetch secret ${fullSecretPath}:`, error.message);
    throw new Error(`Secret ${fullSecretPath} not found in AWS Secrets Manager (region: ${env.AWS_REGION})`);
  }
}

/**
 * Fetch multiple secrets at once
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

/**
 * Clear secrets cache
 */
export function clearSecretsCache(): void {
  secretsCache.clear();
}
