import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MockTierService } from "./tiers.service";

@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiers: MockTierService,
  ) {}

  /** Recompute from current wallets and refresh the cache row. */
  async check(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    const res = await this.tiers.verify(wallets.map((w) => ({ chain: w.chain, mockUsd: w.mockUsd })));
    if (!res.tier) {
      await this.prisma.eligibilityCache.deleteMany({ where: { userId } });
      return { tier: null, total: res.total, assetPct: res.assetPct, expiresAt: null, walletCount: wallets.length };
    }
    const row = await this.prisma.eligibilityCache.upsert({
      where: { userId },
      create: { userId, tier: res.tier, assetPct: res.assetPct, expiresAt: res.validUntil },
      update: { tier: res.tier, assetPct: res.assetPct, verifiedAt: new Date(), expiresAt: res.validUntil },
    });
    return { tier: row.tier, total: res.total, assetPct: res.assetPct, expiresAt: row.expiresAt, walletCount: wallets.length };
  }

  /** Cached read with refresh-on-stale (every cache refresh re-verifies). */
  async me(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    const cached = await this.prisma.eligibilityCache.findUnique({ where: { userId } });
    if (cached && cached.expiresAt > new Date()) {
      const total = wallets.reduce((s, w) => s + (w.mockUsd ?? 0), 0);
      return { tier: cached.tier, total, assetPct: cached.assetPct, expiresAt: cached.expiresAt, walletCount: wallets.length };
    }
    return this.check(userId);
  }
}
