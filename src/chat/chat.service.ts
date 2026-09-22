import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RoomsService } from "../rooms/rooms.service";
import { CacheService } from "../common/cache.service";
import { TokenCardData, TokensService } from "./tokens.service";

export function extractTickers(text: string): string[] {
  const out: string[] = [];
  const re = /\$([A-Za-z]{2,10})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[1].toUpperCase();
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 3);
}

const CARD_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 60 * 1000;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
    private readonly cache: CacheService,
    private readonly tokens: TokensService,
  ) {}

  async assertScopeAccess(userId: string, scope: string, scopeId: string): Promise<void> {
    if (scope === "room") {
      await this.rooms.assertMember(userId, scopeId);
      return;
    }
    if (scope === "dm") {
      const match = await this.prisma.match.findUnique({ where: { id: scopeId } });
      if (!match || (match.aUserId !== userId && match.bUserId !== userId)) {
        throw new ForbiddenException("Not your conversation");
      }
      return;
    }
    throw new BadRequestException("scope must be dm or room");
  }

  async history(userId: string, scope: string, scopeId: string, cursor?: string, limit = 50) {
    await this.assertScopeAccess(userId, scope, scopeId);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const rows = await this.prisma.message.findMany({
      where: { scope, scopeId, ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}) },
      include: { sender: true },
      orderBy: { createdAt: "desc" },
      take,
    });
    const items = rows.reverse().map((m) => this.shape(m, m.sender.handle));
    return { items, nextCursor: rows.length ? rows[0].createdAt.toISOString() : null };
  }

  async post(userId: string, scope: string, scopeId: string, body: string) {
    const text = body.trim().slice(0, 240);
    if (!text) throw new BadRequestException("Empty message");
    await this.assertScopeAccess(userId, scope, scopeId);
    const sender = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const msg = await this.prisma.message.create({ data: { scope, scopeId, senderId: userId, body: text } });
    const tickers = extractTickers(text);
    return { message: this.shape(msg, sender.handle), tickers };
  }

  /**
   * Token card via CoinGecko. Cache policy: one CoinGecko call per symbol per
   * 5 minutes max (L1 memory/Redis + L2 Postgres). On failure/429 the last
   * stored row is served as `stale` instead of erroring.
   */
  async tokenCard(symbol: string) {
    const sym = symbol.toUpperCase().slice(0, 10);
    const mem = await this.cache.get<{ card: TokenCardData }>(`token:${sym}`);
    if (mem) return { symbol: sym, card: mem.card, cached: true };
    const row = await this.prisma.tokenCardCache.findUnique({ where: { symbol: sym } });
    const fresh = row && Date.now() - row.fetchedAt.getTime() < CARD_TTL_MS;
    if (fresh) {
      await this.cache.set(`token:${sym}`, { card: row.payload }, CARD_TTL_MS);
      return { symbol: sym, card: row.payload, cached: true };
    }
    const live = await this.tokens.fetchCard(sym);
    if (live && live.status === "live") {
      await this.prisma.tokenCardCache.upsert({
        where: { symbol: sym },
        create: { symbol: sym, payload: live as unknown as object },
        update: { payload: live as unknown as object, fetchedAt: new Date() },
      });
      await this.cache.set(`token:${sym}`, { card: live }, CARD_TTL_MS);
      return { symbol: sym, card: live, cached: false };
    }
    if (live && live.status === "unknown") {
      return { symbol: sym, card: live, cached: false };
    }
    // Fetch failed / rate-limited: serve stale row if we have one.
    if (row) {
      const stale = { ...(row.payload as object), status: "stale" };
      await this.cache.set(`token:${sym}`, { card: stale }, PENDING_TTL_MS);
      return { symbol: sym, card: stale, cached: true };
    }
    const pending: TokenCardData = { status: "pending", name: sym };
    await this.cache.set(`token:${sym}`, { card: pending }, PENDING_TTL_MS);
    return { symbol: sym, card: pending, cached: false };
  }

  private shape(
    m: { id: string; scope: string; scopeId: string; senderId: string; body: string; createdAt: Date },
    handle: string | null,
  ) {
    return {
      id: m.id,
      scope: m.scope,
      scopeId: m.scopeId,
      senderId: m.senderId,
      senderHandle: handle ?? `user_${m.senderId.slice(-4)}`,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
