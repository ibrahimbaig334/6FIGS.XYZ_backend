import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard, AuthedRequest } from "../auth/jwt.guard";
import { WalletService } from "./wallet.service";

@Controller("wallet")
export class WalletController {
  constructor(
    private readonly auth: AuthService,
    private readonly wallets: WalletService,
  ) {}

  @Post("nonce")
  nonce(@Body() body: { chain?: string; address?: string }) {
    return this.auth.nonceFor(String(body.chain ?? ""), String(body.address ?? ""));
  }

  @Post("verify")
  verify(@Body() body: { chain?: string; address?: string; nonce?: string; signature?: string }) {
    return this.auth.verifyAndLogin(
      String(body.chain ?? ""),
      String(body.address ?? ""),
      String(body.nonce ?? ""),
      String(body.signature ?? ""),
    );
  }

  @Post("link")
  link(@Req() req: AuthedRequest, @Body() body: { chain?: string; address?: string }) {
    const userId = this.auth.userIdFromHeader(req.headers.authorization);
    return this.auth.linkWallet(userId, String(body.chain ?? ""), String(body.address ?? ""));
  }

  @Get("me")
  @UseGuards(JwtGuard)
  me(@CurrentUser() userId: string) {
    return this.wallets.listMine(userId);
  }

  @Patch(":id/mock")
  @UseGuards(JwtGuard)
  setMock(@CurrentUser() userId: string, @Param("id") id: string, @Body() body: { value?: number }) {
    return this.wallets.setMock(userId, id, Number(body.value));
  }

  @Delete(":id")
  @UseGuards(JwtGuard)
  remove(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.wallets.remove(userId, id);
  }
}
