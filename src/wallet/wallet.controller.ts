import {
  Controller,
  Delete,
  Get,
  Param,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user";
import { JwtGuard } from "../auth/jwt.guard";
import { WalletService } from "./wallet.service";

@Controller("wallet")
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get("user")
  @UseGuards(JwtGuard)
  user(@CurrentUser() userId: string) {
    return this.wallets.listMine(userId);
  }

  @Delete(":id")
  @UseGuards(JwtGuard)
  remove(@CurrentUser() userId: string, @Param("id") id: string) {
    return this.wallets.remove(userId, id);
  }

  /** Disconnect every wallet (wipes attested verification). Idempotent. */
  @Delete()
  @UseGuards(JwtGuard)
  removeAll(@CurrentUser() userId: string) {
    return this.wallets.removeAll(userId);
  }
}
