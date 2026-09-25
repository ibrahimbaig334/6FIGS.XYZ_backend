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
import { GameService } from "./game.service";
import { PresenceService } from "../presence/presence.service";

@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly games: GameService,
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

  @SubscribeMessage("joinGame")
  async join(@MessageBody() body: { gameId?: unknown }, @ConnectedSocket() socket: Socket) {
    if (typeof body.gameId !== "string") return { error: "gameId required" };
    try {
      const state = await this.games.get(body.gameId, socket.data.userId as string);
      await socket.join(`game:${body.gameId}`);
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "join failed" };
    }
  }

  @SubscribeMessage("makeMove")
  async move(@MessageBody() body: { gameId?: unknown; index?: unknown }, @ConnectedSocket() socket: Socket) {
    if (typeof body.gameId !== "string" || typeof body.index !== "number") return { error: "gameId + index required" };
    try {
      const state = await this.games.move(body.gameId, socket.data.userId as string, body.index);
      this.server.to(`game:${body.gameId}`).emit("gameState", state);
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "move failed" };
    }
  }

  @SubscribeMessage("rematch")
  async rematch(@MessageBody() body: { gameId?: unknown }, @ConnectedSocket() socket: Socket) {
    if (typeof body.gameId !== "string") return { error: "gameId required" };
    try {
      const state = await this.games.rematch(body.gameId, socket.data.userId as string);
      this.server.to(`game:${body.gameId}`).emit("gameState", state);
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "rematch failed" };
    }
  }
}
