import type { Env } from '../types/interfaces.js';

// Local logging function to avoid import issues in Worker environment
function logger(level: 'info' | 'warn' | 'error', message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logData = { timestamp, level, message, ...data };
  console.log(JSON.stringify(logData));
}

interface SecretValue {
  apiKey: string;
  createdAt: string;
  version: string;
  rotatedBy?: string;
}

export class AWSSecretsManager {
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;
  private configured: boolean;

  constructor(env: Env) {
    this.accessKeyId = env.AWS_ACCESS_KEY_ID || '';
    this.secretAccessKey = env.AWS_SECRET_ACCESS_KEY || '';
    this.region = env.AWS_REGION || 'us-east-1';

    if (!this.accessKeyId || !this.secretAccessKey) {
      logger('error', 'AWS credentials not configured', {
        hasAccessKey: !!this.accessKeyId,
        hasSecretKey: !!this.secretAccessKey
      });
      this.configured = false;
    } else {
      this.configured = true;
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Get secret from AWS Secrets Manager
   * Supports both flat paths (Oslira/KEY) and environment-prefixed paths (Oslira/production/KEY)
   * @param secretPath - Full secret path (e.g., "production/SUPABASE_URL" or "SUPABASE_URL")
   */
  async getSecret(secretPath: string): Promise<string> {
    if (!this.configured) {
      throw new Error('AWS Secrets Manager not configured');
    }

    try {
      // If path contains slash, it's already prefixed (e.g., "production/SUPABASE_URL")
      // Otherwise it's a flat key (e.g., "OPENAI_API_KEY")
      const fullPath = secretPath.includes('/') 
        ? `Oslira/${secretPath}`
        : `Oslira/${secretPath}`;

      const response = await this.makeAWSRequest('GetSecretValue', {
        SecretId: fullPath,
        VersionStage: 'AWSCURRENT'
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AWS API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (!data.SecretString) {
        throw new Error('Secret has no string value');
      }

      // Try to parse as structured JSON first
      try {
        const secretValue: SecretValue = JSON.parse(data.SecretString);
logger('info', 'Retrieved structured secret from AWS', { 
  secretPath,
  version: secretValue.version,
  rotatedBy: secretValue.rotatedBy,
  apiKeyLength: secretValue.apiKey.length,
  apiKeyPreview: secretValue.apiKey.substring(0, 15) + '...' + secretValue.apiKey.substring(secretValue.apiKey.length - 6)
});
return secretValue.apiKey;
      } catch {
        // If not structured, return as plain string
        logger('info', 'Retrieved plain text secret from AWS', { secretPath });
        return data.SecretString;
      }

    } catch (error: any) {
      logger('error', 'Failed to retrieve secret from AWS', { 
        secretPath, 
        error: error.message 
      });
      throw new Error(`AWS Secrets retrieval failed for ${secretPath}: ${error.message}`);
    }
  }

  /**
   * Update existing secret value
   * @param secretPath - Full secret path (e.g., "production/SUPABASE_URL")
   * @param secretValue - New secret value
   * @param rotatedBy - Who/what rotated the secret
   */
  async putSecret(secretPath: string, secretValue: string, rotatedBy: string = 'manual'): Promise<void> {
    if (!this.configured) {
      throw new Error('AWS Secrets Manager not configured');
    }

    try {
      const fullPath = secretPath.includes('/') 
        ? `Oslira/${secretPath}`
        : `Oslira/${secretPath}`;

      const payload = {
        SecretId: fullPath,
        SecretString: JSON.stringify({
          apiKey: secretValue,
          createdAt: new Date().toISOString(),
          version: `v${Date.now()}`,
          rotatedBy: rotatedBy
        } as SecretValue)
      };

      const response = await this.makeAWSRequest('PutSecretValue', payload);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AWS API error: ${response.status} - ${errorText}`);
      }

      logger('info', 'Successfully updated secret in AWS', { 
        secretPath, 
        rotatedBy 
      });

    } catch (error: any) {
      logger('error', 'Failed to store secret in AWS', { 
        secretPath, 
        error: error.message 
      });
      throw new Error(`AWS Secrets storage failed for ${secretPath}: ${error.message}`);
    }
  }

  /**
   * Create a new secret
   * @param secretPath - Full secret path (e.g., "production/SUPABASE_URL")
   * @param secretValue - Secret value
   * @param description - Human-readable description
   */
  async createSecret(secretPath: string, secretValue: string, description: string): Promise<void> {
    if (!this.configured) {
      throw new Error('AWS Secrets Manager not configured');
    }

    try {
      const fullPath = secretPath.includes('/') 
        ? `Oslira/${secretPath}`
        : `Oslira/${secretPath}`;

      const payload = {
        Name: fullPath,
        Description: description,
        SecretString: JSON.stringify({
          apiKey: secretValue,
          createdAt: new Date().toISOString(),
          version: 'v1',
          rotatedBy: 'initial_setup'
        } as SecretValue)
      };

      const response = await this.makeAWSRequest('CreateSecret', payload);

      if (!response.ok) {
        const errorText = await response.text();
        
        // If secret already exists, update it instead
        if (errorText.includes('already exists')) {
          logger('info', 'Secret exists, updating instead', { secretPath });
          await this.putSecret(secretPath, secretValue, 'migration');
          return;
        }
        
        throw new Error(`AWS API error: ${response.status} - ${errorText}`);
      }

      logger('info', 'Successfully created secret in AWS', { secretPath });

    } catch (error: any) {
      logger('error', 'Failed to create secret in AWS', { 
        secretPath, 
        error: error.message 
      });
      throw new Error(`AWS Secrets creation failed for ${secretPath}: ${error.message}`);
    }
  }

  /**
   * List all secrets with optional prefix filter
   */
  async listSecrets(prefix: string = 'Oslira/'): Promise<string[]> {
    if (!this.configured) {
      throw new Error('AWS Secrets Manager not configured');
    }

    try {
      const response = await this.makeAWSRequest('ListSecrets', {
        Filters: [
          {
            Key: 'name',
            Values: [prefix]
          }
        ],
        MaxResults: 100
      });

      if (!response.ok) {
        throw new Error(`AWS API error: ${response.status}`);
      }

      const data = await response.json();
      const secretNames = data.SecretList?.map((secret: any) => secret.Name) || [];
      
      logger('info', 'Listed secrets from AWS', { 
        count: secretNames.length,
        prefix 
      });

      return secretNames;

    } catch (error: any) {
      logger('error', 'Failed to list secrets', { 
        error: error.message,
        prefix
      });
      return [];
    }
  }

  // =============================================================================
  // AWS SIGNATURE V4 IMPLEMENTATION
  // =============================================================================

  private async makeAWSRequest(action: string, payload: any): Promise<Response> {
    const endpoint = `https://secretsmanager.${this.region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const headers = await this.getSignedHeaders(action, body);

    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        ...headers
      },
      body: body
    });
  }

  private async getSignedHeaders(action: string, payload: string): Promise<Record<string, string>> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    // Create canonical request
    const canonicalHeaders = [
      `host:secretsmanager.${this.region}.amazonaws.com`,
      `x-amz-date:${amzDate}`,
      `x-amz-target:secretsmanager.${action}`
    ].join('\n');

    const signedHeaders = 'host;x-amz-date;x-amz-target';
    const payloadHash = await this.sha256(payload);

    const canonicalRequest = [
      'POST',
      '/',
      '',
      canonicalHeaders,
      '',
      signedHeaders,
      payloadHash
    ].join('\n');

    // Create string to sign
    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.region}/secretsmanager/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256(canonicalRequest)
    ].join('\n');

    // Calculate signature
    const signature = await this.calculateSignature(stringToSign, dateStamp);

    // Create authorization header
    const authorization = [
      `${algorithm} Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(', ');

    return {
      'Authorization': authorization,
      'X-Amz-Date': amzDate,
      'X-Amz-Target': `secretsmanager.${action}`
    };
  }

  private async calculateSignature(stringToSign: string, dateStamp: string): Promise<string> {
    const kDate = await this.hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = await this.hmac(kDate, this.region);
    const kService = await this.hmac(kRegion, 'secretsmanager');
    const kSigning = await this.hmac(kService, 'aws4_request');
    
    const signature = await this.hmac(kSigning, stringToSign);
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async hmac(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      typeof key === 'string' ? new TextEncoder().encode(key) : key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  }

  private async sha256(data: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

// Helper function to get singleton instance
let awsSecretsInstance: AWSSecretsManager | null = null;

export function getAWSSecretsManager(env: Env): AWSSecretsManager {
  if (!awsSecretsInstance) {
    awsSecretsInstance = new AWSSecretsManager(env);
  }
  return awsSecretsInstance;
}
