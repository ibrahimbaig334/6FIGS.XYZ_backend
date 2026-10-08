import { Injectable } from "@nestjs/common";
import { TeeService } from "../tee/tee.service";

export interface NoTierEligibility {
  source: "none";
  tier: null;
  walletCount: number;
  expiresAt: null;
}

/**
 * Eligibility is served only from stored attestations. With the legacy
 * `Wallet` table gone, an account has no tier until it proves through the
 * tee. A tee read transparently re-verifies on its TTL.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly tee: TeeService) {}

  private noTier(): NoTierEligibility {
    return { source: "none", tier: null, walletCount: 0, expiresAt: null };
  }

  /** Recompute (or refresh) the stored verification. */
  async check(userId: string) {
    const tee = await this.tee.refresh(userId, true).catch(() => null);
    return tee ?? this.noTier();
  }

  /** Cached read with refresh-on-stale; never reads onchain balances. */
  async me(userId: string) {
    const tee = await this.tee.read(userId).catch(() => null);
    return tee ?? this.noTier();
  }
}
