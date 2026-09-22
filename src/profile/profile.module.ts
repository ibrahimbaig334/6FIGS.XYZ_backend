import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EligibilityModule } from "../eligibility/eligibility.module";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";

@Module({
  imports: [AuthModule, EligibilityModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
