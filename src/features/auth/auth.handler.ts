/**
 * Auth Handlers
 *
 * Endpoints:
 * - POST /api/auth/google/callback - Complete OAuth flow, issue tokens
 * - POST /api/auth/refresh - Rotate tokens, extend session
 * - POST /api/auth/logout - Revoke refresh token
 * - GET /api/auth/session - Fetch current user data (requires auth)
 * - GET /api/auth/bootstrap - Single source for all init data (requires auth)
 */

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type {
  GoogleCallbackRequest,
  AuthResponse,
  RefreshRequest,
  RefreshResponse,
  LogoutRequest,
  SessionResponse,
  BootstrapResponse,
} from './auth.types';

import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { JWTService } from '@/infrastructure/auth/jwt.service';
import { TokenService } from '@/infrastructure/auth/token.service';
import { GoogleOAuthService } from '@/infrastructure/auth/google-oauth.service';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { logger } from '@/shared/utils/logger.util';

/**
 * Convert Google User ID to deterministic UUID v5
 */
async function googleIdToUUID(googleId: string): Promise<string> {
  const GOOGLE_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  const encoder = new TextEncoder();
  const data = encoder.encode(GOOGLE_NAMESPACE + googleId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  const uuid = [
    hashArray.slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(4, 6).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(6, 8).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(8, 10).map(b => b.toString(16).padStart(2, '0')).join(''),
    hashArray.slice(10, 16).map(b => b.toString(16).padStart(2, '0')).join('')
  ].join('-');

  const chars = uuid.split('');
  chars[14] = '5';
  chars[19] = '8';

  return chars.join('');
}

/** POST /api/auth/google/callback - Complete Google OAuth flow */
export async function handleGoogleCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json() as GoogleCallbackRequest;

    if (!body.code) {
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    const googleOAuth = new GoogleOAuthService(c.env);
    const googleUser = await googleOAuth.completeOAuthFlow(body.code);

    const userId = await googleIdToUUID(googleUser.id);

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    const { data: accountData, error: accountError } = await supabase
      .rpc('create_account_atomic', {
        p_user_id: userId,
        p_email: googleUser.email,
        p_full_name: googleUser.name,
        p_avatar_url: googleUser.picture
      });

    if (accountError || !accountData) {
      logger.error('Account creation failed', {
        error_code: accountError?.code,
        error_message: accountError?.message,
        error_details: accountError?.details
      });
      return c.json({
        error: 'Failed to create account',
        details: accountError?.message
      }, 500);
    }

    const isNewUser = accountData.is_new_user ?? false;

    if (isNewUser) {
      try {
        logger.info('Creating Stripe customer for new user', {
          account_id: accountData.account_id
        });

        const { StripeService } = await import('@/infrastructure/billing/stripe.service');
        const stripeService = new StripeService(c.env);

        const stripeCustomerId = await stripeService.createCustomer({
          email: googleUser.email,
          name: googleUser.name,
          account_id: accountData.account_id,
          user_id: accountData.user_id,
          metadata: {
            signup_method: 'google_oauth',
            environment: c.env.APP_ENV
          }
        });

        logger.info('Stripe customer created', {
          stripe_customer_id: stripeCustomerId,
          account_id: accountData.account_id
        });

        const isProduction = c.env.APP_ENV === 'production';
        const columnName = isProduction ? 'stripe_customer_id_live' : 'stripe_customer_id_test';

        const { error: updateError } = await supabase
          .from('accounts')
          .update({ [columnName]: stripeCustomerId })
          .eq('id', accountData.account_id);

        if (updateError) {
          logger.warn('Failed to save stripe_customer_id to database', {
            error_code: updateError.code,
            error_message: updateError.message,
            account_id: accountData.account_id,
            stripe_customer_id: stripeCustomerId
          });
        }

      } catch (error: unknown) {
        logger.warn('Stripe customer creation failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
          account_id: accountData.account_id,
          email: googleUser.email
        });
      }
    }

    const jwtService = new JWTService(c.env);
    const accessToken = await jwtService.sign({
      userId: accountData.user_id,
      accountId: accountData.account_id,
      email: accountData.email,
      onboardingCompleted: accountData.onboarding_completed
    });

    const tokenService = new TokenService(supabase);
    const refreshToken = await tokenService.create(
      accountData.user_id,
      accountData.account_id
    );

    const response: AuthResponse = {
      accessToken,
      refreshToken,
      expiresAt: jwtService.getExpiryTime(),
      user: {
        id: accountData.user_id,
        email: accountData.email,
        full_name: accountData.full_name,
        avatar_url: googleUser.picture,
        onboarding_completed: accountData.onboarding_completed
      },
      account: {
        id: accountData.account_id,
        name: accountData.full_name + "'s Account",
        credit_balance: accountData.credit_balance
      },
      isNewUser: isNewUser
    };

    return successResponse(c, response);

  } catch (error: unknown) {
    logger.error('Google callback fatal error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return c.json({
      error: 'Authentication failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

/** POST /api/auth/refresh - Rotate refresh token and issue new access token */
export async function handleRefresh(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json() as RefreshRequest;

    if (!body.refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const tokenService = new TokenService(supabase);
    const jwtService = new JWTService(c.env);

    const tokenData = await tokenService.validate(body.refreshToken);

    if (!tokenData) {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }

    const newRefreshToken = await tokenService.rotate(
      body.refreshToken,
      tokenData.user_id,
      tokenData.account_id
    );

    const { data: user } = await supabase
      .from('users')
      .select('email')
      .eq('id', tokenData.user_id)
      .single();

    const { data: businesses } = await supabase
      .from('business_profiles')
      .select('onboarding_completed')
      .eq('account_id', tokenData.account_id);

    const hasCompletedBusiness = businesses?.some(b => b.onboarding_completed) || false;

    const newAccessToken = await jwtService.sign({
      userId: tokenData.user_id,
      accountId: tokenData.account_id,
      email: user?.email || tokenData.user_id,
      onboardingCompleted: hasCompletedBusiness
    });

    const response: RefreshResponse = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: jwtService.getExpiryTime()
    };

    return c.json(response, 200);

  } catch (error: unknown) {
    logger.error('Token refresh failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json({
      error: 'Token refresh failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

/** POST /api/auth/logout - Revoke refresh token */
export async function handleLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json() as LogoutRequest;

    if (!body.refreshToken) {
      return c.json({ error: 'Missing refresh token' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const tokenService = new TokenService(supabase);

    await tokenService.revoke(body.refreshToken);

    return c.json({ success: true }, 200);

  } catch (error: unknown) {
    logger.error('Logout failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json({
      error: 'Logout failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

/** GET /api/auth/session - Get current user session info */
export async function handleGetSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const auth = getAuthContext(c);
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, full_name, avatar_url')
      .eq('id', auth.userId)
      .single();

    if (userError || !user) {
      logger.error('User not found', { userId: auth.userId, error: userError?.message });
      return c.json({ error: 'User not found' }, 404);
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('id', auth.accountId)
      .single();

    if (accountError || !account) {
      logger.error('Account not found', { accountId: auth.accountId, error: accountError?.message });
      return c.json({ error: 'Account not found' }, 404);
    }

    const { data: businesses } = await supabase
      .from('business_profiles')
      .select('onboarding_completed')
      .eq('account_id', auth.accountId);

    const hasCompletedBusiness = businesses?.some(b => b.onboarding_completed) || false;

    let newAccessToken: string | undefined;
    if (hasCompletedBusiness !== auth.onboardingCompleted) {
      logger.info('Onboarding status changed, issuing fresh JWT', {
        jwt_claim: auth.onboardingCompleted,
        actual_status: hasCompletedBusiness
      });
      const jwtService = new JWTService(c.env);
      newAccessToken = await jwtService.sign({
        userId: auth.userId,
        accountId: auth.accountId,
        email: user.email,
        onboardingCompleted: hasCompletedBusiness
      });
    }

    const { data: balances } = await supabase
      .from('balances')
      .select('credit_balance, light_analyses_balance')
      .eq('account_id', auth.accountId)
      .single();

    const response: SessionResponse & { newAccessToken?: string } = {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        onboarding_completed: hasCompletedBusiness
      },
      account: {
        id: account.id,
        name: account.name,
        credit_balance: balances?.credit_balance || 0,
        light_analyses_balance: balances?.light_analyses_balance || 0
      }
    };

    if (newAccessToken) {
      response.newAccessToken = newAccessToken;
    }

    return successResponse(c, response);

  } catch (error: unknown) {
    logger.error('Get session failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json({
      error: 'Failed to fetch session',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

/** GET /api/auth/bootstrap - Single endpoint for all user initialization data */
export async function handleBootstrap(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = getAuthContext(c);

  try {
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);

    const { data, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        full_name,
        avatar_url,
        accounts!fk_accounts_owner (
          id,
          name,
          balances (
            account_id,
            credit_balance,
            light_analyses_balance,
            last_transaction_at,
            created_at,
            updated_at
          ),
          subscriptions (
            id,
            plan_type,
            status,
            current_period_start,
            current_period_end,
            stripe_subscription_id_live,
            stripe_subscription_id_test,
            stripe_customer_id_live,
            stripe_customer_id_test
          )
        )
      `)
      .eq('id', auth.userId)
      .single();

    if (error || !data) {
      logger.error('Bootstrap user not found', { userId: auth.userId, error: error?.message });
      return errorResponse(c, 'Bootstrap failed', 'NOT_FOUND', 404);
    }

    const user = data;
    const account = Array.isArray(data.accounts) ? data.accounts[0] : data.accounts;
    const subscription = account?.subscriptions?.[0] || null;
    const balance = account?.balances?.[0] || null;

    const isProduction = c.env.APP_ENV === 'production';

    const response: BootstrapResponse = {
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        onboarding_completed: auth.onboardingCompleted
      },
      account: {
        id: account.id,
        name: account.name
      },
      subscription: subscription ? {
        id: subscription.id,
        tier: subscription.plan_type as 'free' | 'growth' | 'pro' | 'agency' | 'enterprise',
        status: subscription.status as 'active' | 'canceled' | 'past_due',
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        stripe_subscription_id: isProduction
          ? subscription.stripe_subscription_id_live
          : subscription.stripe_subscription_id_test,
        stripe_customer_id: isProduction
          ? subscription.stripe_customer_id_live
          : subscription.stripe_customer_id_test
      } : null,
      balances: balance ? {
        account_id: balance.account_id,
        credit_balance: balance.credit_balance,
        light_analyses_balance: balance.light_analyses_balance,
        last_transaction_at: balance.last_transaction_at,
        created_at: balance.created_at,
        updated_at: balance.updated_at
      } : {
        account_id: account.id,
        credit_balance: 0,
        light_analyses_balance: 0,
        last_transaction_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    };

    return successResponse(c, response);

  } catch (error: unknown) {
    logger.error('Bootstrap failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: auth.userId,
      accountId: auth.accountId
    });
    return errorResponse(c, 'Bootstrap failed', 'INTERNAL_ERROR', 500);
  }
}
