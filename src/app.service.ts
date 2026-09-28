import { Injectable } from "@nestjs/common";
import { requiredEnv } from "./common/env";

@Injectable()
export class AppService {
  health() {
    return {
      status: "ok",
      chainMode: requiredEnv("CHAIN_MODE"),
      time: new Date().toISOString(),
    };
  }
}
