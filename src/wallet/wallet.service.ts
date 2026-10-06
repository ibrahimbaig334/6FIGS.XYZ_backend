import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";

/**
 * Wallet listings never expose an address: the schema has no readable address
 * column, so only the family and a display label are returned.
 *
 * Removal is deliberately simple: disconnecting ANY wallet wipes the whole
 * attested verification (identity + bindings + tier cache), because the tier
 * attests the full wallet set and cannot survive a smaller one. The user
 * re-proves the remaining wallets with the automatic flow. Even the last
 * wallet can be disconnected — the account simply becomes unverified.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async listMine(userId: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { id: "asc" },
    });
    return wallets.map((w) => ({
      id: w.id,
      chain: w.chain,
      name: w.name,
      address: null,
      display: w.name ?? w.chain,
    }));
  }

  /** Wipe one user's whole attested verification (identity + bindings + cache). */
  private async wipeVerification(userId: string, identityNullifier: string) {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.teeWalletBinding.deleteMany({
          where: { identityNullifier },
        });
        await tx.teeIdentity.delete({
          where: { identityNullifier },
        });
        await tx.eligibilityCache.deleteMany({ where: { userId } });
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
  }

  async remove(userId: string, walletId: string) {
    // Tee wallets are addressed by their binding nullifier (what the
    // profile exposes as the wallet id). Only that wallet is disconnected:
    // its binding is deleted and the tier is zeroed (the attestation
    // covered the full set), while the remaining wallets stay enrolled and
    // can be re-verified. Even the last wallet can go — the account simply
    // becomes unverified.
    const binding = await this.prisma.teeWalletBinding.findUnique({
      where: { walletNullifier: walletId },
    });
    if (binding) {
      const identity = await this.prisma.teeIdentity.findUnique({
        where: { identityNullifier: binding.identityNullifier },
      });
      if (!identity || identity.userId !== userId)
        throw new NotFoundException("Wallet not found");
      await this.prisma.$transaction(
        async (tx) => {
          await tx.teeWalletBinding.delete({
            where: { walletNullifier: walletId },
          });
          await tx.teeIdentity.update({
            where: { identityNullifier: binding.identityNullifier },
            data: { tier: 0, tierLabel: "NONE" },
          });
          await tx.eligibilityCache.deleteMany({ where: { userId } });
        },
        { timeout: 30_000, maxWait: 15_000 },
      );
      return { ok: true, tierReset: true };
    }
    // Legacy Wallet-row fallback.
    const w = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!w || w.userId !== userId)
      throw new NotFoundException("Wallet not found");
    const remaining = await this.prisma.wallet.count({ where: { userId } });
    if (remaining <= 1)
      throw new BadRequestException(
        "Cannot remove your last wallet — disconnect instead",
      );
    await this.prisma.wallet.delete({ where: { id: walletId } });
    return { ok: true };
  }

  /** Disconnect every wallet: wipes all attested verification plus any
   *  legacy rows. Idempotent — always returns ok. */
  async removeAll(userId: string) {
    const identities = await this.prisma.teeIdentity.findMany({
      where: { userId },
      select: { identityNullifier: true },
    });
    for (const ident of identities) {
      await this.wipeVerification(userId, ident.identityNullifier);
    }
    await this.prisma.wallet.deleteMany({ where: { userId } });
    await this.prisma.eligibilityCache.deleteMany({ where: { userId } });
    return { ok: true };
  }
}
