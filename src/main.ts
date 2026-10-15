import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { assertEnv } from "./common/env";
import { corsOrigin } from "./common/cors";

async function bootstrap() {
  assertEnv(); // fail fast on missing env — never boot half-configured
  const app = await NestFactory.create(AppModule);
  // Open CORS by default: any frontend origin (dev ports, previews, the
  // production domain) may call the API. Set WEB_ORIGIN to pin origins —
  // single URL or comma-separated list. Auth rides on Bearer headers, not
  // cookies, so a reflected origin carries no ambient authority.
  app.enableCors({ origin: corsOrigin() });
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
