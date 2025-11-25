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

    // Step 6a: Initialize progress DO IMMEDIATELY (before workflow)
    // This ensures SSE connections can establish successfully with existing state
    // CRITICAL: Prevents race condition where frontend SSE connects before DO is initialized
    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);

    try {
      await progressDO.fetch('http://do/initialize', {
        method: 'POST',
        body: JSON.stringify({
          run_id: runId,
          account_id: auth.accountId,
          username: input.username,
          analysis_type: input.analysisType
        })
      });

      console.log(`[Analyze][${requestId}] Progress tracker initialized`);
    } catch (error: any) {
      console.error(`[Analyze][${requestId}] Failed to initialize progress:`, error.message);
      throw new Error('Failed to initialize progress tracker');
    }

    // Step 6b: NOW trigger workflow (workflow no longer needs to initialize DO)
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
 * GET /api/analysis/:runId/stream
 * Stream analysis progress via Server-Sent Events (SSE)
 *
 * Real-time alternative to polling /progress endpoint.
 * Automatically closes when analysis completes or fails.
 *
 * ARCHITECTURE: Creates its own SSE stream with built-in heartbeat,
 * polling the DO for updates. This is more robust than forwarding the
 * DO's stream directly, as it maintains keep-alive during long operations.
 *
 * NOTE: No authentication required - the cryptographically random runId
 * serves as implicit authentication (only the user who initiated the request knows it).
 */
export async function streamAnalysisProgress(c: Context<{ Bindings: Env }>) {
  try {
    const runId = c.req.param('runId');

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    console.log('[SSE] Starting stream:', runId);

    const progressId = c.env.ANALYSIS_PROGRESS.idFromName(runId);
    const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);

    // Track stream state
    let isStreamClosed = false;
    let lastProgress = -1;
    let lastStatus = '';
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    const encoder = new TextEncoder();

    // Create our own SSE stream with heartbeat
    const stream = new ReadableStream({
      start: async (controller) => {
        // Helper to send SSE event
        const sendEvent = (eventType: string, data: object) => {
          if (isStreamClosed) return;
          try {
            const event = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(event));
          } catch (e) {
            // Stream might be closed
          }
        };

        // Helper to send heartbeat comment (keeps connection alive)
        const sendHeartbeat = () => {
          if (isStreamClosed) return;
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch (e) {
            // Stream might be closed
          }
        };

        // Initial SSE comment to establish stream
        controller.enqueue(encoder.encode(': stream-start\n\n'));

        // Fetch initial state
        try {
          const response = await progressDO.fetch('http://do/progress');
          if (response.ok) {
            const progress = await response.json() as { status: string; progress: number } | null;
            if (progress) {
              lastProgress = progress.progress;
              lastStatus = progress.status;

              const eventType = progress.status === 'pending' ? 'ready' : 'progress';
              sendEvent(eventType, progress);
              console.log(`[SSE] Initial state: ${progress.status} ${progress.progress}%`);

              // If already terminal, close stream
              if (progress.status === 'complete' || progress.status === 'failed' || progress.status === 'cancelled') {
                sendEvent(progress.status, progress);
                controller.close();
                isStreamClosed = true;
                return;
              }
            }
          }
        } catch (e) {
          console.error('[SSE] Failed to fetch initial state:', e);
        }

        // Poll for updates every second
        pollInterval = setInterval(async () => {
          if (isStreamClosed) {
            if (pollInterval) clearInterval(pollInterval);
            return;
          }

          try {
            const response = await progressDO.fetch('http://do/progress');
            if (!response.ok) return;

            const progress = await response.json() as { status: string; progress: number } | null;
            if (!progress) return;

            // Only send if progress or status changed
            if (progress.progress !== lastProgress || progress.status !== lastStatus) {
              lastProgress = progress.progress;
              lastStatus = progress.status;

              sendEvent('progress', progress);

              // If terminal state, send final event and close
              if (progress.status === 'complete' || progress.status === 'failed' || progress.status === 'cancelled') {
                sendEvent(progress.status, progress);
                console.log(`[SSE] Terminal state: ${progress.status}`);

                // Clean up intervals
                if (pollInterval) clearInterval(pollInterval);
                if (heartbeatInterval) clearInterval(heartbeatInterval);
                pollInterval = null;
                heartbeatInterval = null;

                controller.close();
                isStreamClosed = true;
              }
            }
          } catch (e) {
            // Ignore polling errors, will retry next interval
          }
        }, 1000);

        // Send heartbeat every 15 seconds to keep connection alive
        heartbeatInterval = setInterval(() => {
          sendHeartbeat();
        }, 15000);
      },

      cancel: () => {
        console.log('[SSE] Client disconnected:', runId);
        isStreamClosed = true;
        if (pollInterval) clearInterval(pollInterval);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });

  } catch (error: any) {
    console.error('[SSE] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid run ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to stream progress', 'STREAM_ERROR', 500);
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

    console.log(`[ActiveAnalyses][${requestId}] Found ${activeAnalyses.length} active/recent analyses for account ${auth.accountId}`);

    // If no active analyses, return empty result immediately
    if (activeAnalyses.length === 0) {
      return successResponse(c, {
        active_count: 0,
        analyses: [],
        server_time: new Date().toISOString()
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
      analyses: analysesWithProgress,
      server_time: new Date().toISOString()
    });

  } catch (error: any) {
    console.error(`[ActiveAnalyses][${requestId}] Error:`, {
      error: error.message,
      stack: error.stack?.split('\n')[0]
    });

    return errorResponse(c, 'Failed to fetch active analyses', 'ACTIVE_ANALYSES_ERROR', 500);
  }
}
