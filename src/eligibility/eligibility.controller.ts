import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { EligibilityService } from "./eligibility.service";

@Controller("eligibility")
@UseGuards(JwtGuard)
export class EligibilityController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get("user")
  user(@CurrentUser() userId: string) {
    return this.eligibility.me(userId);
  }

  @Post("check")
  check(@CurrentUser() userId: string) {
    // Tee path always recomputes (enclave recheck); the old force flag only
    // controlled the removed RPC balance cache and no longer applies.
    return this.eligibility.check(userId);
  }
}
