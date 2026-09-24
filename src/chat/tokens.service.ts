import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";

export const TOKEN_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 60 * 1000;

export interface TokenCardData {
  status: "live" | "pending" | "stale" | "unknown";
  name: string;
  image?: string | null;
  price?: number | null;
  mcap?: number | null;
  vol24h?: number | null;
  change24h?: number | null;
  // NOTE: no holders field — CoinGecko free API exposes no holder counts.
}

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", USDC: "usd-coin", USDT: "tether",
  DOGE: "dogecoin", ARB: "arbitrum", OP: "optimism", LINK: "chainlink", AVAX: "avalanche-2",
  MATIC: "matic-network", POL: "matic-network", BNB: "binancecoin", XRP: "ripple", ADA: "cardano",
  TRX: "tron", TON: "the-open-network", NEAR: "near", ATOM: "cosmos", INJ: "injective-protocol",
  SUI: "sui", APT: "aptos", PEPE: "pepe", WIF: "dogwifcoin", BONK: "bonk",
  JUP: "jupiter-exchange-solana", WBTC: "wrapped-bitcoin", STETH: "staked-ether",
  DAI: "dai", UNI: "uniswap", AAVE: "aave",
};

/**
 * CoinGecko market-data provider.
 * Rate-limit strategy: every symbol is cached (Redis L1 + Postgres L2) for
 * 5 minutes, so repeated $TICKER mentions — and balance-to-USD conversions —
 * never hit the API more than once per symbol per 5 min. On 429/failure the
 * last stored row is served as `stale`.
 */
@Injectable()
export class TokensService {
  private readonly log = new Logger("TokensService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private headers(): Record<string, string> {
    const key = process.env.COINGECKO_API_KEY;
    return key ? { "x-cg-demo-api-key": key } : {};
  }

  private async resolveId(sym: string): Promise<string | null> {
    if (SYMBOL_TO_ID[sym]) return SYMBOL_TO_ID[sym];
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { coins?: { id: string; symbol: string }[] };
      const hit = data.coins?.find((c) => c.symbol?.toUpperCase() === sym) ?? data.coins?.[0];
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Full card with 5-min cache (Redis L1 + Postgres L2). Only `live` rows
   * refresh the clock; failures fall back to the stale row when present.
   */
  async getCard(symbol: string): Promise<{ card: TokenCardData; cached: boolean }> {
    const sym = symbol.toUpperCase().slice(0, 10);
    const mem = await this.cache.get<{ card: TokenCardData }>(`token:${sym}`);
    if (mem) return { card: mem.card, cached: true };
    const row = await this.prisma.tokenCardCache.findUnique({ where: { symbol: sym } });
    if (row && Date.now() - row.fetchedAt.getTime() < TOKEN_TTL_MS) {
      await this.cache.set(`token:${sym}`, { card: row.payload }, TOKEN_TTL_MS);
      return { card: row.payload as unknown as TokenCardData, cached: true };
    }
    const live = await this.fetchCard(sym);
    if (live && live.status === "live") {
      await this.prisma.tokenCardCache.upsert({
        where: { symbol: sym },
        create: { symbol: sym, payload: live as unknown as object },
        update: { payload: live as unknown as object, fetchedAt: new Date() },
      });
      await this.cache.set(`token:${sym}`, { card: live }, TOKEN_TTL_MS);
      return { card: live, cached: false };
    }
    if (live && live.status === "unknown") return { card: live, cached: false };
    if (row) {
      const stale = { ...(row.payload as object), status: "stale" } as TokenCardData;
      await this.cache.set(`token:${sym}`, { card: stale }, PENDING_TTL_MS);
      return { card: stale, cached: true };
    }
    const pending: TokenCardData = { status: "pending", name: sym };
    await this.cache.set(`token:${sym}`, { card: pending }, PENDING_TTL_MS);
    return { card: pending, cached: false };
  }

  /** Cached USD price for balance conversion — never triggers an extra
   * CoinGecko call beyond the shared 5-min cache above. */
  async getPrice(symbol: string): Promise<number | null> {
    const { card } = await this.getCard(symbol);
    return typeof card.price === "number" ? card.price : null;
  }

  async fetchCard(sym: string): Promise<TokenCardData | null> {
    const id = await this.resolveId(sym);
    if (!id) return { status: "unknown", name: sym };
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`,
        { headers: this.headers() },
      );
      if (res.status === 429) {
        this.log.warn("CoinGecko rate-limited — serving stale/pending");
        return null;
      }
      if (!res.ok) return null;
      const arr = (await res.json()) as {
        name: string;
        image?: string;
        current_price?: number;
        market_cap?: number;
        total_volume?: number;
        price_change_percentage_24h?: number;
      }[];
      const m = arr[0];
      if (!m) return { status: "unknown", name: sym };
      return {
        status: "live",
        name: m.name,
        image: m.image ?? null,
        price: m.current_price ?? null,
        mcap: m.market_cap ?? null,
        vol24h: m.total_volume ?? null,
        change24h: m.price_change_percentage_24h ?? null,
      };
    } catch (err) {
      this.log.warn(`CoinGecko fetch failed for $${sym}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
