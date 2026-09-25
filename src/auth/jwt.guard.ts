import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";

export interface AuthedRequest {
  headers: { authorization?: string };
  userId?: string;
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = this.auth.userIdFromHeader(req.headers.authorization);
    if (!userId) throw new UnauthorizedException("Missing or invalid session — reconnect wallet");
    // The account itself may be gone (admin wipe) — treat as logged out, not a 500.
    if (!(await this.auth.userExists(userId))) {
      throw new UnauthorizedException("Account no longer exists — reconnect wallet");
    }
    req.userId = userId;
    return true;
  }
}
