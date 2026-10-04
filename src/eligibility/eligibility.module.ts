import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TokensModule } from "../chat/tokens.module";
import { TeeModule } from "../tee/tee.module";
import { EligibilityController } from "./eligibility.controller";
import { EligibilityService } from "./eligibility.service";

@Module({
  imports: [AuthModule, TokensModule, TeeModule],
  controllers: [EligibilityController],
  providers: [EligibilityService],
  exports: [EligibilityService],
})
export class EligibilityModule {}
