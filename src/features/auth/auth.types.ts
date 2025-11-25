// src/features/auth/auth.types.ts

/**
 * JWT PAYLOAD
 * Data stored inside the access token (15 min expiry)
 */
export interface JWTPayload {
  userId: string;
  accountId: string;
  email: string;
  onboardingCompleted: boolean;
  iat: number;  // Issued at (Unix timestamp)
  exp: number;  // Expires at (Unix timestamp)
}

/**
 * REFRESH TOKEN RECORD
 * Database representation of a refresh token
 */
export interface RefreshTokenRecord {
  id: string;
  token: string;
  user_id: string;
  account_id: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_token: string | null;
  created_at: string;
}

/**
 * GOOGLE OAUTH CREDENTIALS
 * Fetched from AWS Secrets Manager
 */
export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * GOOGLE USER INFO
 * Returned from Google's userinfo endpoint
 */
export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}

/**
 * GOOGLE TOKEN RESPONSE
 * Returned from Google's token exchange
 */
export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token: string;
}

/**
 * AUTH RESPONSE
 * Returned to frontend after successful authentication
 */
export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    full_name: string;
    avatar_url: string | null;
    onboarding_completed: boolean;
  };
  account: {
    id: string;
    name: string;
    credit_balance: number;
  };
  isNewUser: boolean;
}

/**
 * SESSION RESPONSE
 * Returned from GET /api/auth/session
 */
export interface SessionResponse {
  user: {
    id: string;
    email: string;
    full_name: string;
    avatar_url: string | null;
    onboarding_completed: boolean;
  };
  account: {
    id: string;
    name: string;
    credit_balance: number;
    light_analyses_balance: number;
  };
}

/**
 * REFRESH REQUEST
 * Body for POST /api/auth/refresh
 */
export interface RefreshRequest {
  refreshToken: string;
}

/**
 * REFRESH RESPONSE
 * Returned from POST /api/auth/refresh
 */
export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * GOOGLE CALLBACK REQUEST
 * Body for POST /api/auth/google/callback
 */
export interface GoogleCallbackRequest {
  code: string;
}

/**
 * LOGOUT REQUEST
 * Body for POST /api/auth/logout
 */
export interface LogoutRequest {
  refreshToken: string;
}

/**
 * AUTH CONTEXT
 * Attached to Hono context after middleware validation
 */
export interface AuthContext {
  userId: string;
  accountId: string;
  email: string;
  onboardingCompleted: boolean;
}

/**
 * BOOTSTRAP RESPONSE
 * Returned from GET /api/auth/bootstrap
 * Single source of truth for all user initialization data
 */
export interface BootstrapResponse {
  user: {
    id: string;
    email: string;
    full_name: string;
    avatar_url: string | null;
    onboarding_completed: boolean;
  };
  account: {
    id: string;
    name: string;
  };
  subscription: {
    id: string;
    tier: 'free' | 'growth' | 'pro' | 'agency' | 'enterprise';
    status: 'active' | 'canceled' | 'past_due';
    current_period_start: string;
    current_period_end: string;
    stripe_subscription_id: string | null;
    stripe_customer_id: string | null;
  } | null;
  balances: {
    account_id: string;
    credit_balance: number;
    light_analyses_balance: number;
    last_transaction_at: string | null;
    created_at: string;
    updated_at: string;
  };
}
