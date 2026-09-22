import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";

@Module({
  imports: [AuthModule],
  controllers: [PlayController],
  providers: [PlayService],
})
export class PlayModule {}
