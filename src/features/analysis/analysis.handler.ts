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
import { getCreditCost, getCreditType, type AnalysisType } from '@/config/operations-pricing.config';
import { logger } from '@/shared/utils/logger.util';

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
  analysisType: z.enum(['light', 'deep'])
});

const GetProgressParamsSchema = z.object({
  runId: z.string().startsWith('run_')
});

// ===============================================================================
// HELPERS
// ===============================================================================

// getCreditCost is now imported from @/config/operations-pricing.config

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

    // Step 3: Check credit balance BEFORE starting workflow
    // MODULAR: Uses analysis type to route to correct credit type
    const analysisType = input.analysisType as AnalysisType;
    const analysisCost = getCreditCost(analysisType);
    const creditType = getCreditType(analysisType);
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const creditsRepo = new CreditsRepository(supabase);

    const hasBalance = await creditsRepo.hasSufficientBalanceForAnalysis(
      auth.accountId,
      analysisType,
      analysisCost
    );

    if (!hasBalance) {
      logger.warn('Insufficient balance for analysis', {
        requestId,
        accountId: auth.accountId,
        analysisType,
        creditType,
        required: analysisCost
      });
      return errorResponse(c, `Insufficient ${creditType.replace('_', ' ')} balance`, 'INSUFFICIENT_BALANCE', 402);
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
        logger.warn('Analysis already in progress for profile', {
          requestId,
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

    logger.info('Created placeholder records for analysis', {
      requestId,
      leadId: leadResult.lead_id,
      runId,
      isNewLead: leadResult.is_new
    });

    // Step 6: Trigger workflow (using global broadcaster for progress updates)
    const workflowParams = {
      run_id: runId,
      account_id: auth.accountId,
      business_profile_id: input.businessProfileId,
      username: input.username,
      analysis_type: input.analysisType,
      requested_at: new Date().toISOString()
    };

    await c.env.ANALYSIS_WORKFLOW.create({ params: workflowParams });

    logger.info('Analysis workflow started', {
      requestId,
      runId,
      username: input.username,
      analysisType: input.analysisType,
      analysisCost
    });

    return successResponse(c, {
      run_id: runId,
      username: input.username,
      analysis_type: input.analysisType,
      status: 'queued',
      message: 'Analysis queued successfully'
    }, 202);

  } catch (error) {
    logger.error('Failed to start analysis', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    if (error instanceof Error && error.message.includes('Insufficient') && error.message.includes('balance')) {
      return errorResponse(c, error.message, 'INSUFFICIENT_BALANCE', 402);
    }

    if (error instanceof Error && error.message.includes('already in progress')) {
      return errorResponse(c, 'Analysis already in progress', 'DUPLICATE_ANALYSIS', 409);
    }

    return errorResponse(c, 'Failed to start analysis', 'ANALYSIS_ERROR', 500);
  }
}

/**
 * NOTE: Old per-analysis progress endpoints removed.
 * Progress is now tracked via global WebSocket broadcaster (/api/analysis/ws)
 * and database queries (/api/analysis/active).
 */

/**
 * POST /api/internal/broadcast
 * Internal endpoint called by Workflows to broadcast progress updates
 *
 * SECURITY: This is called by Workflows (internal), not by external clients.
 * In production, add IP whitelist or internal auth token.
 */
export async function internalBroadcast(c: Context<{ Bindings: Env }>) {
  try {
    const { accountId, type, runId, data } = await c.req.json();

    if (!accountId || !type || !runId || !data) {
      return errorResponse(c, 'Missing required fields', 'INVALID_INPUT', 400);
    }

    // Get broadcaster DO for this account
    const broadcasterId = c.env.GLOBAL_BROADCASTER.idFromName(accountId);
    const broadcasterDO = c.env.GLOBAL_BROADCASTER.get(broadcasterId);

    // Forward broadcast request to DO
    await broadcasterDO.fetch('http://do/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        runId,
        data,
        timestamp: Date.now()
      })
    });

    return successResponse(c, { broadcasted: true });
  } catch (error) {
    logger.error('[InternalBroadcast] Failed', { error });
    return errorResponse(c, 'Broadcast failed', 'BROADCAST_ERROR', 500);
  }
}

/**
 * GET /api/analysis/ws
 * Global WebSocket connection for ALL analysis progress updates
 *
 * Frontend connects ONCE to this endpoint, receives updates for ALL analyses.
 */
export async function globalWebSocketUpgrade(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);

    // Upgrade to WebSocket
    const upgradeHeader = c.req.header('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return errorResponse(c, 'Expected WebSocket', 'INVALID_REQUEST', 400);
    }

    // Get broadcaster DO for this account
    const broadcasterId = c.env.GLOBAL_BROADCASTER.idFromName(auth.accountId);
    const broadcasterDO = c.env.GLOBAL_BROADCASTER.get(broadcasterId);

    // Proxy WebSocket upgrade to DO
    return broadcasterDO.fetch(
      `http://do/websocket?accountId=${auth.accountId}`,
      {
        headers: c.req.raw.headers
      }
    );
  } catch (error) {
    logger.error('[GlobalWebSocket] Upgrade failed', { error });
    return errorResponse(c, 'WebSocket upgrade failed', 'WEBSOCKET_ERROR', 500);
  }
}

/**
 * GET /api/analysis/active
 * Get all active analyses for the authenticated user
 * Returns aggregated progress for all pending/processing analyses
 *
 * NOTE: Real-time progress updates are delivered via global WebSocket (/api/analysis/ws).
 * This endpoint provides initial state for reconnection scenarios.
 */
export async function getActiveAnalyses(c: Context<{ Bindings: Env }>) {
  const requestId = generateId('req');

  try {
    const auth = getAuthContext(c);

    // Query database for active analyses
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const analysisRepo = new AnalysisRepository(supabase);
    const activeAnalyses = await analysisRepo.getActiveAnalyses(auth.accountId);

    logger.info('Found active analyses', {
      requestId,
      count: activeAnalyses.length,
      accountId: auth.accountId
    });

    // If no active analyses, return empty result immediately
    if (activeAnalyses.length === 0) {
      return successResponse(c, {
        active_count: 0,
        analyses: [],
        server_time: new Date().toISOString()
      });
    }

    // Transform database records to frontend format
    // Progress updates will be delivered via WebSocket in real-time
    const analysesWithProgress = activeAnalyses.map((analysis) => ({
      runId: analysis.run_id,
      username: null, // Will be populated via WebSocket
      analysisType: analysis.analysis_type,
      status: analysis.status === 'processing' ? 'analyzing' : analysis.status,
      progress: 0, // Will be updated via WebSocket
      step: { current: 0, total: 3 }, // Will be updated via WebSocket
      startedAt: analysis.started_at,
      updatedAt: analysis.updated_at
    }));

    logger.info('Returning active analyses', {
      requestId,
      count: analysesWithProgress.length
    });

    return successResponse(c, {
      active_count: analysesWithProgress.length,
      analyses: analysesWithProgress,
      server_time: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to fetch active analyses', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return errorResponse(c, 'Failed to fetch active analyses', 'ACTIVE_ANALYSES_ERROR', 500);
  }
}
