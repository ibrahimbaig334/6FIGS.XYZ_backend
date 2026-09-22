import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function checkWinner(board: string): string | null {
  for (const [a, b, c] of LINES) {
    if (board[a] !== "." && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return null;
}

@Injectable()
export class GameService {
  constructor(private readonly prisma: PrismaService) {}

  private async load(gameId: string, userId: string) {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, include: { match: true } });
    if (!game) throw new NotFoundException("Game not found");
    if (game.match.aUserId !== userId && game.match.bUserId !== userId) {
      throw new ForbiddenException("Not your game");
    }
    return game;
  }

  private shape(game: { id: string; board: string; turn: string; status: string; winner: string | null; match: { aUserId: string; bUserId: string } }, userId: string) {
    const youAre = game.match.aUserId === userId ? "X" : "O";
    const oppId = game.match.aUserId === userId ? game.match.bUserId : game.match.aUserId;
    return { id: game.id, matchId: game.match ? (game as unknown as { matchId: string }).matchId : undefined, board: game.board, turn: game.turn, status: game.status, winner: game.winner, youAre, oppId };
  }

  async get(gameId: string, userId: string) {
    const game = await this.load(gameId, userId);
    const opp = await this.prisma.user.findUnique({ where: { id: this.shape(game, userId).oppId } });
    return {
      ...this.shape(game, userId),
      opponent: opp ? { id: opp.id, handle: opp.handle ?? `user_${opp.id.slice(-4)}`, visMode: opp.visMode, isBot: opp.isBot } : null,
    };
  }

  async move(gameId: string, userId: string, index: number) {
    const game = await this.load(gameId, userId);
    if (game.status !== "open") throw new BadRequestException("Game is over — rematch to play again");
    const mark = game.match.aUserId === userId ? "X" : "O";
    if (game.turn !== mark) throw new BadRequestException("Not your turn");
    if (!Number.isInteger(index) || index < 0 || index > 8 || game.board[index] !== ".") {
      throw new BadRequestException("Illegal move");
    }
    const board = game.board.slice(0, index) + mark + game.board.slice(index + 1);
    const winner = checkWinner(board);
    const status = winner ? "done" : board.includes(".") ? "open" : "draw";
    const updated = await this.prisma.game.update({
      where: { id: gameId },
      data: { board, winner, status, turn: mark === "X" ? "O" : "X" },
      include: { match: true },
    });
    return { ...this.shape(updated, userId), board, winner, status };
  }

  async rematch(gameId: string, userId: string) {
    await this.load(gameId, userId);
    const updated = await this.prisma.game.update({
      where: { id: gameId },
      data: { board: ".........", turn: "X", status: "open", winner: null },
      include: { match: true },
    });
    return this.shape(updated, userId);
  }
}
