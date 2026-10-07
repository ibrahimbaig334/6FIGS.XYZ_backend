import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import bs58 from "bs58";
import { verifyAsync } from "@noble/ed25519";
import jwt from "jsonwebtoken";
import { PrismaService } from "../prisma/prisma.service";
import {
  JWT_EXPIRES_IN,
  MAX_WALLETS_PER_USER,
  NONCE_TTL_MS,
} from "../common/constants";
import { requiredEnv } from "../common/env";

const CHAINS = ["SOL"] as const;
export type Chain = (typeof CHAINS)[number];

function isDevnet(): boolean {
  return requiredEnv("CHAIN_MODE") === "devnet";
}

function jwtSecret(): string {
  return requiredEnv("JWT_SECRET");
}

export function loginMessage(
  chain: string,
  address: string,
  nonce: string,
): string {
  return `6FIGS.XYZ login\n${chain}:${address}\nnonce: ${nonce}`;
}

export function normalizeAddress(chain: string, address: string): string {
  const a = address.trim();
  if (chain === "SOL") {
    try {
      const raw = bs58.decode(a);
      if (raw.length !== 32) throw new Error("bad length");
      return a;
    } catch {
      throw new BadRequestException("Invalid Solana address");
    }
  }
  throw new BadRequestException("Unsupported chain");
}

export function addressHash(chain: string, normalized: string): string {
  return createHash("sha256").update(`${chain}:${normalized}`).digest("hex");
}

interface NonceEntry {
  chain: string;
  address: string;
  nonce: string;
  exp: number;
}

@Injectable()
export class AuthService {
  private nonces = new Map<string, NonceEntry>();

  constructor(private readonly prisma: PrismaService) {}

  nonceFor(chain: string, address: string, purpose = "login"): { nonce: string } {
    if (!CHAINS.includes(chain as Chain))
      throw new BadRequestException("Unsupported chain");
    const normalized = normalizeAddress(chain, address);
    const nonce = randomBytes(16).toString("hex");
    // Namespaced per purpose: concurrent login + recovery flows for the same
    // wallet must never overwrite each other's challenge.
    this.nonces.set(`${purpose}:${chain}:${normalized}`, {
      chain,
      address: normalized,
      nonce,
      exp: Date.now() + NONCE_TTL_MS,
    });
    return { nonce };
  }

  private takeNonce(
    chain: string,
    normalized: string,
    nonce: string,
    purpose = "login",
  ): void {
    const key = `${purpose}:${chain}:${normalized}`;
    const entry = this.nonces.get(key);
    this.nonces.delete(key);
    if (!entry || entry.nonce !== nonce || entry.exp < Date.now()) {
      throw new UnauthorizedException(
        "Nonce expired or invalid — request a new one",
      );
    }
  }

  private async verifySignature(
    chain: string,
    normalized: string,
    nonce: string,
    signature: string,
  ): Promise<void> {
    if (chain === "SOL") {
      let ok = false;
      try {
        ok = await verifyAsync(
          bs58.decode(signature),
          new TextEncoder().encode(loginMessage(chain, normalized, nonce)),
          bs58.decode(normalized),
        );
      } catch {
        ok = false;
      }
      if (!ok) throw new UnauthorizedException("Bad Solana signature");
      return;
    }
    throw new BadRequestException("Unsupported chain");
  }

  async verifyAndLogin(
    chain: string,
    address: string,
    nonce: string,
    signature: string,
    userId: string | null = null,
    walletName: string | null = null,
  ) {
    const normalized = await this.checkSignature(
      chain,
      address,
      nonce,
      signature,
    );
    // Fresh address + logged-in session → attach as an additional wallet (multi-wallet).
    // Address owned by someone else → log in as the owner. New address, no session → new user.
    const hash = addressHash(chain, normalized);
    const existing = await this.prisma.wallet.findUnique({
      where: { addressHash: hash },
    });
    const wallet = await this.findOrCreateWallet(
      existing ? existing.userId : userId,
      chain,
      normalized,
      walletName,
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: wallet.userId },
    });
    return { token: await this.issueToken(user.id), user: this.publicUser(user) };
  }

  /**
   * Explicit add-wallet flow for logged-in sessions. Unlike verify it can NEVER
   * create a new account or switch sessions: the address either attaches to
   * YOUR account or is rejected as owned elsewhere.
   */
  async verifyAndAttach(
    userId: string,
    chain: string,
    address: string,
    nonce: string,
    signature: string,
    walletName: string | null = null,
  ) {
    const normalized = await this.checkSignature(
      chain,
      address,
      nonce,
      signature,
    );
    const wallet = await this.findOrCreateWallet(
      userId,
      chain,
      normalized,
      walletName,
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: wallet.userId },
    });
    return { token: await this.issueToken(user.id), user: this.publicUser(user) };
  }

  private async checkSignature(
    chain: string,
    address: string,
    nonce: string,
    signature: string,
    purpose = "login",
  ): Promise<string> {
    if (!CHAINS.includes(chain as Chain))
      throw new BadRequestException("Unsupported chain");
    const normalized = normalizeAddress(chain, address);
    this.takeNonce(chain, normalized, nonce, purpose);
    await this.verifySignature(chain, normalized, nonce, signature);
    return normalized;
  }

  /**
   * Public signature check WITHOUT any session effect: proves control of
   * the wallet right now (nonce is consumed, so no replays). Used by
   * username recovery flows; returns the normalized address.
   */
  async verifyControl(
    chain: string,
    address: string,
    nonce: string,
    signature: string,
    purpose = "login",
  ): Promise<string> {
    return this.checkSignature(chain, address, nonce, signature, purpose);
  }

  /**
   * Address-link flow. In prod every chain must use the signed verify flow;
   * in devnet plain linking stays open as a test hook (no mock UI anymore).
   */
  async linkWallet(
    userId: string | null,
    chain: string,
    address: string,
    walletName: string | null = null,
  ) {
    if (!CHAINS.includes(chain as Chain))
      throw new BadRequestException("Unsupported chain");
    if (!isDevnet()) {
      throw new BadRequestException(
        "Wallets must connect via the signed verify flow",
      );
    }
    const normalized = normalizeAddress(chain, address);
    const wallet = await this.findOrCreateWallet(
      userId,
      chain,
      normalized,
      walletName,
    );
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: wallet.userId },
    });
    return { token: await this.issueToken(user.id), user: this.publicUser(user) };
  }

  private async findOrCreateWallet(
    userId: string | null,
    chain: string,
    normalized: string,
    walletName: string | null = null,
  ) {
    const name =
      typeof walletName === "string" && walletName.trim()
        ? walletName.trim().slice(0, 32)
        : null;
    const hash = addressHash(chain, normalized);
    const existing = await this.prisma.wallet.findUnique({
      where: { addressHash: hash },
    });
    if (existing) {
      if (userId && existing.userId !== userId)
        throw new BadRequestException(
          "Wallet already linked to another account",
        );
      if (!existing.verifiedAt || (name && name !== existing.name)) {
        return this.prisma.wallet.update({
          where: { id: existing.id },
          data: {
            verifiedAt: new Date(),
            ...(name ? { name } : {}),
          },
        });
      }
      return existing;
    }
    let owner = userId;
    if (!owner) {
      const user = await this.createUserWithHandle(normalized);
      owner = user.id;
    }
    const owned = await this.prisma.wallet.count({ where: { userId: owner } });
    if (owned >= MAX_WALLETS_PER_USER) {
      throw new ForbiddenException(
        `Wallet limit reached (${MAX_WALLETS_PER_USER}) — remove one to add another`,
      );
    }
    return this.prisma.wallet.create({
      data: {
        userId: owner,
        chain,
        addressHash: hash,
        ...(name ? { name } : {}),
        verifiedAt: new Date(),
      },
    });
  }

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
   * Default username: user_<4 random letters>_<last 4 of wallet address>
   * (e.g. user_egdd_dskf). Assigned once at account creation; the user can
   * replace it with their own handle in settings.
   */
  private handleFor(address: string): string {
    const rand = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join("");
    const suffix = address.toLowerCase().slice(-4);
    return `user_${rand}_${suffix}`;
  }

  private async createUserWithHandle(address: string) {
    for (let i = 0; i < 5; i++) {
      try {
        return await this.prisma.user.create({
          data: { handle: this.handleFor(address) },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          continue; // handle collision — roll again
        }
        throw e;
      }
    }
    return this.prisma.user.create({
      data: { handle: `user_${randomBytes(3).toString("hex")}` },
    });
  }

  /**
   * Verify a session token and reject it when it predates a password change.
   * `iat` is in seconds; any token issued before the rotation (even in the
   * same second) is dead, so a stolen session does not survive a reset.
   */
  async validateToken(token: string): Promise<{ userId: string }> {
    let payload: { sub?: unknown; pv?: unknown };
    try {
      payload = jwt.verify(token, jwtSecret()) as { sub?: unknown; pv?: unknown };
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
      throw new UnauthorizedException("Account no longer exists — reconnect wallet");
    }
    const current = user.passwordChangedAt?.getTime() ?? 0;
    const tokenVersion = typeof payload.pv === "number" ? payload.pv : 0;
    if (tokenVersion < current) {
      throw new UnauthorizedException("Session expired after a password change — sign in again");
    }
    return { userId: user.id };
  }

  async userIdFromHeader(authHeader: string | undefined): Promise<string | null> {
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

  private publicUser(user: {
    id: string;
    handle: string | null;
    visMode: string;
    username?: string | null;
  }) {
    return {
      id: user.id,
      handle: user.handle,
      visMode: user.visMode,
      username: user.username ?? null,
    };
  }
}
