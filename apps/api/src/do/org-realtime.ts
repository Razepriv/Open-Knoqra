import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { REALTIME_USER_HEADER, type RealtimeMessage } from '../lib/realtime';

/**
 * Fan-out hub for one organization (keyed `idFromName(orgId)`). Sockets use the hibernation API,
 * so an idle org costs nothing. The Worker route authenticates the caller and checks membership
 * before forwarding; this object is reachable only through its binding, never from the internet.
 *
 * Sockets are send-only from the server's side: the client's `ping` is answered by the runtime's
 * auto-response, and any other client frame is ignored. Nothing a client sends is trusted.
 */
export class OrgRealtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const userId = request.headers.get(REALTIME_USER_HEADER);
    if (!userId) return new Response('Missing user.', { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Sends `message` to every connected socket, or with `userId` only to that user's sockets (each
   * socket is tagged with its user when accepted), and returns how many it reached.
   */
  async broadcast(message: RealtimeMessage, userId?: string): Promise<number> {
    const frame = JSON.stringify(message);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.send(frame);
        sent += 1;
      } catch (error) {
        // A socket closing mid-broadcast must not stop the others.
        logger.warn('realtime.send_failed', { error });
      }
    }
    return sent;
  }

  /** Client frames carry no authority; only the auto-responded `ping` has a meaning. */
  override async webSocketMessage(): Promise<void> {
    // Deliberately ignored.
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    closeQuietly(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    closeQuietly(ws, 1011);
  }
}

/** Completes the close handshake; 1005/1006 are reserved and may not be sent, so map them to 1000. */
function closeQuietly(ws: WebSocket, code: number): void {
  const sendable = code === 1005 || code === 1006 ? 1000 : code;
  try {
    ws.close(sendable, 'closing');
  } catch {
    // Already closed: nothing to do.
  }
}
