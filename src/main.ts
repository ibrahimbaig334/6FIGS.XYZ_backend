import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { assertEnv } from "./common/env";

async function bootstrap() {
  assertEnv(); // fail fast on missing env — never boot half-configured
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
