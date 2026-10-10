import { Injectable, UnauthorizedException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { PrismaService } from "../prisma/prisma.service";
import { JWT_EXPIRES_IN } from "../common/constants";
import { requiredEnv } from "../common/env";

function jwtSecret(): string {
  return requiredEnv("JWT_SECRET");
}

/**
 * Session tokens only. Wallet addresses never reach this service anymore:
 * login, proving, and recovery all run through the attested enclave, which
 * sees addresses inside sealed memory while the backend sees merely
 * one-way nullifiers.
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a session token carrying the account's current password version
   * (`passwordChangedAt` in ms). A later rotation bumps the version, so any
   * token minted before it fails `validateToken` even within the same second.
   */
  async issueToken(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordChangedAt: true },
    });
    return jwt.sign(
      { sub: userId, pv: user?.passwordChangedAt?.getTime() ?? 0 },
      jwtSecret(),
      { expiresIn: JWT_EXPIRES_IN },
    );
  }

  /**
   * Verify a session token and reject it when it predates a password change.
   * `iat` is in seconds; any token issued before the rotation (even in the
   * same second) is dead, so a stolen session does not survive a reset.
   */
  async validateToken(token: string): Promise<{ userId: string }> {
    let payload: { sub?: unknown; pv?: unknown };
    try {
      payload = jwt.verify(token, jwtSecret()) as {
        sub?: unknown;
        pv?: unknown;
      };
    } catch {
      throw new UnauthorizedException("Invalid session — reconnect wallet");
    }
    if (typeof payload.sub !== "string") {
      throw new UnauthorizedException("Invalid session — reconnect wallet");
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, passwordChangedAt: true },
    });
    if (!user) {
      throw new UnauthorizedException(
        "Account no longer exists — reconnect wallet",
      );
    }
    const current = user.passwordChangedAt?.getTime() ?? 0;
    const tokenVersion = typeof payload.pv === "number" ? payload.pv : 0;
    if (tokenVersion < current) {
      throw new UnauthorizedException(
        "Session expired after a password change — sign in again",
      );
    }
    return { userId: user.id };
  }

  async userIdFromHeader(
    authHeader: string | undefined,
  ): Promise<string | null> {
    if (!authHeader?.startsWith("Bearer ")) return null;
    try {
      return (await this.validateToken(authHeader.slice(7))).userId;
    } catch {
      return null;
    }
  }

  async userExists(userId: string): Promise<boolean> {
    return (await this.prisma.user.count({ where: { id: userId } })) > 0;
  }
}
