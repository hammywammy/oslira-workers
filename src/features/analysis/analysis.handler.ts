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
 * WITH COMPREHENSIVE LOGGING FOR DEBUGGING
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
// HANDLERS
// ===============================================================================

/**
 * POST /api/leads/analyze
 * Trigger async analysis workflow
 */
export async function analyzeInstagramLead(c: Context<{ Bindings: Env }>) {
  const requestId = generateId('req');
  const startTime = Date.now();
  
  console.log(`[AnalyzeInstagramLead][${requestId}] START`, {
    method: c.req.method,
    path: c.req.path,
    timestamp: new Date().toISOString()
  });

  try {
    // Step 1: Get auth context
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 1: Extracting auth context`);
    const auth = getAuthContext(c);
    console.log(`[AnalyzeInstagramLead][${requestId}] Auth context extracted:`, {
      userId: auth.userId,
      accountId: auth.accountId,
      email: auth.email,
      onboardingCompleted: auth.onboardingCompleted
    });

    // Step 2: Parse request body
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 2: Parsing request body`);
    const body = await c.req.json();
    console.log(`[AnalyzeInstagramLead][${requestId}] Raw body:`, body);

    // Step 3: Validate input
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 3: Validating input`);
    const input = validateBody(AnalyzeLeadSchema, body);
    console.log(`[AnalyzeInstagramLead][${requestId}] Validation passed:`, {
      username: input.username,
      businessProfileId: input.businessProfileId,
      analysisType: input.analysisType
    });

    // Step 4: Generate run ID
    const runId = generateId('run');
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 4: Generated run_id: ${runId}`);

    // Step 5: Check environment bindings
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 5: Checking environment bindings`);
    if (!c.env.ANALYSIS_WORKFLOW) {
      console.error(`[AnalyzeInstagramLead][${requestId}] CRITICAL: ANALYSIS_WORKFLOW binding missing`);
      throw new Error('ANALYSIS_WORKFLOW binding not configured');
    }
    if (!c.env.ANALYSIS_PROGRESS) {
      console.error(`[AnalyzeInstagramLead][${requestId}] CRITICAL: ANALYSIS_PROGRESS binding missing`);
      throw new Error('ANALYSIS_PROGRESS binding not configured');
    }
    console.log(`[AnalyzeInstagramLead][${requestId}] Environment bindings OK`);

    // Step 6: Trigger workflow
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 6: Triggering ANALYSIS_WORKFLOW`);
    const workflowParams = {
      run_id: runId,
      account_id: auth.accountId,
      business_profile_id: input.businessProfileId,
      username: input.username,
      analysis_type: input.analysisType,
      requested_at: new Date().toISOString()
    };
    console.log(`[AnalyzeInstagramLead][${requestId}] Workflow params:`, workflowParams);
    
    try {
      const instance = await c.env.ANALYSIS_WORKFLOW.create({
        params: workflowParams
      });
      console.log(`[AnalyzeInstagramLead][${requestId}] Workflow created successfully:`, {
        instanceId: instance.id
      });
    } catch (workflowError: any) {
      console.error(`[AnalyzeInstagramLead][${requestId}] Workflow creation failed:`, {
        error: workflowError.message,
        stack: workflowError.stack,
        params: workflowParams
      });
      throw new Error(`Workflow creation failed: ${workflowError.message}`);
    }

    // Step 7: Initialize progress tracker
    console.log(`[AnalyzeInstagramLead][${requestId}] Step 7: Initializing progress tracker`);
    try {
      const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
      console.log(`[AnalyzeInstagramLead][${requestId}] Progress ID generated:`, {
        progressId: progressId.toString()
      });
      
      const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
      console.log(`[AnalyzeInstagramLead][${requestId}] Progress DO instance obtained`);
      
      const progressPayload = {
        run_id: runId,
        account_id: auth.accountId,
        username: input.username,
        analysis_type: input.analysisType
      };
      console.log(`[AnalyzeInstagramLead][${requestId}] Progress payload:`, progressPayload);
      
      const progressResponse = await progressDO.fetch('http://do/initialize', {
        method: 'POST',
        body: JSON.stringify(progressPayload)
      });
      
      console.log(`[AnalyzeInstagramLead][${requestId}] Progress tracker initialized:`, {
        status: progressResponse.status,
        statusText: progressResponse.statusText
      });
      
      if (!progressResponse.ok) {
        const errorText = await progressResponse.text();
        console.error(`[AnalyzeInstagramLead][${requestId}] Progress init failed:`, {
          status: progressResponse.status,
          error: errorText
        });
        throw new Error(`Progress initialization failed: ${errorText}`);
      }
    } catch (progressError: any) {
      console.error(`[AnalyzeInstagramLead][${requestId}] Progress tracker error:`, {
        error: progressError.message,
        stack: progressError.stack
      });
      throw new Error(`Progress tracker failed: ${progressError.message}`);
    }

    // Step 8: Success response
    const elapsed = Date.now() - startTime;
    console.log(`[AnalyzeInstagramLead][${requestId}] SUCCESS - Analysis started`, {
      runId,
      elapsed: `${elapsed}ms`,
      username: input.username,
      analysisType: input.analysisType
    });

    return successResponse(c, {
      run_id: runId,
      status: 'processing',
      message: 'Analysis started. Use GET /api/analysis/:runId/progress to track progress.',
      progress_url: `/api/analysis/${runId}/progress`,
      cancel_url: `/api/analysis/${runId}/cancel`
    }, 202); // 202 Accepted

  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error(`[AnalyzeInstagramLead][${requestId}] ERROR after ${elapsed}ms:`, {
      error: error.message,
      stack: error.stack,
      name: error.name
    });

    // Specific error handling
    if (error.message.includes('Insufficient credits')) {
      console.log(`[AnalyzeInstagramLead][${requestId}] Error type: INSUFFICIENT_CREDITS`);
      return errorResponse(c, 'Insufficient credits', 'INSUFFICIENT_CREDITS', 402);
    }

    if (error.message.includes('already in progress')) {
      console.log(`[AnalyzeInstagramLead][${requestId}] Error type: DUPLICATE_ANALYSIS`);
      return errorResponse(c, 'Analysis already in progress for this profile', 'DUPLICATE_ANALYSIS', 409);
    }

    if (error.message.includes('binding not configured')) {
      console.log(`[AnalyzeInstagramLead][${requestId}] Error type: CONFIGURATION_ERROR`);
      return errorResponse(c, 'Service configuration error', 'CONFIGURATION_ERROR', 500);
    }

    console.log(`[AnalyzeInstagramLead][${requestId}] Error type: ANALYSIS_ERROR (generic)`);
    return errorResponse(c, 'Failed to start analysis', 'ANALYSIS_ERROR', 500);
  }
}

/**
 * GET /api/analysis/:runId/progress
 * Get current analysis progress
 */
export async function getAnalysisProgress(c: Context<{ Bindings: Env }>) {
  const requestId = generateId('req');
  console.log(`[GetAnalysisProgress][${requestId}] START`);

  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    console.log(`[GetAnalysisProgress][${requestId}] Request:`, {
      runId,
      userId: auth.userId
    });

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });
    console.log(`[GetAnalysisProgress][${requestId}] RunId validated`);

    // Get progress from Durable Object
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    console.log(`[GetAnalysisProgress][${requestId}] Fetching progress from DO`);
    const response = await progressDO.fetch('http://do/progress');
    const progress = await response.json();

    console.log(`[GetAnalysisProgress][${requestId}] Progress:`, progress);

    if (!progress) {
      console.log(`[GetAnalysisProgress][${requestId}] Analysis not found`);
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    // Verify ownership (progress should have account_id, but we'll check DB)
    // TODO: Add account_id verification

    console.log(`[GetAnalysisProgress][${requestId}] SUCCESS`);
    return successResponse(c, progress);

  } catch (error: any) {
    console.error(`[GetAnalysisProgress][${requestId}] ERROR:`, {
      error: error.message,
      stack: error.stack
    });

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
  const requestId = generateId('req');
  console.log(`[CancelAnalysis][${requestId}] START`);

  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    console.log(`[CancelAnalysis][${requestId}] Request:`, {
      runId,
      userId: auth.userId
    });

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Cancel via Durable Object
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    console.log(`[CancelAnalysis][${requestId}] Sending cancel request to DO`);
    const response = await progressDO.fetch('http://do/cancel', {
      method: 'POST'
    });

    const result = await response.json();
    console.log(`[CancelAnalysis][${requestId}] Cancel result:`, result);

    if (!result.success) {
      console.log(`[CancelAnalysis][${requestId}] Cancel failed`);
      return errorResponse(c, 'Failed to cancel analysis', 'CANCEL_ERROR', 500);
    }

    // TODO: Also signal workflow to stop (workflow cancellation)
    // This would require workflow instance reference

    console.log(`[CancelAnalysis][${requestId}] SUCCESS`);
    return successResponse(c, {
      run_id: runId,
      status: 'cancelled',
      message: 'Analysis cancelled successfully'
    });

  } catch (error: any) {
    console.error(`[CancelAnalysis][${requestId}] ERROR:`, {
      error: error.message,
      stack: error.stack
    });

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
  const requestId = generateId('req');
  console.log(`[GetAnalysisResult][${requestId}] START`);

  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    console.log(`[GetAnalysisResult][${requestId}] Request:`, {
      runId,
      userId: auth.userId
    });

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Get progress first to check status
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
    
    console.log(`[GetAnalysisResult][${requestId}] Checking progress`);
    const progressResponse = await progressDO.fetch('http://do/progress');
    const progress = await progressResponse.json();

    console.log(`[GetAnalysisResult][${requestId}] Progress status:`, {
      status: progress?.status,
      progress: progress?.progress
    });

    if (!progress || progress.status !== 'complete') {
      console.log(`[GetAnalysisResult][${requestId}] Analysis not complete yet`);
      return c.json({
        success: false,
        error: 'Analysis still processing',
        code: 'TOO_EARLY',
        status: progress?.status,
        progress: progress?.progress
      }, 425); // 425 Too Early
    }

    // TODO: Fetch actual result from database
    console.log(`[GetAnalysisResult][${requestId}] SUCCESS (TODO: fetch from DB)`);
    return successResponse(c, {
      run_id: runId,
      status: 'complete',
      result: progress.result || {}
    });

  } catch (error: any) {
    console.error(`[GetAnalysisResult][${requestId}] ERROR:`, {
      error: error.message,
      stack: error.stack
    });

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Analysis not found', 'NOT_FOUND', 404);
    }

    return errorResponse(c, 'Failed to get result', 'RESULT_ERROR', 500);
  }
}
