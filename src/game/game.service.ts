import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceService } from "../presence/presence.service";

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function checkWinner(board: string): string | null {
  for (const [a, b, c] of LINES) {
    if (board[a] !== "." && board[a] === board[b] && board[b] === board[c])
      return board[a];
  }
  return null;
}

/** House bot: complete its own line, block yours, take center, else random. */
function botPick(board: string, mark: string): number {
  const cells = board.split("");
  const empties = cells
    .map((c, i) => (c === "." ? i : -1))
    .filter((i) => i >= 0);
  if (empties.length === 0) return -1;
  const complete = (m: string): number => {
    for (const [a, b, c] of LINES) {
      const line = [cells[a], cells[b], cells[c]];
      if (line.filter((x) => x === m).length === 2 && line.includes(".")) {
        const at = [a, b, c].find((i) => cells[i] === ".");
        if (at !== undefined) return at;
      }
    }
    return -1;
  };
  const win = complete(mark);
  if (win >= 0) return win;
  const block = complete(mark === "X" ? "O" : "X");
  if (block >= 0) return block;
  if (cells[4] === ".") return 4;
  return empties[Math.floor(Math.random() * empties.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Human-like pause before the house bot answers (ms, randomized per move).
const BOT_MOVE_DELAY_MIN_MS = 800;
const BOT_MOVE_DELAY_MAX_MS = 1600;

@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
  ) {}

  private async load(gameId: string, userId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { match: true },
    });
    if (!game) throw new NotFoundException("Game not found");
    if (game.match.aUserId !== userId && game.match.bUserId !== userId) {
      throw new ForbiddenException("Not your game");
    }
    return game;
  }

  private shape(
    game: {
      id: string;
      board: string;
      turn: string;
      status: string;
      winner: string | null;
      match: { aUserId: string; bUserId: string };
    },
    userId: string,
  ) {
    const youAre = game.match.aUserId === userId ? "X" : "O";
    const oppId =
      game.match.aUserId === userId ? game.match.bUserId : game.match.aUserId;
    return {
      id: game.id,
      matchId: game.match
        ? (game as unknown as { matchId: string }).matchId
        : undefined,
      board: game.board,
      turn: game.turn,
      status: game.status,
      winner: game.winner,
      youAre,
      oppId,
    };
  }

  async get(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    const opp = await this.prisma.user.findUnique({
      where: { id: this.shape(game, userId).oppId },
    });
    return {
      ...this.shape(game, userId),
      opponent: opp
        ? {
            id: opp.id,
            handle: opp.handle ?? `user_${opp.id.slice(-4)}`,
            visMode: opp.visMode,
          }
        : null,
    };
  }

  /** Opponent presence for the left-game countdown: global online plus
   *  whether they are actually ON the game page (memory-only, zero DB trips). */
  async live(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    const oppId =
      game.match.aUserId === userId ? game.match.bUserId : game.match.aUserId;
    // House bot has no socket: it is always "here", so presence-gated UI
    // (waiting text, board locks, return countdowns) never trips on it.
    const opp = await this.prisma.user.findUnique({
      where: { id: oppId },
      select: { isBot: true },
    });
    if (opp?.isBot) return { oppOnline: true, oppHere: true, oppInGame: true };
    return {
      oppOnline: this.presence.status(oppId).online,
      oppHere: this.presence.isInRoom(oppId, `dm:${game.matchId}`),
      oppInGame: this.presence.isInRoom(oppId, `game:${gameId}`),
    };
  }

  async move(gameId: string, userId: string, index: number) {
    const game = await this.load(gameId, userId);
    if (game.status === "closed")
      throw new BadRequestException("This game was closed");
    if (game.status !== "open")
      throw new BadRequestException("Game is over — rematch to play again");
    const mark = game.match.aUserId === userId ? "X" : "O";
    if (game.turn !== mark) throw new BadRequestException("Not your turn");
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 8 ||
      game.board[index] !== "."
    ) {
      throw new BadRequestException("Illegal move");
    }
    const board =
      game.board.slice(0, index) + mark + game.board.slice(index + 1);
    const winner = checkWinner(board);
    const status = winner ? "done" : board.includes(".") ? "open" : "draw";
    let final = await this.prisma.game.update({
      where: { id: gameId },
      data: { board, winner, status, turn: mark === "X" ? "O" : "X" },
      include: { match: true },
    });
    // House bot answers after a short human-like pause in the same
    // request: no polling, no presence needed. Win if it can, block if it
    // must, else a random seat.
    const oppId =
      final.match.aUserId === userId
        ? final.match.bUserId
        : final.match.aUserId;
    const opp = await this.prisma.user.findUnique({
      where: { id: oppId },
      select: { isBot: true },
    });
    if (opp?.isBot && final.status === "open") {
      const delay =
        BOT_MOVE_DELAY_MIN_MS +
        Math.random() * (BOT_MOVE_DELAY_MAX_MS - BOT_MOVE_DELAY_MIN_MS);
      await sleep(delay);
      const botMark = final.turn;
      const at = botPick(final.board, botMark);
      if (at >= 0) {
        const b2 =
          final.board.slice(0, at) + botMark + final.board.slice(at + 1);
        const w2 = checkWinner(b2);
        final = await this.prisma.game.update({
          where: { id: gameId },
          data: {
            board: b2,
            winner: w2,
            status: w2 ? "done" : b2.includes(".") ? "open" : "draw",
            turn: botMark === "X" ? "O" : "X",
          },
          include: { match: true },
        });
      }
    }
    return {
      ...this.shape(final, userId),
      board: final.board,
      winner: final.winner,
      status: final.status,
    };
  }

  async rematch(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    if (game.status === "closed")
      throw new BadRequestException("This game was closed");
    // Only finished games reset — crossed/stale offers can never wipe a live one.
    if (game.status === "open")
      throw new BadRequestException("Finish the current game first");
    const updated = await this.prisma.game.update({
      where: { id: gameId },
      data: { board: ".........", turn: "X", status: "open", winner: null },
      include: { match: true },
    });
    return this.shape(updated, userId);
  }

  /**
   * Close an abandoned game (opponent never returned): moves and rematches
   * reject afterwards, and both clients treat it as kicked-out (redirect).
   * Idempotent — closing a finished game just returns its state.
   */
  async close(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    if (game.status !== "open") return this.shape(game, userId);
    const updated = await this.prisma.game.update({
      where: { id: gameId },
      data: { board: game.board, turn: game.turn, status: "closed" },
      include: { match: true },
    });
    return this.shape(updated, userId);
  }

  /**
   * Validate a rematch OFFER (the reset itself happens only on accept):
   * finished games only, opponent must be ON the game page to get the toast
   * (globally online but elsewhere is NOT enough).
   * House-bot games reset INSTANTLY (the bot has no socket to accept) —
   * returns { instant: true, state } so the gateway can broadcast directly.
   */
  async offerRematch(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    if (game.status === "open")
      throw new BadRequestException("Finish the current game first");
    if (game.status === "closed")
      throw new BadRequestException("This game was closed");
    const oppId =
      game.match.aUserId === userId ? game.match.bUserId : game.match.aUserId;
    const [me, opp] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, handle: true },
      }),
      this.prisma.user.findUnique({
        where: { id: oppId },
        select: { id: true, handle: true, isBot: true },
      }),
    ]);
    if (opp?.isBot) {
      const updated = await this.prisma.game.update({
        where: { id: gameId },
        data: { board: ".........", turn: "X", status: "open", winner: null },
        include: { match: true },
      });
      return {
        toUserId: oppId,
        fromUserId: userId,
        fromHandle: me?.handle ?? `user_${userId.slice(-4)}`,
        toHandle: opp?.handle ?? `user_${oppId.slice(-4)}`,
        instant: true as const,
        state: this.shape(updated, userId),
      };
    }
    if (!this.presence.isInRoom(oppId, `game:${gameId}`))
      throw new BadRequestException("Opponent left the game");
    return {
      toUserId: oppId,
      fromUserId: userId,
      fromHandle: me?.handle ?? `user_${userId.slice(-4)}`,
      toHandle: opp?.handle ?? `user_${oppId.slice(-4)}`,
    };
  }
}
