import { Injectable, Logger } from "@nestjs/common";
import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokensService } from "../chat/tokens.service";
import { CacheService } from "../common/cache.service";
import { isDevnet } from "../common/tiers";

/** Native chain balances are reusable for 10 min (ZKP replaces this anyway). */
export const BAL_TTL_MS = 10 * 60 * 1000;

/**
 * Live onchain balances → USD.
 * - EVM wallets: native balance on EVM_RPC_URL (default: PublicNode Sepolia) × cached ETH price.
 * - SOL wallets: native balance on SOL_RPC_URL (default: Solana devnet) × cached SOL price.
 * - BTC: not read onchain in v1 (devnet leaves BTC out entirely).
 * Native balances sit in Redis for 10 min, so repeated profile/eligibility reads
 * never touch an RPC twice per address per 10 min; prices come from TokensService's
 * shared 5-min cache — no extra CoinGecko calls. Balance and price lookups run in
 * parallel. mockUsd is a devnet-only test hook (used by the route suite); the UI
 * never sets it.
 */
@Injectable()
export class BalancesService {
  private readonly log = new Logger("BalancesService");
  private evmProvider: ethers.JsonRpcProvider | null = null;
  private solConnection: Connection | null = null;

  constructor(
    private readonly tokens: TokensService,
    private readonly cache: CacheService,
  ) {}

  private evm(): ethers.JsonRpcProvider {
    if (!this.evmProvider) {
      // PublicNode is the default because rpc.sepolia.org is unreliable;
      // override with EVM_RPC_URL (e.g. Alchemy/Infura) anytime.
      this.evmProvider = new ethers.JsonRpcProvider(
        process.env.EVM_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
      );
    }
    return this.evmProvider;
  }

  private sol(): Connection {
    if (!this.solConnection) {
      this.solConnection = new Connection(process.env.SOL_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    }
    return this.solConnection;
  }

  async usdFor(chain: string, address: string, mockUsd: number | null): Promise<number> {
    if (isDevnet() && mockUsd !== null && mockUsd !== undefined) return mockUsd;
    try {
      if (chain === "EVM") {
        const [eth, price] = await Promise.all([this.evmNative(address), this.tokens.getPrice("ETH")]);
        return price ? eth * price : 0;
      }
      if (chain === "SOL") {
        const [sol, price] = await Promise.all([this.solNative(address), this.tokens.getPrice("SOL")]);
        return price ? sol * price : 0;
      }
    } catch (err) {
      this.log.warn(`Balance lookup failed ${chain}:${address.slice(0, 10)}… — counting $0`);
    }
    return 0;
  }

  private async cachedNative(key: string, fetch: () => Promise<number>): Promise<number> {
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
      await this.cache.set(key, String(native), BAL_TTL_MS);
    } catch {
      /* cache write failure must not fail the lookup */
    }
    return native;
  }

  private evmNative(address: string): Promise<number> {
    return this.cachedNative(`bal:EVM:${address}`, async () => {
      const wei = await this.evm().getBalance(address);
      return Number(ethers.formatEther(wei));
    });
  }

  private solNative(address: string): Promise<number> {
    return this.cachedNative(`bal:SOL:${address}`, async () => {
      const lamports = await this.sol().getBalance(new PublicKey(address));
      return lamports / 1e9;
    });
  }
}
