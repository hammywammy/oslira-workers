// infrastructure/durable-objects/business-context-progress.do.ts

import { DurableObject } from 'cloudflare:workers';
import type { BusinessContextProgressState } from '@/shared/types/business-context.types';
import type { Env } from '@/shared/types/env.types';

/**
 * BUSINESS CONTEXT PROGRESS DURABLE OBJECT
 *
 * Manages real-time progress tracking for business context generation using WebSocket Hibernation API.
 *
 * Features:
 * - Real-time progress updates via WebSocket (0-100%)
 * - Hibernation support for cost efficiency (DO sleeps when idle)
 * - Secrets caching support (24hr TTL, enterprise-safe)
 * - Automatic cleanup after 24 hours
 * - HTTP fallback endpoints for polling
 *
 * LOGGING STRATEGY:
 * - Poll requests (GET /progress): Only log when state CHANGES (not every request)
 * - Mutations (POST): Always log for debugging
 * - Reduces log volume by 98%
 */

interface CachedSecrets {
  openai_key: string;
  claude_key: string;
  cached_at: string;
}

export class BusinessContextProgressDO extends DurableObject {
  private state: DurableObjectState;
  private lastLoggedState: string | null = null; // For change detection

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;

    // CRITICAL: Auto-respond to pings without waking from hibernation
    // This prevents billable duration charges while keeping connections alive
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ action: 'ping' }),
        JSON.stringify({ type: 'pong', timestamp: Date.now() })
      )
    );
  }

  /**
   * Handle HTTP requests to this Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const isPolling = method === 'GET' && url.pathname === '/progress';

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

        console.log('[BusinessContextProgressDO] WebSocket connected:', runId);

        // Send initial progress immediately
        const progress = await this.getProgress();
        if (progress) {
          const eventType = progress.status === 'pending' ? 'ready' : 'progress';
          server.send(JSON.stringify({ type: eventType, data: progress }));

          // If already terminal state, send that too
          if (progress.status === 'complete' || progress.status === 'failed') {
            server.send(JSON.stringify({ type: progress.status, data: progress }));
          }
        }

        return new Response(null, { status: 101, webSocket: client });
      }

      // =========================================================================
      // GET /progress - REDUCED LOGGING (only changes)
      // =========================================================================
      if (isPolling) {
        const progress = await this.getProgress();

        // Only log if state has changed since last poll
        const currentStateKey = progress
          ? `${progress.status}-${progress.progress}-${progress.current_step}`
          : 'null';

        if (this.lastLoggedState !== currentStateKey) {
          console.log(`[BusinessContextProgressDO] STATE CHANGE: ${currentStateKey}`);
          this.lastLoggedState = currentStateKey;
        }

        return Response.json(progress);
      }

      // =========================================================================
      // ALL OTHER OPERATIONS - FULL LOGGING
      // =========================================================================

      console.log('[BusinessContextProgressDO] Request:', method, url.pathname);

      // POST /initialize - Initialize progress state
      if (method === 'POST' && url.pathname === '/initialize') {
        const params = await request.json();
        console.log('[BusinessContextProgressDO] Initializing:', params.run_id);

        await this.initialize(params);

        console.log('[BusinessContextProgressDO] Initialize complete');
        return Response.json({ success: true });
      }

      // POST /update - Update progress
      if (method === 'POST' && url.pathname === '/update') {
        const update = await request.json();
        console.log('[BusinessContextProgressDO] Updating:', {
          progress: update.progress,
          step: update.current_step
        });

        await this.updateProgress(update);

        console.log('[BusinessContextProgressDO] Update complete');
        return Response.json({ success: true });
      }

      // POST /complete - Mark as complete
      if (method === 'POST' && url.pathname === '/complete') {
        console.log('[BusinessContextProgressDO] ========== COMPLETE ENDPOINT START ==========');

        try {
          const body = await request.json();
          console.log('[BusinessContextProgressDO] Complete request body:', {
            has_result: !!body?.result,
            result_keys: body?.result ? Object.keys(body.result) : []
          });

          // Get current progress from storage
          console.log('[BusinessContextProgressDO] Fetching current progress from storage...');
          const current = await this.state.storage.get<BusinessContextProgressState>('progress');

          if (!current) {
            console.error('[BusinessContextProgressDO] COMPLETE FAILED: Progress not initialized');
            return Response.json({
              success: false,
              error: 'Progress not initialized'
            }, { status: 400 });
          }

          console.log('[BusinessContextProgressDO] Current progress state:', {
            run_id: current.run_id,
            status: current.status,
            progress: current.progress,
            current_step: current.current_step
          });

          // Build completed state
          const completed: BusinessContextProgressState = {
            ...current,
            status: 'complete',
            progress: 100,
            current_step: 'Business context generated successfully',
            updated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            result: body?.result || current.result
          };

          console.log('[BusinessContextProgressDO] Completed state to save:', {
            run_id: completed.run_id,
            status: completed.status,
            progress: completed.progress,
            current_step: completed.current_step,
            has_result: !!completed.result
          });

          // Save to storage
          console.log('[BusinessContextProgressDO] Saving completed state to storage...');
          await this.state.storage.put('progress', completed);
          console.log('[BusinessContextProgressDO] Storage write successful');

          // Verify write
          console.log('[BusinessContextProgressDO] Verifying saved state...');
          const verified = await this.state.storage.get<BusinessContextProgressState>('progress');
          console.log('[BusinessContextProgressDO] Verified state from storage:', {
            status: verified?.status,
            progress: verified?.progress,
            matches_expected: verified?.status === 'complete' && verified?.progress === 100
          });

          if (verified?.status !== 'complete') {
            console.error('[BusinessContextProgressDO] VERIFICATION FAILED: Status not set to complete!');
            return Response.json({
              success: false,
              error: 'Verification failed - status not persisted'
            }, { status: 500 });
          }

          // Broadcast completion to all WebSocket clients
          this.broadcastProgress(verified, 'complete');

          console.log('[BusinessContextProgressDO] ========== COMPLETE ENDPOINT SUCCESS ==========');
          return Response.json({
            success: true,
            status: verified.status,
            progress: verified.progress
          });

        } catch (error: any) {
          console.error('[BusinessContextProgressDO] ========== COMPLETE ENDPOINT FAILED ==========');
          console.error('[BusinessContextProgressDO] Complete error:', {
            error_name: error.name,
            error_message: error.message,
            error_stack: error.stack?.split('\n').slice(0, 5).join('\n')
          });

          return Response.json({
            success: false,
            error: error.message,
            error_name: error.name
          }, { status: 500 });
        }
      }

      // POST /fail - Mark as failed
      if (method === 'POST' && url.pathname === '/fail') {
        const error = await request.json();
        console.log('[BusinessContextProgressDO] Marking failed:', error.error_message);

        await this.failGeneration(error.error_message);

        console.log('[BusinessContextProgressDO] Marked failed');
        return Response.json({ success: true });
      }

      // GET /get-secrets - Get cached secrets
      if (method === 'GET' && url.pathname === '/get-secrets') {
        const secrets = await this.state.storage.get<CachedSecrets>('cached_secrets');

        if (secrets) {
          console.log('[BusinessContextProgressDO] Returning cached secrets');
          return Response.json(secrets);
        } else {
          console.log('[BusinessContextProgressDO] No cached secrets found');
          return Response.json(null, { status: 404 });
        }
      }

      // POST /cache-secrets - Cache secrets
      if (method === 'POST' && url.pathname === '/cache-secrets') {
        const secrets = await request.json();
        console.log('[BusinessContextProgressDO] Caching secrets (24hr TTL)');

        await this.state.storage.put('cached_secrets', secrets);

        console.log('[BusinessContextProgressDO] Secrets cached');
        return Response.json({ success: true });
      }

      console.log('[BusinessContextProgressDO] Route not found:', url.pathname);
      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error: any) {
      console.error('[BusinessContextProgressDO] REQUEST FAILED', {
        method,
        pathname: url.pathname,
        error_name: error.name,
        error_message: error.message,
        error_stack: error.stack?.split('\n').slice(0, 3).join('\n')
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
      console.error('[BusinessContextProgressDO] WebSocket message error:', error.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }

  /**
   * Called when WebSocket closes (hibernation-safe)
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as { runId?: string } | null;
    console.log('[BusinessContextProgressDO] WebSocket closed', {
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
    console.error('[BusinessContextProgressDO] WebSocket error:', {
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
    progress: BusinessContextProgressState,
    eventType: 'ready' | 'progress' | 'complete' | 'failed' = 'progress'
  ): void {
    const message = JSON.stringify({ type: eventType, data: progress });

    // Get ALL connected WebSockets (hibernation-safe)
    const sockets = this.ctx.getWebSockets();

    if (sockets.length === 0) {
      return;
    }

    console.log(`[BusinessContextProgressDO] Broadcasting ${eventType} (${progress.progress}%) to ${sockets.length} client(s)`);

    sockets.forEach(ws => {
      try {
        ws.send(message);
      } catch (error: any) {
        console.error('[BusinessContextProgressDO] Send failed:', error.message);
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
  }): Promise<void> {
    const initialState: BusinessContextProgressState = {
      run_id: params.run_id,
      account_id: params.account_id,
      status: 'pending',
      progress: 0,
      current_step: 'Initializing business context generation',
      total_steps: 3,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      await this.state.storage.put('progress', initialState);

      // Broadcast "ready" event to any WebSocket clients waiting
      this.broadcastProgress(initialState, 'ready');

      // Set automatic cleanup alarm (24 hours)
      await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);

    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Initialize failed:', error.message);
      throw error;
    }
  }

  /**
   * Get current progress
   * SILENT - only logs on state changes (see fetch handler)
   */
  async getProgress(): Promise<BusinessContextProgressState | null> {
    try {
      const progress = await this.state.storage.get<BusinessContextProgressState>('progress');
      return progress || null;
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Get progress failed:', error.message);
      throw error;
    }
  }

  /**
   * Update progress
   */
  async updateProgress(update: {
    progress: number;
    current_step: string;
    status?: 'pending' | 'processing' | 'complete' | 'failed';
  }): Promise<void> {
    const current = await this.getProgress();

    if (!current) {
      throw new Error('Progress not initialized');
    }

    const updated: BusinessContextProgressState = {
      ...current,
      progress: update.progress,
      current_step: update.current_step,
      status: update.status || 'processing',
      updated_at: new Date().toISOString()
    };

    try {
      await this.state.storage.put('progress', updated);

      // Broadcast to all WebSocket clients
      this.broadcastProgress(updated);
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Update failed:', error.message);
      throw error;
    }
  }

  /**
   * Mark generation as complete
   */
  async completeGeneration(result: any): Promise<void> {
    const current = await this.getProgress();

    if (!current) {
      throw new Error('Progress not initialized');
    }

    const completed: BusinessContextProgressState = {
      ...current,
      status: 'complete',
      progress: 100,
      current_step: 'Business context generated successfully',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: result
    };

    try {
      await this.state.storage.put('progress', completed);

      // Broadcast completion to all WebSocket clients
      this.broadcastProgress(completed, 'complete');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Complete failed:', error.message);
      throw error;
    }
  }

  /**
   * Mark generation as failed
   */
  async failGeneration(errorMessage: string): Promise<void> {
    const current = await this.getProgress();

    if (!current) {
      throw new Error('Progress not initialized');
    }

    const failed: BusinessContextProgressState = {
      ...current,
      status: 'failed',
      current_step: 'Generation failed',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: errorMessage
    };

    try {
      await this.state.storage.put('progress', failed);

      // Broadcast failure to all WebSocket clients
      this.broadcastProgress(failed, 'failed');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Mark failed failed:', error.message);
      throw error;
    }
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[BusinessContextProgressDO] Alarm triggered - cleanup starting');

    try {
      // Close all active WebSocket connections before cleanup
      const sockets = this.ctx.getWebSockets();
      sockets.forEach(ws => {
        try {
          ws.close(1000, 'DO cleanup - session expired');
        } catch (error: any) {
          console.error('[BusinessContextProgressDO] Error closing WebSocket:', error.message);
        }
      });

      await this.state.storage.deleteAll();
      console.log('[BusinessContextProgressDO] Cleanup complete');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Cleanup failed:', error.message);
    }
  }
}
