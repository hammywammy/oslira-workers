// features/analysis/analysis.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { generateId } from '@/shared/utils/id.util';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { z } from 'zod';

/**
 * ASYNC ANALYSIS HANDLERS
 * 
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
// HELPERS
// ===============================================================================

function getCreditCost(type: 'light' | 'deep' | 'xray'): number {
  const costs = { light: 1, deep: 3, xray: 5 };
  return costs[type];
}

// ===============================================================================
// HANDLERS
// ===============================================================================

/**
 * POST /api/leads/analyze
 * Trigger async analysis workflow
 */
export async function analyzeInstagramLead(c: Context<{ Bindings: Env }>) {
  const requestId = generateId('req');
  
  try {
    // Step 1: Auth
    const auth = getAuthContext(c);

    // Step 2: Validate input
    const body = await c.req.json();
    const input = validateBody(AnalyzeLeadSchema, body);

    // Step 3: Check credits BEFORE starting workflow
    const creditsCost = getCreditCost(input.analysisType);
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const creditsRepo = new CreditsRepository(supabase);
    
    const hasCredits = await creditsRepo.hasSufficientCredits(
      auth.accountId,
      creditsCost
    );
    
    if (!hasCredits) {
      console.warn(`[Analyze][${requestId}] Insufficient credits`, {
        accountId: auth.accountId,
        required: creditsCost
      });
      return errorResponse(c, 'Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    // Step 4: Generate run ID
    const runId = generateId('run');

    // Step 5: Trigger workflow
    const workflowParams = {
      run_id: runId,
      account_id: auth.accountId,
      business_profile_id: input.businessProfileId,
      username: input.username,
      analysis_type: input.analysisType,
      requested_at: new Date().toISOString()
    };
    
    await c.env.ANALYSIS_WORKFLOW.create({ params: workflowParams });

    console.log(`[Analyze][${requestId}] Started`, {
      runId,
      username: input.username,
      type: input.analysisType,
      credits: creditsCost
    });

    return successResponse(c, {
      run_id: runId,
      status: 'processing',
      message: 'Analysis started',
      progress_url: `/api/analysis/${runId}/progress`,
      cancel_url: `/api/analysis/${runId}/cancel`
    }, 202);

  } catch (error: any) {
    console.error(`[Analyze][${requestId}] Failed:`, {
      error: error.message,
      stack: error.stack?.split('\n')[0]
    });

    if (error.message.includes('Insufficient credits')) {
      return errorResponse(c, 'Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    if (error.message.includes('already in progress')) {
      return errorResponse(c, 'Analysis already in progress', 'DUPLICATE_ANALYSIS', 409);
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
    validateBody(GetProgressParamsSchema, { runId });

    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const response = await progressDO.fetch('http://do/progress');
    const progress = await response.json();

    if (!progress) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    return successResponse(c, progress);

  } catch (error: any) {
    console.error('[Progress] Error:', { error: error.message });

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
    validateBody(GetProgressParamsSchema, { runId });

    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const response = await progressDO.fetch('http://do/cancel', {
      method: 'POST'
    });

    const result = await response.json();

    if (!result.success) {
      return errorResponse(c, 'Failed to cancel analysis', 'CANCEL_ERROR', 500);
    }

    console.log(`[Cancel] Success:`, { runId });

    return successResponse(c, {
      run_id: runId,
      status: 'cancelled',
      message: 'Analysis cancelled successfully'
    });

  } catch (error: any) {
    console.error('[Cancel] Error:', { error: error.message });

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
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
    validateBody(GetProgressParamsSchema, { runId });

    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    const progressResponse = await progressDO.fetch('http://do/progress');
    const progress = await progressResponse.json();

    if (!progress || progress.status !== 'complete') {
      return c.json({
        success: false,
        error: 'Analysis still processing',
        code: 'TOO_EARLY',
        status: progress?.status,
        progress: progress?.progress
      }, 425);
    }

    return successResponse(c, {
      run_id: runId,
      status: 'complete',
      result: progress.result || {}
    });

  } catch (error: any) {
    console.error('[Result] Error:', { error: error.message });

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    return errorResponse(c, 'Failed to get result', 'RESULT_ERROR', 500);
  }
}
