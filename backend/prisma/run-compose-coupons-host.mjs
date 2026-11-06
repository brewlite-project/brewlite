/** Local-only Compose seed launcher. Never intended to run inside a backend runtime image.
 * Parses the untracked Compose env file without printing credentials, maps the
 * internal postgres:5432 connection to the loopback-published host port 55432,
 * and delegates the actual INSERT-only writes to seed-compose-coupons.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { composeInternalUrlToHostUrl, validatePromotionSeedTarget } from './seed-compose-coupons.policy.ts';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Optional override lets a separate Git worktree target the Compose project
// configured in the main BrewLite checkout, without copying secret files.
const envFile = process.env.SEED_PROMO_COMPOSE_ENV_FILE
  ? resolve(process.env.SEED_PROMO_COMPOSE_ENV_FILE)
  : resolve(backendRoot, '..', 'compose.env');
const acknowledgement = 'SEED_PROMO_brewlite_compose';

function main() {
  // This launcher deliberately runs outside Compose (with host devDependencies).
  // No silent production override; all opt-in conditions still reach the seed guard.
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    throw new Error('Seed blocked: host NODE_ENV must not be production/unknown');
  }
  if (process.env.SEED_PROMO_CONFIRM !== acknowledgement) {
    throw new Error('Seed blocked: set SEED_PROMO_CONFIRM=SEED_PROMO_brewlite_compose explicitly');
  }
  let compose;
  try {
    compose = parse(readFileSync(envFile));
  } catch {
    throw new Error('Seed blocked: missing/unreadable local Compose env file');
  }
  if (compose.NODE_ENV && compose.NODE_ENV !== 'development' && compose.NODE_ENV !== 'test') {
    throw new Error('Seed blocked: compose.env NODE_ENV is not a dev/test runtime');
  }
  if (compose.POSTGRES_DB !== 'brewlite_compose' || !compose.POSTGRES_USER || !compose.POSTGRES_PASSWORD || !compose.DATABASE_URL) {
    throw new Error('Seed blocked: incomplete dev Compose PostgreSQL configuration');
  }
  const internal = new URL(compose.DATABASE_URL);
  if (decodeURIComponent(internal.username) !== compose.POSTGRES_USER ||
      decodeURIComponent(internal.password) !== compose.POSTGRES_PASSWORD) {
    throw new Error('Seed blocked: Compose DATABASE_URL credentials differ from POSTGRES_USER/PASSWORD');
  }

  const localUrl = composeInternalUrlToHostUrl(compose.DATABASE_URL);
  const environment = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: localUrl,
    SEED_PROMO_ENV: 'dev-compose',
    SEED_PROMO_ALLOWED_DATABASE: 'brewlite_compose',
    SEED_PROMO_CONFIRM: acknowledgement,
  };
  validatePromotionSeedTarget(environment);
  console.log('Target: local Dev Compose PostgreSQL at 127.0.0.1:55432/brewlite_compose');
  console.log('INSERT-only coupon seed; no existing coupon/redemption changes.');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed-compose-coupons.ts'], {
    cwd: backendRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error('Promotion seed launcher blocked:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
