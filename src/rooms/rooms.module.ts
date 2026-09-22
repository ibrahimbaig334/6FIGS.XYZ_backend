import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EligibilityModule } from "../eligibility/eligibility.module";
import { RoomsController } from "./rooms.controller";
import { RoomsService } from "./rooms.service";

@Module({
  imports: [AuthModule, EligibilityModule],
  controllers: [RoomsController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
