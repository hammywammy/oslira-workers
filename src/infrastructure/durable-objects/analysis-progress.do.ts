// infrastructure/durable-objects/analysis-progress.do.ts

import { DurableObject } from 'cloudflare:workers';
import type { AnalysisProgressState } from '@/shared/types/env.types';

/**
 * ANALYSIS PROGRESS DURABLE OBJECT
 * 
 * Manages real-time progress tracking for analysis runs
 * 
 * Features:
 * - Real-time progress updates (0-100%)
 * - Cancellation support
 * - WebSocket subscriptions for live updates (future)
 * - Automatic cleanup after 24 hours
 * 
 * Usage:
 * - Workflow updates progress as it executes steps
 * - Frontend polls GET /api/analysis/:runId/progress
 * - User can POST /api/analysis/:runId/cancel to stop
 */

export class AnalysisProgressDO extends DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  /**
   * Handle HTTP requests to this Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      // POST /initialize - Initialize progress state (CRITICAL FIX: Added this route)
      if (method === 'POST' && url.pathname === '/initialize') {
        console.log('[AnalysisProgressDO] Initializing progress tracker');
        const params = await request.json();
        console.log('[AnalysisProgressDO] Initialize params:', params);
        await this.initialize(params);
        return Response.json({ success: true });
      }

      // GET /progress - Get current progress
      if (method === 'GET' && url.pathname === '/progress') {
        const progress = await this.getProgress();
        return Response.json(progress);
      }

      // POST /update - Update progress (called by workflow)
      if (method === 'POST' && url.pathname === '/update') {
        const update = await request.json();
        await this.updateProgress(update);
        return Response.json({ success: true });
      }

      // POST /cancel - Cancel analysis
      if (method === 'POST' && url.pathname === '/cancel') {
        await this.cancelAnalysis();
        return Response.json({ success: true, cancelled: true });
      }

      // POST /complete - Mark as complete (called by workflow)
      if (method === 'POST' && url.pathname === '/complete') {
        const result = await request.json();
        await this.completeAnalysis(result);
        return Response.json({ success: true });
      }

      // POST /fail - Mark as failed (called by workflow)
      if (method === 'POST' && url.pathname === '/fail') {
        const error = await request.json();
        await this.failAnalysis(error.message);
        return Response.json({ success: true });
      }

      console.warn('[AnalysisProgressDO] Unknown route:', method, url.pathname);
      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error: any) {
      console.error('[AnalysisProgressDO] Error:', {
        method,
        path: url.pathname,
        error: error.message,
        stack: error.stack
      });
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  /**
   * Initialize progress state
   */
  async initialize(params: {
    run_id: string;
    account_id: string;
    username: string;
    analysis_type: string;
  }): Promise<void> {
    console.log('[AnalysisProgressDO] Creating initial state:', params);
    
    const initialState: AnalysisProgressState = {
      run_id: params.run_id,
      account_id: params.account_id,
      username: params.username,
      analysis_type: params.analysis_type,
      status: 'pending',
      progress: 0,
      current_step: 'Initializing analysis',
      total_steps: 10, // Will vary by analysis type
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', initialState);
    console.log('[AnalysisProgressDO] Initial state saved to storage');
    
    // Set automatic cleanup alarm (24 hours)
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    console.log('[AnalysisProgressDO] Cleanup alarm set for 24 hours');
  }

  /**
   * Get current progress
   */
  async getProgress(): Promise<AnalysisProgressState | null> {
    return await this.state.storage.get<AnalysisProgressState>('progress');
  }

  /**
   * Update progress
   */
  async updateProgress(update: {
    progress: number;
    current_step: string;
    status?: 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  }): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    // Check if cancelled
    if (current.status === 'cancelled') {
      throw new Error('Analysis cancelled by user');
    }

    const updated: AnalysisProgressState = {
      ...current,
      progress: update.progress,
      current_step: update.current_step,
      status: update.status || 'processing',
      updated_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', updated);
  }

  /**
   * Cancel analysis
   */
  async cancelAnalysis(): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    // Can only cancel if not already complete
    if (current.status === 'complete') {
      throw new Error('Cannot cancel completed analysis');
    }

    const cancelled: AnalysisProgressState = {
      ...current,
      status: 'cancelled',
      progress: current.progress, // Keep current progress
      current_step: 'Analysis cancelled by user',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', cancelled);
  }

  /**
   * Mark analysis as complete
   */
  async completeAnalysis(result: any): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    const completed: AnalysisProgressState = {
      ...current,
      status: 'complete',
      progress: 100,
      current_step: 'Analysis complete',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: {
        overall_score: result.overall_score,
        niche_fit_score: result.niche_fit_score,
        engagement_score: result.engagement_score,
        confidence_level: result.confidence_level,
        summary_text: result.summary_text,
        outreach_message: result.outreach_message
      }
    };

    await this.state.storage.put('progress', completed);
  }

  /**
   * Mark analysis as failed
   */
  async failAnalysis(errorMessage: string): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    const failed: AnalysisProgressState = {
      ...current,
      status: 'failed',
      current_step: 'Analysis failed',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: errorMessage
    };

    await this.state.storage.put('progress', failed);
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[AnalysisProgressDO] Cleaning up old progress state');
    await this.state.storage.deleteAll();
  }

  /**
   * WebSocket handler (future feature for real-time updates)
   */
  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Future: Real-time progress updates via WebSocket
    const data = JSON.parse(message);
    
    if (data.action === 'subscribe') {
      const progress = await this.getProgress();
      ws.send(JSON.stringify(progress));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Cleanup WebSocket connection
    ws.close(code, reason);
  }
}
