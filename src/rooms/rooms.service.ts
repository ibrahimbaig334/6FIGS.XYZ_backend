import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { EligibilityService } from "../eligibility/eligibility.service";
import { PresenceService } from "../presence/presence.service";
import { CacheService } from "../common/cache.service";
import { tierRank } from "../common/tiers";
import {
  INVITE_CODE_MIN,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LOCK_WAIT_MS,
  MAX_ROOMS_PER_USER,
  ROOM_CAPACITY,
  ROOM_DESC_MAX,
  ROOM_GAME_LOCK_MS,
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
  ROOM_NAME_MAX,
  ROOM_NAME_MIN,
  ROOM_TOKEN_OPTIONS,
  ROOMS_CACHE_MS,
} from "../common/constants";

export function inviteHash(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Rooms hold 2–50 members (see maxMembers); 1v1 rooms also get a board. */
/** Room size defaults to a 1v1 duel (see ROOM_CAPACITY). */

const VALID_TIERS = ["TIER I", "TIER II", "TIER III", "TIER IV"];

/** Directory size buckets: duo (exactly 2) | small (3–10) | large (11+). */
function sizeMatches(maxMembers: number, size: string): boolean {
  if (size === "duo") return maxMembers <= 2;
  if (size === "small") return maxMembers >= 3 && maxMembers <= 10;
  if (size === "large") return maxMembers >= 11;
  return true;
}

/** Holdings gate: the required symbol must sit in the joiner's disclosed
 *  top assets (compared uppercase — price sources vary in case). */
function holdsToken(
  elig: { tier: string | null } & Partial<{ topAssets: unknown }>,
  minToken: string | null,
): boolean {
  if (!minToken) return true;
  const assets = Array.isArray(elig.topAssets)
    ? elig.topAssets.map((s) => String(s).toUpperCase())
    : [];
  return assets.includes(minToken.toUpperCase());
}

/** Cached roster item (presence-free — onlineCount is filled fresh per response). */
interface RoomListItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  accessType: string;
  minTier: string | null;
  minToken: string | null;
  maxMembers: number;
  memberCount: number;
  createdAt: Date;
  isMember: boolean;
  isOwner: boolean;
  creatorHandle: string;
}

interface RoomListOut {
  items: RoomListItem[];
  total: number;
  page: number;
  limit: number;
  ownedCount: number;
}

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
   * sort: created | members | mine (only rooms I'm in, newest first) | tier
   * (by min-tier rank). tier= filters tier-rooms to one min-tier
   * (TIER I/II/III — invite rooms have no tier, so the frontend hides the tier
   * options under the invite-only filter). Redis caches the ROSTER
   * for 15s per user+param combo; the live presence count is filled fresh on
   * EVERY response from socket occupancy (never cached) — closing a tab drops
   * the count without any Leave click.
   */
  async list(
    userId: string,
    query: {
      q?: string;
      access?: string;
      tier?: string;
      token?: string;
      size?: string;
      sort?: string;
      order?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const q = (query.q ?? "").trim().toLowerCase();
    const access =
      query.access === "tier" || query.access === "invite"
        ? query.access
        : undefined;
    const tier = VALID_TIERS.find((t) => t === query.tier);
    const token =
      typeof query.token === "string" &&
      ROOM_TOKEN_OPTIONS.includes(query.token.toUpperCase())
        ? query.token.toUpperCase()
        : undefined;
    const size =
      query.size === "duo" || query.size === "small" || query.size === "large"
        ? query.size
        : undefined;
    const sort =
      query.sort === "mine" || query.sort === "members" || query.sort === "tier"
        ? query.sort
        : "created";
    const order = query.order === "asc" ? 1 : -1;
    const limit = Math.min(
      Math.max(query.limit ?? LIST_DEFAULT_LIMIT, 1),
      LIST_MAX_LIMIT,
    );
    const page = Math.max(query.page ?? 1, 1);
    const cacheKey = `rooms:list:${userId}:${JSON.stringify({ q, access, tier, token, size, sort, order, page, limit })}`;
    const hit = await this.cache.get<RoomListOut>(cacheKey);
    const out =
      hit ??
      (await this.buildList(
        userId,
        { q, access, tier, token, size, sort, order, page, limit },
        cacheKey,
      ));
    return this.withPresence(out);
  }

  /** Roster (cached) + fresh socket-occupancy counts on top. */
  private withPresence(out: RoomListOut) {
    return {
      ...out,
      items: out.items.map((i) => ({
        ...i,
        onlineCount: this.presence.countInRoom(`room:${i.id}`),
      })),
    };
  }

  private async buildList(
    userId: string,
    q: {
      q: string;
      access?: string;
      tier?: string;
      token?: string;
      size?: string;
      sort: string;
      order: number;
      page: number;
      limit: number;
    },
    cacheKey: string,
  ): Promise<RoomListOut> {
    const [allRooms, mine, ownedCount, creators] = await Promise.all([
      this.prisma.room.findMany({
        include: { _count: { select: { members: true } } },
      }),
      this.prisma.roomMember.findMany({
        where: { userId },
        select: { roomId: true },
      }),
      this.prisma.room.count({ where: { createdBy: userId } }),
      this.prisma.user.findMany({ select: { id: true, handle: true } }),
    ]);
    const mySet = new Set(mine.map((m) => m.roomId));
    const handleBy = new Map(
      creators.map((u) => [u.id, u.handle ?? `user_${u.id.slice(-4)}`]),
    );
    let rooms = allRooms;
    if (q.access) rooms = rooms.filter((r) => r.accessType === q.access);
    if (q.tier)
      rooms = rooms.filter(
        (r) => r.accessType === "tier" && r.minTier === q.tier,
      );
    if (q.token)
      rooms = rooms.filter(
        (r) => r.minToken !== null && r.minToken.toUpperCase() === q.token,
      );
    if (q.size) rooms = rooms.filter((r) => sizeMatches(r.maxMembers, q.size!));
    if (q.q)
      rooms = rooms.filter(
        (r) =>
          r.name.toLowerCase().includes(q.q) ||
          (r.description ?? "").toLowerCase().includes(q.q),
      );
    if (q.sort === "mine") {
      // MY ROOMS is a filter, not just an ordering: only rooms I'm in, newest first.
      rooms = rooms.filter((r) => mySet.has(r.id));
      rooms.sort((a, b) => {
        const va = a.createdAt.getTime();
        const vb = b.createdAt.getTime();
        if (va < vb) return -1 * q.order;
        if (va > vb) return 1 * q.order;
        return 0;
      });
    } else {
      const by: Record<string, (r: (typeof rooms)[number]) => string | number> =
        {
          created: (r) => r.createdAt.getTime(),
          members: (r) => r._count.members,
          tier: (r) => tierRank(r.minTier),
        };
      const key = by[q.sort];
      rooms.sort((a, b) => {
        const va = key(a);
        const vb = key(b);
        if (va < vb) return -1 * q.order;
        if (va > vb) return 1 * q.order;
        return 0;
      });
    }
    const total = rooms.length;
    const items: RoomListItem[] = rooms
      .slice((q.page - 1) * q.limit, q.page * q.limit)
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        imageUrl: r.imageUrl,
        accessType: r.accessType,
        minTier: r.minTier,
        minToken: r.minToken,
        maxMembers: r.maxMembers,
        memberCount: r._count.members,
        createdAt: r.createdAt,
        isMember: mySet.has(r.id),
        isOwner: r.createdBy === userId,
        creatorHandle: handleBy.get(r.createdBy) ?? "unknown",
      }));
    const out: RoomListOut = {
      items,
      total,
      page: q.page,
      limit: q.limit,
      ownedCount,
    };
    await this.cache.set(cacheKey, out, ROOMS_CACHE_MS);
    return out;
  }

  async create(
    userId: string,
    body: {
      name?: unknown;
      description?: unknown;
      imageUrl?: unknown;
      accessType?: unknown;
      minTier?: unknown;
      minToken?: unknown;
      maxMembers?: unknown;
      inviteCode?: unknown;
    },
  ) {
    // Grapheme-safe truncation: never split an emoji / ZWJ sequence, and an
    // emoji counts as 1 character — matching the frontend validator.
    const IntlWithSeg = Intl as unknown as {
      Segmenter?: new (
        locale: string,
        opts: { granularity: string },
      ) => { segment(s: string): Iterable<{ segment: string }> };
    };
    const graphemeSlice = (s: string, n: number) => {
      if (typeof IntlWithSeg.Segmenter === "function") {
        const seg = new IntlWithSeg.Segmenter("en", {
          granularity: "grapheme",
        });
        const parts = Array.from(seg.segment(s), (p) => p.segment);
        return parts.length > n ? parts.slice(0, n).join("") : s;
      }
      // Fallback (no Segmenter): code-point-safe slice, never split surrogates.
      return Array.from(s).slice(0, n).join("");
    };
    const name = graphemeSlice(String(body.name ?? "").trim(), ROOM_NAME_MAX);
    if (name.length < ROOM_NAME_MIN)
      throw new BadRequestException("Room name needs 3+ chars");
    const description = graphemeSlice(
      String(body.description ?? "").trim(),
      ROOM_DESC_MAX,
    );
    if (!description) throw new BadRequestException("Description is required");
    const accessType = String(body.accessType ?? "");
    if (accessType !== "tier" && accessType !== "invite")
      throw new BadRequestException("accessType must be tier or invite");
    const owned = await this.prisma.room.count({
      where: { createdBy: userId },
    });
    if (owned >= MAX_ROOMS_PER_USER) {
      throw new ForbiddenException(
        `Room limit reached (${MAX_ROOMS_PER_USER}) — delete one to create another`,
      );
    }
    let minTier: string | null = null;
    let minToken: string | null = null;
    let codeHash: string | null = null;
    const maxMembers =
      body.maxMembers === undefined ||
      body.maxMembers === null ||
      body.maxMembers === ""
        ? ROOM_CAPACITY
        : Number(body.maxMembers);
    if (
      !Number.isInteger(maxMembers) ||
      maxMembers < ROOM_MIN_MEMBERS ||
      maxMembers > ROOM_MAX_MEMBERS
    )
      throw new BadRequestException(
        `Room size must be ${ROOM_MIN_MEMBERS}–${ROOM_MAX_MEMBERS} members`,
      );
    if (accessType === "tier") {
      if (!VALID_TIERS.includes(String(body.minTier)))
        throw new BadRequestException("minTier must be TIER I, II, III or IV");
      minTier = String(body.minTier);
      // A room can never demand more than the creator currently holds — hides
      // the higher-tier options in the UI and blocks forged requests here.
      const elig = await this.eligibility.me(userId);
      if (!elig.tier)
        throw new ForbiddenException(
          "Verify your holdings in Profile before creating a tier room",
        );
      if (tierRank(minTier) > tierRank(elig.tier))
        throw new ForbiddenException(
          `You are ${elig.tier} — you cannot require ${minTier}`,
        );
      // Optional holdings gate: a disclosed top-asset symbol. The creator
      // must hold it too — same honesty rule as the tier (checked below
      // against their own top assets).
      if (
        body.minToken !== undefined &&
        body.minToken !== null &&
        String(body.minToken).trim() !== ""
      ) {
        const want = String(body.minToken).trim().toUpperCase();
        if (!ROOM_TOKEN_OPTIONS.includes(want))
          throw new BadRequestException(
            `minToken must be one of ${ROOM_TOKEN_OPTIONS.join(", ")}`,
          );
        if (!holdsToken(elig, want))
          throw new ForbiddenException(
            `You need ${want} in your top holdings to require it`,
          );
        minToken = want;
      }
    } else {
      if (
        body.minToken !== undefined &&
        body.minToken !== null &&
        String(body.minToken).trim() !== ""
      )
        throw new BadRequestException("Token gates are for tier rooms only");
      const code = String(body.inviteCode ?? "").trim();
      if (code.length < INVITE_CODE_MIN)
        throw new BadRequestException("Invite code needs 4+ chars");
      codeHash = inviteHash(code);
    }
    const room = await this.prisma.room.create({
      data: {
        name,
        description,
        imageUrl: body.imageUrl ? String(body.imageUrl).slice(0, 512) : null,
        accessType,
        minTier,
        minToken,
        maxMembers,
        inviteCodeHash: codeHash,
        createdBy: userId,
      },
    });
    await this.prisma.roomMember.create({ data: { roomId: room.id, userId } });
    await this.cache.delPrefix("rooms:list:");
    // The plaintext code is returned exactly once (creation) so the creator
    // can share an invite link. It is never readable again afterwards.
    const inviteCode =
      accessType === "invite"
        ? String(body.inviteCode).trim().toUpperCase()
        : null;
    return {
      id: room.id,
      name: room.name,
      accessType: room.accessType,
      minTier: room.minTier,
      minToken: room.minToken,
      maxMembers: room.maxMembers,
      inviteCode,
    };
  }

  async join(userId: string, roomId: string, code?: unknown) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    // Invite rooms enforce the password for EVERYONE — including the creator and
    // current members — before any membership shortcut.
    if (room.accessType === "invite") {
      if (inviteHash(String(code ?? "")) !== room.inviteCodeHash)
        throw new ForbiddenException("Wrong invite code");
    }
    // Tier rooms re-check eligibility for existing members too: a holder who
    // dropped below the room's tier is locked out of their own room.
    if (room.accessType === "tier") {
      const elig = await this.eligibility.me(userId);
      if (!elig.tier)
        throw new ForbiddenException(
          "Verify your holdings in Profile to enter this room",
        );
      if (tierRank(elig.tier) < tierRank(room.minTier))
        throw new ForbiddenException(
          `This room needs ${room.minTier} — you are ${elig.tier}`,
        );
      if (!holdsToken(elig, room.minToken))
        throw new ForbiddenException(
          `This room needs ${room.minToken} in your top holdings`,
        );
    }
    const [existing, count] = await Promise.all([
      this.prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
      }),
      this.prisma.roomMember.count({ where: { roomId } }),
    ]);
    if (existing) return { ok: true, roomId };
    const seats = room.maxMembers ?? ROOM_CAPACITY;
    if (count >= seats)
      throw new ForbiddenException(
        `Room is full (${count}/${seats} seats taken)`,
      );
    await this.prisma.roomMember.create({ data: { roomId, userId } });
    await this.cache.delPrefix("rooms:list:");
    return { ok: true, roomId };
  }

  /** Leave a room. Empty rooms survive — only the owner can delete (DELETE). */
  async leave(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new ForbiddenException("You are not in this room");
    await this.prisma.roomMember.delete({
      where: { roomId_userId: { roomId, userId } },
    });
    await this.cache.delPrefix("rooms:list:");
    return { ok: true, roomId };
  }

  /** Creator-only room deletion (members, room-scoped messages and the room go). */
  async remove(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    if (room.createdBy !== userId)
      throw new ForbiddenException("Only the room creator can delete it");
    await this.prisma.message.deleteMany({
      where: { scope: "room", scopeId: roomId },
    });
    await this.prisma.roomMember.deleteMany({ where: { roomId } });
    await this.prisma.room.delete({ where: { id: roomId } });
    await this.cache.delPrefix("rooms:list:");
    return { ok: true, roomId };
  }

  async members(userId: string, roomId: string) {
    const rows = await this.prisma.roomMember.findMany({
      where: { roomId },
      include: { user: true },
    });
    if (!rows.some((m) => m.userId === userId))
      throw new ForbiddenException("Join the room first");
    return rows.map((m) => ({
      id: m.user.id,
      handle: m.user.handle ?? `user_${m.user.id.slice(-4)}`,
      // Room-page presence (NOT global online): the dot means "on this room
      // page right now" — a member browsing elsewhere shows as away. Matches
      // the header's scope-based onlineCount instead of contradicting it.
      online: this.presence.isInRoom(m.user.id, `room:${roomId}`),
      lastSeenAt: this.presence.status(m.user.id).lastSeenAt,
    }));
  }

  /**
   * The room's 1v1 game: returns the pair's open game, creating a match+game
   * when needed. Requires both seats filled (member-only, needs a peer).
   * Chat rooms (maxMembers > 2) have no board at all.
   * Guarded by a Redis lock — concurrent calls from both players used to race
   * and create two different games (boards wouldn't sync).
   */
  async game(userId: string, roomId: string) {
    const lockKey = `lock:room-game:${roomId}`;
    const locked = await this.cache.lock(
      lockKey,
      ROOM_GAME_LOCK_MS,
      LOCK_WAIT_MS,
    );
    try {
      // Membership check rides on the same fetch (no extra round trip).
      const members = await this.prisma.roomMember.findMany({
        where: { roomId },
        orderBy: { joinedAt: "asc" },
      });
      if (!members.some((m) => m.userId === userId))
        throw new ForbiddenException("Join the room first");
      // Members who dropped below the room's tier lose access to its game too.
      const room = await this.prisma.room.findUnique({
        where: { id: roomId },
        select: { accessType: true, minTier: true, maxMembers: true },
      });
      if (room?.accessType === "tier") {
        const elig = await this.eligibility.me(userId);
        if (!elig.tier || tierRank(elig.tier) < tierRank(room.minTier))
          throw new ForbiddenException(
            elig.tier
              ? `This room needs ${room.minTier} — you are ${elig.tier}`
              : "Verify your holdings in Profile to enter this room",
          );
      }
      if ((room?.maxMembers ?? ROOM_CAPACITY) > 2)
        throw new BadRequestException(
          "Chat rooms have no board — 1v1 rooms only",
        );
      if (members.length < 2)
        throw new BadRequestException("Waiting for your 1v1 peer to join");
      const [u1, u2] = [members[0].userId, members[1].userId];
      const existing = await this.prisma.match.findFirst({
        where: {
          OR: [
            { aUserId: u1, bUserId: u2 },
            { aUserId: u2, bUserId: u1 },
          ],
        },
        orderBy: { createdAt: "desc" },
        include: { games: { orderBy: { updatedAt: "desc" }, take: 1 } },
      });
      if (
        existing &&
        existing.games[0] &&
        existing.games[0].status === "open"
      ) {
        return { gameId: existing.games[0].id, matchId: existing.id };
      }
      const match = await this.prisma.match.create({
        data: { aUserId: u1, bUserId: u2, origin: "room" },
      });
      const game = await this.prisma.game.create({
        data: { matchId: match.id },
      });
      return { gameId: game.id, matchId: match.id };
    } finally {
      if (locked) await this.cache.unlock(lockKey);
    }
  }

  /**
   * Lightweight room header for the join gate (name, access rules, membership).
   * Never exposes inviteCodeHash — only isMember tells the client whether to
   * ask for a code at all.
   *
   * `canEnter`/`joinReason` carry the ENTRY verdict so the gate can explain
   * itself (low tier, room full, unverified) instead of a generic failure —
   * enforced for members too, so a holder who drops tier is locked out of a
   * room they created at a higher tier.
   */
  async meta(userId: string, roomId: string) {
    const [room, member, memberCount] = await Promise.all([
      this.prisma.room.findUnique({ where: { id: roomId } }),
      this.prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
      }),
      this.prisma.roomMember.count({ where: { roomId } }),
    ]);
    if (!room) throw new NotFoundException("Room not found");
    const creator = await this.prisma.user.findUnique({
      where: { id: room.createdBy },
      select: { id: true, handle: true },
    });
    const isMember = !!member;
    let joinReason: string | null = null;
    if (room.accessType === "tier") {
      const elig = await this.eligibility.me(userId);
      if (!elig.tier)
        joinReason = "Verify your holdings in Profile to enter this room";
      else if (tierRank(elig.tier) < tierRank(room.minTier))
        joinReason = `This room needs ${room.minTier} — you are ${elig.tier}`;
      else if (!holdsToken(elig, room.minToken))
        joinReason = `This room needs ${room.minToken} in your top holdings`;
    }
    const seats = room.maxMembers ?? ROOM_CAPACITY;
    if (!joinReason && !isMember && memberCount >= seats)
      joinReason = `Room is full (${memberCount}/${seats} seats taken)`;
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      imageUrl: room.imageUrl,
      accessType: room.accessType,
      minTier: room.minTier,
      minToken: room.minToken,
      maxMembers: seats,
      memberCount,
      onlineCount: this.presence.countInRoom(`room:${roomId}`),
      isMember,
      isOwner: room.createdBy === userId,
      canEnter: !joinReason,
      joinReason,
      creatorHandle: creator?.handle ?? `user_${room.createdBy.slice(-4)}`,
    };
  }

  async assertMember(userId: string, roomId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) throw new ForbiddenException("Join the room first");
  }
}
