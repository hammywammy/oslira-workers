// features/onboarding/onboarding.handler.ts

/**
 * ONBOARDING HANDLERS - FLAT STRUCTURE
 * 
 * Accepts EXACTLY what frontend sends.
 * Transforms internally for workflow processing.
 */

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextQueueMessage } from '@/shared/types/business-context.types';
import {
  GenerateContextRequestSchema,
  GetProgressParamsSchema,
  transformToWorkflowParams
} from './onboarding.schemas';
import { getAuthContext } from '@/shared/utils/auth.util';
import { validateBody } from '@/shared/utils/validation.util';
import { errorResponse } from '@/shared/utils/response.util';

/**
 * Generate UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * POST /api/business/generate-context
 * Start business context generation (async via queue)
 * 
 * Flow:
 * 1. Validate flat form data from frontend
 * 2. Transform to workflow format internally
 * 3. Generate run_id and queue for processing
 * 4. Return run_id for polling
 */
export async function generateBusinessContext(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const body = await c.req.json();

    // Validate flat structure from frontend
    const input = validateBody(GenerateContextRequestSchema, body);

    // Transform to workflow format (internal mapping)
    const workflowParams = transformToWorkflowParams(input);

    // Generate run ID
    const runId = generateUUID();

    console.log('[GenerateBusinessContext] Starting:', {
      run_id: runId,
      account_id: auth.accountId,
      signature_name: input.signature_name,
    });

    // Initialize progress tracker (Durable Object)
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    await progressDO.fetch('http://do/initialize', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        account_id: auth.accountId,
      }),
    });

    // Queue message for async processing
    const message: BusinessContextQueueMessage = {
      run_id: runId,
      account_id: auth.accountId,
      user_inputs: workflowParams, // Send transformed data to workflow
      requested_at: new Date().toISOString(),
    };

    await c.env.BUSINESS_CONTEXT_QUEUE.send(message);

    console.log('[GenerateBusinessContext] Queued successfully:', runId);

    // Return immediately (202 Accepted)
    return c.json(
      {
        success: true,
        data: {
          run_id: runId,
          status: 'queued',
          message: 'Business context generation started. Use progress_url to track status.',
          progress_url: `/api/business/generate-context/${runId}/progress`,
        },
      },
      202
    );
  } catch (error: any) {
    console.error('[GenerateBusinessContext] Error:', error);

    if (error.name === 'ZodError') {
      return c.json(
        {
          error: 'Validation failed',
          message: 'Please check your form data',
          details: error.errors,
        },
        400
      );
    }

    return errorResponse(c, 'Failed to start generation', 'GENERATION_ERROR', 500);
  }
}

/**
 * GET /api/business/generate-context/:runId/progress
 * Get current generation progress
 */
export async function getGenerationProgress(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    // Validate runId format (UUID)
    validateBody(GetProgressParamsSchema, { runId });

    // Get progress from Durable Object
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    const response = await progressDO.fetch('http://do/progress');
    const data = await response.json();

    return c.json(data, 200);
  } catch (error: any) {
    console.error('[GetGenerationProgress] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid run ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'Failed to get progress', 'PROGRESS_ERROR', 500);
  }
}

/**
 * GET /api/business/generate-context/:runId/result
 * Get final generation result (when complete)
 */
export async function getGenerationResult(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const runId = c.req.param('runId');

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Get result from Durable Object
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    const response = await progressDO.fetch('http://do/result');
    const data = await response.json();

    if (!data.result) {
      return c.json(
        {
          error: 'Generation not complete',
          message: 'Context generation is still in progress. Check /progress endpoint.',
        },
        404
      );
    }

    return c.json(data, 200);
  } catch (error: any) {
    console.error('[GetGenerationResult] Error:', error);
    return errorResponse(c, 'Failed to get result', 'RESULT_ERROR', 500);
  }
}

/**
 * GET /api/business/generate-context/:runId/ws
 * WebSocket proxy to Durable Object for real-time progress updates.
 *
 * Uses WebSocket Hibernation API for cost efficiency.
 * Forwards WebSocket upgrade request directly to DO.
 *
 * NOTE: No authentication required - the cryptographically random runId UUID
 * serves as implicit authentication (only the user who initiated the request knows it).
 */
export async function streamBusinessContextWebSocket(c: Context<{ Bindings: Env }>) {
  try {
    const runId = c.req.param('runId');

    // Validate WebSocket upgrade
    if (c.req.header('Upgrade') !== 'websocket') {
      return errorResponse(c, 'Expected WebSocket upgrade', 'BAD_REQUEST', 400);
    }

    // Validate runId format (UUID)
    validateBody(GetProgressParamsSchema, { runId });

    console.log('[WebSocket] Proxying to BusinessContextProgressDO:', runId);

    // Get DO stub
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    // Build DO URL with runId parameter
    const url = new URL(c.req.url);
    url.pathname = '/ws';
    url.searchParams.set('runId', runId);

    // Forward upgrade request to DO
    return await progressDO.fetch(url.toString(), {
      headers: c.req.raw.headers
    });

  } catch (error: any) {
    console.error('[WebSocket] BusinessContext proxy error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Invalid run ID', 'VALIDATION_ERROR', 400);
    }

    return errorResponse(c, 'WebSocket connection failed', 'WEBSOCKET_ERROR', 500);
  }
}
