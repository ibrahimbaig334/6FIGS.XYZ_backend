import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { AttestationVerifier } from "@sixfigs/tee/verifier";
import { RecheckClient, RemovalClient } from "@sixfigs/tee/client";
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
import { AuthService } from "../auth/auth.service";
import {
  RECOVERY_TOKEN_PREFIX,
  RECOVERY_TTL_MS,
} from "../auth/username.service";

const NONCE_TTL_MS = 15 * 60 * 1000;
const RECHECK_LOCK_MS = 60_000;
const DEFAULT_RECHECK_TTL_MS = 3_600_000;
/** Interactive-tx limits: the DB is remote (local backend → Render
 *  Postgres), so the Prisma 5s default can expire mid-register. */
const TX_OPTS = { timeout: 30_000, maxWait: 15_000 };
/** Attested-proof freshness: replaces pre-issued nonces for sessionless
 *  flows (nothing to lose between issue and submit, no expiry pressure on
 *  the user, immune to cache restarts). */
const REPLAY_WINDOW_MS = 30 * 60 * 1000;

export interface TeeWalletView {
  /** Opaque wallet pseudonym (keyed hash) â€” stable id for removal, reveals nothing. */
  id: string;
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
    private readonly auth: AuthService,
  ) {}

  private enclaveUrl(): string {
    return (process.env.SIXFIGS_ENCLAVE_URL ?? "").trim();
  }

  privateVerifierConfig() {
    const configuredProviders = splitList(
      process.env.SIXFIGS_REQUIRED_ESCROW_KEY_PROVIDERS,
    );
    // Production defaults to KMS-only unless the operator overrides it.
    const requiredEscrowKeyProviders =
      configuredProviders.length > 0
        ? configuredProviders
        : process.env.NODE_ENV === "production"
          ? ["kms"]
          : [];
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
        ...(requiredEscrowKeyProviders.length > 0
          ? { requiredEscrowKeyProviders }
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
      ...(config.policy.requiredEscrowKeyProviders
        ? { requiredEscrowKeyProviders: config.policy.requiredEscrowKeyProviders }
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

  /**
   * Issue a single-use registration nonce bound to this session. When the user
   * already has a verified identity, also return what an addition needs: the
   * stored identity pseudonym and the opaque escrow blob. The blob is
   * ciphertext the backend cannot read; handing it back to its owner is what
   * lets the browser add a wallet without reconnecting the old ones.
   */
  async issueNonce(userId: string): Promise<{
    nonce: string;
    add?: { identityNullifier: string; escrowBlob: SignedEnvelope };
  }> {
    const nonce = randomBytes(24).toString("base64url");
    await this.cache.set(`tee:nonce:${nonce}`, { userId }, NONCE_TTL_MS);
    const stored = await this.prisma.teeIdentity.findUnique({ where: { userId } });
    if (!stored) return { nonce };
    return {
      nonce,
      add: {
        identityNullifier: stored.identityNullifier,
        escrowBlob: JSON.parse(stored.escrowBlob) as SignedEnvelope,
      },
    };
  }

  /**
   * First-submitter-wins claim for sessionless submits. Pre-issued nonces
   * have a fatal flaw here: anything that loses the store entry between
   * issue and submit (restart, eviction, race) turns into a user-facing
   * 401 with no recovery. Claiming atomically at submit leaves no window
   * at all; the attested createdAt below bounds the replay horizon instead.
   */
  private async claimNonce(nonce: string): Promise<void> {
    const fresh = await this.cache.lock(
      `tee:nonce:used:${nonce}`,
      REPLAY_WINDOW_MS,
      0,
    );
    if (!fresh) {
      throw new UnauthorizedException("Proof already used — reconnect and try again");
    }
  }

  /** Consume a nonce; consumed or unknown nonces fail closed. Null user = public (login/identify) nonce. */
  async consumeNonce(nonce: string): Promise<string | null> {
    const entry = await this.cache.get<{ userId: string | null }>(`tee:nonce:${nonce}`);
    await this.cache.del(`tee:nonce:${nonce}`);
    if (!entry || entry.userId === undefined) {
      this.log.warn(
        `tee nonce consume failed (missing): nonce=${String(nonce).slice(0, 8)}`,
      );
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
   * A null userId means sessionless wallet login: the nonce must be public,
   * the result must establish a full set, and the owner is resolved (or
   * created) from the attested wallets.
   */
  async register(
    userId: string | null,
    signed: SignedRegistration,
    escrowBlob?: SignedEnvelope,
  ): Promise<{ view: TeeIdentityView; userId: string }> {
    if (!signed || typeof signed !== "object" || !signed.body || typeof signed.body.nonce !== "string") {
      throw new BadRequestException("Malformed signed registration");
    }
    if (userId === null) {
      // Sessionless: atomic first-submitter-wins claim (no pre-issued entry).
      await this.claimNonce(signed.body.nonce);
    } else {
      const boundUser = await this.consumeNonce(signed.body.nonce);
      if (boundUser !== userId) {
        throw new UnauthorizedException("Registration belongs to another session");
      }
    }
    const v = await this.verifySigned(signed, escrowBlob);
    const {
      body,
      kept,
      keptIds,
      addedIds,
      removed,
      removedIds,
      labels,
      isAddition,
      isRemoval,
      escrowForWrite,
    } = v;
    const effectiveUserId =
      userId ?? (await this.resolveOrCreateLoginUser(keptIds));
    // Freshness from the attested creation time (not wall-clock games):
    // proofs older than the replay window are dead, claimed or not.
    const createdMs =
      typeof v.body.createdAt === "number"
        ? v.body.createdAt
        : Date.parse(v.body.createdAt);
    if (Number.isNaN(createdMs) || Date.now() - createdMs > REPLAY_WINDOW_MS) {
      throw new BadRequestException("Proof is stale — reconnect and try again");
    }

    try {
      await this.prisma.$transaction(async (tx) => {
      const writeIdentity = async (identityNullifier: string) => {
        const existing = await tx.teeIdentity.findUnique({ where: { userId: effectiveUserId } });
        await tx.teeIdentity.upsert({
          where: { userId: effectiveUserId },
          create: {
            userId: effectiveUserId,
            identityNullifier,
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            escrowBlob: escrowForWrite,
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
          update: {
            identityNullifier,
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            escrowBlob: escrowForWrite,
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
        });
        if (existing && existing.identityNullifier !== identityNullifier) {
          await tx.teeWalletBinding.deleteMany({
            where: { identityNullifier: existing.identityNullifier },
          });
        }
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

      if (isRemoval) {
        const previous = body.previousIdentityNullifier!;
        const mine = await tx.teeIdentity.findUnique({ where: { userId: effectiveUserId } });
        if (!mine || mine.identityNullifier !== previous) {
          throw new BadRequestException("No matching verified identity for this removal");
        }
        const previousRows = await tx.teeWalletBinding.findMany({
          where: { identityNullifier: previous },
        });
        const previousIds = new Set(previousRows.map((r) => r.walletNullifier));
        if (previousRows.length === 0 || previousIds.size !== previousRows.length) {
          throw new BadRequestException("Stored wallet set is incoherent");
        }
        const keptSet = new Set(keptIds);
        const removedSet = new Set(removedIds);
        if (keptSet.size !== keptIds.length || removedSet.size !== removedIds.length) {
          throw new BadRequestException("Wallet set contains duplicates");
        }
        if (keptIds.some((id) => removedSet.has(id))) {
          throw new BadRequestException("A wallet cannot be kept and removed");
        }
        // Exact partition: stored = kept âˆª removed.
        const union = new Set([...keptIds, ...removedIds]);
        if (union.size !== previousIds.size || [...previousIds].some((id) => !union.has(id))) {
          throw new BadRequestException("Removal omits an enrolled wallet");
        }
        if (removedIds.some((id) => !previousIds.has(id))) {
          throw new BadRequestException("Removal of a wallet that was never enrolled");
        }
        await writeIdentity(body.identityNullifier);
      } else if (isAddition) {
        const previous = body.previousIdentityNullifier!;
        const mine = await tx.teeIdentity.findUnique({ where: { userId: effectiveUserId } });
        if (!mine || mine.identityNullifier !== previous) {
          throw new BadRequestException("No matching verified identity for this addition");
        }
        const previousRows = await tx.teeWalletBinding.findMany({
          where: { identityNullifier: previous },
        });
        const previousIds = new Set(previousRows.map((r) => r.walletNullifier));
        if (previousRows.length === 0 || previousIds.size !== previousRows.length) {
          throw new BadRequestException("Stored wallet set is incoherent");
        }
        // Every stored wallet must remain; the new set is a strict superset.
        for (const id of previousIds) {
          if (!keptIds.includes(id)) {
            throw new BadRequestException("Transition drops a stored wallet");
          }
        }
        const derivedAdded = keptIds.filter((id) => !previousIds.has(id));
        const claimed = new Set(addedIds);
        if (
          derivedAdded.length === 0 ||
          derivedAdded.length !== claimed.size ||
          derivedAdded.some((id) => !claimed.has(id))
        ) {
          throw new BadRequestException("Signed added-wallet set does not match the transition");
        }
        // One wallet, one account: an added wallet must be unowned elsewhere.
        const taken = await tx.teeWalletBinding.findMany({
          where: { walletNullifier: { in: derivedAdded } },
        });
        if (taken.length > 0) {
          throw new BadRequestException("That wallet is already connected to an account");
        }
        await writeIdentity(body.identityNullifier);
      } else {
        const ownerRows = await tx.teeWalletBinding.findMany({
          where: { walletNullifier: { in: keptIds } },
        });
        const ownerIdentities = new Set(ownerRows.map((r) => r.identityNullifier));
        const mine = await tx.teeIdentity.findUnique({ where: { userId: effectiveUserId } });

          const assertMine = async (identityNullifier: string) => {
            const row = await tx.teeIdentity.findUnique({ where: { identityNullifier } });
            if (!row || row.userId !== effectiveUserId) {
              throw new BadRequestException("Wallet set belongs to another account");
            }
          };

        if (ownerIdentities.size === 0) {
          // Fresh set: if the user already has a different identity, the new
          // proof replaces it (re-prove is the account's own choice);
          // writeIdentity detaches the previous bindings.
          await writeIdentity(body.identityNullifier);
        } else if (ownerIdentities.size === 1) {
          const previous = [...ownerIdentities][0]!;
          // Ownership FIRST â€” before any write in either sub-branch. Without
          // this, proving a set enrolled elsewhere crashes on the unique
          // constraint instead of failing closed with a 400.
          await assertMine(previous);
          if (previous === body.identityNullifier) {
            await writeIdentity(previous);
          } else {
            const previousRows = ownerRows.map((r) => ({
              family: r.family as "evm" | "solana",
              walletNullifier: r.walletNullifier,
            }));
            const keptSet = new Set(keptIds);
            if (previousRows.some((e) => !keptSet.has(e.walletNullifier))) {
              throw new BadRequestException("Transition drops a wallet without consent");
            }
            // A tier zeroed by disconnects may be re-established over any
            // subset of its remaining wallets; otherwise the stored set
            // must match exactly.
            if (
              walletSetNullifier(previousRows) !== previous &&
              !(mine && mine.tier === 0)
            ) {
              throw new BadRequestException("Stored wallet set is incoherent");
            }
            await writeIdentity(body.identityNullifier);
          }
        } else {
          throw new BadRequestException("Wallets belong to multiple accounts");
        }
      }

      await this.syncEligibilityCache(tx, effectiveUserId, body.tier);
      // Writes only â€” the final read happens outside the transaction so a
      // slow/cold DB can never surface as "Transaction already closed".
      }, TX_OPTS);
    } catch (e) {
      // Lost a concurrent double-submit race on the unique nullifier: if the
      // winner persisted exactly this set, return it (idempotent success);
      // anything else is a foreign set and stays a 400.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const mine = await this.prisma.teeIdentity.findUnique({
          where: { userId: effectiveUserId },
          include: { bindings: { orderBy: { createdAt: "asc" } } },
        });
        if (mine && mine.identityNullifier === body.identityNullifier) {
          return { view: this.view(mine), userId: effectiveUserId };
        }
        throw new BadRequestException("Wallet set belongs to another account");
      }
      throw e;
    }

    const persisted = await this.prisma.teeIdentity.findUniqueOrThrow({
      where: { userId: effectiveUserId },
      include: { bindings: { orderBy: { createdAt: "asc" } } },
    });
    return { view: this.view(persisted), userId: effectiveUserId };
  }

  /** Attested verify + parse shared by register / login / identify. */
  private async verifySigned(
    signed: SignedRegistration,
    escrowBlob?: SignedEnvelope,
    opts?: { establishOnly?: boolean; requireEscrow?: boolean },
  ): Promise<{
    body: RegistrationResultBody;
    kept: RegistrationResultBody["walletNullifiers"];
    keptIds: string[];
    addedIds: string[];
    removed: RegistrationResultBody["walletNullifiers"];
    removedIds: string[];
    labels: Map<string, string | null>;
    isAddition: boolean;
    isRemoval: boolean;
    escrowForWrite: string;
  }> {
    const { verifier, expectedPolicyVersion } = this.ensureConfigured();
    if (!signed || typeof signed !== "object" || !signed.body) {
      throw new BadRequestException("Malformed signed registration");
    }
    const establishment = signed.body.previousIdentityNullifier === undefined;
    if (opts?.establishOnly && !establishment) {
      throw new BadRequestException("Wallet login must establish a full set");
    }
    if (establishment && opts?.requireEscrow !== false && (!escrowBlob || escrowBlob.v !== 1)) {
      throw new BadRequestException("Malformed escrow blob");
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
    const keptIds = kept.map((w) => w.walletNullifier);
    const addedIds = (body.addedWalletNullifiers ?? []).map((w) => w.walletNullifier);
    const removed = body.removedWalletNullifiers ?? [];
    const removedIds = removed.map((w) => w.walletNullifier);
    if (keptIds.length === 0) throw new BadRequestException("Empty wallet set");
    const labels = new Map(kept.map((w) => [w.walletNullifier, w.label ?? null]));
    const isAddition = body.addedWalletNullifiers !== undefined;
    const isRemoval = removedIds.length > 0;
    if (isAddition && isRemoval) {
      throw new BadRequestException("A transition cannot add and remove wallets at once");
    }
    if ((isAddition || isRemoval) && (!body.previousIdentityNullifier || !body.nextEscrowBlob)) {
      throw new BadRequestException("Transition result is missing its previous identity or escrow blob");
    }
    // Additions/removals store the enclave-produced blob; establishments store
    // the client-produced blob.
    const escrowForWrite = JSON.stringify(body.nextEscrowBlob ?? escrowBlob);
    return {
      body,
      kept,
      keptIds,
      addedIds,
      removed,
      removedIds,
      labels,
      isAddition,
      isRemoval,
      escrowForWrite,
    };
  }

  /**
   * Sessionless wallet login through the enclave. The server never sees an
   * address: it resolves the owner from the attested nullifiers (or creates
   * the account for a fresh set) and issues a JWT. Same proof as a normal
   * establish, so tier and escrow persist identically. Single-use is enforced
   * by atomic claim (not a pre-issued nonce), and the attested creation time
   * bounds replays.
   */
  async registerLogin(
    signed: SignedRegistration,
    escrowBlob?: SignedEnvelope,
  ): Promise<{ token: string }> {
    if (!signed || typeof signed !== "object" || !signed.body || typeof signed.body.nonce !== "string") {
      throw new BadRequestException("Malformed signed registration");
    }
    // No claim here: register(null, …) claims exactly once below. Claiming
    // twice would reject every login with "already used" (found the hard way).
    const { view, userId } = await this.register(null, signed, escrowBlob);
    void view;
    return { token: await this.auth.issueToken(userId) };
  }

  /** Owner lookup (or creation) for a sessionless login set. */
  private async resolveOrCreateLoginUser(keptIds: string[]): Promise<string> {
    const rows = await this.prisma.teeWalletBinding.findMany({
      where: { walletNullifier: { in: keptIds } },
    });
    const owners = new Set(rows.map((r) => r.identityNullifier));
    if (owners.size === 0) {
      for (let i = 0; i < 5; i++) {
        try {
          const user = await this.prisma.user.create({
            data: { handle: `user_${randomBytes(3).toString("hex")}` },
          });
          return user.id;
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
      throw new BadRequestException("Couldn't create account — try again");
    }
    if (owners.size > 1) {
      throw new BadRequestException("Wallets belong to multiple accounts");
    }
    const identity = await this.prisma.teeIdentity.findUnique({
      where: { identityNullifier: [...owners][0]! },
    });
    if (!identity) throw new BadRequestException("Stored wallet set is incoherent");
    return identity.userId;
  }

  /**
   * Sessionless identify for username recovery: which account holds these
   * wallets? Every kept wallet must resolve to ONE identity (shared wallets
   * are impossible — bindings are globally unique — so a subset still
   * identifies its owner). Returns the username plus a single-use recovery
   * token. Nothing is stored; no addresses are involved at any point.
   */
  async identify(
    signed: SignedRegistration,
  ): Promise<{ username: string | null; recoveryToken: string }> {
    if (!signed || typeof signed !== "object" || !signed.body || typeof signed.body.nonce !== "string") {
      throw new BadRequestException("Malformed signed registration");
    }
    await this.claimNonce(signed.body.nonce);
    const v = await this.verifySigned(signed, undefined, {
      establishOnly: true,
      requireEscrow: false,
    });
    const rows = await this.prisma.teeWalletBinding.findMany({
      where: { walletNullifier: { in: v.keptIds } },
    });
    if (rows.length !== v.keptIds.length) {
      throw new NotFoundException("No account found for this wallet set");
    }
    const owners = new Set(rows.map((r) => r.identityNullifier));
    if (owners.size !== 1) {
      throw new BadRequestException("Wallets belong to multiple accounts");
    }
    const identity = await this.prisma.teeIdentity.findUnique({
      where: { identityNullifier: [...owners][0]! },
    });
    if (!identity) throw new NotFoundException("No account found for this wallet set");
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: identity.userId },
    });
    const raw = randomBytes(32).toString("base64url");
    await this.cache.set(
      `${RECOVERY_TOKEN_PREFIX}${raw}`,
      { userId: user.id },
      RECOVERY_TTL_MS,
    );
    return { username: user.username, recoveryToken: raw };
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
    topAssets: unknown;
    verifiedAt: Date;
    expiresAt: Date;
    bindings: Array<{ walletNullifier: string; family: string; label: string | null }>;
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
      wallets: identity.bindings.map((b) => ({ id: b.walletNullifier, family: b.family, label: b.label })),
      walletCount: identity.bindings.length,
      verifiedAt: identity.verifiedAt.toISOString(),
      expiresAt: identity.expiresAt.toISOString(),
      stale,
      verified,
    };
  }

  /** Count legacy wallet rows for the no-tier eligibility fallback. */
  async countWallets(userId: string): Promise<number> {
    return this.prisma.wallet.count({ where: { userId } });
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

      await this.prisma.$transaction(async (tx) => {
        await tx.teeIdentity.update({
          where: { identityNullifier: stored.identityNullifier },
          data: {
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
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
      }, TX_OPTS);
      const updated = await this.prisma.teeIdentity.findUniqueOrThrow({
        where: { identityNullifier: stored.identityNullifier },
        include: { bindings: { orderBy: { createdAt: "asc" } } },
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

  /**
   * Session-authorized wallet removal. The account session is the only
   * wallet-facing proof: the enclave detaches the wallet from the escrow blob
   * without signatures, and the backend enforces that the returned set is
   * exactly the stored set minus the target. Denial-only tradeoff documented
   * in the tee SECURITY.md.
   */
  async removeWallet(userId: string, walletId: string): Promise<TeeIdentityView> {
    const { enclaveUrl, verifier, expectedPolicyVersion } = this.ensureConfigured();
    const stored = await this.prisma.teeIdentity.findUnique({
      where: { userId },
      include: { bindings: { orderBy: { createdAt: "asc" } } },
    });
    if (!stored) {
      throw new BadRequestException("No verified wallet set for this account");
    }
    if (stored.bindings.length <= 1) {
      throw new BadRequestException("Cannot remove your only wallet");
    }
    if (!stored.bindings.some((b) => b.walletNullifier === walletId)) {
      throw new BadRequestException("That wallet is not connected to your account");
    }

    const locked = await this.cache.lock(
      `tee:recheck:${stored.identityNullifier}`,
      RECHECK_LOCK_MS,
    );
    if (!locked) {
      throw new BadRequestException("A verification is already running, try again");
    }
    try {
      const nonce = randomBytes(16).toString("hex");
      const client = new RemovalClient({ enclaveUrl, policy: this.clientPolicy() });
      const blob = JSON.parse(stored.escrowBlob) as SignedEnvelope;
      const res = await client.remove({
        escrowBlob: blob,
        identityNullifier: stored.identityNullifier,
        removeWalletNullifiers: [walletId],
        nonce,
      });
      const body = await verifier.verifyRegistration(res, {
        expectedNonce: nonce,
        expectedPolicyVersion,
      });
      if (body.previousIdentityNullifier !== stored.identityNullifier) {
        throw new BadRequestException("Removal did not extend the stored identity");
      }
      if (!body.nextEscrowBlob) {
        throw new BadRequestException("Removal did not return an escrow blob");
      }
      const removedIds = (body.removedWalletNullifiers ?? []).map((w) => w.walletNullifier);
      if (removedIds.length !== 1 || removedIds[0] !== walletId) {
        throw new BadRequestException("Removal result does not detach the requested wallet");
      }
      const keptIds = body.walletNullifiers.map((w) => w.walletNullifier);
      const keptSet = new Set(keptIds);
      const expectedKept = new Set(
        stored.bindings.map((b) => b.walletNullifier).filter((id) => id !== walletId),
      );
      if (
        keptSet.size !== keptIds.length ||
        keptSet.size !== expectedKept.size ||
        keptIds.some((id) => !expectedKept.has(id))
      ) {
        throw new BadRequestException("Removal returned a different wallet set");
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.teeIdentity.update({
          where: { userId },
          data: {
            identityNullifier: body.identityNullifier,
            tier: body.tier,
            tierLabel: this.tierLabel(body.tier),
            portfolioBand: body.portfolioBand,
            topAssets: body.topAssets,
            policyVersion: body.policyVersion,
            escrowBlob: JSON.stringify(body.nextEscrowBlob),
            verifiedAt: new Date(body.createdAt),
            expiresAt: new Date(body.expiresAt),
          },
        });
        await tx.teeWalletBinding.delete({ where: { walletNullifier: walletId } });
        for (const entry of body.walletNullifiers) {
          await tx.teeWalletBinding.update({
            where: { walletNullifier: entry.walletNullifier },
            data: { family: entry.family, label: entry.label ?? null },
          });
        }
        await this.syncEligibilityCache(tx, userId, body.tier);
      }, TX_OPTS);

      const updated = await this.prisma.teeIdentity.findUniqueOrThrow({
        where: { userId },
        include: { bindings: { orderBy: { createdAt: "asc" } } },
      });
      return this.view(updated);
    } finally {
      await this.cache.unlock(`tee:recheck:${stored.identityNullifier}`);
    }
  }
}
