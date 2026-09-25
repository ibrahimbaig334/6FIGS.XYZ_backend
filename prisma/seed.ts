/* Seed policy: NO mock data, ever. Only removes legacy bot users (their wallets,
 * tiers, memberships and bot-created rooms cascade). Rooms are created by real
 * users through the app — nothing is seeded. */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const bots = await prisma.user.deleteMany({ where: { isBot: true } });
  console.log(`Removed ${bots.count} bot users (0 expected)`);
  const rooms = await prisma.room.count();
  const users = await prisma.user.count();
  console.log(`DB holds ${users} users, ${rooms} user-created rooms — nothing seeded`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
