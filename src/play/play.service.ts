import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceService } from "../presence/presence.service";

@Injectable()
export class PlayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  private async requireTier(userId: string): Promise<void> {
    const cache = await this.prisma.eligibilityCache.findUnique({ where: { userId } });
    if (!cache || cache.expiresAt <= new Date()) {
      throw new ForbiddenException("Verify ≥ $100K in Profile first");
    }
  }

  /** Verified-holders directory (fresh tiers only). */
  async online(selfId: string | null, filter?: string, q?: string) {
    const rows = await this.prisma.eligibilityCache.findMany({
      where: { expiresAt: { gt: new Date() }, ...(filter ? { tier: filter } : {}) },
      include: { user: true },
      orderBy: { verifiedAt: "desc" },
      take: 100,
    });
    const query = (q ?? "").toLowerCase();
    return rows
      .filter((r) => r.userId !== selfId)
      .filter((r) => !query || (r.user.handle ?? "").toLowerCase().includes(query))
      .map((r) => ({
        id: r.user.id,
        handle: r.user.handle ?? `user_${r.user.id.slice(-4)}`,
        tier: r.tier,
        visMode: r.user.visMode,
        tags: r.user.tags,
        ...this.presence.status(r.user.id),
      }));
  }

  /** Random queue → match + game. X = requester. */
  async queue(selfId: string) {
    await this.requireTier(selfId);
    const pool = await this.online(selfId);
    if (!pool.length) throw new BadRequestException("No verified opponents online — seed devnet or invite someone");
    const opponent = pool[Math.floor(Math.random() * pool.length)];
    return this.openMatch(selfId, opponent.id, opponent);
  }

  /** Challenge a specific verified holder (Play page "with friends" row button). */
  async challenge(selfId: string, targetId: string) {
    await this.requireTier(selfId);
    if (targetId === selfId) throw new BadRequestException("You cannot challenge yourself");
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new BadRequestException("Unknown holder");
    const cache = await this.prisma.eligibilityCache.findUnique({ where: { userId: targetId } });
    if (!cache || cache.expiresAt <= new Date()) {
      throw new BadRequestException("That holder is not verified right now");
    }
    return this.openMatch(selfId, targetId, {
      id: target.id,
      handle: target.handle ?? `user_${target.id.slice(-4)}`,
      tier: cache.tier,
      visMode: target.visMode,
      tags: target.tags,
    });
  }

  private async openMatch(selfId: string, oppId: string, opponent: object) {
    const match = await this.prisma.match.create({ data: { aUserId: selfId, bUserId: oppId } });
    const game = await this.prisma.game.create({ data: { matchId: match.id } });
    return { matchId: match.id, gameId: game.id, youAre: "X", opponent };
  }
}
