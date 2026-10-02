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
import { REMATCH_OFFER_MS } from "../common/constants";

interface RematchOffer {
  gameId: string;
  from: string;
  to: string;
  timer: ReturnType<typeof setTimeout>;
}

@WebSocketGateway({
  cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly games: GameService,
    private readonly presence: PresenceService,
  ) {}

  /** Pending rematch offers by game — memory-only like presence (single instance). */
  private readonly offers = new Map<string, RematchOffer>();

  private dropOffer(gameId: string) {
    const o = this.offers.get(gameId);
    if (o) clearTimeout(o.timer);
    this.offers.delete(gameId);
  }

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
  async join(
    @MessageBody() body: { gameId?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if (typeof body.gameId !== "string") return { error: "gameId required" };
    try {
      const state = await this.games.get(
        body.gameId,
        socket.data.userId as string,
      );
      await socket.join(`game:${body.gameId}`);
      // Game-room presence: who is actually ON the game page (leaving the
      // page = leaving the game, even with other tabs still connected).
      this.presence.trackJoin(
        socket.id,
        socket.data.userId as string,
        `game:${body.gameId}`,
      );
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "join failed" };
    }
  }

  /** Leave the game page (homepage, rooms lobby…) — stops broadcasts + presence. */
  @SubscribeMessage("leaveGame")
  async leave(
    @MessageBody() body: { gameId?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if (typeof body.gameId !== "string") return { error: "gameId required" };
    await socket.leave(`game:${body.gameId}`);
    this.presence.trackLeave(socket.id, `game:${body.gameId}`);
    return { ok: true };
  }

  @SubscribeMessage("makeMove")
  async move(
    @MessageBody() body: { gameId?: unknown; index?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if (typeof body.gameId !== "string" || typeof body.index !== "number")
      return { error: "gameId + index required" };
    try {
      const state = await this.games.move(
        body.gameId,
        socket.data.userId as string,
        body.index,
      );
      this.server.to(`game:${body.gameId}`).emit("gameState", state);
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "move failed" };
    }
  }

  /**
   * Offer a rematch: the opponent gets an accept/decline toast, and the board
   * resets ONLY on accept. Replaces the old instant-reset `rematch`.
   */
  @SubscribeMessage("rematchOffer")
  async offer(
    @MessageBody() body: { gameId?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if (typeof body.gameId !== "string") return { error: "gameId required" };
    try {
      const userId = socket.data.userId as string;
      const offer = await this.games.offerRematch(body.gameId, userId);
      this.dropOffer(body.gameId); // one live offer per game — newest wins
      const timer = setTimeout(() => {
        this.offers.delete(body.gameId as string);
        this.server.to(`user:${offer.fromUserId}`).emit("rematchDeclined", {
          gameId: body.gameId,
          reason: "noresponse",
        });
      }, REMATCH_OFFER_MS);
      this.offers.set(body.gameId, {
        gameId: body.gameId,
        from: offer.fromUserId,
        to: offer.toUserId,
        timer,
      });
      this.server.to(`user:${offer.toUserId}`).emit("rematchOffer", {
        gameId: body.gameId,
        fromHandle: offer.fromHandle,
      });
      return { ok: true, toHandle: offer.toHandle };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "offer failed" };
    }
  }

  /** Answer a rematch offer: accept resets the board for BOTH players. */
  @SubscribeMessage("rematchAnswer")
  async answer(
    @MessageBody() body: { gameId?: unknown; accept?: unknown },
    @ConnectedSocket() socket: Socket,
  ) {
    if (typeof body.gameId !== "string" || typeof body.accept !== "boolean")
      return { error: "gameId + accept required" };
    const offer = this.offers.get(body.gameId);
    const userId = socket.data.userId as string;
    if (!offer || offer.to !== userId)
      return { error: "No rematch offer for you" };
    this.dropOffer(body.gameId);
    try {
      if (!body.accept) {
        this.server
          .to(`user:${offer.from}`)
          .emit("rematchDeclined", { gameId: body.gameId, reason: "declined" });
        return { ok: true };
      }
      const state = await this.games.rematch(body.gameId, userId);
      this.server.to(`game:${body.gameId}`).emit("gameState", state);
      return { ok: true, state };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "answer failed" };
    }
  }
}
