// infrastructure/durable-objects/global-broadcaster.do.ts

import { DurableObject } from 'cloudflare:workers';
import { logger } from '@/shared/utils/logger.util';

/**
 * GLOBAL BROADCASTER DURABLE OBJECT
 *
 * Single Durable Object that manages ALL WebSocket connections for real-time analysis updates.
 *
 * ARCHITECTURE:
 * - ONE instance per account (named by accountId)
 * - Receives broadcast requests from Workflows via Worker proxy
 * - Broadcasts to ALL connected WebSocket clients
 * - Uses WebSocket Hibernation API for cost efficiency
 *
 * BENEFITS vs per-analysis DOs:
 * - 1 WebSocket connection total (not N connections)
 * - No hibernation disconnection issues (many connections keep it alive)
 * - 99% cost reduction
 * - Scales to unlimited concurrent analyses
 */

interface BroadcastMessage {
  type: 'analysis.progress' | 'analysis.complete' | 'analysis.failed';
  runId: string;
  data: {
    progress: number;
    step: { current: number; total: number };
    status: string;
    currentStep?: string;
    avatarUrl?: string;
    leadId?: string;
    error?: string;
  };
  timestamp: number;
}

export class GlobalBroadcasterDO extends DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    // Auto-respond to pings without waking from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'pong', timestamp: Date.now() })
      )
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // =========================================================================
    // WEBSOCKET UPGRADE - Frontend connects here
    // =========================================================================
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation support
      this.ctx.acceptWebSocket(server);

      // Attach account metadata
      const accountId = url.searchParams.get('accountId');
      if (accountId) {
        server.serializeAttachment({
          accountId,
          connectedAt: Date.now()
        });
      }

      logger.info('[GlobalBroadcaster] WebSocket connected', {
        accountId,
        totalConnections: this.ctx.getWebSockets().length
      });

      // Send ready confirmation
      server.send(JSON.stringify({
        type: 'ready',
        timestamp: Date.now()
      }));

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // =========================================================================
    // BROADCAST ENDPOINT - Worker calls this when Workflow updates progress
    // =========================================================================
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      try {
        const message: BroadcastMessage = await request.json();

        // Broadcast to ALL connected WebSockets
        const sockets = this.ctx.getWebSockets();
        let successCount = 0;
        let failCount = 0;

        sockets.forEach(ws => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(message));
              successCount++;
            }
          } catch (error) {
            failCount++;
            logger.error('[GlobalBroadcaster] Send failed', { error });
            // Remove dead socket
            ws.close(1000, 'Send failed');
          }
        });

        logger.info('[GlobalBroadcaster] Broadcast complete', {
          runId: message.runId,
          type: message.type,
          progress: message.data.progress,
          successCount,
          failCount,
          totalSockets: sockets.length
        });

        return Response.json({
          success: true,
          delivered: successCount,
          failed: failCount
        });
      } catch (error) {
        logger.error('[GlobalBroadcaster] Broadcast error', { error });
        return Response.json({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
      }
    }

    // =========================================================================
    // HEALTH CHECK
    // =========================================================================
    if (url.pathname === '/health') {
      const sockets = this.ctx.getWebSockets();
      return Response.json({
        status: 'healthy',
        connections: sockets.length,
        timestamp: Date.now()
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Hibernation-safe WebSocket handlers
  async webSocketMessage(ws: WebSocket, message: string) {
    // Handle client messages if needed (e.g., heartbeat)
    try {
      const data = JSON.parse(message);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (error) {
      logger.warn('[GlobalBroadcaster] Invalid message', { message });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const attachment = ws.deserializeAttachment() as { accountId?: string } | null;
    logger.info('[GlobalBroadcaster] WebSocket closed', {
      accountId: attachment?.accountId,
      code,
      wasClean,
      remainingConnections: this.ctx.getWebSockets().length
    });
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    logger.error('[GlobalBroadcaster] WebSocket error', { error });
  }
}
