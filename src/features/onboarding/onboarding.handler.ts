// features/onboarding/onboarding.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { BusinessContextQueueMessage } from '@/shared/types/business-context.types';
import { GenerateContextRequestSchema, GetProgressParamsSchema } from './onboarding.schemas';
import { getAuthContext } from '@/shared/utils/auth.util';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/business/generate-context
 * Start business context generation (async via queue)
 */
export async function generateBusinessContext(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const body = await c.req.json();

    // Validate request body
    const input = validateBody(GenerateContextRequestSchema, body);

    // Generate run ID
    const runId = uuidv4();

    console.log('[GenerateBusinessContext] Starting:', {
      run_id: runId,
      account_id: auth.primaryAccountId,
      business_name: input.user_inputs.business_name
    });

    // Initialize progress tracker (Durable Object)
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    await progressDO.fetch('http://do/initialize', {
      method: 'POST',
      body: JSON.stringify({
        run_id: runId,
        account_id: auth.primaryAccountId
      })
    });

    // Queue message for async processing
    const message: BusinessContextQueueMessage = {
      run_id: runId,
      account_id: auth.primaryAccountId,
      user_inputs: input.user_inputs,
      requested_at: new Date().toISOString()
    };

    await c.env.BUSINESS_CONTEXT_QUEUE.send(message);

    console.log('[GenerateBusinessContext] Queued successfully:', runId);

    // Return immediately (202 Accepted)
    return c.json({
      success: true,
      data: {
        run_id: runId,
        status: 'queued',
        message: 'Business context generation started. Use progress_url to track status.',
        progress_url: `/api/business/generate-context/${runId}/progress`
      }
    }, 202);

  } catch (error: any) {
    console.error('[GenerateBusinessContext] Error:', error);

    if (error.name === 'ZodError') {
      return errorResponse(c, 'Validation failed', 'VALIDATION_ERROR', 400);
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

    // Validate runId format
    validateBody(GetProgressParamsSchema, { runId });

    // Get progress from Durable Object
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    const response = await progressDO.fetch('http://do/progress');
    const progress = await response.json();

    if (!progress) {
      return errorResponse(c, 'Generation not found', 'NOT_FOUND', 404);
    }

    // Verify ownership (basic security check)
    if (progress.account_id !== auth.primaryAccountId) {
      return errorResponse(c, 'Unauthorized', 'UNAUTHORIZED', 403);
    }

    return successResponse(c, progress);

  } catch (error: any) {
    console.error('[GetGenerationProgress] Error:', error);

    if (error.message.includes('not found')) {
      return errorResponse(c, 'Generation not found', 'NOT_FOUND', 404);
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

    // Get progress from Durable Object
    const progressId = c.env.BUSINESS_CONTEXT_PROGRESS.idFromName(runId);
    const progressDO = c.env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    const response = await progressDO.fetch('http://do/progress');
    const progress = await response.json();

    if (!progress) {
      return errorResponse(c, 'Generation not found', 'NOT_FOUND', 404);
    }

    // Verify ownership
    if (progress.account_id !== auth.primaryAccountId) {
      return errorResponse(c, 'Unauthorized', 'UNAUTHORIZED', 403);
    }

    // Check if complete
    if (progress.status !== 'complete') {
      return errorResponse(
        c,
        `Generation not complete. Current status: ${progress.status}`,
        'NOT_COMPLETE',
        409
      );
    }

    return successResponse(c, {
      run_id: runId,
      status: 'complete',
      completed_at: progress.completed_at,
      result: progress.result
    });

  } catch (error: any) {
    console.error('[GetGenerationResult] Error:', error);
    return errorResponse(c, 'Failed to get result', 'RESULT_ERROR', 500);
  }
}
