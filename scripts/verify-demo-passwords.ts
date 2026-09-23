/**
 * Verify demo account password hashes against the documented seed password.
 * Diagnostic script: run with `bun scripts/verify-demo-passwords.ts`
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  const officers = await db.officer.findMany({
    select: { email: true, name: true, role: true, status: true, authenticationStatus: true, passwordHash: true },
    orderBy: { email: "asc" },
  });

  const candidates = ["Demo@Pass1"];
  for (const o of officers) {
    let match: string | null = null;
    for (const pw of candidates) {
      if (bcrypt.compareSync(pw, o.passwordHash)) { match = pw; break; }
    }
    console.log(
      `${match ? "OK  " : "FAIL"} ${o.email.padEnd(36)} role=${o.role.padEnd(17)} status=${o.status.padEnd(10)} auth=${o.authenticationStatus}`
    );
  }
}

main().finally(() => db.$disconnect());
