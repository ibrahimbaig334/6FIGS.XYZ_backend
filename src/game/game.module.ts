import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";

@Module({
  imports: [AuthModule],
  controllers: [GameController],
  providers: [GameService, GameGateway],
})
export class GameModule {}
