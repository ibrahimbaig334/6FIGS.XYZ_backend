import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "./current-user";
import { JwtGuard } from "./jwt.guard";
import { EmailService } from "./email.service";

@Controller("auth/email")
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Post("signup")
  signup(@Body() body: { email?: string; password?: string }) {
    return this.email.signup(String(body.email ?? ""), String(body.password ?? ""));
  }

  @Post("login")
  login(@Body() body: { email?: string; password?: string }) {
    return this.email.login(String(body.email ?? ""), String(body.password ?? ""));
  }

  /** Link an email to the current (possibly wallet-only) account. */
  @Post("link")
  @UseGuards(JwtGuard)
  link(
    @CurrentUser() userId: string,
    @Body() body: { email?: string; password?: string },
  ) {
    return this.email.link(userId, String(body.email ?? ""), String(body.password ?? ""));
  }
}