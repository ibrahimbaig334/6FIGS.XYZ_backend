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

const VALID_TIERS = ["TIER I", "TIER II", "TIER III"];

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly presence: PresenceService,
    private readonly cache: CacheService,
  ) {}

  async list() {
    const hit = await this.cache.get<unknown[]>("rooms:list");
    if (hit) return hit;
    const rooms = await this.prisma.room.findMany({ include: { _count: { select: { members: true } } }, orderBy: { createdAt: "asc" } });
    const out = rooms.map((r) => ({
      id: r.id,
      name: r.name,
      imageUrl: r.imageUrl,
      accessType: r.accessType,
      minTier: r.minTier,
      memberCount: r._count.members,
      createdAt: r.createdAt,
    }));
    await this.cache.set("rooms:list", out, 15_000);
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
    await this.cache.del("rooms:list");
    return { id: room.id, name: room.name, accessType: room.accessType, minTier: room.minTier };
  }

  async join(userId: string, roomId: string, code?: unknown) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException("Room not found");
    const existing = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (existing) return { ok: true, roomId };
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
    await this.cache.del("rooms:list");
    return { ok: true, roomId };
  }

  async members(userId: string, roomId: string) {
    const member = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (!member) throw new ForbiddenException("Join the room first");
    const rows = await this.prisma.roomMember.findMany({ where: { roomId }, include: { user: true } });
    return rows.map((m) => ({
      id: m.user.id,
      handle: m.user.handle ?? `user_${m.user.id.slice(-4)}`,
      isBot: m.user.isBot,
      ...this.presence.status(m.user.id, m.user.isBot),
    }));
  }

  async assertMember(userId: string, roomId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({ where: { roomId_userId: { roomId, userId } } });
    if (!member) throw new ForbiddenException("Join the room first");
  }
}
