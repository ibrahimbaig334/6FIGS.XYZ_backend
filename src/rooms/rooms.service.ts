import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EligibilityService } from "../eligibility/eligibility.service";
import { PresenceService } from "../presence/presence.service";
import { CacheService } from "../common/cache.service";
import { tierRank } from "../common/tiers";

export function inviteHash(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** 1v1-only: every private room holds at most two members. */
export const ROOM_CAPACITY = 2;

const VALID_TIERS = ["TIER I", "TIER II", "TIER III"];

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly presence: PresenceService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Room directory with search, filters, sorting and pagination.
   * sort: created | name | members. Cached 15s per user+param combo in Redis
   * (userId is part of the key because items include per-user isMember).
   */
  async list(userId: string, query: { q?: string; access?: string; sort?: string; order?: string; page?: number; limit?: number }) {
    const q = (query.q ?? "").trim().toLowerCase();
    const access = query.access === "tier" || query.access === "invite" ? query.access : undefined;
    const sort = query.sort === "name" || query.sort === "members" ? query.sort : "created";
    const order = query.order === "asc" ? 1 : -1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const page = Math.max(query.page ?? 1, 1);
    const cacheKey = `rooms:list:${userId}:${JSON.stringify({ q, access, sort, order, page, limit })}`;
    const hit = await this.cache.get<unknown>(cacheKey);
    if (hit) return hit;

    let rooms = await this.prisma.room.findMany({ include: { _count: { select: { members: true } } } });
    const mine = await this.prisma.roomMember.findMany({ where: { userId }, select: { roomId: true } });
    const mySet = new Set(mine.map((m) => m.roomId));
    if (access) rooms = rooms.filter((r) => r.accessType === access);
    if (q) rooms = rooms.filter((r) => r.name.toLowerCase().includes(q));
    const by: Record<string, (r: (typeof rooms)[number]) => string | number> = {
      created: (r) => r.createdAt.getTime(),
      name: (r) => r.name.toLowerCase(),
      members: (r) => r._count.members,
    };
    const key = by[sort];
    rooms.sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });
    const total = rooms.length;
    const items = rooms.slice((page - 1) * limit, page * limit).map((r) => ({
      id: r.id,
      name: r.name,
      imageUrl: r.imageUrl,
      accessType: r.accessType,
      minTier: r.minTier,
      memberCount: r._count.members,
      createdAt: r.createdAt,
      isMember: mySet.has(r.id),
    }));
    const out = { items, total, page, limit };
    await this.cache.set(cacheKey, out, 15_000);
    return out;
  }

  async create(userId: string, body: { name?: unknown; imageUrl?: unknown; accessType?: unknown; minTier?: unknown; inviteCode?: unknown }) {
    const name = String(body.name ?? "").trim().slice(0, 48);
    if (name.length < 3) throw new BadRequestException("Room name needs 3+ chars");
    const accessType = String(body.accessType ?? "");
    if (accessType !== "tier" && accessType !== "invite") throw new BadRequestException("accessType must be tier or invite");
    let minTier: string | null = null;
    let codeHash: string | null = null;
    if (accessType === "tier") {
      if (!VALID_TIERS.includes(String(body.minTier))) throw new BadRequestException("minTier must be TIER I, II or III");
      minTier = String(body.minTier);
    } else {
      const code = String(body.inviteCode ?? "").trim();
      if (code.length < 4) throw new BadRequestException("Invite code needs 4+ chars");
      codeHash = inviteHash(code);
    }
    const room = await this.prisma.room.create({
      data: { name, imageUrl: body.imageUrl ? String(body.imageUrl).slice(0, 512) : null, accessType, minTier, inviteCodeHash: codeHash, createdBy: userId },
    });
    await this.prisma.roomMember.create({ data: { roomId: room.id, userId } });
    await this.cache.delPrefix("rooms:list:");
    // The plaintext code is returned exactly once (creation) so the creator
    // can share an invite link. It is never readable again afterwards.
    const inviteCode = accessType === "invite" ? String(body.inviteCode).trim().toUpperCase() : null;
    return { id: room.id, name: room.name, accessType: room.accessType, minTier: room.minTier, inviteCode };
  }

  async join(userId: string, roomId: string, code?: unknown) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    const existing = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (existing) return { ok: true, roomId };
    const count = await this.prisma.roomMember.count({ where: { roomId } });
    if (count >= ROOM_CAPACITY) throw new ForbiddenException("Room is full — private rooms are 1v1");
    const elig = await this.eligibility.me(userId);
    if (!elig.tier) throw new ForbiddenException("Verify ≥ $100K in Profile first");
    if (room.accessType === "tier") {
      if (tierRank(elig.tier) < tierRank(room.minTier)) {
        throw new ForbiddenException(`Needs ${room.minTier} (you are ${elig.tier})`);
      }
    } else {
      if (inviteHash(String(code ?? "")) !== room.inviteCodeHash) throw new ForbiddenException("Wrong invite code");
    }
    await this.prisma.roomMember.create({ data: { roomId, userId } });
    await this.cache.delPrefix("rooms:list:");
    return { ok: true, roomId };
  }

  async members(userId: string, roomId: string) {
    const member = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (!member) throw new ForbiddenException("Join the room first");
    const rows = await this.prisma.roomMember.findMany({ where: { roomId }, include: { user: true } });
    return rows.map((m) => ({
      id: m.user.id,
      handle: m.user.handle ?? `user_${m.user.id.slice(-4)}`,
      ...this.presence.status(m.user.id),
    }));
  }

  /**
   * The room's 1v1 game: returns the pair's open game, creating a match+game
   * when needed. Requires both seats filled (member-only, needs a peer).
   * Guarded by a Redis lock — concurrent calls from both players used to race
   * and create two different games (boards wouldn't sync).
   */
  async game(userId: string, roomId: string) {
    await this.assertMember(userId, roomId);
    const lockKey = `lock:room-game:${roomId}`;
    const locked = await this.cache.lock(lockKey, 5000, 2000);
    try {
      const members = await this.prisma.roomMember.findMany({ where: { roomId }, orderBy: { joinedAt: "asc" } });
      if (members.length < 2) throw new BadRequestException("Waiting for your 1v1 peer to join");
      const [u1, u2] = [members[0].userId, members[1].userId];
      const existing = await this.prisma.match.findFirst({
        where: { OR: [{ aUserId: u1, bUserId: u2 }, { aUserId: u2, bUserId: u1 }] },
        orderBy: { createdAt: "desc" },
        include: { games: { orderBy: { updatedAt: "desc" }, take: 1 } },
      });
      if (existing && existing.games[0] && existing.games[0].status === "open") {
        return { gameId: existing.games[0].id, matchId: existing.id };
      }
      const match = await this.prisma.match.create({ data: { aUserId: u1, bUserId: u2 } });
      const game = await this.prisma.game.create({ data: { matchId: match.id } });
      return { gameId: game.id, matchId: match.id };
    } finally {
      if (locked) await this.cache.unlock(lockKey);
    }
  }

  /**
   * Lightweight room header for the join gate (name, access rules, membership).
   * Never exposes inviteCodeHash — only isMember tells the client whether to
   * ask for a code at all.
   */
  async meta(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    const member = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    const memberCount = await this.prisma.roomMember.count({ where: { roomId } });
    return {
      id: room.id,
      name: room.name,
      imageUrl: room.imageUrl,
      accessType: room.accessType,
      minTier: room.minTier,
      memberCount,
      isMember: !!member,
    };
  }

  async assertMember(userId: string, roomId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (!member) throw new ForbiddenException("Join the room first");
  }
}
