import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EligibilityService } from "../eligibility/eligibility.service";
import { VIS_MODES, shortAddr } from "../common/tiers";

function decodeAddr(enc: string | null): string {
  try {
    return enc ? Buffer.from(enc, "base64url").toString("utf8") : "unknown";
  } catch {
    return "unknown";
  }
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
  ) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const wallets = await this.prisma.wallet.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const elig = await this.eligibility.me(userId);
    return {
      id: user.id,
      handle: user.handle,
      visMode: user.visMode,
      tags: user.tags,
      eligibility: elig,
      wallets: wallets.map((w) => {
        const address = decodeAddr(w.addressEnc);
        return { id: w.id, chain: w.chain, address, display: shortAddr(address), mockUsd: w.mockUsd };
      }),
    };
  }

  async update(userId: string, body: { handle?: unknown; visMode?: unknown }) {
    const data: { handle?: string | null; visMode?: string } = {};
    if (body.handle !== undefined) {
      const h = String(body.handle).trim();
      if (h && !/^[a-zA-Z0-9_.]{3,24}$/.test(h)) throw new BadRequestException("Handle: 3–24 chars, letters/numbers/._");
      data.handle = h || null;
    }
    if (body.visMode !== undefined) {
      if (!VIS_MODES.includes(body.visMode as (typeof VIS_MODES)[number])) {
        throw new BadRequestException("visMode must be HIDDEN, CATEGORIES or FULL");
      }
      data.visMode = String(body.visMode);
    }
    const user = await this.prisma.user.update({ where: { id: userId }, data });
    return { id: user.id, handle: user.handle, visMode: user.visMode };
  }
}
