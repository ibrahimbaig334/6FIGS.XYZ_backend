import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
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
    // validateToken also rejects sessions issued before a password change and
    // accounts that no longer exist.
    const userId = await this.auth.userIdFromHeader(req.headers.authorization);
    if (!userId)
      throw new UnauthorizedException(
        "Missing or invalid session — reconnect wallet",
      );
    req.userId = userId;
    return true;
  }
}
