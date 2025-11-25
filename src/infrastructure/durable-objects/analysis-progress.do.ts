// infrastructure/durable-objects/analysis-progress.do.ts

import { DurableObject } from 'cloudflare:workers';
import type { AnalysisProgressState } from '@/shared/types/env.types';

/**
 * ANALYSIS PROGRESS DURABLE OBJECT
 *
 * Manages real-time progress tracking for analysis runs using WebSocket Hibernation API.
 *
 * Features:
 * - Real-time progress updates via WebSocket (0-100%)
 * - Hibernation support for cost efficiency (DO sleeps when idle)
 * - Cancellation support
 * - Automatic cleanup after 24 hours
 * - HTTP fallback endpoints for polling
 *
 * Architecture:
 * - Frontend connects via WebSocket → Worker proxy → DO WebSocket server
 * - Workflow updates progress → DO broadcasts to all connected WebSocket clients
 * - Uses ctx.getWebSockets() for hibernation-safe WebSocket management
 */

export class AnalysisProgressDO extends DurableObject {
  private state: DurableObjectState;
  private lastLoggedState: string | null = null; // For change detection

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
      // =========================================================================
      // WEBSOCKET UPGRADE HANDLER
      // =========================================================================
      if (request.headers.get('Upgrade') === 'websocket') {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Accept with hibernation support (CRITICAL - enables DO to sleep)
        this.ctx.acceptWebSocket(server);

        // Attach runId metadata (survives hibernation, must be <2KB)
        const runId = url.searchParams.get('runId');
        if (runId) {
          server.serializeAttachment({ runId, connectedAt: Date.now() });
        }

        console.log('[AnalysisProgressDO] WebSocket connected:', runId);

        // Send initial progress immediately
        const progress = await this.getProgress();
        if (progress) {
          const eventType = progress.status === 'pending' ? 'ready' : 'progress';
          server.send(JSON.stringify({ type: eventType, data: progress }));

          // If already terminal state, send that too
          if (progress.status === 'complete' || progress.status === 'failed' || progress.status === 'cancelled') {
            server.send(JSON.stringify({ type: progress.status, data: progress }));
          }
        }

        return new Response(null, { status: 101, webSocket: client });
      }

      // =========================================================================
      // HTTP ENDPOINTS (fallback & workflow communication)
      // =========================================================================

      // POST /initialize - Initialize progress state (CRITICAL FIX: Added this route)
      if (method === 'POST' && url.pathname === '/initialize') {
        console.log('[AnalysisProgressDO] Initializing progress tracker');
        const params = await request.json();
        console.log('[AnalysisProgressDO] Initialize params:', params);
        await this.initialize(params);
        return Response.json({ success: true });
      }

      // GET /progress - Get current progress (HTTP polling fallback)
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
        stack: error.stack?.split('\n')[0]
      });
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // ===========================================================================
  // WEBSOCKET HIBERNATION HANDLERS
  // ===========================================================================

  /**
   * Called when WebSocket receives a message (hibernation-safe)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);
      const attachment = ws.deserializeAttachment() as { runId?: string } | null;

      if (data.action === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (data.action === 'get_progress') {
        const progress = await this.getProgress();
        ws.send(JSON.stringify({ type: 'progress', data: progress }));
      }
    } catch (error: any) {
      console.error('[AnalysisProgressDO] WebSocket message error:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }

  /**
   * Called when WebSocket closes (hibernation-safe)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as { runId?: string } | null;
    console.log('[AnalysisProgressDO] WebSocket closed', {
      runId: attachment?.runId,
      code,
      wasClean
    });
  }

  /**
   * Called when WebSocket errors (hibernation-safe)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as { runId?: string } | null;
    console.error('[AnalysisProgressDO] WebSocket error:', {
      runId: attachment?.runId,
      error
    });
  }

  // ===========================================================================
  // BROADCAST METHOD (HIBERNATION-SAFE)
  // ===========================================================================

  /**
   * Broadcast progress update to all connected WebSocket clients
   * Uses ctx.getWebSockets() which is hibernation-safe
   */
  private broadcastProgress(
    progress: AnalysisProgressState,
    eventType: 'ready' | 'progress' | 'complete' | 'failed' | 'cancelled' = 'progress'
  ): void {
    const message = JSON.stringify({ type: eventType, data: progress });

    // Get ALL connected WebSockets (hibernation-safe)
    const sockets = this.ctx.getWebSockets();

    if (sockets.length === 0) {
      console.log(`[AnalysisProgressDO] No WebSocket clients connected (event: ${eventType}, progress: ${progress.progress}%)`);
      return;
    }

    console.log(`[AnalysisProgressDO] Broadcasting ${eventType} (${progress.progress}%) to ${sockets.length} client(s)`);

    sockets.forEach(ws => {
      try {
        ws.send(message);
      } catch (error: any) {
        console.error('[AnalysisProgressDO] Send failed:', error.message);
      }
    });
  }

  // ===========================================================================
  // PROGRESS STATE METHODS
  // ===========================================================================

  /**
   * Initialize progress state
   */
  async initialize(params: {
    run_id: string;
    account_id: string;
    username: string;
    analysis_type: string;
  }): Promise<void> {
    console.log(`[AnalysisProgressDO][${params.run_id}] Initializing with params:`, {
      run_id: params.run_id,
      account_id: params.account_id,
      username: params.username,
      analysis_type: params.analysis_type
    });

    const initialState: AnalysisProgressState = {
      run_id: params.run_id,
      account_id: params.account_id,
      username: params.username,
      analysis_type: params.analysis_type,
      status: 'pending',
      progress: 0,
      current_step: 'Initializing analysis',
      total_steps: 10,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', initialState);
    console.log(`[AnalysisProgressDO][${params.run_id}] State saved to storage successfully`);

    // Broadcast "ready" event to any WebSocket clients waiting
    this.broadcastProgress(initialState, 'ready');
    console.log(`[AnalysisProgressDO][${params.run_id}] Broadcasted ready event`);

    // Set automatic cleanup alarm (24 hours)
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    console.log(`[AnalysisProgressDO][${params.run_id}] Cleanup alarm set for 24 hours`);
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
      console.error('[AnalysisProgressDO] Update called but progress not initialized!', update);
      throw new Error('Progress not initialized');
    }

    console.log(`[AnalysisProgressDO][${current.run_id}] Updating progress: ${update.progress}% - ${update.current_step}`);

    // Check if cancelled
    if (current.status === 'cancelled') {
      console.warn(`[AnalysisProgressDO][${current.run_id}] Analysis already cancelled`);
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
    console.log(`[AnalysisProgressDO][${current.run_id}] Progress updated successfully`);

    // Broadcast to all WebSocket clients
    this.broadcastProgress(updated);
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

    // Broadcast cancellation to all WebSocket clients
    this.broadcastProgress(cancelled, 'cancelled');
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
        summary_text: result.summary_text
      }
    };

    await this.state.storage.put('progress', completed);

    // Broadcast completion to all WebSocket clients
    this.broadcastProgress(completed, 'complete');
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

    // Broadcast failure to all WebSocket clients
    this.broadcastProgress(failed, 'failed');
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[AnalysisProgressDO] Cleaning up old progress state');

    // Close all active WebSocket connections before cleanup
    const sockets = this.ctx.getWebSockets();
    sockets.forEach(ws => {
      try {
        ws.close(1000, 'DO cleanup - session expired');
      } catch (error: any) {
        console.error('[AnalysisProgressDO] Error closing WebSocket:', error.message);
      }
    });

    await this.state.storage.deleteAll();
  }
}
