import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RoomsService } from "../rooms/rooms.service";
import { TokensService } from "./tokens.service";

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

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
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
    let cursorDate: Date | undefined;
    if (cursor) {
      cursorDate = new Date(cursor);
      if (Number.isNaN(cursorDate.getTime())) throw new BadRequestException("Invalid cursor");
    }
    const rows = await this.prisma.message.findMany({
      where: { scope, scopeId, ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}) },
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
    if (scope === "dm") await this.maybeBefriend(scopeId);
    return { message: this.shape(msg, sender.handle), tickers };
  }

  /**
   * Friendship rule: a random-matched pair becomes friends once BOTH sides have
   * sent at least one message in their shared DM.
   */
  private async maybeBefriend(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match || match.origin !== "random") return;
    const rows = await this.prisma.message.findMany({ where: { scope: "dm", scopeId: matchId }, select: { senderId: true } });
    if (new Set(rows.map((r) => r.senderId)).size < 2) return;
    const [a, b] = [match.aUserId, match.bUserId].sort();
    await this.prisma.friendship.upsert({
      where: { aUserId_bUserId: { aUserId: a, bUserId: b } },
      update: {},
      create: { aUserId: a, bUserId: b },
    });
  }

  /** Token card — delegates to TokensService (shared 5-min CoinGecko cache). */
  async tokenCard(symbol: string) {
    const sym = symbol.toUpperCase().slice(0, 10);
    const { card, cached } = await this.tokens.getCard(sym);
    return { symbol: sym, card, cached };
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
