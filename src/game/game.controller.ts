import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { GameService } from "./game.service";

@Controller("games")
@UseGuards(JwtGuard)
export class GameController {
  constructor(private readonly games: GameService) {}

  @Get(":id")
  get(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.games.get(id, userId);
  }

  /** Cheap opponent-presence probe for the "opponent left" overlay (no DB trips). */
  @Get(":id/live")
  live(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.games.live(id, userId);
  }

  /** Close an abandoned open game (opponent never returned) — kicks both out. */
  @Post(":id/close")
  close(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.games.close(id, userId);
  }
}
