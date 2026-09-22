import { Injectable } from "@nestjs/common";
import { Tier, tierOf } from "../common/tiers";

export interface TierInput {
  chain: string;
  mockUsd: number | null;
}

export interface TierResult {
  tier: Tier | null;
  total: number;
  assetPct: Record<string, number>;
  validUntil: Date;
}

/**
 * Seam for the future ZKP prover (PRD §9, deferred).
 * Today: tier = f(sum of devnet mock balances). Wallets with no mock
 * balance count as $0 — no balance source exists until ZKP lands.
 */
@Injectable()
export class MockTierService {
  async verify(wallets: TierInput[]): Promise<TierResult> {
    const total = wallets.reduce((s, w) => s + (w.mockUsd ?? 0), 0);
    const perChain: Record<string, number> = {};
    for (const w of wallets) perChain[w.chain] = (perChain[w.chain] ?? 0) + (w.mockUsd ?? 0);
    const assetPct: Record<string, number> = {};
    if (total > 0) {
      for (const [chain, v] of Object.entries(perChain)) {
        assetPct[chain] = Math.round((v / total) * 100);
      }
    }
    return { tier: tierOf(total), total, assetPct, validUntil: new Date(Date.now() + 24 * 3600 * 1000) };
  }
}
