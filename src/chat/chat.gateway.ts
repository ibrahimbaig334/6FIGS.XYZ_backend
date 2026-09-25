import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service";
import { ChatService } from "./chat.service";
import { PresenceService } from "../presence/presence.service";

@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly chat: ChatService,
    private readonly presence: PresenceService,
  ) {}

  handleConnection(socket: Socket) {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== "string") return socket.disconnect();
    try {
      const userId = this.auth.validateToken(token).userId;
      socket.data.userId = userId;
      socket.join(`user:${userId}`);
      this.presence.markOnline(userId, socket.id);
    } catch {
      return socket.disconnect();
    }
  }

  handleDisconnect(socket: Socket) {
    this.presence.markOffline(socket.id);
  }

  @SubscribeMessage("joinScope")
  async join(@MessageBody() body: { scope?: unknown; scopeId?: unknown }, @ConnectedSocket() socket: Socket) {
    if ((body.scope !== "dm" && body.scope !== "room") || typeof body.scopeId !== "string") {
      return { error: "scope (dm|room) + scopeId required" };
    }
    try {
      await this.chat.assertScopeAccess(socket.data.userId as string, body.scope, body.scopeId);
      await socket.join(`${body.scope}:${body.scopeId}`);
      this.presence.trackJoin(socket.id, socket.data.userId as string, `${body.scope}:${body.scopeId}`);
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "join failed" };
    }
  }

  @SubscribeMessage("leaveScope")
  async leave(@MessageBody() body: { scope?: unknown; scopeId?: unknown }, @ConnectedSocket() socket: Socket) {
    if ((body.scope !== "dm" && body.scope !== "room") || typeof body.scopeId !== "string") {
      return { error: "scope (dm|room) + scopeId required" };
    }
    await socket.leave(`${body.scope}:${body.scopeId}`);
    this.presence.trackLeave(socket.id, `${body.scope}:${body.scopeId}`);
    return { ok: true };
  }

  @SubscribeMessage("sendMessage")
  async send(
    @MessageBody() body: { scope?: unknown; scopeId?: unknown; body?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if ((body.scope !== "dm" && body.scope !== "room") || typeof body.scopeId !== "string" || typeof body.body !== "string") {
      return { error: "scope + scopeId + body required" };
    }
    try {
      const posted = await this.chat.post(socket.data.userId as string, body.scope, body.scopeId, body.body);
      this.server.to(`${body.scope}:${body.scopeId}`).emit("chatMessage", posted);
      return { ok: true, ...posted };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "send failed" };
    }
  }
}
