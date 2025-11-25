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
  private lastLoggedState: string | null = null; // For change detection
  private sseConnections: Map<string, ReadableStreamDefaultController> = new Map(); // Active SSE streams

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

      // GET /stream - SSE streaming endpoint
      if (method === 'GET' && url.pathname === '/stream') {
        console.log('[AnalysisProgressDO] SSE stream connection requested');

        const connectionId = crypto.randomUUID();
        let isClosed = false;
        let heartbeatInterval: number | null = null;

        const stream = new ReadableStream({
          start: async (controller) => {
            try {
              // Store connection
              this.sseConnections.set(connectionId, controller);
              console.log(`[AnalysisProgressDO] SSE connection established: ${connectionId}`);

              // Send initial connection event
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ connectionId })}\n\n`));

              // Send current state immediately
              const currentProgress = await this.getProgress();
              if (currentProgress) {
                const progressEvent = `event: progress\ndata: ${JSON.stringify(currentProgress)}\n\n`;
                controller.enqueue(encoder.encode(progressEvent));

                // If already complete or failed, close stream
                if (currentProgress.status === 'complete' || currentProgress.status === 'failed') {
                  const completeEvent = `event: ${currentProgress.status}\ndata: ${JSON.stringify(currentProgress)}\n\n`;
                  controller.enqueue(encoder.encode(completeEvent));
                  controller.close();
                  this.sseConnections.delete(connectionId);
                  isClosed = true;
                }
              }

              // Keepalive heartbeat - prevent connection timeout
              heartbeatInterval = setInterval(() => {
                if (isClosed) {
                  if (heartbeatInterval) clearInterval(heartbeatInterval);
                  return;
                }

                try {
                  // Send comment (ignored by EventSource, keeps connection alive)
                  controller.enqueue(encoder.encode(': heartbeat\n\n'));
                } catch (error: any) {
                  console.error('[AnalysisProgressDO] Heartbeat failed:', error.message);
                  if (heartbeatInterval) clearInterval(heartbeatInterval);
                }
              }, 5000) as unknown as number; // Every 5 seconds
            } catch (error: any) {
              console.error(`[AnalysisProgressDO] SSE stream error: ${error.message}`);
              if (!isClosed) {
                controller.error(error);
                this.sseConnections.delete(connectionId);
              }
            }
          },
          cancel: () => {
            console.log(`[AnalysisProgressDO] SSE connection closed: ${connectionId}`);
            this.sseConnections.delete(connectionId);
            isClosed = true;
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);  // ADDED: Clean up heartbeat
            }
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no' // Disable nginx buffering
          }
        });
      }

      // POST /update - Update progress (called by workflow)
      if (method === 'POST' && url.pathname === '/update') {
        const update = await request.json();
        await this.updateProgress(update);

        // Broadcast update to all SSE connections
        const currentProgress = await this.getProgress();
        if (currentProgress) {
          this.broadcastToSSE(currentProgress);
        }

        return Response.json({ success: true });
      }

      // POST /cancel - Cancel analysis
      if (method === 'POST' && url.pathname === '/cancel') {
        await this.cancelAnalysis();

        // Broadcast cancellation to all SSE connections
        const currentProgress = await this.getProgress();
        if (currentProgress) {
          this.broadcastToSSE(currentProgress, 'cancelled');
        }

        return Response.json({ success: true, cancelled: true });
      }

      // POST /complete - Mark as complete (called by workflow)
      if (method === 'POST' && url.pathname === '/complete') {
        const result = await request.json();
        await this.completeAnalysis(result);

        // Broadcast completion to all SSE connections
        const currentProgress = await this.getProgress();
        if (currentProgress) {
          this.broadcastToSSE(currentProgress, 'complete');
        }

        return Response.json({ success: true });
      }

      // POST /fail - Mark as failed (called by workflow)
      if (method === 'POST' && url.pathname === '/fail') {
        const error = await request.json();
        await this.failAnalysis(error.message);

        // Broadcast failure to all SSE connections
        const currentProgress = await this.getProgress();
        if (currentProgress) {
          this.broadcastToSSE(currentProgress, 'failed');
        }

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

    // ADDED: Broadcast "ready" event to any SSE clients waiting for DO initialization
    this.broadcastToSSE(initialState, 'ready');
    console.log(`[AnalysisProgressDO][${params.run_id}] Broadcasted ready event to SSE clients`);

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
        summary_text: result.summary_text
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
   * Broadcast progress update to all active SSE connections
   */
  private broadcastToSSE(
    progress: AnalysisProgressState,
    eventType: 'ready' | 'progress' | 'complete' | 'failed' | 'cancelled' = 'progress'
  ): void {
    if (this.sseConnections.size === 0) {
      return;
    }

    const encoder = new TextEncoder();
    const event = `event: ${eventType}\ndata: ${JSON.stringify(progress)}\n\n`;
    const encoded = encoder.encode(event);

    const connectionsToRemove: string[] = [];

    this.sseConnections.forEach((controller, connectionId) => {
      try {
        controller.enqueue(encoded);

        // Close connection if complete or failed
        if (eventType === 'complete' || eventType === 'failed' || eventType === 'cancelled') {
          controller.close();
          connectionsToRemove.push(connectionId);
        }
      } catch (error: any) {
        console.error(`[AnalysisProgressDO] Failed to send to SSE connection ${connectionId}:`, error.message);
        connectionsToRemove.push(connectionId);
      }
    });

    // Clean up closed/failed connections
    connectionsToRemove.forEach(id => this.sseConnections.delete(id));

    if (connectionsToRemove.length > 0) {
      console.log(`[AnalysisProgressDO] Cleaned up ${connectionsToRemove.length} SSE connections`);
    }
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[AnalysisProgressDO] Cleaning up old progress state');

    // Close all active SSE connections before cleanup
    this.sseConnections.forEach((controller, connectionId) => {
      try {
        controller.close();
      } catch (error: any) {
        console.error(`[AnalysisProgressDO] Error closing SSE connection ${connectionId}:`, error.message);
      }
    });
    this.sseConnections.clear();

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
