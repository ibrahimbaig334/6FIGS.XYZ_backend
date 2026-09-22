import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { ethers } from "ethers";
import bs58 from "bs58";
import { verifyAsync } from "@noble/ed25519";
import jwt from "jsonwebtoken";
import { PrismaService } from "../prisma/prisma.service";

const CHAINS = ["EVM", "SOL", "BTC"] as const;
export type Chain = (typeof CHAINS)[number];

function isDevnet(): boolean {
  return (process.env.CHAIN_MODE ?? "devnet") === "devnet";
}

function jwtSecret(): string {
  return process.env.JWT_SECRET ?? "dev-secret-change-me";
}

export function loginMessage(chain: string, address: string, nonce: string): string {
  return `6FIGS.XYZ login\n${chain}:${address}\nnonce: ${nonce}`;
}

export function normalizeAddress(chain: string, address: string): string {
  const a = address.trim();
  if (chain === "EVM") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new BadRequestException("Invalid EVM address");
    return a.toLowerCase();
  }
  if (chain === "SOL") {
    try {
      const raw = bs58.decode(a);
      if (raw.length !== 32) throw new Error("bad length");
      return a;
    } catch {
      throw new BadRequestException("Invalid Solana address");
    }
  }
  if (chain === "BTC") {
    if (!/^[A-Za-z0-9]{26,62}$/.test(a)) throw new BadRequestException("Invalid BTC address");
    return a;
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

  nonceFor(chain: string, address: string): { nonce: string } {
    if (!CHAINS.includes(chain as Chain)) throw new BadRequestException("Unsupported chain");
    const normalized = normalizeAddress(chain, address);
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(`${chain}:${normalized}`, { chain, address: normalized, nonce, exp: Date.now() + 10 * 60 * 1000 });
    return { nonce };
  }

  private takeNonce(chain: string, normalized: string, nonce: string): void {
    const key = `${chain}:${normalized}`;
    const entry = this.nonces.get(key);
    this.nonces.delete(key);
    if (!entry || entry.nonce !== nonce || entry.exp < Date.now()) {
      throw new UnauthorizedException("Nonce expired or invalid — request a new one");
    }
  }

  private async verifySignature(chain: string, normalized: string, nonce: string, signature: string): Promise<void> {
    if (isDevnet() && signature === "mock") return; // devnet mock wallets (no extension)
    if (chain === "EVM") {
      const recovered = ethers.verifyMessage(loginMessage(chain, normalized, nonce), signature);
      if (recovered.toLowerCase() !== normalized.toLowerCase()) throw new UnauthorizedException("Bad EVM signature");
      return;
    }
    if (chain === "SOL") {
      let sigBytes: Uint8Array;
      try {
        sigBytes = bs58.decode(signature);
      } catch {
        throw new UnauthorizedException("Bad Solana signature encoding");
      }
      const ok = await verifyAsync(
        sigBytes,
        new TextEncoder().encode(loginMessage(chain, normalized, nonce)),
        bs58.decode(normalized),
      );
      if (!ok) throw new UnauthorizedException("Bad Solana signature");
      return;
    }
    throw new BadRequestException("BTC wallets are link-only (no signature flow)");
  }

  async verifyAndLogin(chain: string, address: string, nonce: string, signature: string) {
    if (!CHAINS.includes(chain as Chain)) throw new BadRequestException("Unsupported chain");
    const normalized = normalizeAddress(chain, address);
    this.takeNonce(chain, normalized, nonce);
    await this.verifySignature(chain, normalized, nonce, signature);
    const wallet = await this.findOrCreateWallet(null, chain, normalized);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: wallet.userId } });
    return { token: this.issueToken(user.id), user: this.publicUser(user) };
  }

  /** BTC link-only + devnet mock link. Attaches to userId when known, else creates a user. */
  async linkWallet(userId: string | null, chain: string, address: string) {
    if (!CHAINS.includes(chain as Chain)) throw new BadRequestException("Unsupported chain");
    if (chain !== "BTC" && !isDevnet()) {
      throw new BadRequestException("EVM/SOL wallets must connect via signed verify flow");
    }
    const normalized = normalizeAddress(chain, address);
    const wallet = await this.findOrCreateWallet(userId, chain, normalized);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: wallet.userId } });
    return { token: this.issueToken(user.id), user: this.publicUser(user) };
  }

  private async findOrCreateWallet(userId: string | null, chain: string, normalized: string) {
    const hash = addressHash(chain, normalized);
    const existing = await this.prisma.wallet.findUnique({ where: { addressHash: hash } });
    if (existing) {
      if (userId && existing.userId !== userId) throw new BadRequestException("Wallet already linked to another account");
      if (!existing.verifiedAt) {
        return this.prisma.wallet.update({ where: { id: existing.id }, data: { verifiedAt: new Date() } });
      }
      return existing;
    }
    let owner = userId;
    if (!owner) {
      const user = await this.prisma.user.create({ data: {} });
      owner = user.id;
    }
    return this.prisma.wallet.create({
      data: {
        userId: owner,
        chain,
        addressHash: hash,
        // NOTE: reversible placeholder until ZKP encryption lands (see SUMMARY.txt).
        addressEnc: Buffer.from(normalized, "utf8").toString("base64url"),
        verifiedAt: new Date(),
      },
    });
  }

  issueToken(userId: string): string {
    return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: "7d" });
  }

  validateToken(token: string): { userId: string } {
    try {
      const payload = jwt.verify(token, jwtSecret()) as { sub?: unknown };
      if (typeof payload.sub !== "string") throw new Error("bad sub");
      return { userId: payload.sub };
    } catch {
      throw new UnauthorizedException("Invalid session — reconnect wallet");
    }
  }

  userIdFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader?.startsWith("Bearer ")) return null;
    try {
      return this.validateToken(authHeader.slice(7)).userId;
    } catch {
      return null;
    }
  }

  private publicUser(user: { id: string; handle: string | null; visMode: string }) {
    return { id: user.id, handle: user.handle, visMode: user.visMode };
  }
}
