import { Injectable } from "@nestjs/common";
import { TeeService } from "../tee/tee.service";

export interface LegacyEligibility {
  source: "legacy";
  tier: null;
  walletCount: number;
  expiresAt: null;
}

/**
 * Eligibility is served only from stored attestations. Legacy live-balance
 * reads are gone with `Wallet.addressEnc`: wallet-only accounts authenticate
 * but get no tier until they prove through the tee. A tee read transparently
 * re-verifies on its TTL.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly tee: TeeService) {}

  private async walletCount(userId: string): Promise<number> {
    return this.tee.countWallets(userId);
  }

  private noTier(count: number): LegacyEligibility {
    return { source: "legacy", tier: null, walletCount: count, expiresAt: null };
  }

  /** Recompute (or refresh) the stored verification. */
  async check(userId: string) {
    const tee = await this.tee.refresh(userId, true).catch(() => null);
    if (tee) return tee;
    return this.noTier(await this.walletCount(userId));
  }

  /** Cached read with refresh-on-stale; never reads onchain balances. */
  async me(userId: string) {
    const tee = await this.tee.read(userId).catch(() => null);
    if (tee) return tee;
    return this.noTier(await this.walletCount(userId));
  }
}