// features/analysis/analysis.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { generateId } from '@/shared/utils/id.util';
import { z } from 'zod';

/**
 * ASYNC ANALYSIS HANDLERS
 * 
 * Phase 4B: Uses Workflows for async execution
 * - POST /api/leads/analyze → Triggers workflow, returns immediately
 * - GET /api/analysis/:runId/progress → Get current progress
 * - POST /api/analysis/:runId/cancel → Cancel running analysis
 * - GET /api/analysis/:runId/result → Get final result
 */

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

const AnalyzeLeadSchema = z.object({
  username: z.string().min(1).max(50),
  businessProfileId: z.string().uuid(),
  analysisType: z.enum(['light', 'deep', 'xray'])
});

const GetProgressParamsSchema = z.object({
  runId: z.string().startsWith('run_')
});

// ===============================================================================
// HANDLERS
// ===============================================================================

/**
 * POST /api/leads/analyze
 * Trigger async analysis workflow
 */
export async function analyzeInstagramLead(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const body = await c.req.json();

    // Validate input
    const input = validateBody(AnalyzeLeadSchema, body);

    // Generate run ID
    const runId = generateId('run');

    // Trigger workflow (returns immediately)
    const instance = await c.env.ANALYSIS_WORKFLOW.create({
      params: {
        run_id: runId,
        account_id: auth.primaryAccountId,
        business_profile_id: input.businessProfileId,
        username: input.username,
        analysis_type: input.analysisType,
        requested_at: new Date().toISOString()
      }
    });

    // Initialize progress tracker
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    await progressDO.fetch('http://do/initialize', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        account_id: auth.primaryAccountId,
        username: input.username,
        analysis_type: input.analysisType
      })
    });

    return successResponse(c, {
      run_id: runId,
      status: 'processing',
      message: 'Analysis started. Use GET /api/analysis/:runId/progress to track progress.',
      progress_url: `/api/analysis/${runId}/progress`,
      cancel_url: `/api/analysis/${runId}/cancel`
    }, 202); // 202 Accepted

  } catch (error: any) {
    console.error('[AnalyzeInstagramLead] Error:', error);

    if (error.message.includes('Insufficient credits')) {
      return errorResponse(c, 'Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    if (error.message.includes('already in progress')) {
      return errorResponse(c, 'Analysis already in progress for this profile', 'DUPLICATE_ANALYSIS', 409);
    }

    return errorResponse(c, 'Failed to start analysis', 'ANALYSIS_ERROR', 500);
  }
}

/**
 * GET /api/analysis/:runId/progress
 * Get current analysis progress
 */
export async function getAnalysisProgress(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Get progress from Durable Object
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const response = await progressDO.fetch('http://do/progress');
    const progress = await response.json();

    if (!progress) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    // Verify ownership (progress should have account_id, but we'll check DB)
    // TODO: Add account_id verification

    return successResponse(c, progress);

  } catch (error: any) {
    console.error('[GetAnalysisProgress] Error:', error);

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    return errorResponse(c, 'Failed to get progress', 'PROGRESS_ERROR', 500);
  }
}

/**
 * POST /api/analysis/:runId/cancel
 * Cancel running analysis
 */
export async function cancelAnalysis(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Cancel via Durable Object
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const response = await progressDO.fetch('http://do/cancel', {
      method: 'POST'
    });

    const result = await response.json();

    if (!result.success) {
      return errorResponse(c, 'Failed to cancel analysis', 'CANCEL_ERROR', 500);
    }

    // TODO: Also signal workflow to stop (workflow cancellation)
    // This would require workflow instance reference

    return successResponse(c, {
      run_id: runId,
      status: 'cancelled',
      message: 'Analysis cancelled successfully'
    });

  } catch (error: any) {
    console.error('[CancelAnalysis] Error:', error);

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    if (error.message.includes('already complete')) {
      return errorResponse(c, 'Cannot cancel completed analysis', 'ALREADY_COMPLETE', 400);
    }

    return errorResponse(c, 'Failed to cancel analysis', 'CANCEL_ERROR', 500);
  }
}

/**
 * GET /api/analysis/:runId/result
 * Get final analysis result (once complete)
 */
export async function getAnalysisResult(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // First check progress to see if complete
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const progressResponse = await progressDO.fetch('http://do/progress');
    const progress = await progressResponse.json();

    if (!progress) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    if (progress.status !== 'complete') {
      return errorResponse(
        c,
        `Analysis is ${progress.status}. Use /progress endpoint to track.`,
        'NOT_COMPLETE',
        425 // Too Early
      );
    }

    // Get full result from database
    const { SupabaseClientFactory } = await import('@/infrastructure/database/supabase.client');
    const { AnalysisRepository } = await import('@/infrastructure/database/repositories/analysis.repository');
    
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const analysisRepo = new AnalysisRepository(supabase);
    
    const analysis = await analysisRepo.getByRunId(runId);

    if (!analysis) {
      return errorResponse(c, 'Analysis result not found', 'NOT_FOUND', 404);
    }

    // Verify ownership
    if (analysis.account_id !== auth.primaryAccountId) {
      return errorResponse(c, 'Not authorized to view this analysis', 'FORBIDDEN', 403);
    }

    return successResponse(c, {
      run_id: runId,
      lead_id: analysis.lead_id,
      analysis_id: analysis.id,
      status: analysis.status,
      analysis_type: analysis.analysis_type,
      overall_score: analysis.overall_score,
      niche_fit_score: analysis.niche_fit_score,
      engagement_score: analysis.engagement_score,
      confidence_level: analysis.confidence_level,
      summary_text: analysis.summary_text,
      credits_charged: analysis.credits_used,
      actual_cost: analysis.actual_cost,
      completed_at: analysis.completed_at,
      created_at: analysis.created_at
    });

  } catch (error: any) {
    console.error('[GetAnalysisResult] Error:', error);
    return errorResponse(c, 'Failed to get analysis result', 'RESULT_ERROR', 500);
  }
}
