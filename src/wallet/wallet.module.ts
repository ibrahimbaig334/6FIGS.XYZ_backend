import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ProfileModule } from "../profile/profile.module";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

@Module({
  imports: [AuthModule, ProfileModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
