import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { ProfileService } from "./profile.service";

@Controller("profile")
@UseGuards(JwtGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get("me")
  me(@CurrentUser() userId: string) {
    return this.profile.me(userId);
  }

  @Patch("me")
  update(@CurrentUser() userId: string, @Body() body: { handle?: unknown; visMode?: unknown }) {
    return this.profile.update(userId, body);
  }
}
