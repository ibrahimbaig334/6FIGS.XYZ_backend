import { Injectable, Logger } from "@nestjs/common";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokensService } from "../chat/tokens.service";
import { CacheService } from "../common/cache.service";
import { BAL_CACHE_MS } from "../common/constants";
import { requiredEnv } from "../common/env";
import { isDevnet } from "../common/tiers";

/**
 * Live onchain balances → USD (Solana only — EVM/BTC removed in the SOL-only build).
 * - SOL wallets: native balance on SOL_RPC_URL × cached SOL price.
 * Native balances sit in Redis for 10 min, so repeated profile/eligibility reads
 * never touch an RPC twice per address per 10 min; prices come from TokensService's
 * shared 5-min cache — no extra CoinGecko calls. Balance and price lookups run in
 * parallel. mockUsd is a devnet-only test hook (used by the route suite); the UI
 * never sets it.
 */
@Injectable()
export class BalancesService {
  private readonly log = new Logger("BalancesService");
  private solConnection: Connection | null = null;

  constructor(
    private readonly tokens: TokensService,
    private readonly cache: CacheService,
  ) {}

  private sol(): Connection {
    if (!this.solConnection) {
      this.solConnection = new Connection(
        requiredEnv("SOL_RPC_URL"),
        "confirmed",
      );
    }
    return this.solConnection;
  }

  async usdFor(
    chain: string,
    address: string,
    mockUsd: number | null,
  ): Promise<number> {
    if (isDevnet() && mockUsd !== null && mockUsd !== undefined) return mockUsd;
    try {
      if (chain === "SOL") {
        const [sol, price] = await Promise.all([
          this.solNative(address),
          this.tokens.getPrice("SOL"),
        ]);
        return price ? sol * price : 0;
      }
    } catch (err) {
      this.log.warn(
        `Balance lookup failed ${chain}:${address.slice(0, 10)}… — counting $0`,
      );
    }
    return 0;
  }

  private async cachedNative(
    key: string,
    fetch: () => Promise<number>,
  ): Promise<number> {
    let hit: number | undefined;
    try {
      const raw = await this.cache.get<string>(key);
      if (raw !== undefined) hit = Number(raw);
    } catch {
      hit = undefined; // Redis blip → fall through to RPC
    }
    if (hit !== undefined && Number.isFinite(hit)) return hit;
    const native = await fetch();
    try {
      await this.cache.set(key, String(native), BAL_CACHE_MS);
    } catch {
      /* cache write failure must not fail the lookup */
    }
    return native;
  }

  private solNative(address: string): Promise<number> {
    return this.cachedNative(`bal:SOL:${address}`, async () => {
      const lamports = await this.sol().getBalance(new PublicKey(address));
      return lamports / 1e9;
    });
  }
}
