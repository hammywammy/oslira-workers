// src/infrastructure/auth/jwt.service.ts

import type { Env } from '@/shared/types/env.types';
import type { JWTPayload } from '@/features/auth/auth.types';
import { getSecret } from '@/infrastructure/config/secrets';

/**
 * JWT SERVICE
 * 
 * Handles JWT signing and verification using HS256 algorithm
 * Secret key fetched from AWS Secrets Manager (cached for 5 minutes)
 * 
 * Token format:
 * - Algorithm: HS256 (HMAC with SHA-256)
 * - Expiry: 15 minutes
 * - Payload: { userId, accountId, email, onboardingCompleted, iat, exp }
 */

export class JWTService {
  private env: Env;
  private secretCache: { value: string; fetchedAt: number } | null = null;
  private readonly SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly TOKEN_EXPIRY = 15 * 60; // 15 minutes in seconds

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get JWT secret from AWS Secrets Manager (with caching)
   */
  private async getJWTSecret(): Promise<string> {
    // Return cached secret if still valid
    if (this.secretCache && (Date.now() - this.secretCache.fetchedAt) < this.SECRET_CACHE_TTL) {
      return this.secretCache.value;
    }

    // Fetch from AWS
    const secret = await getSecret('JWT_SECRET', this.env, this.env.APP_ENV);
    
    // Cache it
    this.secretCache = {
      value: secret,
      fetchedAt: Date.now()
    };

    return secret;
  }

  /**
   * Sign a JWT token
   * 
   * @param payload - Data to encode in the token
   * @returns JWT string
   */
  async sign(payload: Omit<JWTPayload, 'iat' | 'exp'>): Promise<string> {
    console.log(`[AUTH-TRACE-301][${Date.now()}] JWTService.signStart: Starting JWT signing {userId: '${payload.userId}', accountId: '${payload.accountId}', email: '${payload.email}'}`);

    const secret = await this.getJWTSecret();

    const now = Math.floor(Date.now() / 1000);

    const fullPayload: JWTPayload = {
      ...payload,
      iat: now,
      exp: now + this.TOKEN_EXPIRY
    };

    console.log(`[AUTH-TRACE-302][${Date.now()}] JWTService.payloadCreated: JWT payload created {iat: ${now}, exp: ${now + this.TOKEN_EXPIRY}, expiresInSeconds: ${this.TOKEN_EXPIRY}}`);

    // Create JWT manually (Cloudflare Workers don't have jsonwebtoken package)
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(fullPayload));

    console.log(`[AUTH-TRACE-303][${Date.now()}] JWTService.encodingComplete: Header and payload encoded {headerLength: ${encodedHeader.length}, payloadLength: ${encodedPayload.length}}`);

    const signature = await this.createSignature(
      `${encodedHeader}.${encodedPayload}`,
      secret
    );

    const jwt = `${encodedHeader}.${encodedPayload}.${signature}`;
    console.log(`[AUTH-TRACE-304][${Date.now()}] JWTService.signComplete: JWT signed successfully {jwtLength: ${jwt.length}, userId: '${payload.userId}'}`);

    return jwt;
  }

  /**
   * Verify and decode a JWT token
   * 
   * @param token - JWT string to verify
   * @returns Decoded payload or null if invalid
   */
  async verify(token: string): Promise<JWTPayload | null> {
    try {
      console.log(`[AUTH-TRACE-311][${Date.now()}] JWTService.verifyStart: Starting JWT verification {tokenLength: ${token.length}}`);

      const secret = await this.getJWTSecret();

      // Split token into parts
      const parts = token.split('.');
      if (parts.length !== 3) {
        console.warn(`[AUTH-TRACE-312][${Date.now()}] JWTService.verifyMalformed: JWT malformed - invalid parts count {partsCount: ${parts.length}}`);
        return null;
      }

      const [encodedHeader, encodedPayload, signature] = parts;

      console.log(`[AUTH-TRACE-313][${Date.now()}] JWTService.verifyParsed: JWT split into parts {headerLength: ${encodedHeader.length}, payloadLength: ${encodedPayload.length}, signatureLength: ${signature.length}}`);

      // Verify signature
      const expectedSignature = await this.createSignature(
        `${encodedHeader}.${encodedPayload}`,
        secret
      );

      if (signature !== expectedSignature) {
        console.warn(`[AUTH-TRACE-314][${Date.now()}] JWTService.verifySignatureFailed: Invalid JWT signature`);
        console.warn('[JWT] Invalid signature');
        return null;
      }

      console.log(`[AUTH-TRACE-315][${Date.now()}] JWTService.verifySignatureValid: JWT signature valid`);

      // Decode payload
      const payload = JSON.parse(this.base64UrlDecode(encodedPayload)) as JWTPayload;

      console.log(`[AUTH-TRACE-316][${Date.now()}] JWTService.verifyPayloadDecoded: JWT payload decoded {userId: '${payload.userId}', accountId: '${payload.accountId}', exp: ${payload.exp}}`);

      // Check expiry
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        console.warn(`[AUTH-TRACE-317][${Date.now()}] JWTService.verifyExpired: JWT expired {exp: ${payload.exp}, now: ${now}, expiredBySeconds: ${now - payload.exp}}`);
        console.warn('[JWT] Token expired');
        return null;
      }

      console.log(`[AUTH-TRACE-318][${Date.now()}] JWTService.verifySuccess: JWT verified successfully {userId: '${payload.userId}', accountId: '${payload.accountId}'}`);

      return payload;

    } catch (error) {
      console.error(`[AUTH-TRACE-319][${Date.now()}] JWTService.verifyError: JWT verification failed {error: '${error}'}`);
      console.error('[JWT] Verification failed:', error);
      return null;
    }
  }

  /**
   * Create HMAC-SHA256 signature
   */
  private async createSignature(data: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(data);

    // Import key
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Sign
    const signature = await crypto.subtle.sign('HMAC', key, messageData);

    // Convert to base64url
    return this.arrayBufferToBase64Url(signature);
  }

  /**
   * Base64 URL encode
   */
  private base64UrlEncode(str: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    return this.arrayBufferToBase64Url(data);
  }

  /**
   * Base64 URL decode
   */
  private base64UrlDecode(str: string): string {
    // Add padding if needed
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }

    // Decode
    const decoder = new TextDecoder();
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return decoder.decode(bytes);
  }

  /**
   * Convert ArrayBuffer to Base64 URL
   */
  private arrayBufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Get token expiry time (for frontend storage)
   */
  getExpiryTime(): number {
    return Date.now() + (this.TOKEN_EXPIRY * 1000);
  }
}
