import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EligibilityController } from "./eligibility.controller";
import { EligibilityService } from "./eligibility.service";
import { MockTierService } from "./tiers.service";

@Module({
  imports: [AuthModule],
  controllers: [EligibilityController],
  providers: [EligibilityService, MockTierService],
  exports: [EligibilityService],
})
export class EligibilityModule {}
