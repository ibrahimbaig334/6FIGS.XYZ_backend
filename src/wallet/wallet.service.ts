import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import { shortAddr } from "../common/tiers";

function isDevnet(): boolean {
  return (process.env.CHAIN_MODE ?? "devnet") === "devnet";
}

function decodeAddr(enc: string | null): string {
  try {
    return enc ? Buffer.from(enc, "base64url").toString("utf8") : "unknown";
  } catch {
    return "unknown";
  }
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async listMine(userId: string) {
    const wallets = await this.prisma.wallet.findMany({ where: { userId }, orderBy: { id: "asc" } });
    return wallets.map((w) => {
      const address = decodeAddr(w.addressEnc);
      return { id: w.id, chain: w.chain, address, display: shortAddr(address), mockUsd: w.mockUsd };
    });
  }

  async setMock(userId: string, walletId: string, value: number) {
    if (!isDevnet()) throw new ForbiddenException("Mock balances are devnet-only");
    if (!Number.isInteger(value) || value < 0) throw new BadRequestException("mockUsd must be a non-negative integer");
    const w = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!w || w.userId !== userId) throw new NotFoundException("Wallet not found");
    await this.prisma.wallet.update({ where: { id: walletId }, data: { mockUsd: value } });
    return { ok: true };
  }

  async remove(userId: string, walletId: string) {
    const w = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!w || w.userId !== userId) throw new NotFoundException("Wallet not found");
    const remaining = await this.prisma.wallet.count({ where: { userId } });
    if (remaining <= 1) throw new BadRequestException("Cannot remove your last wallet — disconnect instead");
    await this.prisma.wallet.delete({ where: { id: walletId } });
    return { ok: true };
  }
}
