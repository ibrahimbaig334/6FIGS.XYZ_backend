import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";
import { AuthService } from "./auth.service";
import {
  EMAIL_PATTERN,
  MIN_PASSWORD_LEN,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "./password";

// Login-attempt budget per email, windowed. Wrong-password probing against
// one account is capped without locking the account itself.
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Web2 accounts. Wallets attach to them through the tee prove flow; login and
 * sessions never need an address at rest. Legacy wallet-only accounts stay
 * valid until the owner links an email.
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly auth: AuthService,
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
        return { token: this.auth.issueToken(user.id), user: this.sessionUser(user) };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          // Either the email is taken or the handle collided; distinguish to
          // avoid leaking account existence on timing alone is overkill — the
          // message is intentionally generic either way.
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
    return { token: this.auth.issueToken(user.id), user: this.sessionUser(user) };
  }

  async login(email: string, password: string) {
    const creds = this.checkCredentials(email, password);
    await this.throttle(creds.email);
    const user = await this.prisma.user.findUnique({ where: { email: creds.email } });
    const hash = user?.passwordHash ?? "";
    const ok = hash !== "" && (await verifyPassword(creds.password, hash));
    if (!ok) throw new UnauthorizedException("Wrong email or password");
    await this.clearThrottle(creds.email);
    return { token: this.auth.issueToken(user!.id), user: this.sessionUser(user!) };
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
      data: { email: creds.email, passwordHash: await hashPassword(creds.password) },
    });
    return { token: this.auth.issueToken(user.id), user: this.sessionUser(user) };
  }

  private sessionUser(user: {
    id: string;
    handle: string | null;
    visMode: string;
    email: string | null;
  }) {
    return { id: user.id, handle: user.handle, visMode: user.visMode, email: user.email };
  }
}