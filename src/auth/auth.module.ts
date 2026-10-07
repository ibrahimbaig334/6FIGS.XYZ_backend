import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtGuard } from "./jwt.guard";
import { UsernameService } from "./username.service";
import { UsernameController } from "./username.controller";

@Module({
  controllers: [UsernameController],
  providers: [AuthService, JwtGuard, UsernameService],
  exports: [AuthService, JwtGuard, UsernameService],
})
export class AuthModule {}
