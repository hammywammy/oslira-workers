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
import { AppError } from '@/shared/middleware/error.middleware';
import { createUserClient } from '@/infrastructure/database/supabase.client';

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
    const supabase = await createUserClient(c.env);
    const service = new LeadsService(supabase);
    const { leads, total } = await service.listLeads(accountId, query);

    return paginatedResponse(c, leads, {
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasMore: (query.page * query.pageSize) < total
    });

  } catch (error: any) {
    console.error('[ListLeads] Error:', error);
    
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
    const supabase = await createUserClient(c.env);
    const service = new LeadsService(supabase);
    const lead = await service.getLeadById(accountId, leadId);

    if (!lead) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    return successResponse(c, lead);

  } catch (error: any) {
    console.error('[GetLead] Error:', error);
    
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
    const supabase = await createUserClient(c.env);
    const service = new LeadsService(supabase);
    const hasAccess = await service.verifyLeadOwnership(accountId, leadId);

    if (!hasAccess) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Get analyses
    const analyses = await service.getLeadAnalyses(accountId, query);

    return successResponse(c, analyses);

  } catch (error: any) {
    console.error('[GetLeadAnalyses] Error:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid parameters', 'VALIDATION_ERROR', 400);
    }
    
    return errorResponse(c, 'Failed to get analyses', 'INTERNAL_ERROR', 500);
  }
}

/**
 * DELETE /api/leads/:leadId
 * Soft delete lead
 */
export async function deleteLead(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const accountId = auth.accountId;
    const leadId = c.req.param('leadId');

    // Validate params
    validateQuery(DeleteLeadParamsSchema, { leadId });

    // Verify lead ownership
    const supabase = await createUserClient(c.env);
    const service = new LeadsService(supabase);
    const hasAccess = await service.verifyLeadOwnership(accountId, leadId);

    if (!hasAccess) {
      return errorResponse(c, 'Lead not found', 'NOT_FOUND', 404);
    }

    // Delete lead
    await service.deleteLead(accountId, leadId);

    return noContentResponse(c);

  } catch (error: any) {
    console.error('[DeleteLead] Error:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid lead ID', 'VALIDATION_ERROR', 400);
    }
    
    return errorResponse(c, 'Failed to delete lead', 'INTERNAL_ERROR', 500);
  }
}
