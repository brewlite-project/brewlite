/**
 * BrewLite demo Customer seed. Run only in an explicitly approved local dev DB.
 * From backend/: npx --no-install tsx prisma/seed-users.ts
 * This script does not alter existing users, product data, or migrations.
 */
import "dotenv/config";
import * as argon2 from "argon2";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const demoUsers = [
  { id: "f1000000-0000-4000-8000-000000000001", email: "demo.customer1@brewlite.test", fullName: "Khách hàng Demo 1" },
  { id: "f1000000-0000-4000-8000-000000000002", email: "demo.customer2@brewlite.test", fullName: "Khách hàng Demo 2" },
] as const;

function getTarget() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new Error("DATABASE_URL is not a valid URL"); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error("Only PostgreSQL DATABASE_URL is supported");
  }
  // Fail closed on non-local hosts. Production/cloud databases cannot be seeded
  // even with a misleading NODE_ENV or an accidental copied DATABASE_URL.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error("Demo user seed is restricted to local PostgreSQL hosts. Remote databases are blocked.");
  }

  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const allowedDb = process.env.SEED_DEMO_ALLOWED_DATABASE;
  if (!dbName || !allowedDb || dbName !== allowedDb) {
    throw new Error("Database name must exactly match SEED_DEMO_ALLOWED_DATABASE (set it to your approved local dev DB name)");
  }
  if (/(^|[_-])(prod|production|staging|stage|live)([_-]|$)/i.test(dbName)) {
    throw new Error("Refusing to seed a database named as production or staging");
  }

  const password = process.env.SEED_DEMO_USER_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_DEMO_USER_PASSWORD must be set (minimum 8 characters)");
  }
  return { databaseUrl, dbName, host: url.hostname, port: url.port || '5432', password };
}

async function main() {
  const target = getTarget();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.databaseUrl }) });
  try {
    // A DB-side check protects against a misleading connection string / routing.
    const result = await prisma.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name
    `;
    const actualDb = result[0]?.database_name;
    if (actualDb !== target.dbName) {
      throw new Error(`Actual PostgreSQL database ${actualDb ?? '(unknown)'} does not match requested ${target.dbName}`);
    }

    console.log("\nBrewLite demo User seed (CREATE ONLY)");
    console.log(`Target: ${target.host}:${target.port}/${actualDb}`);
    console.log(`Users: ${demoUsers.map((user) => user.email).join(', ')}`);
    console.log("Existing accounts will NOT be modified or deleted.");

    // Must be explicitly run by a human, not silently in CI or a startup hook.
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error("An interactive terminal is required; automated/noninteractive seeding is blocked");
    }
    const rl = createInterface({ input: stdin, output: stdout });
    let confirmation: string;
    try {
      confirmation = await rl.question(`Type SEED ${actualDb} to confirm: `);
    } finally {
      rl.close();
    }
    if (confirmation !== `SEED ${actualDb}`) {
      throw new Error("Confirmation did not match; no users were created");
    }

    const hash = await argon2.hash(target.password, { type: argon2.argon2id });
    let created = 0;
    for (const user of demoUsers) {
      // INSERT ... ON CONFLICT DO NOTHING: no UPDATE/password reset/point reset.
      const result = await prisma.user.createMany({
        data: [{
          id: user.id,
          email: user.email,
          passwordHash: hash,
          fullName: user.fullName,
          loyaltyPoints: 0,
        }],
        skipDuplicates: true,
      });
      created += result.count;
    }
    console.log(`Demo User seed complete: ${created} created, ${demoUsers.length - created} skipped (existing/conflicting).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Demo User seed failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
