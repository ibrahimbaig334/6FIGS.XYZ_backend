import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtGuard } from "./jwt.guard";
import { EmailService } from "./email.service";
import { EmailController } from "./email.controller";

@Module({
  controllers: [EmailController],
  providers: [AuthService, JwtGuard, EmailService],
  exports: [AuthService, JwtGuard, EmailService],
})
export class AuthModule {}
