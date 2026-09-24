import { PrismaClient } from "@prisma/client";

// Revoke every live session — used after API smoke tests so the demo DB
// returns to its pristine "no active sessions" state.
const db = new PrismaClient();

async function main() {
  const r = await db.session.updateMany({
    where: { revoked: false },
    data: { revoked: true, revokedAt: new Date() },
  });
  console.log(`Revoked ${r.count} session(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
