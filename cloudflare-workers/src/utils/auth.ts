// ===============================================================================
// AUTHENTICATION UTILITIES
// File: cloudflare-workers/src/utils/auth.ts
// ===============================================================================

import type { Env } from '../types/interfaces.js';
import { logger } from './logger.js';
import { createClient } from '@supabase/supabase-js';

interface JWTPayload {
  sub: string;
  email?: string;
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  role?: string;
}

interface AuthResult {
  isValid: boolean;
  userId?: string;
  email?: string;
  error?: string;
}

// ===============================================================================
// JWT TOKEN VALIDATION
// ===============================================================================

export async function validateJWTToken(token: string, env: Env, requestId: string): Promise<boolean> {
  const result = await extractUserFromJWT(token, env, requestId);
  return result.isValid;
}

// ===============================================================================
// JWT SIGNATURE VERIFICATION
// ===============================================================================

async function verifyJWTSignature(token: string, env: Env): Promise<boolean> {
  try {
    const { getApiKey } = await import('../services/enhanced-config-manager.js');
    const supabaseUrl = await getApiKey('SUPABASE_URL', env, env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', env, env.APP_ENV);
    
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': serviceRole
      }
    });

    return response.ok;

  } catch (error: any) {
    logger('error', 'Signature verification failed', { error: error.message });
    return false;
  }
}

// ===============================================================================
// EXTRACT USER FROM JWT
// ===============================================================================

export async function extractUserFromJWT(token: string, env: Env, requestId: string = 'default'): Promise<AuthResult> {
  try {
    const { getApiKey } = await import('../services/enhanced-config-manager.js');
const supabaseUrl = await getApiKey('SUPABASE_URL', env, env.APP_ENV);
const supabaseKey = await getApiKey('SUPABASE_SERVICE_ROLE', env, env.APP_ENV);
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      logger('warn', 'Invalid JWT token', { error: error?.message, requestId });
      return { isValid: false, error: error?.message || 'Invalid token' };
    }
    
    logger('info', 'JWT token validated', { userId: user.id, email: user.email, requestId });
    
    return {
      isValid: true,
      userId: user.id,
      email: user.email
    };
    
  } catch (error: any) {
    logger('error', 'JWT extraction failed', { error: error.message, requestId });
    return { isValid: false, error: 'Authentication failed' };
  }
}

// ===============================================================================
// VERIFY USER EXISTS IN DATABASE
// ===============================================================================

export async function verifyUserExists(userId: string, env: Env): Promise<AuthResult> {
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/users?select=id,email&id=eq.${userId}`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return { isValid: false, error: 'Database query failed' };
    }

    const users = await response.json();
    if (!users || users.length === 0) {
      return { isValid: false, error: 'User not found' };
    }

    const user = users[0];
    return {
      isValid: true,
      userId: user.id,
      email: user.email
    };

  } catch (error: any) {
    logger('error', 'User verification failed', { error: error.message, userId });
    return { isValid: false, error: 'User verification failed' };
  }
}
