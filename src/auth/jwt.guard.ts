import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";

export interface AuthedRequest {
  headers: { authorization?: string };
  userId?: string;
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = this.auth.userIdFromHeader(req.headers.authorization);
    if (!userId) throw new UnauthorizedException("Missing or invalid session — reconnect wallet");
    req.userId = userId;
    return true;
  }
}
