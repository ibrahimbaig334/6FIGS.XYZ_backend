import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard, AuthedRequest } from "../auth/jwt.guard";
import { ProfileService } from "../profile/profile.service";
import { WalletService } from "./wallet.service";

@Controller("wallet")
export class WalletController {
  constructor(
    private readonly auth: AuthService,
    private readonly wallets: WalletService,
    private readonly profile: ProfileService,
  ) {}

  @Post("nonce")
  nonce(@Body() body: { chain?: string; address?: string }) {
    return this.auth.nonceFor(
      String(body.chain ?? ""),
      String(body.address ?? ""),
    );
  }

  @Post("verify")
  verify(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      chain?: string;
      address?: string;
      nonce?: string;
      signature?: string;
      walletName?: string;
    },
  ) {
    return this.withProfile(
      this.auth.verifyAndLogin(
        String(body.chain ?? ""),
        String(body.address ?? ""),
        String(body.nonce ?? ""),
        String(body.signature ?? ""),
        this.auth.userIdFromHeader(req.headers.authorization),
        typeof body.walletName === "string" ? body.walletName : null,
      ),
    );
  }

  /**
   * Add-wallet flow for logged-in sessions. Can never create or switch
   * accounts — the address attaches to YOUR account or is rejected.
   */
  @Post("add")
  @UseGuards(JwtGuard)
  add(
    @CurrentUser() userId: string,
    @Body()
    body: {
      chain?: string;
      address?: string;
      nonce?: string;
      signature?: string;
      walletName?: string;
    },
  ) {
    return this.withProfile(
      this.auth.verifyAndAttach(
        userId,
        String(body.chain ?? ""),
        String(body.address ?? ""),
        String(body.nonce ?? ""),
        String(body.signature ?? ""),
        typeof body.walletName === "string" ? body.walletName : null,
      ),
    );
  }

  /**
   * Login responses carry the full profile (eligibility included) so the
   * frontend can render the tier badge immediately — no follow-up
   * /profile/user fetch in the connect critical path.
   */
  private async withProfile(p: Promise<{ token: string; user: { id: string } }>) {
    const res = await p;
    const profile = await this.profile.me(res.user.id);
    return { ...res, profile };
  }

  @Post("link")
  link(
    @Req() req: AuthedRequest,
    @Body() body: { chain?: string; address?: string; walletName?: string },
  ) {
    const userId = this.auth.userIdFromHeader(req.headers.authorization);
    return this.auth.linkWallet(
      userId,
      String(body.chain ?? ""),
      String(body.address ?? ""),
      typeof body.walletName === "string" ? body.walletName : null,
    );
  }

  @Get("user")
  @UseGuards(JwtGuard)
  user(@CurrentUser() userId: string) {
    return this.wallets.listMine(userId);
  }

  @Patch(":id/mock")
  @UseGuards(JwtGuard)
  setMock(
    @CurrentUser() userId: string,
    @Param("id") id: string,
    @Body() body: { value?: number },
  ) {
    return this.wallets.setMock(userId, id, Number(body.value));
  }

  @Delete(":id")
  @UseGuards(JwtGuard)
  remove(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.wallets.remove(userId, id);
  }
}
