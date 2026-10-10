import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { TeeService } from "./tee.service";

@Controller("eligibility")
export class TeeController {
  constructor(private readonly tee: TeeService) {}

  /** Single-use registration nonce bound to this session. */
  @Post("tee-nonce")
  @UseGuards(JwtGuard)
  nonce(@CurrentUser() userId: string) {
    return this.tee.issueNonce(userId);
  }

  /** Submit an attested registration plus its escrow blob. */
  @Post("tee-register")
  @UseGuards(JwtGuard)
  async register(
    @CurrentUser() userId: string,
    @Body() body: { signed?: unknown; escrowBlob?: unknown },
  ) {
    const { view } = await this.tee.register(
      userId,
      body.signed as Parameters<TeeService["register"]>[1],
      body.escrowBlob as Parameters<TeeService["register"]>[2],
    );
    return view;
  }

  /**
   * Sessionless wallet login through the enclave. The server never sees an
   * address — the owner is resolved (or created) from attested nullifiers.
   */
  @Post("tee-login")
  login(@Body() body: { signed?: unknown; escrowBlob?: unknown }) {
    return this.tee.registerLogin(
      body.signed as Parameters<TeeService["registerLogin"]>[0],
      body.escrowBlob as Parameters<TeeService["registerLogin"]>[1],
    );
  }

  /**
   * Sessionless identify for username recovery: which account holds these
   * wallets? Returns the username plus a single-use recovery token. Nothing
   * is stored; no addresses are involved at any point.
   */
  @Post("tee-identify")
  identify(@Body() body: { signed?: unknown }) {
    return this.tee.identify(
      body.signed as Parameters<TeeService["identify"]>[0],
    );
  }

  /** Force a freshness re-verification now. */
  @Post("tee-recheck")
  @UseGuards(JwtGuard)
  recheck(@CurrentUser() userId: string) {
    return this.tee.refresh(userId, true);
  }

  /**
   * Disconnect every wallet: wipes the attested verification (identity,
   * bindings, tier cache). The username sign-in survives. Idempotent.
   */
  @Delete("tee-identity")
  @UseGuards(JwtGuard)
  resetIdentity(@CurrentUser() userId: string) {
    return this.tee.resetIdentity(userId);
  }

  /**
   * Session-authorized wallet removal. No wallet signature: the logged-in
   * session authorizes the backend, which presents the stored escrow blob to
   * the enclave. Denial-only tradeoff, see docs/SECURITY.md in the tee repo.
   */
  @Delete("tee-wallet/:walletId")
  @UseGuards(JwtGuard)
  removeWallet(
    @CurrentUser() userId: string,
    @Param("walletId") walletId: string,
  ) {
    return this.tee.removeWallet(userId, walletId);
  }
}
