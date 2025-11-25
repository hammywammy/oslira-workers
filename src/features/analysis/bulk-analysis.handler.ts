// features/analysis/bulk-analysis.handler.ts

import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { getAuthContext } from '@/shared/middleware/auth.middleware';
import { validateBody } from '@/shared/utils/validation.util';
import { successResponse, errorResponse } from '@/shared/utils/response.util';
import { generateId } from '@/shared/utils/id.util';
import { z } from 'zod';

/**
 * BULK ANALYSIS HANDLER
 * 
 * Allows users to analyze multiple profiles at once
 * 
 * Features:
 * - Submit array of usernames (max 50 per batch)
 * - All analyses queued asynchronously
 * - Returns batch tracking ID
 * - Individual run IDs for each analysis
 * - Track batch progress
 * 
 * Use case: Analyze 20 prospects at once instead of one-by-one
 */

// ===============================================================================
// REQUEST SCHEMAS
// ===============================================================================

const BulkAnalyzeSchema = z.object({
  usernames: z.array(z.string().min(1).max(50)).min(1).max(50),
  businessProfileId: z.string().uuid(),
  analysisType: z.enum(['light', 'deep'])
});

const BatchProgressSchema = z.object({
  batchId: z.string().startsWith('batch_')
});

// ===============================================================================
// HANDLERS
// ===============================================================================

/**
 * POST /api/leads/analyze/bulk
 * Queue multiple analyses
 */
export async function bulkAnalyzeLeads(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const body = await c.req.json();

    // Validate input
    const input = validateBody(BulkAnalyzeSchema, body);

    // Check for duplicates in request
    const uniqueUsernames = [...new Set(input.usernames)];
    if (uniqueUsernames.length !== input.usernames.length) {
      return errorResponse(c, 'Duplicate usernames in request', 'DUPLICATE_USERNAMES', 400);
    }

    // Verify business profile exists and user has access
    // TODO: Add business profile validation

    // Check credits (estimate)
    const creditCost = 1; // Light analysis only
    const totalCreditsNeeded = uniqueUsernames.length * creditCost;

    // TODO: Check if user has sufficient credits
    // For now, just validate

    // Generate batch ID
    const batchId = generateId('batch');

    // Queue all analyses with batch processing
    const analyses: Array<{
      run_id: string;
      username: string;
      status: 'queued' | 'failed';
    }> = [];

    // Use BatchProcessor for intelligent batching (Apify limit: 10 concurrent)
    const { BatchProcessor } = await import('@/infrastructure/batch/batch-processor.service');
    const processor = new BatchProcessor({
      batchSize: 10,      // 10 profiles per batch
      maxConcurrent: 1,   // Sequential batches (Apify constraint)
      retryAttempts: 3,
      retryDelay: 5000
    });

    // Process usernames in batches
    const summary = await processor.processBatch(
      uniqueUsernames,
      async (username) => {
        const runId = generateId('run');

        // Trigger workflow for each username
        await c.env.ANALYSIS_WORKFLOW.create({
          params: {
            run_id: runId,
            account_id: auth.primaryAccountId,
            business_profile_id: input.businessProfileId,
            username: username,
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
            username: username,
            analysis_type: input.analysisType
          })
        });

        return { run_id: runId, username };
      },
      (completed, total) => {
        console.log(`[BulkAnalysis] Progress: ${completed}/${total}`);
      }
    );

    // Collect results
    for (const result of summary.results) {
      if (result.result.success && result.result.data) {
        analyses.push({
          run_id: result.result.data.run_id,
          username: result.result.data.username,
          status: 'queued'
        });
      } else {
        analyses.push({
          run_id: 'failed',
          username: result.item,
          status: 'failed'
        });
      }
    }

    // Store batch metadata in KV for progress tracking
    await c.env.OSLIRA_KV.put(
      `batch:${batchId}`,
      JSON.stringify({
        batch_id: batchId,
        account_id: auth.primaryAccountId,
        business_profile_id: input.businessProfileId,
        analysis_type: input.analysisType,
        total_count: uniqueUsernames.length,
        analyses: analyses,
        created_at: new Date().toISOString()
      }),
      {
        expirationTtl: 7 * 24 * 60 * 60 // Expire after 7 days
      }
    );

    const successCount = analyses.filter(a => a.status === 'queued').length;
    const failedCount = analyses.filter(a => a.status === 'failed').length;

    return successResponse(c, {
      batch_id: batchId,
      total_count: uniqueUsernames.length,
      queued: successCount,
      failed: failedCount,
      analyses: analyses.map(a => ({
        username: a.username,
        run_id: a.run_id,
        status: a.status,
        progress_url: a.status === 'queued' ? `/api/analysis/${a.run_id}/progress` : null
      })),
      batch_progress_url: `/api/leads/analyze/bulk/${batchId}/progress`,
      message: `${successCount} analyses queued successfully${failedCount > 0 ? `, ${failedCount} failed` : ''}`
    }, 202); // 202 Accepted

  } catch (error: any) {
    console.error('[BulkAnalysis] Error:', error);

    if (error.message.includes('Insufficient credits')) {
      return errorResponse(c, 'Insufficient credits for bulk analysis', 'INSUFFICIENT_CREDITS', 402);
    }

    return errorResponse(c, 'Failed to queue bulk analysis', 'BULK_ANALYSIS_ERROR', 500);
  }
}

/**
 * GET /api/leads/analyze/bulk/:batchId/progress
 * Track batch progress
 */
export async function getBatchProgress(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const batchId = c.req.param('batchId');

    // Validate batchId format
    validateBody(BatchProgressSchema, { batchId });

    // Get batch metadata from KV
    const batchData = await c.env.OSLIRA_KV.get(`batch:${batchId}`, 'json');

    if (!batchData) {
      return errorResponse(c, 'Batch not found or expired', 'NOT_FOUND', 404);
    }

    const batch = batchData as any;

    // Verify ownership
    if (batch.account_id !== auth.primaryAccountId) {
      return errorResponse(c, 'Unauthorized', 'UNAUTHORIZED', 403);
    }

    // Get progress for each analysis
    const analysesWithProgress = await Promise.all(
      batch.analyses.map(async (analysis: any) => {
        if (analysis.status === 'failed' || analysis.run_id === 'failed') {
          return {
            username: analysis.username,
            run_id: analysis.run_id,
            status: 'failed',
            progress: 0
          };
        }

        try {
          const progressId = c.env.ANALYSIS_PROGRESS.idFromName(analysis.run_id);
          const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
          
          const response = await progressDO.fetch('http://do/progress');
          const progress = await response.json();

          return {
            username: analysis.username,
            run_id: analysis.run_id,
            status: progress.status,
            progress: progress.progress,
            current_step: progress.current_step
          };
        } catch (error) {
          return {
            username: analysis.username,
            run_id: analysis.run_id,
            status: 'unknown',
            progress: 0
          };
        }
      })
    );

    // Calculate batch statistics
    const statusCounts = {
      pending: 0,
      processing: 0,
      complete: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0
    };

    let totalProgress = 0;

    for (const analysis of analysesWithProgress) {
      const status = analysis.status as keyof typeof statusCounts;
      if (status in statusCounts) {
        statusCounts[status]++;
      }
      totalProgress += analysis.progress || 0;
    }

    const overallProgress = Math.floor(totalProgress / batch.total_count);
    const isComplete = statusCounts.complete === batch.total_count;
    const hasFailures = statusCounts.failed > 0;

    return successResponse(c, {
      batch_id: batchId,
      analysis_type: batch.analysis_type,
      total_count: batch.total_count,
      overall_progress: overallProgress,
      is_complete: isComplete,
      status_counts: statusCounts,
      analyses: analysesWithProgress,
      created_at: batch.created_at,
      message: isComplete
        ? 'Batch analysis complete'
        : `${statusCounts.complete}/${batch.total_count} analyses complete`
    });

  } catch (error: any) {
    console.error('[BulkAnalysis] Progress error:', error);
    return errorResponse(c, 'Failed to get batch progress', 'PROGRESS_ERROR', 500);
  }
}

/**
 * POST /api/leads/analyze/bulk/:batchId/cancel
 * Cancel entire batch
 */
export async function cancelBatch(c: Context<{ Bindings: Env }>) {
  try {
    const auth = getAuthContext(c);
    const batchId = c.req.param('batchId');

    // Validate batchId format
    validateBody(BatchProgressSchema, { batchId });

    // Get batch metadata from KV
    const batchData = await c.env.OSLIRA_KV.get(`batch:${batchId}`, 'json');

    if (!batchData) {
      return errorResponse(c, 'Batch not found or expired', 'NOT_FOUND', 404);
    }

    const batch = batchData as any;

    // Verify ownership
    if (batch.account_id !== auth.primaryAccountId) {
      return errorResponse(c, 'Unauthorized', 'UNAUTHORIZED', 403);
    }

    // Cancel all in-progress analyses
    let cancelledCount = 0;

    for (const analysis of batch.analyses) {
      if (analysis.status === 'failed' || analysis.run_id === 'failed') {
        continue;
      }

      try {
        const progressId = c.env.ANALYSIS_PROGRESS.idFromName(analysis.run_id);
        const progressDO = c.env.ANALYSIS_PROGRESS.get(progressId);
        
        await progressDO.fetch('http://do/cancel', {
          method: 'POST'
        });

        cancelledCount++;
      } catch (error) {
        console.error(`[BulkAnalysis] Failed to cancel ${analysis.run_id}:`, error);
      }
    }

    return successResponse(c, {
      batch_id: batchId,
      cancelled: cancelledCount,
      total: batch.total_count,
      message: `Cancelled ${cancelledCount}/${batch.total_count} analyses`
    });

  } catch (error: any) {
    console.error('[BulkAnalysis] Cancel error:', error);
    return errorResponse(c, 'Failed to cancel batch', 'CANCEL_ERROR', 500);
  }
}
