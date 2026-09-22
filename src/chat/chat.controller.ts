import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { ChatService } from "./chat.service";

@Controller("chat")
@UseGuards(JwtGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get("tokens/:symbol")
  token(@Param("symbol") symbol: string) {
    return this.chat.tokenCard(symbol);
  }

  @Get(":scope/:id")
  history(
    @CurrentUser() userId: string,
    @Param("scope") scope: string,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.chat.history(userId, scope, id, cursor, limit ? Number(limit) : undefined);
  }
}
