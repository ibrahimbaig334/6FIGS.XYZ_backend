/* Devnet seed: no bots. Removes legacy bot users (cascades their wallets,
 * tiers, memberships and bot-created rooms), then ensures one starter lounge
 * if at least one real user exists. Invite codes: DEGEN69 / ALPHA1 (docs). */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const bots = await prisma.user.deleteMany({ where: { isBot: true } });
  console.log(`Removed ${bots.count} bot users`);
  const first = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) {
    console.log("No real users — skipping room seeds (create rooms from the app)");
    return;
  }
  const existing = await prisma.room.findFirst({ where: { name: "₿ BTC LOUNGE" } });
  if (!existing) {
    const room = await prisma.room.create({
      data: { name: "₿ BTC LOUNGE", accessType: "tier", minTier: "TIER I", createdBy: first.id },
    });
    await prisma.roomMember.create({ data: { roomId: room.id, userId: first.id } });
    console.log("Seeded starter lounge: ₿ BTC LOUNGE");
  } else {
    console.log("Starter lounge already exists");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
