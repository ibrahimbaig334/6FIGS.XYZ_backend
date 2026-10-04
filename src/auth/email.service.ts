import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";
import { AuthService } from "./auth.service";
import { MailerService } from "../mailer/mailer.service";
import {
  EMAIL_PATTERN,
  MIN_PASSWORD_LEN,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "./password";

// Login/attempt budget per email, windowed. Wrong-password probing against
// one account is capped without locking the account itself.
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

type TokenKind = "verify" | "reset";

/**
 * Web2 accounts. Wallets attach to them through the tee prove flow; login and
 * sessions never need an address at rest. Email verification, password reset,
 * and password change round out the account's recovery surface. Raw tokens
 * exist only in the emailed link; only their SHA-256 hash is stored.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger("EmailService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
  ) {}

  private checkCredentials(email: string, password: string): { email: string; password: string } {
    const normalized = normalizeEmail(String(email ?? ""));
    if (!EMAIL_PATTERN.test(normalized))
      throw new BadRequestException("Enter a valid email address");
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN)
      throw new BadRequestException(
        `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      );
    return { email: normalized, password };
  }

  private checkPassword(password: unknown): string {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN)
      throw new BadRequestException(
        `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      );
    return password;
  }

  private async throttle(email: string): Promise<void> {
    const key = `email:rl:${email}`;
    const count = (await this.cache.get<number>(key)) ?? 0;
    if (count >= ATTEMPT_LIMIT) throw new HttpException("Too many attempts — try again later", 429);
    await this.cache.set(key, count + 1, ATTEMPT_WINDOW_MS);
  }

  private async clearThrottle(email: string): Promise<void> {
    await this.cache.del(`email:rl:${email}`);
  }

  private handleFor(): string {
    const rand = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join("");
    return `user_${rand}`;
  }

  private appUrl(): string {
    return (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
  }

  private hashToken(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  /** Create a token row and return the raw token for the email link. */
  private async issueToken(userId: string, kind: TokenKind, ttlMs: number): Promise<string> {
    const raw = randomBytes(32).toString("base64url");
    await this.prisma.$transaction([
      // Only the newest link for a kind may work; earlier ones are dropped.
      this.prisma.emailToken.deleteMany({ where: { userId, kind, consumedAt: null } }),
      this.prisma.emailToken.create({
        data: {
          userId,
          kind,
          tokenHash: this.hashToken(raw),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return raw;
  }

  private async consumeToken(kind: TokenKind, raw: string): Promise<string | null> {
    if (typeof raw !== "string" || raw.length < 16) return null;
    const tokenHash = this.hashToken(raw);
    const result = await this.prisma.emailToken.updateMany({
      where: {
        tokenHash,
        kind,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (result.count === 0) return null;
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash } });
    return row?.userId ?? null;
  }

  private async sendVerify(userId: string, email: string): Promise<void> {
    try {
      const token = await this.issueToken(userId, "verify", VERIFY_TTL_MS);
      const link = `${this.appUrl()}/verify-email?token=${encodeURIComponent(token)}`;
      await this.mailer.send({
        to: email,
        subject: "Verify your 6figs email",
        text: `Confirm this email to finish setting up your 6figs account:\n\n${link}\n\nThis link expires in 24 hours.`,
      });
    } catch (error) {
      this.log.warn(
        `verification email failed for ${email}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
  }

  async signup(email: string, password: string) {
    const creds = this.checkCredentials(email, password);
    await this.throttle(creds.email);
    const passwordHash = await hashPassword(creds.password);
    for (let i = 0; i < 5; i++) {
      try {
        const user = await this.prisma.user.create({
          data: { email: creds.email, passwordHash, handle: `${this.handleFor()}` },
        });
        await this.clearThrottle(creds.email);
        await this.sendVerify(user.id, creds.email);
        return { token: await this.auth.issueToken(user.id), user: this.sessionUser(user) };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          const taken = await this.prisma.user.findUnique({ where: { email: creds.email } });
          if (taken) throw new ConflictException("That email is already registered");
          continue;
        }
        throw e;
      }
    }
    const user = await this.prisma.user.create({
      data: {
        email: creds.email,
        passwordHash,
        handle: `user_${randomBytes(3).toString("hex")}`,
      },
    });
    await this.clearThrottle(creds.email);
    await this.sendVerify(user.id, creds.email);
    return { token: await this.auth.issueToken(user.id), user: this.sessionUser(user) };
  }

  async login(email: string, password: string) {
    const creds = this.checkCredentials(email, password);
    await this.throttle(creds.email);
    const user = await this.prisma.user.findUnique({ where: { email: creds.email } });
    const hash = user?.passwordHash ?? "";
    const ok = hash !== "" && (await verifyPassword(creds.password, hash));
    if (!ok) throw new UnauthorizedException("Wrong email or password");
    await this.clearThrottle(creds.email);
    return { token: await this.auth.issueToken(user!.id), user: this.sessionUser(user!) };
  }

  /** Attach an email to the current (wallet) account. The account stays the same. */
  async link(userId: string, email: string, password: string) {
    const creds = this.checkCredentials(email, password);
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (me.email) throw new ConflictException("This account already has an email");
    const taken = await this.prisma.user.findUnique({ where: { email: creds.email } });
    if (taken) throw new ConflictException("That email is already registered");
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: creds.email,
        passwordHash: await hashPassword(creds.password),
        emailVerifiedAt: null,
        passwordChangedAt: new Date(),
      },
    });
    await this.sendVerify(user.id, creds.email);
    return { token: await this.auth.issueToken(user.id), user: this.sessionUser(user) };
  }

  /** Consume an emailed verification token. */
  async verify(token: string) {
    const userId = await this.consumeToken("verify", String(token ?? ""));
    if (!userId) throw new BadRequestException("This verification link is invalid or expired");
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    return { verified: true };
  }

  /** Re-send verification for the current account. Rate-limited. */
  async resendVerification(userId: string) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!me.email) throw new BadRequestException("This account has no email to verify");
    if (me.emailVerifiedAt) return { verified: true };
    await this.throttle(me.email);
    await this.sendVerify(me.id, me.email);
    return { sent: true };
  }

  /**
   * Start a password reset. The response is always the same, whether or not
   * the address exists, to avoid account enumeration.
   */
  async forgot(email: string) {
    const normalized = normalizeEmail(String(email ?? ""));
    if (!EMAIL_PATTERN.test(normalized)) return { ok: true };
    await this.throttle(`forgot:${normalized}`).catch(() => undefined);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (user) {
      try {
        const token = await this.issueToken(user.id, "reset", RESET_TTL_MS);
        const link = `${this.appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
        await this.mailer.send({
          to: normalized,
          subject: "Reset your 6figs password",
          text: `Use this link to choose a new password:\n\n${link}\n\nThis link expires in 30 minutes. If you did not ask, ignore this email.`,
        });
      } catch (error) {
        this.log.warn(
          `reset email failed for ${normalized}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    return { ok: true };
  }

  /** Consume a reset token and set the new password. */
  async reset(token: string, password: string) {
    const next = this.checkPassword(password);
    const raw = String(token ?? "");
    const tokenHash = this.hashToken(raw);
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash } });
    if (!row || row.kind !== "reset" || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("This reset link is invalid or expired");
    }
    const passwordHash = await hashPassword(next);
    await this.prisma.$transaction([
      this.prisma.emailToken.updateMany({
        where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash, passwordChangedAt: new Date() },
      }),
    ]);
    return { ok: true };
  }

  /** Authenticated rotation: requires the current password. */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const hash = me.passwordHash ?? "";
    const ok = hash !== "" && (await verifyPassword(String(currentPassword ?? ""), hash));
    if (!ok) throw new UnauthorizedException("Current password is incorrect");
    const next = this.checkPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() },
    });
    return { ok: true };
  }

  private sessionUser(user: {
    id: string;
    handle: string | null;
    visMode: string;
    email: string | null;
    emailVerifiedAt?: Date | null;
  }) {
    return {
      id: user.id,
      handle: user.handle,
      visMode: user.visMode,
      email: user.email,
      emailVerified: user.emailVerifiedAt != null,
    };
  }
}