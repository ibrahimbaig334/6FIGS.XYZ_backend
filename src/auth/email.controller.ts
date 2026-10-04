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

  /** Consume an emailed verification link. */
  @Post("verify")
  verify(@Body() body: { token?: string }) {
    return this.email.verify(String(body.token ?? ""));
  }

  /** Re-send the verification email for the current account. */
  @Post("resend-verification")
  @UseGuards(JwtGuard)
  resendVerification(@CurrentUser() userId: string) {
    return this.email.resendVerification(userId);
  }

  /** Start a password reset; always returns the same generic response. */
  @Post("forgot")
  forgot(@Body() body: { email?: string }) {
    return this.email.forgot(String(body.email ?? ""));
  }

  /** Finish a password reset with the emailed token. */
  @Post("reset")
  reset(@Body() body: { token?: string; password?: string }) {
    return this.email.reset(String(body.token ?? ""), String(body.password ?? ""));
  }

  /** Rotate the password for the current session. */
  @Post("change-password")
  @UseGuards(JwtGuard)
  changePassword(
    @CurrentUser() userId: string,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    return this.email.changePassword(
      userId,
      String(body.currentPassword ?? ""),
      String(body.newPassword ?? ""),
    );
  }
}