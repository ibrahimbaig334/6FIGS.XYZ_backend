import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { PlayService } from "./play.service";
import { PlayGateway } from "./play.gateway";

@Controller("play")
@UseGuards(JwtGuard)
export class PlayController {
  constructor(
    private readonly play: PlayService,
    private readonly gateway: PlayGateway,
  ) {}

  @Get("online")
  online(
    @CurrentUser() userId: string,
    @Query("filter") filter?: string,
    @Query("q") q?: string,
  ) {
    return this.play.online(userId, filter || undefined, q);
  }

  @Post("queue")
  queue(@CurrentUser() userId: string) {
    return this.play.queue(userId);
  }

  @Get("queue/status")
  queueStatus(@CurrentUser() userId: string) {
    return this.play.queueStatus(userId);
  }

  @Delete("queue")
  queueCancel(@CurrentUser() userId: string) {
    return this.play.queueCancel(userId);
  }

  @Post("challenge")
  challenge(@CurrentUser() userId: string, @Body() body: { userId?: unknown }) {
    if (typeof body.userId !== "string" || !body.userId) {
      throw new BadRequestException("userId required");
    }
    return this.play.challenge(userId, body.userId);
  }

  @Get("friends")
  friends(@CurrentUser() userId: string, @Query("q") q?: string) {
    return this.play.friends(userId, q);
  }

  @Post("request")
  async request(@CurrentUser() userId: string, @Body() body: { userId?: unknown }) {
    if (typeof body.userId !== "string" || !body.userId) {
      throw new BadRequestException("userId required");
    }
    const req = await this.play.requestRoom(userId, body.userId);
    this.gateway.notifyUser(req.toUserId, "roomRequest", req);
    return req;
  }

  @Get("requests/incoming")
  incoming(@CurrentUser() userId: string) {
    return this.play.incoming(userId);
  }

  @Get("requests/outgoing")
  outgoing(@CurrentUser() userId: string) {
    return this.play.outgoing(userId);
  }

  @Get("requests/:id")
  oneRequest(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.play.getRequest(userId, id);
  }

  @Post("requests/:id/accept")
  async accept(@CurrentUser() userId: string, @Param("id") id: string) {
    const req = await this.play.accept(userId, id);
    this.gateway.notifyUser(req.fromUserId, "requestAccepted", { requestId: req.id, roomId: req.roomId });
    return req;
  }

  @Post("requests/:id/decline")
  async decline(@CurrentUser() userId: string, @Param("id") id: string) {
    const req = await this.play.decline(userId, id);
    this.gateway.notifyUser(req.fromUserId, "requestDeclined", { requestId: req.id });
    return req;
  }

  @Post("requests/:id/cancel")
  async cancel(@CurrentUser() userId: string, @Param("id") id: string) {
    const req = await this.play.cancel(userId, id);
    this.gateway.notifyUser(req.toUserId, "requestCancelled", { requestId: req.id });
    return req;
  }
}
