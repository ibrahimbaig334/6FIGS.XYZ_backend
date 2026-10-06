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

  async remove(userId: string, walletId: string) {
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
}