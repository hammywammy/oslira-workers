// features/business/business.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { BusinessService } from './business.service';
import {
  ListBusinessProfilesQuerySchema,
  CreateBusinessProfileSchema,
  UpdateBusinessProfileSchema,
  GetBusinessProfileParamsSchema
} from './business.types';
import { validateQuery, validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse, createdResponse, paginatedResponse } from '@/shared/utils/response.util';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';

/**
 * BUSINESS HANDLER
 * 
 * FIXED: Uses createAdminClient instead of createUserClient
 * Why: Custom JWT auth doesn't work with Supabase RLS (auth.uid() returns null)
 * Safe: Auth middleware already validates JWT and accountId
 */

/**
 * GET /api/business-profiles
 * List all business profiles for account
 */
export async function listBusinessProfiles(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId; // FIXED: was auth.primaryAccountId

    // Validate query params
    const query = validateQuery(ListBusinessProfilesQuerySchema, {
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize')
    });

    // Get profiles - FIXED: Use admin client
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new BusinessService(supabase);
    const { profiles, total } = await service.listProfiles(accountId, query);

    return paginatedResponse(c, profiles, {
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: (query.page * query.pageSize) < total
    });

  } catch (error: any) {
    console.error('[ListBusinessProfiles] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid query parameters', 'VALIDATION_ERROR', 400, error.errors);
    }

    return errorResponse(c, 'Failed to list business profiles', 'INTERNAL_ERROR', 500);
  }
}

/**
 * GET /api/business-profiles/:profileId
 * Get single business profile details
 */
export async function getBusinessProfile(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId; // FIXED: was auth.primaryAccountId
    const profileId = c.req.param('profileId');

    // Validate params
    validateQuery(GetBusinessProfileParamsSchema, { profileId });

    // Get profile - FIXED: Use admin client
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new BusinessService(supabase);
    const profile = await service.getProfileById(accountId, profileId);

    if (!profile) {
      return errorResponse(c, 'Business profile not found', 'NOT_FOUND', 404);
    }

    return successResponse(c, profile);

  } catch (error: any) {
    console.error('[GetBusinessProfile] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid profile ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to get business profile', 'INTERNAL_ERROR', 500);
  }
}

/**
 * POST /api/business-profiles
 * Create new business profile
 */
export async function createBusinessProfile(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId; // FIXED: was auth.primaryAccountId

    // Validate body
    const body = await c.req.json();
    const input = validateBody(CreateBusinessProfileSchema, body);

    // Create profile - FIXED: Use admin client
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new BusinessService(supabase);
    const profile = await service.createProfile(accountId, input);

    return createdResponse(c, profile);

  } catch (error: any) {
    console.error('[CreateBusinessProfile] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid request body', 'VALIDATION_ERROR', 400, error.errors);
    }

    return errorResponse(c, 'Failed to create business profile', 'INTERNAL_ERROR', 500);
  }
}

/**
 * PUT /api/business-profiles/:profileId
 * Update business profile
 */
export async function updateBusinessProfile(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId; // FIXED: was auth.primaryAccountId
    const profileId = c.req.param('profileId');

    // Validate params
    validateQuery(GetBusinessProfileParamsSchema, { profileId });

    // Validate body
    const body = await c.req.json();
    const input = validateBody(UpdateBusinessProfileSchema, body);

    // Update profile - FIXED: Use admin client
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new BusinessService(supabase);
    const profile = await service.updateProfile(accountId, profileId, input);

    return successResponse(c, profile);

  } catch (error: any) {
    console.error('[UpdateBusinessProfile] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid request', 'VALIDATION_ERROR', 400, error.errors);
    }

    if (error.message === 'Business profile not found') {
      return errorResponse(c, 'Business profile not found', 'NOT_FOUND', 404);
    }

    return errorResponse(c, 'Failed to update business profile', 'INTERNAL_ERROR', 500);
  }
}
