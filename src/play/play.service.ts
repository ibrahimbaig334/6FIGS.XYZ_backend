import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceService } from "../presence/presence.service";

@Injectable()
export class PlayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

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
        isBot: r.user.isBot,
        ...this.presence.status(r.user.id, r.user.isBot),
      }));
  }

  /** Random queue → match + game. X = requester. */
  async queue(selfId: string) {
    const pool = await this.online(selfId);
    if (!pool.length) throw new BadRequestException("No verified opponents online — seed devnet or invite someone");
    const opponent = pool[Math.floor(Math.random() * pool.length)];
    const match = await this.prisma.match.create({ data: { aUserId: selfId, bUserId: opponent.id } });
    const game = await this.prisma.game.create({ data: { matchId: match.id } });
    return { matchId: match.id, gameId: game.id, youAre: "X", opponent };
  }
}
