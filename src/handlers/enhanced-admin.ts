import type { Context } from 'hono';
import { getEnhancedConfigManager } from '../services/enhanced-config-manager.js';
import { getAWSSecretsManager } from '../services/aws-secrets-manager.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { fetchJson } from '../utils/helpers.js';

interface ConfigUpdateRequest {
  keyName: string;
  newValue: string;
  adminToken?: string;
}

interface MigrationRequest {
  keyNames?: string[];
  migrateAll?: boolean;
  adminToken?: string;
}

// Admin authentication middleware
function verifyAdminAccess(c: Context): boolean {
  const authHeader = c.req.header('Authorization');
  const adminToken = c.env.ADMIN_TOKEN;
  
  if (!adminToken) {
    logger('error', 'ADMIN_TOKEN not configured in environment');
    return false;
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  
  const token = authHeader.substring(7);
  return token === adminToken;
}

export async function handleUpdateApiKey(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Verify admin access
    if (!verifyAdminAccess(c)) {
      logger('warn', 'Unauthorized admin access attempt', { requestId });
      return c.json(createStandardResponse(false, undefined, 'Unauthorized access', requestId), 401);
    }
    
    const body = await c.req.json() as ConfigUpdateRequest;
    const { keyName, newValue } = body;
    
    // Validate input
    if (!keyName || !newValue) {
      return c.json(createStandardResponse(false, undefined, 'keyName and newValue are required', requestId), 400);
    }
    
// Only AWS-managed keys can be updated via admin panel
const allowedKeys = [
  'SUPABASE_URL',
  'FRONTEND_URL',
  'APIFY_API_TOKEN',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE',
  'SUPABASE_ANON_KEY'
];
    
    if (!allowedKeys.includes(keyName)) {
      return c.json(createStandardResponse(false, undefined, 'Invalid key name', requestId), 400);
    }
    
    // Validate key format
    const keyValidation = validateApiKeyFormat(keyName, newValue);
    if (!keyValidation.valid) {
      return c.json(createStandardResponse(false, undefined, keyValidation.error, requestId), 400);
    }
    
    // Get user info from session if available
    const userEmail = c.req.header('X-User-Email') || 'admin-panel';
    
// Update configuration using enhanced config manager
// MUST specify environment (production or staging)
const environment = c.env.APP_ENV || 'production';
const configManager = getEnhancedConfigManager(c.env);
await configManager.updateConfig(keyName, newValue, environment, userEmail);
    
    // Test the key to ensure it's working
    const testResult = await testApiKey(keyName, newValue, c.env);
    
    logger('info', 'API key updated via enhanced admin panel', { 
      keyName, 
      updatedBy: userEmail,
      testResult: testResult.success,
      usedAWS: isAWSManagedKey(keyName),
      requestId 
    });
    
    return c.json(createStandardResponse(true, {
      message: `${keyName} updated successfully`,
      testResult: testResult,
      storage: isAWSManagedKey(keyName) ? 'AWS Secrets Manager + Supabase backup' : 'Supabase only',
      autoSyncTriggered: true
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Enhanced admin key update failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

export async function handleGetConfigStatus(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Verify admin access
    if (!verifyAdminAccess(c)) {
      return c.json(createStandardResponse(false, undefined, 'Unauthorized access', requestId), 401);
    }
    
    const configManager = getEnhancedConfigManager(c.env);
    const status = await configManager.getConfigStatus();
    
    // Add AWS connectivity status
    let awsStatus = 'not_configured';
    try {
      const awsSecrets = getAWSSecretsManager(c.env);
      const awsSecretsList = await awsSecrets.listSecrets();
      awsStatus = 'connected';
      
      // Add migration recommendations
      Object.keys(status).forEach(keyName => {
        if (isAWSManagedKey(keyName)) {
          status[keyName].migration_recommended = status[keyName].aws.status !== 'configured';
          status[keyName].in_aws = awsSecretsList.includes(keyName);
        }
      });
      
    } catch (awsError: any) {
      awsStatus = `error: ${awsError.message}`;
    }
    
    logger('info', 'Enhanced config status retrieved', { requestId, awsStatus });
    
    return c.json(createStandardResponse(true, { 
      status,
      aws_connectivity: awsStatus,
      migration_summary: {
        total_keys: Object.keys(status).length,
        aws_managed_keys: Object.keys(status).filter(k => isAWSManagedKey(k)).length,
        migration_needed: Object.values(status).filter((s: any) => s.migration_recommended).length
      }
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to get enhanced config status', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

export async function handleMigrateToAWS(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Verify admin access
    if (!verifyAdminAccess(c)) {
      return c.json(createStandardResponse(false, undefined, 'Unauthorized access', requestId), 401);
    }
    
    const body = await c.req.json() as MigrationRequest;
    const { keyNames, migrateAll } = body;
    
    const configManager = getEnhancedConfigManager(c.env);
    
    // Determine which keys to migrate
    const awsManagedKeys = ['OPENAI_API_KEY', 'CLAUDE_API_KEY', 'APIFY_API_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
    const keysToMigrate = migrateAll ? awsManagedKeys : (keyNames || []);
    
    if (keysToMigrate.length === 0) {
      return c.json(createStandardResponse(false, undefined, 'No keys specified for migration', requestId), 400);
    }
    
    const results = [];
    
    for (const keyName of keysToMigrate) {
      try {
        await configManager.migrateToAWS(keyName);
        results.push({
          keyName,
          success: true,
          message: 'Successfully migrated to AWS Secrets Manager'
        });
        
        logger('info', 'Key migrated to AWS', { keyName, requestId });
        
      } catch (migrationError: any) {
        results.push({
          keyName,
          success: false,
          error: migrationError.message
        });
        
        logger('error', 'Key migration failed', { 
          keyName, 
          error: migrationError.message, 
          requestId 
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    
    return c.json(createStandardResponse(true, {
      message: `Migration completed: ${successCount} successful, ${failureCount} failed`,
      results,
      summary: {
        total: keysToMigrate.length,
        successful: successCount,
        failed: failureCount
      }
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Migration process failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

export async function handleGetAuditLog(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Verify admin access
    if (!verifyAdminAccess(c)) {
      return c.json(createStandardResponse(false, undefined, 'Unauthorized access', requestId), 401);
    }
    
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    
    const headers = {
      apikey: c.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json'
    };
    
    // Get audit log from app_config table
    const auditLog = await fetchJson<any[]>(
      `${c.env.SUPABASE_URL}/rest/v1/app_config?environment=eq.production&select=key_name,updated_at,updated_by&order=updated_at.desc&limit=${limit}&offset=${offset}`,
      { headers }
    );
    
    const formattedLog = auditLog.map(entry => ({
      keyName: entry.key_name,
      action: 'UPDATE',
      timestamp: entry.updated_at,
      user: entry.updated_by || 'system',
      id: `${entry.key_name}-${entry.updated_at}`,
      storage: isAWSManagedKey(entry.key_name) ? 'AWS + Supabase' : 'Supabase'
    }));
    
    return c.json(createStandardResponse(true, { 
      log: formattedLog,
      total: formattedLog.length,
      limit,
      offset,
      hasAWSIntegration: true
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to get enhanced audit log', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// =======================================================================================
// HELPER FUNCTIONS - PASTE THESE AT THE END OF THE FILE
// =======================================================================================

function isAWSManagedKey(keyName: string): boolean {
  const awsManagedKeys = [
    'OPENAI_API_KEY',
    'CLAUDE_API_KEY',
    'APIFY_API_TOKEN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET'
  ];
  
  return awsManagedKeys.includes(keyName);
}

function validateApiKeyFormat(keyName: string, keyValue: string): { valid: boolean; error?: string } {
  const validations: Record<string, (key: string) => boolean> = {
    'OPENAI_API_KEY': (key) => key.startsWith('sk-') && key.length > 20,
    'CLAUDE_API_KEY': (key) => key.startsWith('sk-ant-') && key.length > 30,
    'APIFY_API_TOKEN': (key) => key.startsWith('apify_api_') && key.length > 20,
    'STRIPE_SECRET_KEY': (key) => (key.startsWith('sk_live_') || key.startsWith('sk_test_')) && key.length > 20,
    'STRIPE_WEBHOOK_SECRET': (key) => key.startsWith('whsec_') && key.length > 20,
    'STRIPE_PUBLISHABLE_KEY': (key) => (key.startsWith('pk_live_') || key.startsWith('pk_test_')) && key.length > 20,
    'WORKER_URL': (key) => key.startsWith('https://') && key.includes('.workers.dev'),
    'NETLIFY_BUILD_HOOK_URL': (key) => key.startsWith('https://api.netlify.com/build_hooks/')
  };
  
  const validator = validations[keyName];
  if (!validator) {
    return { valid: true }; // Allow unknown key types
  }
  
  if (!validator(keyValue)) {
    return { valid: false, error: `Invalid format for ${keyName}` };
  }
  
  return { valid: true };
}


// Add these functions to the END of enhanced-admin.ts file

export async function handleTestApiKey(c: Context): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Verify admin access
    if (!verifyAdminAccess(c)) {
      return c.json(createStandardResponse(false, undefined, 'Unauthorized access', requestId), 401);
    }
    
    const body = await c.req.json() as { keyName: string; adminToken?: string };
    const { keyName } = body;
    
    if (!keyName) {
      return c.json(createStandardResponse(false, undefined, 'keyName is required', requestId), 400);
    }
    
    // Get the key value
    const configManager = getEnhancedConfigManager(c.env);
    const keyValue = await configManager.getConfig(keyName);
    
    if (!keyValue) {
      return c.json(createStandardResponse(false, undefined, `${keyName} not found or empty`, requestId), 404);
    }
    
    // Test the key
    const testResult = await testApiKey(keyName, keyValue, c.env);
    
    logger('info', 'API key tested via admin panel', { keyName, testResult: testResult.success, requestId });
    
    return c.json(createStandardResponse(true, {
      keyName,
      testResult,
      keyPresent: true,
      keyLength: keyValue.length
    }, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'API key test failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function testApiKey(keyName: string, keyValue: string, env: any): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    switch (keyName) {
      case 'OPENAI_API_KEY':
        return await testOpenAIKey(keyValue);
      
      case 'CLAUDE_API_KEY':
        return await testClaudeKey(keyValue);
      
      case 'APIFY_API_TOKEN':
        return await testApifyKey(keyValue);
      
      case 'STRIPE_SECRET_KEY':
        return await testStripeKey(keyValue);
      
      default:
        return {
          success: true,
          message: `${keyName} format validation passed - no live test available`
        };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Test failed: ${error.message}`
    };
  }
}

async function testOpenAIKey(apiKey: string): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'OpenAI API key is valid and active',
        details: {
          modelsAvailable: data.data?.length || 0,
          status: response.status
        }
      };
    } else {
      const errorData = await response.text();
      return {
        success: false,
        message: `OpenAI API key test failed: ${response.status}`,
        details: { error: errorData }
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `OpenAI test error: ${error.message}`
    };
  }
}

async function testClaudeKey(apiKey: string): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Test' }]
      })
    });

    if (response.ok) {
      return {
        success: true,
        message: 'Claude API key is valid and active',
        details: { status: response.status }
      };
    } else {
      const errorData = await response.text();
      return {
        success: false,
        message: `Claude API key test failed: ${response.status}`,
        details: { error: errorData }
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Claude test error: ${error.message}`
    };
  }
}

async function testApifyKey(apiToken: string): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    const response = await fetch(`https://api.apify.com/v2/users/me?token=${apiToken}`);

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'Apify API token is valid and active',
        details: {
          userId: data.data?.id,
          username: data.data?.username,
          status: response.status
        }
      };
    } else {
      return {
        success: false,
        message: `Apify API token test failed: ${response.status}`
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Apify test error: ${error.message}`
    };
  }
}

async function testStripeKey(secretKey: string): Promise<{ success: boolean; message: string; details?: any }> {
  try {
    const response = await fetch('https://api.stripe.com/v1/account', {
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: 'Stripe secret key is valid and active',
        details: {
          accountId: data.id,
          country: data.country,
          status: response.status
        }
      };
    } else {
      return {
        success: false,
        message: `Stripe secret key test failed: ${response.status}`
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Stripe test error: ${error.message}`
    };
  }
}
