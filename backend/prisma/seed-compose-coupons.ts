/**
 * SCRUM: opt-in dev Compose coupon seed.
 * INSERT-only, conflict-safe. Never resets counters, redemptions or dates on existing rows.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { describePromotionDrift, promotionFixtures, validatePromotionSeedTarget } from './seed-compose-coupons.policy.js';

async function main(): Promise<void> {
  // All checks happen before Prisma connects or writes.
  const dbName = validatePromotionSeedTarget(process.env);
  const connectionString = process.env.DATABASE_URL!;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string; user_name: string }>>`
      SELECT current_database() AS name, current_user AS user_name
    `;
    if (rows.length !== 1 || rows[0]!.name !== dbName) {
      throw new Error('Seed blocked: connected DB differs from approved target');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    // Unique Coupon.code + skipDuplicates makes two concurrent invocations safe.
    // A repeated seed never touches preexisting coupon counters or redemptions.
    const result = await prisma.coupon.createMany({
      data: promotionFixtures.map(f => ({...f, startsAt: now, expiresAt, activeUsageCount: 0})),
      skipDuplicates: true,
    });

    // Read only, to highlight preexisting drift. Do not change rows with usage.
    const existing = await prisma.coupon.findMany({
      where: { code: { in: promotionFixtures.map(f => f.code) } },
      select: { code: true, type: true, value: true, minSubtotalVnd: true, maxDiscountVnd: true,
        usageLimit: true, perUserLimit: true, startsAt: true, expiresAt: true, activeUsageCount: true },
    });
    for (const fixture of promotionFixtures) {
      const coupon = existing.find(row => row.code === fixture.code);
      if (!coupon) throw new Error(`Seed verification failed: ${fixture.code} missing`);
      const drift = describePromotionDrift(coupon, fixture, now);
      if (drift.length > 0) console.warn(`REVIEW ${fixture.code}: existing settings differ (${drift.join(', ')}). No update performed.`);
    }
    console.log(`Coupon seed on ${dbName}: ${result.count} new, ${promotionFixtures.length - result.count} already existed; no existing rows updated.`);
    console.log('No redemption, activeUsageCount, existing validity or quota reset.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Promotion seed rejected/failed:', err instanceof Error ? err.message : 'Unknown error');
  process.exitCode = 1;
});
