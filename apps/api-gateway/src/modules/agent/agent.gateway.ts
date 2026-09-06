import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { AgentEventEmitter } from './services/agent-event.emitter';
import { AgentService } from './services/agent.service';
import { AgentSessionService } from './services/agent-session.service';
import { AgentMessageService } from './services/agent-message.service';
import { AgentPermissionService } from './services/agent-permission.service';
import { AgentRunService } from './services/agent-run.service';

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  isAlive?: boolean;
}

interface WsMessage {
  type: string;
  data?: Record<string, unknown>;
}

interface Subscription {
  eventName: string;
  handler: (...args: any[]) => void;
}

@WebSocketGateway({
  path: '/ws/agent',
  cors: {
    origin: ['http://localhost:3001', 'tauri://localhost', 'https://tauri.localhost'],
    credentials: true,
  },
})
export class AgentGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger('AgentGateway');
  private clients = new Map<string, Set<AuthenticatedSocket>>();
  private heartbeatInterval: NodeJS.Timeout;

  /**
   * Tracks EventEmitter handlers per socket. Without this, subscribe →
   * unsubscribe → subscribe accumulates stale listeners, causing events
   * to fire multiple times and degrading UI performance.
   */
  private subscriptions = new WeakMap<WebSocket, Subscription[]>();

  constructor(
    private jwtService: JwtService,
    private eventEmitter: AgentEventEmitter,
    private agentService: AgentService,
    private sessionService: AgentSessionService,
    private messageService: AgentMessageService,
    private permissionService: AgentPermissionService,
    private runService: AgentRunService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Agent WebSocket Gateway initialized');
    this.startHeartbeat();
  }

  handleConnection(client: AuthenticatedSocket, req: any) {
    try {
      // Extract token from query or headers
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token') || 
                    req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn('Client connected without token');
        client.close(4001, 'Authentication required');
        return;
      }

      const payload = this.jwtService.verify(token);
      client.userId = payload.sub || payload.userId;
      client.isAlive = true;

      this.logger.log(`Client connected: ${client.userId}`);

      // Handle pong for heartbeat
      client.on('pong', () => {
        client.isAlive = true;
      });

    } catch (error) {
      this.logger.error('Authentication failed:', error.message);
      client.close(4001, 'Invalid token');
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`Client disconnected: ${client.userId}`);
    // Remove EventEmitter listeners and subscription tracking.
    this.removeSubscriptions(client);
    // Remove from all session subscriptions.
    if (client.sessionId) {
      const clients = this.clients.get(client.sessionId);
      if (clients) {
        clients.delete(client);
        if (clients.size === 0) {
          this.clients.delete(client.sessionId);
        }
      }
      client.sessionId = undefined;
    }
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string },
  ) {
    const { sessionId } = data;
    
    if (client.sessionId) {
      this.unsubscribeFromSession(client);
    }

    client.sessionId = sessionId;
    
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId).add(client);

    this.logger.log(`Client ${client.userId} subscribed to session ${sessionId}`);

    // Subscribe to session events
    this.subscribeToSessionEvents(client, sessionId);

    return { type: 'subscribed', sessionId };
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: AuthenticatedSocket) {
    this.unsubscribeFromSession(client);
    return { type: 'unsubscribed' };
  }

  @SubscribeMessage('run')
  async handleRun(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string; message: string; workspacePath?: string; remoteProfileId?: string },
  ) {
    const { sessionId, message, workspacePath, remoteProfileId } = data;

    try {
      await this.agentService.run({
        sessionId,
        userId: client.userId!,
        message,
        workspacePath: workspacePath || process.cwd(),
        agentId: 'smoke-monkey-agent',
        remoteProfileId,
      });

      return { type: 'run_started', sessionId };
    } catch (error) {
      this.logger.error(`Run failed: ${error.message}`);
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('interrupt')
  async handleInterrupt(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string },
  ) {
    try {
      await this.agentService.interrupt(data.sessionId);
      return { type: 'interrupted', sessionId: data.sessionId };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('resolve_permission')
  async handleResolvePermission(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { toolCallId: string; effect: 'allow' | 'deny' },
  ) {
    try {
      await this.permissionService.resolvePendingRequest(data.toolCallId, data.effect);
      return { type: 'permission_resolved', toolCallId: data.toolCallId };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('resolve_ask_user')
  async handleResolveAskUser(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { toolCallId: string; answer: unknown },
  ) {
    try {
      await this.agentService.resolveAskUser(data.toolCallId, String(data.answer));
      return { type: 'ask_user_resolved', toolCallId: data.toolCallId };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('get_messages')
  async handleGetMessages(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string },
  ) {
    try {
      const messages = await this.messageService.findBySession(data.sessionId);
      return { type: 'messages', data: messages };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('get_state')
  async handleGetState(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { sessionId: string; runId?: string },
  ) {
    try {
      // If runId is provided, fetch the persisted AgentState from DB.
      if (data.runId) {
        const state = await this.runService.getCheckpoint(data.runId);
        return { type: 'state', data: state };
      }
      // Otherwise check if there's an active run on this session.
      const active = this.agentService.getState(data.sessionId);
      return { type: 'state', data: active };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  @SubscribeMessage('create_session')
  async handleCreateSession(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { workspacePath?: string; title?: string },
  ) {
    try {
      const session = await this.sessionService.create(
        client.userId,
        'build',
        data.workspacePath || process.cwd(),
        data.title || 'New session',
      );
      return { type: 'session_created', data: session };
    } catch (error) {
      return { type: 'error', message: error.message };
    }
  }

  private subscribeToSessionEvents(client: AuthenticatedSocket, sessionId: string) {
    // Always clean up previous handlers for this socket first.
    this.removeSubscriptions(client);

    const eventTypes = [
      'text.delta',
      'text.thought',
      'context.updated',
      'text.end',
      'tool.started',
      'tool.output',
      'tool.progress',
      'tool.completed',
      'tool.failed',
      'permission.required',
      'run.started',
      'run.completed',
      'run.interrupted',
      'run.failed',
      'step.started',
      'step.ended',
      'llm.thinking',
      'ask_user.required',
      'ask_user.response',
      'todo.updated',
      'phase.changed',
      'agent.state',
    ];

    const subs: Subscription[] = [];
    for (const eventType of eventTypes) {
      const eventName = `agent.session.${sessionId}.${eventType}`;
      const handler = (event: any) => {
        this.sendToSession(sessionId, {
          type: eventType,
          data: event,
        });
      };
      this.eventEmitter['eventEmitter'].on(eventName, handler);
      subs.push({ eventName, handler });
    }
    this.subscriptions.set(client, subs);
  }

  /**
   * Removes all EventEmitter listeners tracked for this socket.
   * Called on unsubscribe, disconnect, and before re-subscribing.
   */
  private removeSubscriptions(client: WebSocket): void {
    const subs = this.subscriptions.get(client);
    if (!subs) return;
    for (const { eventName, handler } of subs) {
      this.eventEmitter['eventEmitter'].off(eventName, handler);
    }
    this.subscriptions.delete(client);
  }

  private unsubscribeFromSession(client: AuthenticatedSocket) {
    if (!client.sessionId) return;

    // Remove EventEmitter listeners to prevent accumulation.
    this.removeSubscriptions(client);

    const clients = this.clients.get(client.sessionId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) {
        this.clients.delete(client.sessionId);
      }
    }

    client.sessionId = undefined;
  }

  private sendToSession(sessionId: string, message: WsMessage) {
    const clients = this.clients.get(sessionId);
    if (!clients) return;

    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.server.clients.forEach((client: AuthenticatedSocket) => {
        if (!client.isAlive) {
          this.logger.debug(`Terating inactive client: ${client.userId}`);
          return client.terminate();
        }
        client.isAlive = false;
        client.ping();
      });
    }, 30000);
  }

  // Broadcast to all connected clients (for system-wide events)
  broadcast(message: WsMessage) {
    const data = JSON.stringify(message);
    this.server.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }
}
