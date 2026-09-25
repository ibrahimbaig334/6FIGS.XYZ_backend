import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceService } from "../presence/presence.service";
import { CacheService } from "../common/cache.service";
import { inviteHash } from "../rooms/rooms.service";

const TICKET_TTL_MS = 2 * 60 * 1000;
const FRESH_MATCH_MS = 5 * 60 * 1000;

@Injectable()
export class PlayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly cache: CacheService,
  ) {}

  private async requireTier(userId: string): Promise<void> {
    const cache = await this.prisma.eligibilityCache.findUnique({ where: { userId } });
    if (!cache || cache.expiresAt <= new Date()) {
      throw new ForbiddenException("Verify ≥ $100K in Profile first");
    }
  }

  private pubUser(user: { id: string; handle: string | null; visMode: string; tags: string[] }, tier: string | null) {
    return {
      id: user.id,
      handle: user.handle ?? `user_${user.id.slice(-4)}`,
      tier,
      visMode: user.visMode,
      tags: user.tags,
      ...this.presence.status(user.id),
    };
  }

  /**
   * Verified-holders directory (fresh tiers only). Single round trip: the
   * eligibility→user JOIN runs in Postgres instead of N Prisma queries.
   */
  async online(selfId: string | null, filter?: string, q?: string) {
    const query = (q ?? "").trim();
    const rows = await this.prisma.$queryRaw<
      { id: string; handle: string | null; visMode: string; tags: string[]; tier: string }[]
    >`
      SELECT u.id, u.handle, u."visMode", u.tags, e.tier
      FROM "EligibilityCache" e JOIN "User" u ON u.id = e."userId"
      WHERE e."expiresAt" > NOW()
      ${selfId ? Prisma.sql`AND u.id <> ${selfId}` : Prisma.empty}
      ${filter ? Prisma.sql`AND e.tier = ${filter}` : Prisma.empty}
      ${query ? Prisma.sql`AND u.handle ILIKE ${"%" + query + "%"}` : Prisma.empty}
      ORDER BY e."verifiedAt" DESC LIMIT 100
    `;
    return rows.map((r) => ({
      id: r.id,
      handle: r.handle ?? `user_${r.id.slice(-4)}`,
      tier: r.tier,
      visMode: r.visMode,
      tags: r.tags,
      ...this.presence.status(r.id),
    }));
  }

  /**
   * Random queue, step 1: take a ticket and try to pair instantly.
   * Returns { status: "waiting" } or { status: "matched", matchId, gameId, youAre, opponent }.
   * The waiter learns about the match via queueStatus() polling (or WS in future).
   */
  async queue(selfId: string) {
    await this.requireTier(selfId);
    await this.prisma.queueTicket.upsert({
      where: { userId: selfId },
      update: { createdAt: new Date() },
      create: { userId: selfId },
    });
    const matched = await this.tryMatch(selfId);
    if (matched) return { status: "matched", ...matched };
    return { status: "waiting" };
  }

  /** Random queue, step 2 (poll): match if a peer is waiting, or report the match made for me. */
  async queueStatus(selfId: string) {
    const ticket = await this.prisma.queueTicket.findUnique({ where: { userId: selfId } });
    if (ticket) {
      await this.requireTier(selfId);
      const matched = await this.tryMatch(selfId);
      if (matched) return { status: "matched", ...matched };
      const still = await this.prisma.queueTicket.findUnique({ where: { userId: selfId } });
      if (still) return { status: "waiting" };
    }
    const fresh = await this.findFreshRandomMatch(selfId);
    if (fresh) return { status: "matched", ...fresh };
    return { status: "idle" };
  }

  /** Random queue, cancel: drop the ticket. */
  async queueCancel(selfId: string) {
    await this.prisma.queueTicket.deleteMany({ where: { userId: selfId } });
    return { ok: true };
  }

  /** Pair self with the oldest waiting peer (Redis-locked — no double matches). */
  private async tryMatch(selfId: string) {
    const locked = await this.cache.lock("lock:queue-match", 5000, 2000);
    try {
      const me = await this.prisma.queueTicket.findUnique({ where: { userId: selfId } });
      if (!me) return null;
      await this.prisma.queueTicket.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - TICKET_TTL_MS) } } });
      const stillMe = await this.prisma.queueTicket.findUnique({ where: { userId: selfId } });
      if (!stillMe) return null;
      const waiter = await this.prisma.queueTicket.findFirst({
        where: { userId: { not: selfId } },
        orderBy: { createdAt: "asc" },
      });
      if (!waiter) return null;
      const cache = await this.prisma.eligibilityCache.findUnique({ where: { userId: waiter.userId } });
      const peer = cache && cache.expiresAt > new Date() ? await this.prisma.user.findUnique({ where: { id: waiter.userId } }) : null;
      if (!peer) {
        await this.prisma.queueTicket.delete({ where: { userId: waiter.userId } });
        return null;
      }
      await this.prisma.queueTicket.deleteMany({ where: { userId: { in: [selfId, waiter.userId] } } });
      const match = await this.prisma.match.create({ data: { aUserId: waiter.userId, bUserId: selfId, origin: "random" } });
      const game = await this.prisma.game.create({ data: { matchId: match.id } });
      return { matchId: match.id, gameId: game.id, youAre: "O", opponent: this.pubUser(peer, cache!.tier) };
    } finally {
      if (locked) await this.cache.unlock("lock:queue-match");
    }
  }

  /** Latest open random match involving self (for the waiter after being paired). */
  private async findFreshRandomMatch(selfId: string) {
    const m = await this.prisma.match.findFirst({
      where: {
        origin: "random",
        createdAt: { gt: new Date(Date.now() - FRESH_MATCH_MS) },
        OR: [{ aUserId: selfId }, { bUserId: selfId }],
      },
      orderBy: { createdAt: "desc" },
      include: { games: { orderBy: { updatedAt: "desc" }, take: 1 } },
    });
    if (!m || !m.games[0] || m.games[0].status !== "open") return null;
    const oppId = m.aUserId === selfId ? m.bUserId : m.aUserId;
    const [opp, cache] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: oppId } }),
      this.prisma.eligibilityCache.findUnique({ where: { userId: oppId } }),
    ]);
    if (!opp) return null;
    return {
      matchId: m.id,
      gameId: m.games[0].id,
      youAre: m.aUserId === selfId ? "X" : "O",
      opponent: this.pubUser(opp, cache?.tier ?? null),
    };
  }

  /** Challenge a specific verified holder (kept for tests/direct play). */
  async challenge(selfId: string, targetId: string) {
    await this.requireTier(selfId);
    if (targetId === selfId) throw new BadRequestException("You cannot challenge yourself");
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new BadRequestException("Unknown holder");
    const cache = await this.prisma.eligibilityCache.findUnique({ where: { userId: targetId } });
    if (!cache || cache.expiresAt <= new Date()) {
      throw new BadRequestException("That holder is not verified right now");
    }
    return this.openMatch(selfId, targetId, this.pubUser(target, cache.tier), "challenge");
  }

  private async openMatch(selfId: string, oppId: string, opponent: object, origin: string) {
    const match = await this.prisma.match.create({ data: { aUserId: selfId, bUserId: oppId, origin } });
    const game = await this.prisma.game.create({ data: { matchId: match.id } });
    return { matchId: match.id, gameId: game.id, youAre: "X", opponent };
  }

  /** Friends = random-matched pairs with ≥1 DM each (see ChatService friendship hook). */
  async friends(selfId: string, q?: string) {
    const rows = await this.prisma.friendship.findMany({
      where: { OR: [{ aUserId: selfId }, { bUserId: selfId }] },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const ids = rows.map((r) => (r.aUserId === selfId ? r.bUserId : r.aUserId));
    if (!ids.length) return [];
    const [users, caches] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } } }),
      this.prisma.eligibilityCache.findMany({ where: { userId: { in: ids } } }),
    ]);
    const tierBy = new Map(caches.map((c) => [c.userId, c.tier]));
    const query = (q ?? "").toLowerCase();
    return users
      .filter((u) => !query || (u.handle ?? "").toLowerCase().includes(query))
      .map((u) => this.pubUser(u, tierBy.get(u.id) ?? null));
  }

  private async shapeRequest(
    req: { id: string; fromUserId: string; toUserId: string; status: string; roomId: string | null; createdAt: Date },
    selfId: string,
  ) {
    const [from, to] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: req.fromUserId } }),
      this.prisma.user.findUnique({ where: { id: req.toUserId } }),
    ]);
    const handle = (u: { id: string; handle: string | null } | null) => u?.handle ?? `user_${(u?.id ?? selfId).slice(-4)}`;
    return {
      id: req.id,
      fromUserId: req.fromUserId,
      toUserId: req.toUserId,
      fromHandle: handle(from),
      toHandle: handle(to),
      status: req.status,
      roomId: req.roomId,
      createdAt: req.createdAt.toISOString(),
    };
  }

  /** Invite an online friend to a private room. */
  async requestRoom(selfId: string, targetId: string) {
    if (targetId === selfId) throw new BadRequestException("You cannot invite yourself");
    await this.requireTier(selfId);
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new BadRequestException("Unknown holder");
    const [a, b] = [selfId, targetId].sort();
    const friendship = await this.prisma.friendship.findUnique({ where: { aUserId_bUserId: { aUserId: a, bUserId: b } } });
    if (!friendship) throw new BadRequestException("Only friends can be invited — meet via RANDOM first");
    const tCache = await this.prisma.eligibilityCache.findUnique({ where: { userId: targetId } });
    if (!tCache || tCache.expiresAt <= new Date()) throw new BadRequestException("That friend is not verified right now");
    if (!this.presence.status(targetId).online) throw new BadRequestException("That friend is offline right now");
    const pending = await this.prisma.roomRequest.findFirst({
      where: {
        status: "pending",
        OR: [
          { fromUserId: selfId, toUserId: targetId },
          { fromUserId: targetId, toUserId: selfId },
        ],
      },
    });
    if (pending) throw new ConflictException("A room request is already pending between you");
    const req = await this.prisma.roomRequest.create({ data: { fromUserId: selfId, toUserId: targetId } });
    return this.shapeRequest(req, selfId);
  }

  async incoming(selfId: string) {
    const rows = await this.prisma.roomRequest.findMany({
      where: { toUserId: selfId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((r) => this.shapeRequest(r, selfId)));
  }

  async outgoing(selfId: string) {
    const rows = await this.prisma.roomRequest.findMany({
      where: { fromUserId: selfId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((r) => this.shapeRequest(r, selfId)));
  }

  async getRequest(selfId: string, requestId: string) {
    const req = await this.prisma.roomRequest.findUnique({ where: { id: requestId } });
    if (!req || (req.fromUserId !== selfId && req.toUserId !== selfId)) {
      throw new NotFoundException("Request not found");
    }
    return this.shapeRequest(req, selfId);
  }

  /** Recipient accepts → joint invite room is created (bypasses the 3-room cap) and both join. */
  async accept(selfId: string, requestId: string) {
    const req = await this.prisma.roomRequest.findUnique({ where: { id: requestId } });
    if (!req || req.toUserId !== selfId) throw new NotFoundException("Request not found");
    if (req.status !== "pending") throw new BadRequestException(`Request is already ${req.status}`);
    await this.requireTier(selfId);
    const code = randomBytes(4).toString("hex").toUpperCase();
    const [from, to] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: req.fromUserId } }),
      this.prisma.user.findUnique({ where: { id: req.toUserId } }),
    ]);
    const name = `${from?.handle ?? "A"} × ${to?.handle ?? "B"}`.slice(0, 48);
    const room = await this.prisma.room.create({
      data: { name, accessType: "invite", inviteCodeHash: inviteHash(code), createdBy: req.fromUserId },
    });
    await this.prisma.roomMember.createMany({
      data: [
        { roomId: room.id, userId: req.fromUserId },
        { roomId: room.id, userId: req.toUserId },
      ],
    });
    const updated = await this.prisma.roomRequest.update({ where: { id: req.id }, data: { status: "accepted", roomId: room.id } });
    await this.cache.delPrefix("rooms:list:");
    return { ...(await this.shapeRequest(updated, selfId)), code };
  }

  async decline(selfId: string, requestId: string) {
    const req = await this.prisma.roomRequest.findUnique({ where: { id: requestId } });
    if (!req || req.toUserId !== selfId) throw new NotFoundException("Request not found");
    if (req.status !== "pending") throw new BadRequestException(`Request is already ${req.status}`);
    const updated = await this.prisma.roomRequest.update({ where: { id: req.id }, data: { status: "declined" } });
    return this.shapeRequest(updated, selfId);
  }

  async cancel(selfId: string, requestId: string) {
    const req = await this.prisma.roomRequest.findUnique({ where: { id: requestId } });
    if (!req || req.fromUserId !== selfId) throw new NotFoundException("Request not found");
    if (req.status !== "pending") throw new BadRequestException(`Request is already ${req.status}`);
    const updated = await this.prisma.roomRequest.update({ where: { id: req.id }, data: { status: "cancelled" } });
    return this.shapeRequest(updated, selfId);
  }
}
