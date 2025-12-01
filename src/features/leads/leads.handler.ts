// features/leads/leads.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { LeadsService } from './leads.service';
import {
  ListLeadsQuerySchema,
  GetLeadParamsSchema,
  GetLeadAnalysesQuerySchema,
  DeleteLeadParamsSchema
} from './leads.types';
import { validateQuery } from '@/shared/utils/validation.util';
import { successResponse, errorResponse, paginatedResponse, noContentResponse } from '@/shared/utils/response.util';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { AvatarCacheService } from '@/infrastructure/cache/avatar-cache.service';
import { logger } from '@/shared/utils/logger.util';

/**
 * GET /api/leads
 * List all leads for account
 */
export async function listLeads(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;

    // Validate query params
    const query = validateQuery(ListLeadsQuerySchema, {
      businessProfileId: c.req.query('businessProfileId'),
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      sortBy: c.req.query('sortBy'),
      sortOrder: c.req.query('sortOrder'),
      search: c.req.query('search')
    });

    // Get leads
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new LeadsService(supabase);
    const { leads, total } = await service.listLeads(accountId, query);

    return paginatedResponse(c, leads, {
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: (query.page * query.pageSize) < total
    });

  } catch (error: any) {
    logger.error('Failed to list leads', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid query parameters', 'VALIDATION_ERROR', 400, error.errors);
    }

    return errorResponse(c, 'Failed to list leads', 'INTERNAL_ERROR', 500);
  }
}

/**
 * GET /api/leads/:leadId
 * Get single lead details
 */
export async function getLead(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;
    const leadId = c.req.param('leadId');

    // Validate params
    validateQuery(GetLeadParamsSchema, { leadId });

    // Get lead
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new LeadsService(supabase);
    const lead = await service.getLeadById(accountId, leadId);

    if (!lead) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    return successResponse(c, lead);

  } catch (error: any) {
    logger.error('Failed to get lead', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid lead ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to get lead', 'INTERNAL_ERROR', 500);
  }
}

/**
 * GET /api/leads/:leadId/analyses
 * Get analysis history for lead
 */
export async function getLeadAnalyses(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;
    const leadId = c.req.param('leadId');

    // Validate params
    const query = validateQuery(GetLeadAnalysesQuerySchema, {
      leadId,
      limit: c.req.query('limit'),
      analysisType: c.req.query('analysisType')
    });

    // Verify lead ownership
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new LeadsService(supabase);
    const hasAccess = await service.verifyLeadOwnership(accountId, leadId);

    if (!hasAccess) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Get analyses
    const analyses = await service.getLeadAnalyses(accountId, query);

    return successResponse(c, analyses);

  } catch (error: any) {
    logger.error('Failed to get lead analyses', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid parameters', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to get analyses', 'INTERNAL_ERROR', 500);
  }
}

/**
 * DELETE /api/leads/:leadId
 * Soft delete lead and clean up R2 avatar
 */
export async function deleteLead(c: Context<{ Bindings: Env }>) {
  const auth = getAuthContext(c);
  const accountId = auth.accountId;
  const leadId = c.req.param('leadId');

  try {
    // Validate params
    validateQuery(DeleteLeadParamsSchema, { leadId });

    // Get supabase client
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const service = new LeadsService(supabase);

    // Verify lead exists and user has access
    const hasAccess = await service.verifyLeadOwnership(accountId, leadId);
    if (!hasAccess) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Delete avatar from R2 (per-lead key means always safe to delete)
    try {
      const avatarService = new AvatarCacheService(c.env.R2_MEDIA_BUCKET);
      await avatarService.deleteAvatar(leadId);
      logger.info('Deleted R2 avatar for lead', { leadId });
    } catch (avatarError) {
      // Non-critical - log and continue with lead deletion
      logger.warn('Failed to delete R2 avatar for lead', {
        leadId,
        error: avatarError instanceof Error ? avatarError.message : String(avatarError)
      });
    }

    // Soft delete lead from database
    await service.deleteLead(accountId, leadId);
    logger.info('Lead soft deleted', { leadId, accountId });

    return noContentResponse(c);

  } catch (error) {
    logger.error('Failed to delete lead', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      accountId,
      leadId
    });

    if (error instanceof Error && error.name === 'ZodError') {
      return errorResponse(c, 'Invalid lead ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to delete lead', 'INTERNAL_ERROR', 500);
  }
}
