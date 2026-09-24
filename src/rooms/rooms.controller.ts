import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { RoomsService } from "./rooms.service";

@Controller("rooms")
@UseGuards(JwtGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  list(
    @Query("q") q?: string,
    @Query("access") access?: string,
    @Query("sort") sort?: string,
    @Query("order") order?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.rooms.list({
      q,
      access,
      sort,
      order,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  create(@CurrentUser() userId: string, @Body() body: Record<string, unknown>) {
    return this.rooms.create(userId, body);
  }

  @Post(":id/join")
  join(@CurrentUser() userId: string, @Param("id") id: string, @Body() body: { code?: unknown }) {
    return this.rooms.join(userId, id, body.code);
  }

  @Get(":id/members")
  members(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.rooms.members(userId, id);
  }

  @Get(":id/game")
  game(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.rooms.game(userId, id);
  }
}
