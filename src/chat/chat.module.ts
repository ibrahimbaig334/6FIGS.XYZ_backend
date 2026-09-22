import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RoomsModule } from "../rooms/rooms.module";
import { ChatController } from "./chat.controller";
import { ChatGateway } from "./chat.gateway";
import { ChatService } from "./chat.service";
import { TokensService } from "./tokens.service";

@Module({
  imports: [AuthModule, RoomsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, TokensService],
})
export class ChatModule {}
