import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";
import { AuthService, addressHash } from "./auth.service";
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
const RECOVERY_TTL_MS = 15 * 60 * 1000;

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

  /** How many recovery wallets are linked (no hashes leave the server). */
  async recoveryWalletCount(userId: string) {
    return {
      count: await this.prisma.walletRecovery.count({ where: { userId } }),
    };
  }

  /** Opt a wallet into recovery: proves control now (signed nonce), stores
   *  only the hash — never the address. One wallet links to one account. */
  async linkRecoveryWallet(
    userId: string,
    chain: string,
    address: string,
    nonce: string,
    signature: string,
  ) {
    const normalized = await this.auth.verifyControl(
      chain,
      address,
      nonce,
      signature,
    );
    const hash = addressHash(chain, normalized);
    const existing = await this.prisma.walletRecovery.findUnique({
      where: { addressHash: hash },
    });
    if (existing && existing.userId !== userId)
      throw new ConflictException("That wallet is linked to another account");
    await this.prisma.walletRecovery.upsert({
      where: { addressHash: hash },
      create: { addressHash: hash, userId },
      update: { userId },
    });
    return { ok: true };
  }

  /** Step 1: sign with a linked wallet → reveals the username + a
   *  single-use recovery token. Throttled: wallet hashes are guessable. */
  async recover(
    chain: string,
    address: string,
    nonce: string,
    signature: string,
  ) {
    const normalized = await this.auth.verifyControl(
      chain,
      address,
      nonce,
      signature,
    );
    const hash = addressHash(chain, normalized);
    await this.throttle(`recover:${hash}`).catch(() => undefined);
    const link = await this.prisma.walletRecovery.findUnique({
      where: { addressHash: hash },
    });
    if (!link)
      throw new NotFoundException(
        "No account linked to this wallet — link it in profile first",
      );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: link.userId },
    });
    const raw = randomBytes(32).toString("base64url");
    await this.cache.set(`username:rec:${raw}`, { userId: user.id }, RECOVERY_TTL_MS);
    return { username: user.username, recoveryToken: raw };
  }

  /** Step 2: consume the token — rename and/or set a new password (which
   *  kills all old sessions), or neither to simply sign in. */
  async reset(
    token: string,
    username?: string,
    password?: string,
  ) {
    const raw = String(token ?? "");
    const entry = await this.cache.get<{ userId: string }>(
      `username:rec:${raw}`,
    );
    await this.cache.del(`username:rec:${raw}`);
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
