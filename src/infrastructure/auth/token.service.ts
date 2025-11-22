// src/infrastructure/auth/token.service.ts

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RefreshTokenRecord } from '@/features/auth/auth.types';

/**
 * TOKEN SERVICE
 * 
 * Manages refresh tokens in database with rotation support
 * 
 * Features:
 * - Generate cryptographically secure tokens
 * - Store tokens with 7-day expiry
 * - Validate tokens (check expiry + revocation)
 * - Rotate tokens (invalidate old, create new)
 * - Revoke tokens (logout)
 * 
 * Security:
 * - Tokens are opaque (32 bytes hex = 64 characters)
 * - Each refresh returns NEW token (rotation)
 * - Old tokens are marked as replaced_by (audit trail)
 * - Revoked tokens cannot be used
 */

export class TokenService {
  private supabase: SupabaseClient;
  private readonly TOKEN_EXPIRY_DAYS = 7;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Generate cryptographically secure random token
   * Returns 64-character hex string (32 bytes)
   */
  private generateToken(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Create new refresh token
   * 
   * @param userId - User ID
   * @param accountId - Account ID
   * @returns Token string
   */
  async create(userId: string, accountId: string): Promise<string> {
    console.log(`[AUTH-TRACE-201][${Date.now()}] TokenService.generateStart: Generating new refresh token {userId: '${userId}', accountId: '${accountId}'}`);
    const token = this.generateToken();
    console.log(`[AUTH-TRACE-202][${Date.now()}] TokenService.generateComplete: Token generated {tokenPrefix: '${token.substring(0, 8)}', tokenLength: ${token.length}}`);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.TOKEN_EXPIRY_DAYS);

    console.log(`[AUTH-TRACE-203][${Date.now()}] TokenService.dbInsertStart: Inserting token into database {tokenPrefix: '${token.substring(0, 8)}', expiresAt: '${expiresAt.toISOString()}'}`);
    const { error } = await this.supabase
      .from('refresh_tokens')
      .insert({
        token,
        user_id: userId,
        account_id: accountId,
        expires_at: expiresAt.toISOString()
      });

    if (error) {
      console.error(`[AUTH-TRACE-204][${Date.now()}] TokenService.dbInsertFailed: Database insert failed {tokenPrefix: '${token.substring(0, 8)}', errorCode: '${error.code}', errorMessage: '${error.message}'}`);
      console.error('[TokenService] Create failed:', error);
      throw new Error('Failed to create refresh token');
    }

    console.log(`[AUTH-TRACE-205][${Date.now()}] TokenService.dbInsertSuccess: Token inserted into database successfully {tokenPrefix: '${token.substring(0, 8)}', userId: '${userId}', accountId: '${accountId}'}`);

    return token;
  }

  /**
   * Validate refresh token
   * Checks: exists, not expired, not revoked
   *
   * @param token - Token string to validate
   * @returns Token record or null if invalid
   */
  async validate(token: string): Promise<RefreshTokenRecord | null> {
    console.log(`[AUTH-TRACE-211][${Date.now()}] TokenService.validateStart: Starting token validation {tokenPrefix: '${token.substring(0, 8)}', tokenLength: ${token.length}}`);
    console.log('[TokenService] Starting token validation', {
      token_prefix: token.substring(0, 8)
    });

    console.log(`[AUTH-TRACE-212][${Date.now()}] TokenService.dbQueryStart: Querying database for token {tokenPrefix: '${token.substring(0, 8)}'}`);
    const { data, error } = await this.supabase
      .from('refresh_tokens')
      .select('*')
      .eq('token', token)
      .is('revoked_at', null)
      .single();

    if (error) {
      console.error(`[AUTH-TRACE-213][${Date.now()}] TokenService.dbQueryError: Database query error {tokenPrefix: '${token.substring(0, 8)}', errorCode: '${error.code}', errorMessage: '${error.message}'}`);
      console.error('[TokenService] Validation query error', {
        token_prefix: token.substring(0, 8),
        error_code: error.code,
        error_message: error.message,
        error_details: error.details,
        error_hint: error.hint
      });

      // Run diagnostic query to check if token exists but was revoked
      const { data: revokedCheck, error: revokedError } = await this.supabase
        .from('refresh_tokens')
        .select('token, revoked_at, replaced_by_token, expires_at, created_at')
        .eq('token', token)
        .maybeSingle();

      if (revokedError) {
        console.error('[TokenService] Diagnostic query failed', {
          token_prefix: token.substring(0, 8),
          error_code: revokedError.code,
          error_message: revokedError.message
        });
      } else if (!revokedCheck) {
        console.warn('[TokenService] Token not found in database', {
          token_prefix: token.substring(0, 8)
        });
      } else {
        console.warn('[TokenService] Token found but was revoked', {
          token_prefix: token.substring(0, 8),
          revoked_at: revokedCheck.revoked_at,
          replaced_by_token: revokedCheck.replaced_by_token ? revokedCheck.replaced_by_token.substring(0, 8) : null,
          expires_at: revokedCheck.expires_at,
          created_at: revokedCheck.created_at
        });
      }

      return null;
    }

    if (!data) {
      console.warn(`[AUTH-TRACE-214][${Date.now()}] TokenService.dbQueryNoData: No data returned from query {tokenPrefix: '${token.substring(0, 8)}'}`);
      console.warn('[TokenService] No data returned from query', {
        token_prefix: token.substring(0, 8)
      });

      // Run diagnostic query to check if token exists but was revoked
      const { data: revokedCheck, error: revokedError } = await this.supabase
        .from('refresh_tokens')
        .select('token, revoked_at, replaced_by_token, expires_at, created_at')
        .eq('token', token)
        .maybeSingle();

      if (revokedError) {
        console.error('[TokenService] Diagnostic query failed', {
          token_prefix: token.substring(0, 8),
          error_code: revokedError.code,
          error_message: revokedError.message
        });
      } else if (!revokedCheck) {
        console.warn('[TokenService] Token not found in database', {
          token_prefix: token.substring(0, 8)
        });
      } else {
        console.warn('[TokenService] Token found but was revoked', {
          token_prefix: token.substring(0, 8),
          revoked_at: revokedCheck.revoked_at,
          replaced_by_token: revokedCheck.replaced_by_token ? revokedCheck.replaced_by_token.substring(0, 8) : null,
          expires_at: revokedCheck.expires_at,
          created_at: revokedCheck.created_at
        });
      }

      return null;
    }

    // Check expiry
    console.log(`[AUTH-TRACE-215][${Date.now()}] TokenService.expiryCheckStart: Checking token expiry {tokenPrefix: '${token.substring(0, 8)}', expiresAt: '${data.expires_at}'}`);
    const now = new Date();
    const expiresAt = new Date(data.expires_at);
    if (expiresAt < now) {
      console.warn(`[AUTH-TRACE-216][${Date.now()}] TokenService.expiryCheckFailed: Token expired {tokenPrefix: '${token.substring(0, 8)}', expiresAt: '${data.expires_at}', currentTime: '${now.toISOString()}', expiredByMs: ${now.getTime() - expiresAt.getTime()}}`);
      console.warn('[TokenService] Token expired', {
        token_prefix: token.substring(0, 8),
        expires_at: data.expires_at,
        current_time: now.toISOString(),
        expired_by_ms: now.getTime() - expiresAt.getTime(),
        created_at: data.created_at
      });
      return null;
    }

    console.log(`[AUTH-TRACE-217][${Date.now()}] TokenService.validateSuccess: Token validated successfully {tokenPrefix: '${token.substring(0, 8)}', userId: '${data.user_id}', accountId: '${data.account_id}', expiresAt: '${data.expires_at}'}`);
    console.log('[TokenService] Token validated successfully', {
      token_prefix: token.substring(0, 8),
      user_id: data.user_id,
      account_id: data.account_id,
      expires_at: data.expires_at
    });

    return data as RefreshTokenRecord;
  }

  /**
   * Rotate token (invalidate old, create new)
   * Used during token refresh flow
   * 
   * @param oldToken - Current token to invalidate
   * @returns New token string
   */
async rotate(oldToken: string, userId: string, accountId: string): Promise<string> {
  console.log(`[AUTH-TRACE-221][${Date.now()}] TokenService.rotateStart: Starting token rotation {oldTokenPrefix: '${oldToken.substring(0, 8)}', userId: '${userId}', accountId: '${accountId}'}`);

  // Validate old token
  console.log(`[AUTH-TRACE-222][${Date.now()}] TokenService.rotateValidateOld: Validating old token before rotation {oldTokenPrefix: '${oldToken.substring(0, 8)}'}`);
  const oldRecord = await this.validate(oldToken);
  if (!oldRecord) {
    console.error(`[AUTH-TRACE-223][${Date.now()}] TokenService.rotateValidateFailed: Old token validation failed {oldTokenPrefix: '${oldToken.substring(0, 8)}'}`);
    throw new Error('Invalid or expired refresh token');
  }

  console.log(`[AUTH-TRACE-224][${Date.now()}] TokenService.rotateValidateSuccess: Old token validated {oldTokenPrefix: '${oldToken.substring(0, 8)}'}`);

  // Create new token with explicit userId and accountId
  console.log(`[AUTH-TRACE-225][${Date.now()}] TokenService.rotateCreateNew: Creating new token {userId: '${userId}', accountId: '${accountId}'}`);
  const newToken = await this.create(userId, accountId);

  console.log(`[AUTH-TRACE-226][${Date.now()}] TokenService.rotateNewCreated: New token created {oldTokenPrefix: '${oldToken.substring(0, 8)}', newTokenPrefix: '${newToken.substring(0, 8)}'}`);

  // Mark old token as replaced
  console.log(`[AUTH-TRACE-227][${Date.now()}] TokenService.rotateRevokeOld: Marking old token as replaced {oldTokenPrefix: '${oldToken.substring(0, 8)}', newTokenPrefix: '${newToken.substring(0, 8)}'}`);
  const { error } = await this.supabase
    .from('refresh_tokens')
    .update({
      revoked_at: new Date().toISOString(),
      replaced_by_token: newToken
    })
    .eq('token', oldToken);

  if (error) {
    console.error(`[AUTH-TRACE-228][${Date.now()}] TokenService.rotateRevokeFailed: Failed to revoke old token {oldTokenPrefix: '${oldToken.substring(0, 8)}', errorCode: '${error.code}', errorMessage: '${error.message}'}`);
    console.error('[TokenService] Rotation update failed:', error);
    // Don't throw - new token already created
  } else {
    console.log(`[AUTH-TRACE-229][${Date.now()}] TokenService.rotateRevokeSuccess: Old token revoked successfully {oldTokenPrefix: '${oldToken.substring(0, 8)}', newTokenPrefix: '${newToken.substring(0, 8)}'}`);
  }

  console.log(`[AUTH-TRACE-230][${Date.now()}] TokenService.rotateComplete: Token rotation complete {oldTokenPrefix: '${oldToken.substring(0, 8)}', newTokenPrefix: '${newToken.substring(0, 8)}'}`);
  return newToken;
}
  /**
   * Revoke token (logout)
   * Marks token as revoked immediately
   * 
   * @param token - Token to revoke
   */
  async revoke(token: string): Promise<void> {
    const { error } = await this.supabase
      .from('refresh_tokens')
      .update({
        revoked_at: new Date().toISOString()
      })
      .eq('token', token);

    if (error) {
      console.error('[TokenService] Revoke failed:', error);
      throw new Error('Failed to revoke token');
    }
  }

  /**
   * Revoke all tokens for a user (logout from all devices)
   * 
   * @param userId - User ID
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('refresh_tokens')
      .update({
        revoked_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .is('revoked_at', null);

    if (error) {
      console.error('[TokenService] Revoke all failed:', error);
      throw new Error('Failed to revoke all tokens');
    }
  }

  /**
   * Cleanup expired tokens (for cron job)
   * Deletes tokens that expired more than 30 days ago
   * 
   * @returns Number of tokens deleted
   */
  async cleanupExpired(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await this.supabase
      .from('refresh_tokens')
      .delete()
      .lt('expires_at', thirtyDaysAgo.toISOString())
      .select();

    if (error) {
      console.error('[TokenService] Cleanup failed:', error);
      return 0;
    }

    return data?.length || 0;
  }
}
