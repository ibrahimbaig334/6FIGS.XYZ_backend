import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TeeController } from "./tee.controller";
import { TeeService } from "./tee.service";

@Module({
  imports: [AuthModule],
  controllers: [TeeController],
  providers: [TeeService],
  exports: [TeeService],
})
export class TeeModule {}
