import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
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
  check(@CurrentUser() userId: string, @Body() body: { force?: unknown }) {
    return this.eligibility.check(userId, body?.force === true);
  }
}
