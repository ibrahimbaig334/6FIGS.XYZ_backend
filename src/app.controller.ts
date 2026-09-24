import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";
import { isDevnet, tierList } from "./common/tiers";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  health() {
    return this.appService.health();
  }

  /** Public tier table (thresholds differ between devnet and prod). */
  @Get("tiers")
  tiers() {
    return { chainMode: isDevnet() ? "devnet" : "prod", tiers: tierList() };
  }
}
