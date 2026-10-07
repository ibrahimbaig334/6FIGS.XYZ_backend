import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";
import { AuthService } from "./auth.service";
import { HANDLE_PATTERN } from "../common/constants";
import {
  MIN_PASSWORD_LEN,
  hashPassword,
  verifyPassword,
} from "./password";

// Login/attempt budget per username, windowed. Wrong-password probing
// against one account is capped without locking the account itself.
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
/** Recovery-token lifetime + cache key prefix (shared with tee identify). */
export const RECOVERY_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_TOKEN_PREFIX = "username:rec:";

/**
 * Optional device-free login. A username + password attaches to the
 * wallet-created account (profile), so the user can sign in on another
 * device without connecting wallets. Forgetting either is recovered by
 * signing with a previously linked wallet — no email anywhere.
 */
@Injectable()
export class UsernameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly cache: CacheService,
  ) {}

  private checkUsername(username: unknown): string {
    const v = String(username ?? "").trim();
    if (!HANDLE_PATTERN.test(v))
      throw new BadRequestException(
        "Username: 3–24 chars, letters/numbers/._",
      );
    return v;
  }

  private checkPassword(password: unknown): string {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN)
      throw new BadRequestException(
        `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      );
    return password;
  }

  private async throttle(key: string): Promise<void> {
    const ck = `username:rl:${key}`;
    const count = (await this.cache.get<number>(ck)) ?? 0;
    if (count >= ATTEMPT_LIMIT)
      throw new HttpException("Too many attempts — try again later", 429);
    await this.cache.set(ck, count + 1, ATTEMPT_WINDOW_MS);
  }

  private async clearThrottle(key: string): Promise<void> {
    await this.cache.del(`username:rl:${key}`);
  }

  /** Attach a username + password to the current (wallet) account. First
   *  credential set does NOT bump passwordChangedAt, so the session that
   *  sets it stays valid. */
  async setup(userId: string, username: string, password: string) {
    const name = this.checkUsername(username);
    const pw = this.checkPassword(password);
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (me.username)
      throw new ConflictException(
        "Username already set — change it or recover it instead",
      );
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { username: name, passwordHash: await hashPassword(pw) },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new ConflictException("Username already taken");
      }
      throw e;
    }
    return { username: name };
  }

  async login(username: string, password: string) {
    const name = this.checkUsername(username);
    await this.throttle(`login:${name}`);
    const user = await this.prisma.user.findUnique({
      where: { username: name },
    });
    if (
      !user?.passwordHash ||
      !(await verifyPassword(String(password ?? ""), user.passwordHash))
    ) {
      throw new UnauthorizedException("Wrong username or password");
    }
    await this.clearThrottle(`login:${name}`);
    return { token: await this.auth.issueToken(user.id) };
  }

  /** Logged-in password rotation; bumps the version so old sessions die. */
  async change(userId: string, currentPassword: string, newPassword: string) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (
      !me.passwordHash ||
      !(await verifyPassword(String(currentPassword ?? ""), me.passwordHash))
    ) {
      throw new UnauthorizedException("Current password is incorrect");
    }
    const pw = this.checkPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(pw),
        passwordChangedAt: new Date(),
      },
    });
    return { ok: true };
  }

  /** Step 2: consume the token — rename and/or set a new password (which
   *  kills all old sessions), or neither to simply sign in. Tokens are
   *  minted by tee-identify: any enrolled wallet recovers, no pre-linking. */
  async reset(
    token: string,
    username?: string,
    password?: string,
  ) {
    const raw = String(token ?? "");
    const entry = await this.cache.get<{ userId: string }>(
      `${RECOVERY_TOKEN_PREFIX}${raw}`,
    );
    await this.cache.del(`${RECOVERY_TOKEN_PREFIX}${raw}`);
    if (!entry?.userId)
      throw new BadRequestException(
        "Recovery session expired — connect your wallet again",
      );
    const data: {
      username?: string;
      passwordHash?: string;
      passwordChangedAt?: Date;
    } = {};
    if (username !== undefined) data.username = this.checkUsername(username);
    if (password !== undefined) {
      data.passwordHash = await hashPassword(this.checkPassword(password));
      data.passwordChangedAt = new Date();
    }
    try {
      const updated = await this.prisma.user.update({
        where: { id: entry.userId },
        data,
      });
      return {
        token: await this.auth.issueToken(updated.id),
        username: updated.username,
      };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new ConflictException("Username already taken");
      }
      throw e;
    }
  }
}
