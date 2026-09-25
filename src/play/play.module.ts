import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";
import { PlayGateway } from "./play.gateway";

@Module({
  imports: [AuthModule],
  controllers: [PlayController],
  providers: [PlayService, PlayGateway],
})
export class PlayModule {}
