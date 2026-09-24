import { Injectable, Logger } from "@nestjs/common";
import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokensService } from "../chat/tokens.service";
import { isDevnet } from "../common/tiers";

/**
 * Live onchain balances → USD.
 * - EVM wallets: native balance on EVM_RPC_URL (default: Sepolia) × cached ETH price.
 * - SOL wallets: native balance on SOL_RPC_URL (default: Solana devnet) × cached SOL price.
 * - BTC: not read onchain in v1 (devnet leaves BTC out entirely).
 * Prices come from TokensService's shared 5-min cache — no extra CoinGecko calls.
 * mockUsd is a devnet-only test hook (used by the route suite); the UI never sets it.
 */
@Injectable()
export class BalancesService {
  private readonly log = new Logger("BalancesService");
  private evmProvider: ethers.JsonRpcProvider | null = null;
  private solConnection: Connection | null = null;

  constructor(private readonly tokens: TokensService) {}

  private evm(): ethers.JsonRpcProvider {
    if (!this.evmProvider) {
      this.evmProvider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL ?? "https://rpc.sepolia.org");
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
        const wei = await this.evm().getBalance(address);
        const eth = Number(ethers.formatEther(wei));
        const price = await this.tokens.getPrice("ETH");
        return price ? eth * price : 0;
      }
      if (chain === "SOL") {
        const lamports = await this.sol().getBalance(new PublicKey(address));
        const price = await this.tokens.getPrice("SOL");
        return price ? (lamports / 1e9) * price : 0;
      }
    } catch (err) {
      this.log.warn(`Balance lookup failed ${chain}:${address.slice(0, 10)}… — counting $0`);
    }
    return 0;
  }
}
