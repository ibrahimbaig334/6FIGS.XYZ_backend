/* Devnet seed: bot holders + tier/invite rooms (codes DEGEN69 / ALPHA1). */
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const inviteHash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
const addrHash = (s: string) => createHash("sha256").update(s).digest("hex");

const BOTS = [
  { handle: "VAULT_FOX", tier: "TIER II", tags: ["DEFI", "L2s", "STAKING"], visMode: "CATEGORIES", total: 620_000 },
  { handle: "SATS_QUEEN", tier: "TIER I", tags: ["BTC", "COLD-STORAGE"], visMode: "HIDDEN", total: 210_000 },
  { handle: "MEGAWHALE.E", tier: "TIER III", tags: ["ETH", "NFT-GRAILS", "DEFI"], visMode: "FULL", total: 4_200_000 },
  { handle: "STABLE_SAM", tier: "TIER I", tags: ["STABLES", "YIELD"], visMode: "CATEGORIES", total: 140_000 },
  { handle: "L2_LARRY", tier: "TIER II", tags: ["ARBITRUM", "BASE", "AIRDROPS"], visMode: "HIDDEN", total: 780_000 },
  { handle: "DIAMOND_DAO", tier: "TIER III", tags: ["SOL", "BTC", "DEFI"], visMode: "FULL", total: 8_900_000 },
];

const ROOMS = [
  { name: "₿ BTC LOUNGE", accessType: "tier", minTier: "TIER I" },
  { name: "L2 LOUNGE", accessType: "tier", minTier: "TIER II" },
  { name: "TIER III ALPHA", accessType: "tier", minTier: "TIER III" },
  { name: "DEGEN DOJO", accessType: "invite", code: "DEGEN69" },
  { name: "SOL DEN", accessType: "invite", code: "ALPHA1" },
];

async function main() {
  const botIds: string[] = [];
  for (const b of BOTS) {
    const user = await prisma.user.upsert({
      where: { handle: b.handle },
      create: { handle: b.handle, visMode: b.visMode, tags: b.tags, isBot: true },
      update: { visMode: b.visMode, tags: b.tags, isBot: true },
    });
    botIds.push(user.id);
    const hash = addrHash(`mock:bot:${b.handle}`);
    await prisma.wallet.upsert({
      where: { addressHash: hash },
      create: { userId: user.id, chain: "EVM", addressHash: hash, addressEnc: Buffer.from(`mock:bot:${b.handle}`, "utf8").toString("base64url"), mockUsd: b.total, verifiedAt: new Date() },
      update: { mockUsd: b.total },
    });
    await prisma.eligibilityCache.upsert({
      where: { userId: user.id },
      create: { userId: user.id, tier: b.tier, assetPct: { EVM: 100 }, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
      update: { tier: b.tier, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    });
  }
  const owner = botIds[0];
  for (const r of ROOMS) {
    let room = await prisma.room.findFirst({ where: { name: r.name } });
    if (!room) {
      room = await prisma.room.create({
        data: {
          name: r.name,
          accessType: r.accessType,
          minTier: "minTier" in r ? (r.minTier as string) : null,
          inviteCodeHash: "code" in r ? inviteHash(r.code as string) : null,
          createdBy: owner,
        },
      });
    }
    for (const uid of botIds) {
      await prisma.roomMember.upsert({
        where: { roomId_userId: { roomId: room.id, userId: uid } },
        create: { roomId: room.id, userId: uid },
        update: {},
      });
    }
  }
  console.log(`Seeded ${BOTS.length} bots + ${ROOMS.length} rooms`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
