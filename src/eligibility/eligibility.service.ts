import { Injectable } from "@nestjs/common";
import { Wallet } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { tierOf } from "../common/tiers";
import { BalancesService } from "./balances.service";

export interface WalletBalance {
  walletId: string;
  chain: string;
  usd: number;
}

@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
  ) {}

  private async valueWallets(wallets: Pick<Wallet, "id" | "chain" | "addressEnc" | "mockUsd">[]): Promise<{ balances: WalletBalance[]; total: number }> {
    const balances = await Promise.all(
      wallets.map(async (w) => ({
        walletId: w.id,
        chain: w.chain,
        usd: await this.balances.usdFor(w.chain, this.decode(w.addressEnc), w.mockUsd),
      })),
    );
    return { balances, total: balances.reduce((s, b) => s + b.usd, 0) };
  }

  private decode(enc: string | null): string {
    try {
      return enc ? Buffer.from(enc, "base64url").toString("utf8") : "";
    } catch {
      return "";
    }
  }

  /** Recompute from live onchain balances and refresh the cache row. */
  async check(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    return this.checkWith(userId, wallets);
  }

  private async checkWith(userId: string, wallets: Pick<Wallet, "id" | "chain" | "addressEnc" | "mockUsd">[]) {
    const { balances, total } = await this.valueWallets(wallets);
    const tier = tierOf(total);
    const perChain: Record<string, number> = {};
    for (const b of balances) perChain[b.chain] = (perChain[b.chain] ?? 0) + b.usd;
    const assetPct: Record<string, number> = {};
    if (total > 0) {
      for (const [chain, v] of Object.entries(perChain)) assetPct[chain] = Math.round((v / total) * 100);
    }
    if (!tier) {
      await this.prisma.eligibilityCache.deleteMany({ where: { userId } });
      return { tier: null, total, assetPct, balances, expiresAt: null, walletCount: balances.length };
    }
    const row = await this.prisma.eligibilityCache.upsert({
      where: { userId },
      create: { userId, tier, assetPct, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
      update: { tier, assetPct, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
    });
    return { tier: row.tier, total, assetPct, balances, expiresAt: row.expiresAt, walletCount: balances.length };
  }

  /**
   * Cached read with refresh-on-stale (every cache refresh re-verifies).
   * Cache row + wallets load in parallel; callers holding wallets pass them
   * in to skip the duplicate query.
   */
  async me(userId: string, preloaded?: Pick<Wallet, "id" | "chain" | "addressEnc" | "mockUsd">[]) {
    const cachedP = this.prisma.eligibilityCache.findUnique({ where: { userId } });
    const walletsP = preloaded ? Promise.resolve(preloaded) : this.prisma.wallet.findMany({ where: { userId } });
    const [cached, wallets] = await Promise.all([cachedP, walletsP]);
    if (cached && cached.expiresAt > new Date()) {
      const { balances, total } = await this.valueWallets(wallets);
      return {
        tier: cached.tier,
        total,
        assetPct: cached.assetPct as unknown as Record<string, number>,
        balances,
        expiresAt: cached.expiresAt,
        walletCount: balances.length,
      };
    }
    return this.checkWith(userId, wallets);
  }
}
