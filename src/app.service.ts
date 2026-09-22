import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  health() {
    return {
      status: "ok",
      chainMode: process.env.CHAIN_MODE ?? "devnet",
      time: new Date().toISOString(),
    };
  }
}
