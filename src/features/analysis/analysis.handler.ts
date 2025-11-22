// features/analysis/analysis.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { generateId } from '@/shared/utils/id.util';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { AnalysisRepository } from '@/infrastructure/database/repositories/analysis.repository';
import { LeadsRepository } from '@/infrastructure/database/repositories/leads.repository';
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
  analysisType: z.enum(['light'])
});

const GetProgressParamsSchema = z.object({
  runId: z.string().startsWith('run_')
});

// ===============================================================================
// HELPERS
// ===============================================================================

function getCreditCost(type: 'light'): number {
  return 1;
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

    // Step 3.5: Check for existing in-progress analysis BEFORE creating any records
    const leadsRepo = new LeadsRepository(supabase);
    const analysisRepo = new AnalysisRepository(supabase);

    const existingLead = await leadsRepo.findByUsername(
      auth.accountId,
      input.businessProfileId,
      input.username
    );

    if (existingLead) {
      const inProgressAnalysis = await analysisRepo.findInProgressAnalysis(
        existingLead.id,
        auth.accountId
      );

      if (inProgressAnalysis) {
        console.warn(`[Analyze][${requestId}] Analysis already in progress`, {
          accountId: auth.accountId,
          username: input.username,
          existingRunId: inProgressAnalysis.run_id
        });
        return c.json({
          success: false,
          error: 'Analysis already in progress for this profile',
          code: 'DUPLICATE_ANALYSIS',
          run_id: inProgressAnalysis.run_id
        }, 409);
      }
    }

    // Step 4: Generate run ID
    const runId = generateId('run');

    // Step 5: Create placeholder database records BEFORE triggering workflow
    // This allows getActiveAnalyses to immediately find the analysis when frontend polls

    // Create/get lead record (upsert pattern - returns existing if already exists)
    const leadResult = await leadsRepo.upsertLead({
      account_id: auth.accountId,
      business_profile_id: input.businessProfileId,
      username: input.username,
      follower_count: 0,
      following_count: 0,
      post_count: 0,
      is_verified: false,
      is_private: false,
      is_business_account: false
    });

    // Create analysis record with status: 'pending'
    await analysisRepo.createAnalysis({
      run_id: runId,
      lead_id: leadResult.lead_id,
      account_id: auth.accountId,
      business_profile_id: input.businessProfileId,
      analysis_type: input.analysisType,
      status: 'pending'
    });

    console.log(`[Analyze][${requestId}] Created placeholder records`, {
      leadId: leadResult.lead_id,
      runId,
      isNewLead: leadResult.is_new
    });

    // Step 6: Trigger workflow
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
      username: input.username,
      analysis_type: input.analysisType,
      status: 'queued',
      message: 'Analysis queued successfully'
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

    // Check if response is valid before parsing
    if (!response.ok || response.status === 404) {
      return errorResponse(c, 'Analysis progress not available yet', 'NOT_FOUND', 404);
    }

    const progress = await response.json();

    // Handle case where DO hasn't initialized yet (returns null)
    if (!progress) {
      return errorResponse(c, 'Analysis progress not available yet', 'NOT_FOUND', 404);
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

/**
 * GET /api/analysis/active
 * Get all active analyses for the authenticated user
 * Returns aggregated progress for all pending/processing analyses
 */
export async function getActiveAnalyses(c: Context<{ Bindings: Env }>) {
  const requestId = generateId('req');

  try {
    const auth = getAuthContext(c);

    // Query database for active analyses
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const analysisRepo = new AnalysisRepository(supabase);
    const activeAnalyses = await analysisRepo.getActiveAnalyses(auth.accountId);

    console.log(`[ActiveAnalyses][${requestId}] Found ${activeAnalyses.length} active analyses for account ${auth.accountId}`);

    // If no active analyses, return empty result immediately
    if (activeAnalyses.length === 0) {
      return successResponse(c, {
        active_count: 0,
        analyses: []
      });
    }

    // Helper to parse step from current_step string (e.g., "Step 2/4: Checking cache" -> {current: 2, total: 4})
    const parseStep = (currentStep: string): { current: number; total: number } => {
      const match = currentStep?.match(/Step (\d+)\/(\d+)/);
      if (match) {
        return {
          current: parseInt(match[1], 10),
          total: parseInt(match[2], 10)
        };
      }
      // Default to step 0 of 4 if parsing fails
      return { current: 0, total: 4 };
    };

    // Fetch progress from each DO in parallel
    const progressPromises = activeAnalyses.map(async (analysis) => {
      try {
        const progressId = c.env.ANALYSIS_PROGRESS.idFromName(analysis.run_id);
        const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);

        const response = await progressDO.fetch('http://do/progress');
        const progress = await response.json();

        // Transform to match frontend's expected AnalysisJob interface
        return {
          runId: analysis.run_id,
          username: progress?.username || null,
          analysisType: analysis.analysis_type,
          // Map 'processing' status to 'analyzing' for frontend
          status: (progress?.status || analysis.status) === 'processing' ? 'analyzing' : (progress?.status || analysis.status),
          progress: progress?.progress || 0,
          // Parse current_step string into step object with current and total
          step: parseStep(progress?.current_step || 'Step 0/4: Initializing'),
          startedAt: analysis.started_at,
          updatedAt: progress?.updated_at || analysis.updated_at
        };
      } catch (error: any) {
        console.error(`[ActiveAnalyses][${requestId}] Failed to fetch progress for ${analysis.run_id}:`, error.message);

        // Return basic info from database if DO fetch fails
        return {
          runId: analysis.run_id,
          username: null,
          analysisType: analysis.analysis_type,
          status: analysis.status === 'processing' ? 'analyzing' : analysis.status,
          progress: 0,
          step: { current: 0, total: 4 },
          startedAt: analysis.started_at,
          updatedAt: analysis.updated_at
        };
      }
    });

    const analysesWithProgress = await Promise.all(progressPromises);

    console.log(`[ActiveAnalyses][${requestId}] Returning ${analysesWithProgress.length} analyses with progress`);

    return successResponse(c, {
      active_count: analysesWithProgress.length,
      analyses: analysesWithProgress
    });

  } catch (error: any) {
    console.error(`[ActiveAnalyses][${requestId}] Error:`, {
      error: error.message,
      stack: error.stack?.split('\n')[0]
    });

    return errorResponse(c, 'Failed to fetch active analyses', 'ACTIVE_ANALYSES_ERROR', 500);
  }
}
