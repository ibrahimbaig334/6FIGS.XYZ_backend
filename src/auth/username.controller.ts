import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "./current-user";
import { JwtGuard } from "./jwt.guard";
import { UsernameService } from "./username.service";

@Controller("auth/username")
export class UsernameController {
  constructor(private readonly username: UsernameService) {}

  /** Attach a username + password to the current account (profile). */
  @Post("setup")
  @UseGuards(JwtGuard)
  setup(
    @CurrentUser() userId: string,
    @Body() body: { username?: string; password?: string },
  ) {
    return this.username.setup(
      userId,
      String(body.username ?? ""),
      String(body.password ?? ""),
    );
  }

  /** Device-free sign in. */
  @Post("login")
  login(@Body() body: { username?: string; password?: string }) {
    return this.username.login(
      String(body.username ?? ""),
      String(body.password ?? ""),
    );
  }

  /** Logged-in password rotation. */
  @Post("change")
  @UseGuards(JwtGuard)
  change(
    @CurrentUser() userId: string,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    return this.username.change(
      userId,
      String(body.currentPassword ?? ""),
      String(body.newPassword ?? ""),
    );
  }

  /** How many recovery wallets are linked. */
  @Post("recovery-wallets")
  @UseGuards(JwtGuard)
  recoveryWalletCount(@CurrentUser() userId: string) {
    return this.username.recoveryWalletCount(userId);
  }

  /** Opt a wallet into recovery (signed nonce, stores only the hash). */
  @Post("recovery-wallet")
  @UseGuards(JwtGuard)
  linkRecoveryWallet(
    @CurrentUser() userId: string,
    @Body()
    body: { chain?: string; address?: string; nonce?: string; signature?: string },
  ) {
    return this.username.linkRecoveryWallet(
      userId,
      String(body.chain ?? ""),
      String(body.address ?? ""),
      String(body.nonce ?? ""),
      String(body.signature ?? ""),
    );
  }

  /** Forgot username/password, step 1: sign with a linked wallet. */
  @Post("recover")
  recover(
    @Body()
    body: { chain?: string; address?: string; nonce?: string; signature?: string },
  ) {
    return this.username.recover(
      String(body.chain ?? ""),
      String(body.address ?? ""),
      String(body.nonce ?? ""),
      String(body.signature ?? ""),
    );
  }

  /** Step 2: consume the recovery token to rename/reset/sign in. */
  @Post("reset")
  reset(
    @Body() body: { token?: string; username?: string; password?: string },
  ) {
    return this.username.reset(
      String(body.token ?? ""),
      body.username !== undefined ? String(body.username) : undefined,
      body.password !== undefined ? String(body.password) : undefined,
    );
  }
}
