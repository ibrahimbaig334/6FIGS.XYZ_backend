import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { AuthedRequest } from "./jwt.guard";

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.userId as string;
});
