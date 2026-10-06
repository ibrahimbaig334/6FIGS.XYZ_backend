import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EligibilityService } from "../eligibility/eligibility.service";
import { VIS_MODES } from "../common/tiers";
import { HANDLE_PATTERN } from "../common/constants";

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
  ) {}

  async me(userId: string) {
    const [user, wallets] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.wallet.findMany({
        where: { userId },
        orderBy: { id: "asc" },
      }),
    ]);
    const elig = await this.eligibility.me(userId);
    if ("source" in elig && elig.source === "tee") {
      return {
        id: user.id,
        handle: user.handle,
        visMode: user.visMode,
        email: user.email,
        emailVerified: user.emailVerifiedAt != null,
        tags: user.tags,
        eligibility: elig,
        wallets: elig.wallets.map((w) => ({
          id: w.id,
          chain: w.family,
          name: w.label,
          address: null,
          display: w.label ?? w.family.toUpperCase(),
        })),
      };
    }
    // No stored address exists, so a wallet row exposes only its label.
    return {
      id: user.id,
      handle: user.handle,
      visMode: user.visMode,
      email: user.email,
      emailVerified: user.emailVerifiedAt != null,
      tags: user.tags,
      eligibility: elig,
      wallets: wallets.map((w) => ({
        id: w.id,
        chain: w.chain,
        name: w.name,
        address: null,
        display: w.name ?? w.chain,
      })),
    };
  }

  async update(userId: string, body: { handle?: unknown; visMode?: unknown }) {
    const data: { handle?: string | null; visMode?: string } = {};
    if (body.handle !== undefined) {
      const h = String(body.handle).trim();
      if (h && !HANDLE_PATTERN.test(h))
        throw new BadRequestException("Handle: 3–24 chars, letters/numbers/._");
      data.handle = h || null;
    }
    if (body.visMode !== undefined) {
      if (!VIS_MODES.includes(body.visMode as (typeof VIS_MODES)[number])) {
        throw new BadRequestException("visMode must be HIDDEN or VISIBLE");
      }
      data.visMode = String(body.visMode);
    }
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data,
      });
      return { id: user.id, handle: user.handle, visMode: user.visMode };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        throw new ConflictException("Handle already taken");
      }
      throw e;
    }
  }
}