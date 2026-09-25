import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service";
import { PresenceService } from "../presence/presence.service";

/**
 * Play gateway: authenticates sockets, tracks presence and hosts per-user
 * rooms (`user:{id}`) so the server can push matchmaking events
 * (roomRequest / requestAccepted / requestDeclined / requestCancelled).
 */
@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" } })
export class PlayGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly auth: AuthService,
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

  async userSockets(userId: string): Promise<Socket[]> {
    return (await this.server.in(`user:${userId}`).fetchSockets()) as unknown as Socket[];
  }

  notifyUser(userId: string, event: string, payload: unknown) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
