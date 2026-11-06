/** Pure policy / fixture data for opt-in dev-only promotion seed. */
export type PromotionSeedEnv = Record<string, string | undefined>;

export function validatePromotionSeedTarget(env: PromotionSeedEnv): string {
  // Never allow production, including when the caller tries to opt in explicitly.
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('Seed blocked: NODE_ENV must explicitly be development or test');
  }
  if (env.SEED_PROMO_ENV !== 'dev-compose') {
    throw new Error('Seed blocked: set SEED_PROMO_ENV=dev-compose explicitly');
  }
  const connection = env.DATABASE_URL;
  if (!connection) throw new Error('Seed blocked: DATABASE_URL is missing');
  let url: URL;
  try { url = new URL(connection); } catch { throw new Error('Seed blocked: malformed DATABASE_URL'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error('Seed blocked: PostgreSQL URL required');
  }
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr') || url.searchParams.has('service') || url.searchParams.has('socket')) {
    throw new Error('Seed blocked: URL must not override network target');
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (name !== 'brewlite_compose' || env.SEED_PROMO_ALLOWED_DATABASE !== 'brewlite_compose') {
    throw new Error('Seed blocked: only the explicitly approved brewlite_compose database is allowed');
  }
  // Container-side: postgres:5432; host-side: Compose's loopback-only published 55432.
  // Deliberately reject host:5432: it might point to a different local database.
  const allowedHosts = (url.hostname === 'postgres' && url.port === '5432') ||
    (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '55432');
  if (!allowedHosts) throw new Error('Seed blocked: unexpected DB host/port');
  if (env.SEED_PROMO_CONFIRM !== 'SEED_PROMO_brewlite_compose') {
    throw new Error('Seed blocked: explicit SEED_PROMO_CONFIRM is required');
  }
  return name;
}

export const promotionFixtures = [
  { code: 'WELCOME20', type: 'PERCENT' as const, value: 20, minSubtotalVnd: 50000n, maxDiscountVnd: 30000n, usageLimit: 100, perUserLimit: 1 },
  { code: 'GIAM50K', type: 'FIXED' as const, value: 50000, minSubtotalVnd: 200000n, maxDiscountVnd: null, usageLimit: 50, perUserLimit: 1 },
  { code: 'FREE100', type: 'PERCENT' as const, value: 100, minSubtotalVnd: 0n, maxDiscountVnd: null, usageLimit: 20, perUserLimit: 1 },
  { code: 'BREWLITE10K', type: 'FIXED' as const, value: 10000, minSubtotalVnd: 50000n, maxDiscountVnd: null, usageLimit: 100, perUserLimit: 1 },
  { code: 'QUOTA1K', type: 'FIXED' as const, value: 1000, minSubtotalVnd: 0n, maxDiscountVnd: null, usageLimit: 1, perUserLimit: 1 },
] as const;

export function describePromotionDrift(
  actual: {type: string; value: number; minSubtotalVnd: bigint; maxDiscountVnd: bigint | null; usageLimit: number; perUserLimit: number; startsAt: Date; expiresAt: Date},
  expected: typeof promotionFixtures[number],
  now: Date,
): string[] {
  const differences: string[] = [];
  for (const field of ['type', 'value', 'minSubtotalVnd', 'maxDiscountVnd', 'usageLimit', 'perUserLimit'] as const) {
    if (actual[field] !== expected[field]) differences.push(field);
  }
  if (actual.startsAt > now || actual.expiresAt <= now) differences.push('validity-window');
  return differences;
}

/** Convert the known Compose *container* URL to its loopback-only host mapping.
 * This is for a developer's local tooling process, never for a deployed backend.
 */
export function composeInternalUrlToHostUrl(connection: string): string {
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new Error('Seed blocked: malformed Compose DATABASE_URL');
  }
  // No arbitrary endpoint, DB, userinfo override, or libpq host/socket escape.
  validatePromotionSeedTarget({
    NODE_ENV: 'development',
    SEED_PROMO_ENV: 'dev-compose',
    SEED_PROMO_ALLOWED_DATABASE: 'brewlite_compose',
    SEED_PROMO_CONFIRM: 'SEED_PROMO_brewlite_compose',
    DATABASE_URL: connection,
  });
  if (url.hostname !== 'postgres' || url.port !== '5432') {
    throw new Error('Seed blocked: Compose DATABASE_URL must use postgres:5432');
  }
  url.hostname = '127.0.0.1';
  url.port = '55432';
  return url.toString();
}
