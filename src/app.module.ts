import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "./prisma/prisma.module";
import { CommonModule } from "./common/common.module";
import { PresenceModule } from "./presence/presence.module";
import { AuthModule } from "./auth/auth.module";
import { WalletModule } from "./wallet/wallet.module";
import { EligibilityModule } from "./eligibility/eligibility.module";
import { ProfileModule } from "./profile/profile.module";
import { PlayModule } from "./play/play.module";
import { GameModule } from "./game/game.module";
import { RoomsModule } from "./rooms/rooms.module";
import { ChatModule } from "./chat/chat.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    PresenceModule,
    AuthModule,
    WalletModule,
    EligibilityModule,
    ProfileModule,
    PlayModule,
    GameModule,
    RoomsModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
