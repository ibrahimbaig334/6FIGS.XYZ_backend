import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { AttestationVerifier } from "@sixfigs/tee/verifier";
import { RecheckClient } from "@sixfigs/tee/client";
import {
  POLICY_VERSION,
  productTierLabel,
  walletSetNullifier,
} from "@sixfigs/tee/shared";
import type {
  RegistrationResultBody,
  SignedEnvelope,
  SignedRegistration,
} from "@sixfigs/tee/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../common/cache.service";

const NONCE_TTL_MS = 5 * 60 * 1000;
const RECHECK_LOCK_MS = 60_000;
const DEFAULT_RECHECK_TTL_MS = 3_600_000;

export interface TeeWalletView {
  family: string;
  label: string | null;
}

export interface TeeIdentityView {
  source: "tee";
  /** Product label ("TIER I".."TIER IV") or null when unverified. */
  tier: string | null;
  tierId: number;
  portfolioBand: string;
  topAssets: string[];
  stableBps: number;
  wallets: TeeWalletView[];
  walletCount: number;
  verifiedAt: string;
  expiresAt: string;
  stale: boolean;
  verified: boolean;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Tee trust boundary. Verifies attested registrations with the tee package,
 * persists only nullifiers, tier facts, disclosed symbols, and the opaque
 * escrow blob, and re-verifies silently on a TTL. Never sees an address or a
 * balance: the browser holds plaintext, the enclave holds the escrow key.
 */
@Injectable()
export class TeeService {
  private readonly log = new Logger("TeeService");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private enclaveUrl(): string {
    return (process.env.SIXFIGS_ENCLAVE_URL ?? "").trim();
  }

  privateVerifierConfig() {
    return {
      audience: "6figs-registration",
      policy: {
        allowedImageDigests: splitList(process.env.SIXFIGS_IMAGE_DIGEST),
        allowedProjects: splitList(process.env.SIXFIGS_GCP_PROJECT),
        allowedNullifierSchemes: splitList(process.env.SIXFIGS_ALLOWED_NULLIFIER_SCHEMES).length
          ? splitList(process.env.SIXFIGS_ALLOWED_NULLIFIER_SCHEMES)
          : ["keyed-v1"],
        ...(splitList(process.env.SIXFIGS_REQUIRED_SUPPORT_ATTRS).length
          ? { requiredSupportAttributes: splitList(process.env.SIXFIGS_REQUIRED_SUPPORT_ATTRS) }
          : {}),
      },
      allowMock: process.env.SIXFIGS_ALLOW_MOCK === "1",
    };
  }

  private clientPolicy() {
    const config = this.privateVerifierConfig();
    return {
      allowMock: config.allowMock,
      allowedImageDigests: config.policy.allowedImageDigests,
      allowedProjects: config.policy.allowedProjects,
      ...(config.policy.requiredSupportAttributes
        ? { requiredSupportAttributes: config.policy.requiredSupportAttributes }
        : {}),
    };
  }

  private ensureConfigured(): {
    enclaveUrl: string;
    verifier: AttestationVerifier;
    expectedPolicyVersion: string;
  } {
    const enclaveUrl = this.enclaveUrl();
    const config = this.privateVerifierConfig();
    if (!enclaveUrl || !config.policy.allowedImageDigests.length || !config.policy.allowedProjects.length) {
      throw new BadRequestException(
        "Tee verification is not configured (SIXFIGS_ENCLAVE_URL / SIXFIGS_IMAGE_DIGEST / SIXFIGS_GCP_PROJECT)",
      );
    }
    return {
      enclaveUrl,
      verifier: new AttestationVerifier(config),
      expectedPolicyVersion:
        (process.env.SIXFIGS_EXPECTED_POLICY_VERSION ?? "").trim() || POLICY_VERSION,
    };
  }

  private recheckTtlMs(): number {
    const raw = Number(process.env.TEE_RECHECK_TTL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECHECK_TTL_MS;
  }

  /** Issue a single-use registration nonce bound to this session. */
  async issueNonce(userId: string): Promise<{ nonce: string }> {
    const nonce = randomBytes(24).toString("base64url");
    await this.cache.set(`tee:nonce:${nonce}`, { userId }, NONCE_TTL_MS);
    return { nonce };
  }

  /** Consume a nonce; consumed or unknown nonces fail closed. */
  async consumeNonce(nonce: string): Promise<string> {
    const entry = await this.cache.get<{ userId: string }>(`tee:nonce:${nonce}`);
    await this.cache.del(`tee:nonce:${nonce}`);
    if (!entry?.userId) {
      throw new UnauthorizedException("Registration nonce expired or invalid");
    }
    return entry.userId;
  }

  private tierLabel(tierId: number): string {
    const label = productTierLabel(tierId);
    return label ? `TIER ${label}` : "NONE";
  }

  /**
   * Verify a submitted registration and persist the transition. The nonce is
   * consumed first so a double submit fails closed before attestation work.
   */
  async register(
    userId: string,
    signed: SignedRegistration,
    escrowBlob: SignedEnvelope,
  ): Promise<TeeIdentityView> {
    const { verifier, expectedPolicyVersion } = this.ensureConfigured();
    if (!signed || typeof signed !== "object" || !signed.body || typeof signed.body.nonce !== "string") {
      throw new BadRequestException("Malformed signed registration");
    }
    if (!escrowBlob || typeof escrowBlob !== "object" || escrowBlob.v !== 1) {
      throw new BadRequestException("Malformed escrow blob");
    }
    const boundUser = await this.consumeNonce(signed.body.nonce);
    if (boundUser !== userId) {
      throw new UnauthorizedException("Registration belongs to another session");
    }

    let body: RegistrationResultBody;
    try {
      body = await verifier.verifyRegistration(signed, {
        expectedNonce: signed.body.nonce,
        expectedPolicyVersion,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? `Tee verification failed: ${error.message}` : "Tee verification failed",
      );
    }

    const kept = body.walletNullifiers;
    const removed = body.removedWalletNullifiers ?? [];
    const keptIds = kept.map((w) => w.walletNullifier);
    const removedIds = removed.map((w) => w.walletNullifier);
    const allIds = [...keptIds, ...removedIds];
    if (allIds.length === 0) throw new BadRequestException("Empty wallet set");
    const labels = new Map(kept.map((w) => [w.walletNullifier, w.label ?? null]));

    const persisted = await this.prisma.$transaction(async (tx) => {
      const ownerRows = await tx.teeWalletBinding.findMany({
        where: { walletNullifier: { in: allIds } },
      });
      const ownerIdentities = new Set(ownerRows.map((r) => r.identityNullifier));
      const mine = await tx.teeIdentity.findUnique({ where: { userId } });

      const writeIdentity = async (identityNullifier: string) => {
        await tx.teeIdentity.upsert({
          where: { identityNullifier },
          create: {
            identityNullifier,
            userId,
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            stableBps: body.stableBps,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            escrowBlob: JSON.stringify(escrowBlob),
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
          update: {
            userId,
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            stableBps: body.stableBps,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            escrowBlob: JSON.stringify(escrowBlob),
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
        });
        await tx.teeWalletBinding.deleteMany({ where: { identityNullifier } });
        await tx.teeWalletBinding.createMany({
          data: kept.map((w) => ({
            walletNullifier: w.walletNullifier,
            identityNullifier,
            family: w.family,
            label: labels.get(w.walletNullifier) ?? null,
          })),
        });
      };

      const assertMine = async (identityNullifier: string) => {
        const row = await tx.teeIdentity.findUnique({ where: { identityNullifier } });
        if (!row || row.userId !== userId) {
          throw new BadRequestException("Wallet set belongs to another account");
        }
      };

      if (removed.length > 0) {
        // Removal: every previously enrolled wallet must be accounted for.
        if (ownerIdentities.size !== 1) {
          throw new BadRequestException("Wallet set transition conflicts with enrolled accounts");
        }
        const previous = [...ownerIdentities][0]!;
        const previousEntries = ownerRows.map((r) => ({
          family: r.family as "evm" | "solana",
          walletNullifier: r.walletNullifier,
        }));
        if (walletSetNullifier(previousEntries) !== previous) {
          throw new BadRequestException("Stored wallet set is incoherent");
        }
        await assertMine(previous);
        const union = new Set(allIds);
        const previousIds = previousEntries.map((e) => e.walletNullifier);
        if (previousIds.some((id) => !union.has(id))) {
          throw new BadRequestException("Transition omits an enrolled wallet");
        }
        if (removedIds.some((id) => !previousIds.includes(id))) {
          throw new BadRequestException("Removal of a wallet that was never enrolled");
        }
        if (previous !== body.identityNullifier) {
          await writeIdentity(body.identityNullifier);
          await tx.teeWalletBinding.deleteMany({ where: { identityNullifier: previous } });
          await tx.teeIdentity.delete({ where: { identityNullifier: previous } });
        } else {
          await writeIdentity(previous);
        }
      } else if (ownerIdentities.size === 0) {
        // Fresh set: if the user already has a different identity, the new
        // proof replaces it (re-prove is the account's own choice).
        if (mine && mine.identityNullifier !== body.identityNullifier) {
          await tx.teeWalletBinding.deleteMany({
            where: { identityNullifier: mine.identityNullifier },
          });
          await tx.teeIdentity.delete({ where: { identityNullifier: mine.identityNullifier } });
        }
        await writeIdentity(body.identityNullifier);
      } else if (ownerIdentities.size === 1) {
        const previous = [...ownerIdentities][0]!;
        if (previous === body.identityNullifier) {
          await writeIdentity(previous);
        } else {
          const previousEntries = ownerRows.map((r) => ({
            family: r.family as "evm" | "solana",
            walletNullifier: r.walletNullifier,
          }));
          if (walletSetNullifier(previousEntries) !== previous) {
            throw new BadRequestException("Stored wallet set is incoherent");
          }
          await assertMine(previous);
          const keptSet = new Set(keptIds);
          if (previousEntries.some((e) => !keptSet.has(e.walletNullifier))) {
            throw new BadRequestException("Transition drops a wallet without consent");
          }
          await writeIdentity(body.identityNullifier);
          await tx.teeWalletBinding.deleteMany({ where: { identityNullifier: previous } });
          await tx.teeIdentity.delete({ where: { identityNullifier: previous } });
        }
      } else {
        throw new BadRequestException("Wallets belong to multiple accounts");
      }

      await this.syncEligibilityCache(tx, userId, body.tier);
      return tx.teeIdentity.findUniqueOrThrow({
        where: { identityNullifier: body.identityNullifier },
        include: { bindings: { orderBy: { createdAt: "asc" } } },
      });
    });

    return this.view(persisted);
  }

  private async syncEligibilityCache(
    tx: {
      eligibilityCache: {
        upsert(a: unknown): Promise<unknown>;
        deleteMany(a: unknown): Promise<unknown>;
      };
    },
    userId: string,
    tierId: number,
  ): Promise<void> {
    if (tierId > 0) {
      await tx.eligibilityCache.upsert({
        where: { userId },
        create: { userId, tier: this.tierLabel(tierId), expiresAt: new Date(Date.now() + 24 * 3_600_000) },
        update: { tier: this.tierLabel(tierId), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 3_600_000) },
      });
    } else {
      await tx.eligibilityCache.deleteMany({ where: { userId } });
    }
  }

  /** Stored view with no balance computation. */
  view(identity: {
    identityNullifier: string;
    tier: number;
    tierLabel: string;
    portfolioBand: string;
    stableBps: number;
    topAssets: unknown;
    verifiedAt: Date;
    expiresAt: Date;
    bindings: Array<{ family: string; label: string | null }>;
  }): TeeIdentityView {
    const verifiedAt = identity.verifiedAt.getTime();
    const expiresAt = identity.expiresAt.getTime();
    const now = Date.now();
    const verified = now < expiresAt;
    const stale = now - verifiedAt > this.recheckTtlMs();
    return {
      source: "tee",
      tier: verified && identity.tier > 0 ? identity.tierLabel : null,
      tierId: identity.tier,
      portfolioBand: identity.portfolioBand,
      topAssets: Array.isArray(identity.topAssets) ? (identity.topAssets as string[]) : [],
      stableBps: identity.stableBps,
      wallets: identity.bindings.map((b) => ({ family: b.family, label: b.label })),
      walletCount: identity.bindings.length,
      verifiedAt: identity.verifiedAt.toISOString(),
      expiresAt: identity.expiresAt.toISOString(),
      stale,
      verified,
    };
  }

  /** Read the stored view without triggering a recheck. */
  async storedView(userId: string): Promise<TeeIdentityView | null> {
    const identity = await this.prisma.teeIdentity.findUnique({
      where: { userId },
      include: { bindings: { orderBy: { createdAt: "asc" } } },
    });
    return identity ? this.view(identity) : null;
  }

  /** Read, re-verifying first when the TTL has elapsed. */
  async read(userId: string): Promise<TeeIdentityView | null> {
    const stored = await this.storedView(userId);
    if (!stored) return null;
    if (!stored.stale) return stored;
    return this.refresh(userId);
  }

  /**
   * Refresh an identity through the enclave recheck endpoint. Concurrent
   * attempts for one identity serialize on a Redis lock; a concurrent caller
   * gets the stored view. Enclave failures return the stored view (marked
   * stale/unverified) so a transient outage cannot wipe a valid tier.
   */
  async refresh(userId: string, force = false): Promise<TeeIdentityView | null> {
    const { enclaveUrl, verifier, expectedPolicyVersion } = this.ensureConfigured();
    const stored = await this.prisma.teeIdentity.findUnique({
      where: { userId },
      include: { bindings: { orderBy: { createdAt: "asc" } } },
    });
    if (!stored) return null;
    if (!force && !this.view(stored).stale) return this.view(stored);

    const locked = await this.cache.lock(
      `tee:recheck:${stored.identityNullifier}`,
      RECHECK_LOCK_MS,
    );
    if (!locked) return this.view(stored);

    try {
      const nonce = randomBytes(16).toString("hex");
      const client = new RecheckClient({ enclaveUrl, policy: this.clientPolicy() });
      const blob = JSON.parse(stored.escrowBlob) as SignedEnvelope;
      const res = await client.recheck({
        escrowBlob: blob,
        identityNullifier: stored.identityNullifier,
        nonce,
      });
      const body = await verifier.verifyRegistration(res, {
        expectedNonce: nonce,
        expectedPolicyVersion,
      });
      if (body.identityNullifier !== stored.identityNullifier) {
        throw new BadRequestException("Recheck changed the identity");
      }
      const nextIds = new Set(body.walletNullifiers.map((w) => w.walletNullifier));
      const currentIds = new Set(stored.bindings.map((b) => b.walletNullifier));
      if (nextIds.size !== currentIds.size || [...nextIds].some((id) => !currentIds.has(id))) {
        throw new BadRequestException("Recheck returned a different wallet set");
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.teeIdentity.update({
          where: { identityNullifier: stored.identityNullifier },
          data: {
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            stableBps: body.stableBps,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
        });
        for (const entry of body.walletNullifiers) {
          await tx.teeWalletBinding.update({
            where: { walletNullifier: entry.walletNullifier },
            data: { family: entry.family, label: entry.label ?? null },
          });
        }
        await this.syncEligibilityCache(tx, userId, body.tier);
        return tx.teeIdentity.findUniqueOrThrow({
          where: { identityNullifier: stored.identityNullifier },
          include: { bindings: { orderBy: { createdAt: "asc" } } },
        });
      });
      return this.view(updated);
    } catch (error) {
      this.log.warn(
        `tee recheck failed for identity ${stored.identityNullifier}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      return this.view(stored);
    } finally {
      await this.cache.unlock(`tee:recheck:${stored.identityNullifier}`);
    }
  }
}