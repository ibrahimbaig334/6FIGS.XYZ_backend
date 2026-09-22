import { Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard, AuthedRequest } from "../auth/jwt.guard";
import { PlayService } from "./play.service";

@Controller("play")
export class PlayController {
  constructor(
    private readonly play: PlayService,
    private readonly auth: AuthService,
  ) {}

  @Get("online")
  online(
    @Req() req: AuthedRequest,
    @Query("filter") filter?: string,
    @Query("q") q?: string,
  ) {
    const selfId = this.auth.userIdFromHeader(req.headers.authorization);
    return this.play.online(selfId, filter || undefined, q);
  }

  @Post("queue")
  @UseGuards(JwtGuard)
  queue(@CurrentUser() userId: string) {
    return this.play.queue(userId);
  }
}
