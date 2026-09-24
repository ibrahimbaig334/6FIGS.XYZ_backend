import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { PlayService } from "./play.service";

@Controller("play")
export class PlayController {
  constructor(private readonly play: PlayService) {}

  @Get("online")
  @UseGuards(JwtGuard)
  online(
    @CurrentUser() userId: string,
    @Query("filter") filter?: string,
    @Query("q") q?: string,
  ) {
    return this.play.online(userId, filter || undefined, q);
  }

  @Post("queue")
  @UseGuards(JwtGuard)
  queue(@CurrentUser() userId: string) {
    return this.play.queue(userId);
  }

  @Post("challenge")
  @UseGuards(JwtGuard)
  challenge(@CurrentUser() userId: string, @Body() body: { userId?: unknown }) {
    if (typeof body.userId !== "string" || !body.userId) {
      throw new BadRequestException("userId required");
    }
    return this.play.challenge(userId, body.userId);
  }
}
