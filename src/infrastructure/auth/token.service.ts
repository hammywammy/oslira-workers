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
    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.TOKEN_EXPIRY_DAYS);

    const { error } = await this.supabase
      .from('refresh_tokens')
      .insert({
        token,
        user_id: userId,
        account_id: accountId,
        expires_at: expiresAt.toISOString()
      });

    if (error) {
      console.error('[TokenService] Create failed:', error);
      throw new Error('Failed to create refresh token');
    }

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
    const { data, error } = await this.supabase
      .from('refresh_tokens')
      .select('*')
      .eq('token', token)
      .is('revoked_at', null)
      .single();

    if (error || !data) {
      return null;
    }

    // Check expiry
    const expiresAt = new Date(data.expires_at);
    if (expiresAt < new Date()) {
      console.warn('[TokenService] Token expired:', token.substring(0, 8));
      return null;
    }

    return data as RefreshTokenRecord;
  }

  /**
   * Rotate token (invalidate old, create new)
   * Used during token refresh flow
   * 
   * @param oldToken - Current token to invalidate
   * @returns New token string
   */
  async rotate(oldToken: string): Promise<string> {
    // Validate old token
    const oldRecord = await this.validate(oldToken);
    if (!oldRecord) {
      throw new Error('Invalid or expired refresh token');
    }

    // Create new token
    const newToken = await this.create(oldRecord.user_id, oldRecord.account_id);

    // Mark old token as replaced
    const { error } = await this.supabase
      .from('refresh_tokens')
      .update({
        revoked_at: new Date().toISOString(),
        replaced_by_token: newToken
      })
      .eq('token', oldToken);

    if (error) {
      console.error('[TokenService] Rotation update failed:', error);
      // Don't throw - new token already created
    }

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
