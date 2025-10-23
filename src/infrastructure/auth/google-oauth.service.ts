// src/infrastructure/auth/google-oauth.service.ts

import type { Env } from '@/shared/types/env.types';
import type { GoogleOAuthCredentials, GoogleTokenResponse, GoogleUserInfo } from '@/features/auth/auth.types';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * GOOGLE OAUTH SERVICE
 * 
 * Handles Google OAuth 2.0 flow:
 * 1. Exchange authorization code for access token
 * 2. Fetch user info from Google
 * 
 * Credentials fetched from AWS Secrets Manager
 * Format: { "clientId": "...", "clientSecret": "...", ... }
 */

export class GoogleOAuthService {
  private env: Env;
  private credentialsCache: { value: GoogleOAuthCredentials; fetchedAt: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get Google OAuth credentials from AWS Secrets Manager
   */
  private async getCredentials(): Promise<GoogleOAuthCredentials> {
    // Return cached credentials if still valid
    if (this.credentialsCache && (Date.now() - this.credentialsCache.fetchedAt) < this.CACHE_TTL) {
      return this.credentialsCache.value;
    }

    // Fetch from AWS
    const secretString = await getSecret('GOOGLE_OAUTH', this.env, this.env.APP_ENV);
    
    // Parse JSON (should have clientId and clientSecret)
    let credentials: GoogleOAuthCredentials;
    
    try {
      const parsed = JSON.parse(secretString);
      
      // Extract clientId and clientSecret
      credentials = {
        clientId: parsed.clientId || parsed.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: parsed.clientSecret || parsed.GOOGLE_OAUTH_CLIENT_SECRET
      };

      if (!credentials.clientId || !credentials.clientSecret) {
        throw new Error('Missing clientId or clientSecret in parsed secret');
      }

    } catch (error) {
      console.error('[GoogleOAuth] Failed to parse credentials:', error);
      throw new Error('Invalid GOOGLE_OAUTH secret format');
    }

    // Cache credentials
    this.credentialsCache = {
      value: credentials,
      fetchedAt: Date.now()
    };

    return credentials;
  }

  /**
   * Exchange authorization code for access token
   * 
   * @param code - Authorization code from Google OAuth redirect
   * @returns Access token response
   */
  async exchangeCodeForToken(code: string): Promise<GoogleTokenResponse> {
    const credentials = await this.getCredentials();

    const params = new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: `${this.env.FRONTEND_URL || 'https://app.oslira.com'}/auth/callback`,
      grant_type: 'authorization_code'
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[GoogleOAuth] Token exchange failed:', error);
      throw new Error(`Google token exchange failed: ${response.status}`);
    }

    const data = await response.json() as GoogleTokenResponse;
    return data;
  }

  /**
   * Get user info from Google
   * 
   * @param accessToken - Google access token
   * @returns User information
   */
  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[GoogleOAuth] Get user info failed:', error);
      throw new Error(`Failed to get user info: ${response.status}`);
    }

    const data = await response.json() as GoogleUserInfo;
    
    // Validate required fields
    if (!data.id || !data.email) {
      throw new Error('Invalid user info response from Google');
    }

    return data;
  }

  /**
   * Complete OAuth flow (exchange code + get user info)
   * Convenience method that combines both steps
   * 
   * @param code - Authorization code
   * @returns User information
   */
  async completeOAuthFlow(code: string): Promise<GoogleUserInfo> {
    const tokenResponse = await this.exchangeCodeForToken(code);
    const userInfo = await this.getUserInfo(tokenResponse.access_token);
    return userInfo;
  }
}
