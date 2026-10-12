import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";
import {
  COINGECKO_API,
  TOKEN_CACHE_MS,
  TOKEN_PENDING_MS,
} from "../common/constants";

export const TOKEN_TTL_MS = TOKEN_CACHE_MS;
const PENDING_TTL_MS = TOKEN_PENDING_MS;

export interface TokenCardData {
  status: "live" | "pending" | "stale" | "unknown";
  name: string;
  image?: string | null;
  price?: number | null;
  mcap?: number | null;
  vol24h?: number | null;
  change24h?: number | null;
  /** QuickChart 7d candle PNG (test feature — zero infra, rendered from URL). */
  chartUrl?: string | null;
  // NOTE: no holders field — CoinGecko free API exposes no holder counts.
}

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  USDC: "usd-coin",
  USDT: "tether",
  DOGE: "dogecoin",
  ARB: "arbitrum",
  OP: "optimism",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  POL: "matic-network",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  TRX: "tron",
  TON: "the-open-network",
  NEAR: "near",
  ATOM: "cosmos",
  INJ: "injective-protocol",
  SUI: "sui",
  APT: "aptos",
  PEPE: "pepe",
  WIF: "dogwifcoin",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  WBTC: "wrapped-bitcoin",
  STETH: "staked-ether",
  DAI: "dai",
  UNI: "uniswap",
  AAVE: "aave",
};

/**
 * CoinGecko market-data provider.
 * Rate-limit strategy: every symbol is cached (Redis L1 + Postgres L2) for
 * 5 minutes, so repeated $TICKER mentions — and balance-to-USD conversions —
 * never hit the API more than twice per symbol per 5 min (card + 7d chart,
 * fetched together). On 429/failure the last stored row is served as `stale`.
 */
@Injectable()
export class TokensService {
  private readonly log = new Logger("TokensService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private headers(): Record<string, string> {
    const key = (process.env.COINGECKO_API_KEY ?? "").trim();
    return key ? { "x-cg-demo-api-key": key } : {};
  }

  private async resolveId(sym: string): Promise<string | null> {
    if (SYMBOL_TO_ID[sym]) return SYMBOL_TO_ID[sym];
    try {
      const res = await fetch(
        `${COINGECKO_API}/search?query=${encodeURIComponent(sym)}`,
        {
          headers: this.headers(),
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        coins?: { id: string; symbol: string }[];
      };
      const hit =
        data.coins?.find((c) => c.symbol?.toUpperCase() === sym) ??
        data.coins?.[0];
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Full card with 5-min cache (Redis L1 + Postgres L2). Only `live` rows
   * refresh the clock; failures fall back to the stale row when present.
   */
  async getCard(
    symbol: string,
  ): Promise<{ card: TokenCardData; cached: boolean }> {
    const sym = symbol.toUpperCase().slice(0, 10);
    const mem = await this.cache.get<{ card: TokenCardData }>(`token:${sym}`);
    if (mem) return { card: mem.card, cached: true };
    const row = await this.prisma.tokenCardCache.findUnique({
      where: { symbol: sym },
    });
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
      const stale = {
        ...(row.payload as object),
        status: "stale",
      } as TokenCardData;
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
    // Markets + 7d chart in parallel (chart never blocks the card); one
    // retry on 429 since a fresh symbol costs 2 calls in one burst.
    const [markets, chartUrl] = await Promise.all([
      this.fetchMarkets(id, sym),
      this.fetchChart(id, true),
    ]);
    if (!markets) return null;
    return { status: "live", ...markets, chartUrl };
  }

  private async fetchMarkets(
    id: string,
    sym: string,
  ): Promise<Omit<TokenCardData, "chartUrl" | "status"> | null> {
    try {
      const res = await fetch(
        `${COINGECKO_API}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`,
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
      if (!m) return null;
      return {
        name: m.name,
        image: m.image ?? null,
        price: m.current_price ?? null,
        mcap: m.market_cap ?? null,
        vol24h: m.total_volume ?? null,
        change24h: m.price_change_percentage_24h ?? null,
      };
    } catch (err) {
      this.log.warn(
        `CoinGecko fetch failed for $${sym}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 7-day candles as a QuickChart PNG URL (test feature). Candlesticks need
   * Chart.js v3 (`&version=3`); OHLC comes from CoinGecko's ohlc endpoint.
   * Best-effort: any failure returns null and the card renders without art.
   * Same 5-min cache as the card (built once per fetchCard).
   */
  private async fetchChart(id: string, retry = false): Promise<string | null> {
    try {
      const res = await fetch(
        `${COINGECKO_API}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=7`,
        { headers: this.headers() },
      );
      if (res.status === 429 && !retry) {
        await this.sleep(1200);
        return this.fetchChart(id, true);
      }
      if (!res.ok) return null;
      const rows = (await res.json()) as [
        number,
        number,
        number,
        number,
        number,
      ][];
      const valid = (Array.isArray(rows) ? rows : []).filter(
        (r) =>
          Array.isArray(r) &&
          r.length >= 5 &&
          r.slice(1, 5).every((n) => Number.isFinite(n)),
      );
      if (valid.length < 2) return null;
      const step = Math.max(1, Math.floor(valid.length / 40));
      const candles = valid
        .filter((_, i) => i % step === 0)
        .map(([, o, h, l, c], i) => ({ t: i, o, h, l, c }));
      // Wicks (thin ink range) + bodies (thick green/red range) as two
      // datasets with grouped:false, so each pair overlaps centered.
      // Explicit y bounds: flat data (stables) would otherwise give the
      // scale a zero range and render an error tile.
      const wicks = candles.map((k) => [k.l, k.h]);
      const bodies = candles.map((k) => [
        Math.min(k.o, k.c),
        Math.max(k.o, k.c),
      ]);
      const ups = candles.map((k) => k.c >= k.o);
      let lo = Math.min(...candles.map((k) => k.l));
      let hi = Math.max(...candles.map((k) => k.h));
      if (!(hi > lo)) {
        lo *= 0.99;
        hi *= 1.01;
      }
      const pad = (hi - lo) * 0.04;
      const cfg = {
        type: "bar",
        data: {
          labels: candles.map((_, i) => i),
          datasets: [
            {
              data: wicks,
              backgroundColor: "#121212",
              barThickness: 3,
              categoryPercentage: 1.0,
              grouped: false,
            },
            {
              data: bodies,
              backgroundColor: ups.map((u) => (u ? "#1a7f37" : "#ed3d2b")),
              barThickness: 10,
              categoryPercentage: 1.0,
              grouped: false,
            },
          ],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { display: false },
            y: { display: false, min: lo - pad, max: hi + pad },
          },
          animation: false,
        },
      };
      return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&backgroundColor=transparent&width=600&height=220&version=3`;
    } catch (err) {
      this.log.warn(
        `CoinGecko chart fetch failed for ${id}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
