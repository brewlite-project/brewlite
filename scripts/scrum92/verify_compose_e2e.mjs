/**
 * SCRUM-92 / P2-18 — Reproducible Docker Compose Clean Setup & E2E Integration Verification
 * Works on both Git Bash and Windows PowerShell:
 *   node scripts/scrum92/verify_compose_e2e.mjs --up
 *   node scripts/scrum92/verify_compose_e2e.mjs
 *   node scripts/scrum92/verify_compose_e2e.mjs --keep-artifacts
 *   node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts
 *   node scripts/scrum92/verify_compose_e2e.mjs --down
 *
 * Determinism & Isolation Guarantees:
 * - Enforces an isolated Docker Compose project (`-p brewlite_scrum92_e2e`), isolated named volume
 *   (`brewlite_scrum92_e2e_brewlite_pgdata`), isolated database (`brewlite_seed_scrum92_e2e`), and
 *   dedicated host ports (`13000` frontend, `13001` backend, `15492` postgres) so it never collides
 *   with or requires stopping an active `brewlite_compose` development stack.
 * - Revalidates project/DB/volume metadata (fail-closed) before every lifecycle or cleanup action.
 * - Ensures isolated `postgres` is started and healthy before running `finally` cleanup even if a
 *   prior stack restart (`stop -> start`) failed mid-way, and never swallows cleanup errors.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = path.join(ROOT, 'compose.env');
export const ARTIFACT_STATE_FILE = path.join(os.tmpdir(), 'brewlite-scrum92-e2e-artifacts.json');

export const ISOLATED_PROJECT_NAME = 'brewlite_scrum92_e2e';
export const ISOLATED_VOLUME_NAME = 'brewlite_scrum92_e2e_brewlite_pgdata';
export const ISOLATED_DATABASE_NAME = 'brewlite_seed_scrum92_e2e';

export const ISOLATED_POSTGRES_HOST_PORT = '15492';
export const ISOLATED_BACKEND_HOST_PORT = '13001';
export const ISOLATED_FRONTEND_HOST_PORT = '13000';

const FE_URL = `http://127.0.0.1:${ISOLATED_FRONTEND_HOST_PORT}`;
const BE_URL = `http://127.0.0.1:${ISOLATED_BACKEND_HOST_PORT}`;
const PROXY_API = `${FE_URL}/api/backend`;

export const TEST_COUPON_ID = 'c9200000-0000-4000-8000-000000000092';
export const TEST_COUPON_CODE = 'SCRUM92FREE';

const FORBIDDEN_PROJECTS = new Set(['brewlite_compose', 'cnpm', 'default']);
const FORBIDDEN_VOLUMES = new Set(['brewlite_compose_brewlite_pgdata', 'brewlite_pgdata']);
const FORBIDDEN_DATABASES = new Set(['brewlite_compose', 'brewlite_db', 'postgres']);

export const COMPOSE_VARIABLES = [
  'NODE_ENV',
  'DATABASE_URL',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'BACKEND_HOST_PORT',
  'FRONTEND_HOST_PORT',
  'JWT_SECRET',
  'INTERNAL_SECRET',
  'ORDER_EXPIRATION_ENABLED',
  'ORDER_EXPIRATION_BATCH_SIZE',
  'VNPAY_TMN_CODE',
  'VNPAY_HASH_SECRET',
  'VNPAY_PAYMENT_URL',
  'VNPAY_RETURN_URL',
  'VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL',
  'VNPAY_QUERYDR_URL',
  'VNPAY_QUERYDR_TIMEOUT_MS',
  'PAYMENT_RECONCILIATION_ENABLED',
  'PAYMENT_RECONCILIATION_INTERVAL_MS',
  'PAYMENT_RECONCILIATION_BATCH_SIZE',
  'PAYMENT_RECONCILIATION_LEASE_MS',
  'PAYMENT_RECONCILIATION_COOLDOWN_MS',
  'PAYMENT_RECONCILIATION_IP_ADDR',
  'COMPOSE_PROJECT_NAME',
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id, label = 'UUID') {
  if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new Error(`Invalid ${label}: "${id}"`);
  }
  return id;
}

function stripTrailingWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function checkPreflight(env = process.env) {
  const conflicts = COMPOSE_VARIABLES.filter((name) => env[name] !== undefined);
  if (conflicts.length > 0) {
    throw new Error(
      `Compose preflight failed: exported variable(s) would override compose.env: ${conflicts.join(', ')}`,
    );
  }
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('Missing compose.env in repository root. Copy compose.env.example to compose.env first.');
  }
}

export function parseEnvFile(filePath) {
  const result = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

export function buildIsolatedComposeEnv(baseEnvCfg, hostEnv = process.env) {
  const dbUrl = new URL(
    baseEnvCfg.DATABASE_URL || 'postgresql://brewlite:change_me@postgres:5432/brewlite_compose?schema=public',
  );
  dbUrl.pathname = `/${ISOLATED_DATABASE_NAME}`;

  return {
    ...hostEnv,
    ...baseEnvCfg,
    COMPOSE_PROJECT_NAME: ISOLATED_PROJECT_NAME,
    NODE_ENV: 'test',
    POSTGRES_DB: ISOLATED_DATABASE_NAME,
    POSTGRES_HOST_PORT: ISOLATED_POSTGRES_HOST_PORT,
    BACKEND_HOST_PORT: ISOLATED_BACKEND_HOST_PORT,
    FRONTEND_HOST_PORT: ISOLATED_FRONTEND_HOST_PORT,
    DATABASE_URL: dbUrl.toString(),
    ORDER_EXPIRATION_ENABLED: 'false',
    PAYMENT_RECONCILIATION_ENABLED: 'false',
    VNPAY_TMN_CODE: 'SCRUM92_TEST_TMN',
    VNPAY_HASH_SECRET: 'scrum92-isolated-e2e-synthetic-hmac-secret-0000',
    VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    VNPAY_QUERYDR_URL: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
    VNPAY_QUERYDR_TIMEOUT_MS: '10000',
    VNPAY_ALLOW_HTTP_LOCAL_RETURN_URL: 'true',
    VNPAY_RETURN_URL: `http://localhost:${ISOLATED_FRONTEND_HOST_PORT}/order-confirmation`,
  };
}

let isolatedComposeEnv = null;

function runDockerCompose(args, input) {
  if (!isolatedComposeEnv) {
    throw new Error('Isolated Compose environment has not been initialized.');
  }
  const fullArgs = ['compose', '-p', ISOLATED_PROJECT_NAME, '--env-file', 'compose.env', ...args];
  const res = spawnSync('docker', fullArgs, {
    cwd: ROOT,
    input,
    env: isolatedComposeEnv,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `docker ${fullArgs.join(' ')} failed (exit ${res.status}):\n${res.stdout || ''}\n${res.stderr || ''}`,
    );
  }
  return stripTrailingWhitespace(res.stdout);
}

function inspectContainer(containerId, format) {
  const res = spawnSync('docker', ['inspect', '-f', format, containerId], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`docker inspect failed for ${containerId}: ${res.stderr || res.error?.message}`);
  }
  return stripTrailingWhitespace(res.stdout);
}

function parseContainerEnvList(rawEnvLines) {
  const map = {};
  for (const line of String(rawEnvLines || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    map[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return map;
}

export function validateIsolatedPostgresMetadata({ pgProject, pgVolume, pgDbEnv, actualDb }) {
  if (pgProject !== ISOLATED_PROJECT_NAME || FORBIDDEN_PROJECTS.has(pgProject)) {
    throw new Error(
      `Safety Guard (Fail-Closed): Postgres container project "${pgProject}" !== "${ISOLATED_PROJECT_NAME}". Refusing operation.`,
    );
  }
  if (pgVolume !== ISOLATED_VOLUME_NAME || FORBIDDEN_VOLUMES.has(pgVolume)) {
    throw new Error(
      `Safety Guard (Fail-Closed): Postgres volume "${pgVolume}" !== "${ISOLATED_VOLUME_NAME}". Refusing operation.`,
    );
  }
  if (pgDbEnv !== ISOLATED_DATABASE_NAME) {
    throw new Error(
      `Safety Guard (Fail-Closed): Postgres container POSTGRES_DB="${pgDbEnv}" !== "${ISOLATED_DATABASE_NAME}". Refusing operation.`,
    );
  }
  if (actualDb !== undefined && (actualDb !== ISOLATED_DATABASE_NAME || FORBIDDEN_DATABASES.has(actualDb))) {
    throw new Error(
      `Safety Guard (Fail-Closed): Connected database "${actualDb}" !== "${ISOLATED_DATABASE_NAME}". Refusing operation.`,
    );
  }
}

export function validateIsolatedTargetMetadata({
  pgProject,
  beProject,
  feProject,
  pgVolume,
  pgDbEnv,
  beEnvMap,
  actualDb,
}) {
  validateIsolatedPostgresMetadata({ pgProject, pgVolume, pgDbEnv, actualDb });

  if (
    beProject !== ISOLATED_PROJECT_NAME ||
    feProject !== ISOLATED_PROJECT_NAME ||
    FORBIDDEN_PROJECTS.has(beProject) ||
    FORBIDDEN_PROJECTS.has(feProject)
  ) {
    throw new Error(
      `Safety Guard (Fail-Closed): Container project mismatch (postgres="${pgProject}", backend="${beProject}", frontend="${feProject}"). ` +
        `Expected isolated project "${ISOLATED_PROJECT_NAME}".`,
    );
  }

  if (
    beEnvMap.NODE_ENV !== 'test' ||
    beEnvMap.PAYMENT_RECONCILIATION_ENABLED !== 'false' ||
    beEnvMap.ORDER_EXPIRATION_ENABLED !== 'false'
  ) {
    throw new Error(
      `Safety Guard (Fail-Closed): Isolated E2E backend must run with NODE_ENV="test" and background schedulers disabled to prevent snapshot races ` +
        `(got NODE_ENV="${beEnvMap.NODE_ENV}", PAYMENT_RECONCILIATION_ENABLED="${beEnvMap.PAYMENT_RECONCILIATION_ENABLED}", ` +
        `ORDER_EXPIRATION_ENABLED="${beEnvMap.ORDER_EXPIRATION_ENABLED}"). ` +
        `Start the isolated stack using: node scripts/scrum92/verify_compose_e2e.mjs --up`,
    );
  }
}

function assertIsolatedPostgresTarget({ requireLiveSql = true } = {}) {
  const pgId = runDockerCompose(['ps', '-a', '-q', 'postgres']);
  if (!pgId) {
    throw new Error(
      `Safety Guard (Fail-Closed): No postgres container found in isolated project "${ISOLATED_PROJECT_NAME}".`,
    );
  }

  const pgProject = inspectContainer(pgId, '{{ index .Config.Labels "com.docker.compose.project" }}');
  const pgVolume = inspectContainer(
    pgId,
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}',
  );
  const pgEnvMap = parseContainerEnvList(inspectContainer(pgId, '{{range .Config.Env}}{{println .}}{{end}}'));

  validateIsolatedPostgresMetadata({
    pgProject,
    pgVolume,
    pgDbEnv: pgEnvMap.POSTGRES_DB,
  });

  if (requireLiveSql) {
    const actualDb = runPsqlTuple('SELECT current_database();');
    validateIsolatedPostgresMetadata({
      pgProject,
      pgVolume,
      pgDbEnv: pgEnvMap.POSTGRES_DB,
      actualDb,
    });
  }

  return pgId;
}

function assertIsolatedComposeTarget() {
  const pgId = runDockerCompose(['ps', '-q', 'postgres']);
  const beId = runDockerCompose(['ps', '-q', 'backend']);
  const feId = runDockerCompose(['ps', '-q', 'frontend']);

  if (!pgId || !beId || !feId) {
    throw new Error(
      `Isolated stack "${ISOLATED_PROJECT_NAME}" is not running. Start it with: node scripts/scrum92/verify_compose_e2e.mjs --up`,
    );
  }

  const pgProject = inspectContainer(pgId, '{{ index .Config.Labels "com.docker.compose.project" }}');
  const beProject = inspectContainer(beId, '{{ index .Config.Labels "com.docker.compose.project" }}');
  const feProject = inspectContainer(feId, '{{ index .Config.Labels "com.docker.compose.project" }}');
  const pgVolume = inspectContainer(
    pgId,
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}',
  );
  const pgEnvMap = parseContainerEnvList(inspectContainer(pgId, '{{range .Config.Env}}{{println .}}{{end}}'));
  const beEnvMap = parseContainerEnvList(inspectContainer(beId, '{{range .Config.Env}}{{println .}}{{end}}'));
  const actualDb = runPsqlTuple('SELECT current_database();');

  validateIsolatedTargetMetadata({
    pgProject,
    beProject,
    feProject,
    pgVolume,
    pgDbEnv: pgEnvMap.POSTGRES_DB,
    beEnvMap,
    actualDb,
  });

  return {
    project: pgProject,
    volume: pgVolume,
    database: actualDb,
    nodeEnv: beEnvMap.NODE_ENV,
    ports: {
      frontend: ISOLATED_FRONTEND_HOST_PORT,
      backend: ISOLATED_BACKEND_HOST_PORT,
      postgres: ISOLATED_POSTGRES_HOST_PORT,
    },
    schedulersDisabled: true,
  };
}

function assertIsolatedDownTarget() {
  const rawIds = runDockerCompose(['ps', '-a', '-q']);
  if (!rawIds) return;
  for (const id of rawIds.split(/\r?\n/).filter(Boolean)) {
    const proj = inspectContainer(id, '{{ index .Config.Labels "com.docker.compose.project" }}');
    if (proj !== ISOLATED_PROJECT_NAME || FORBIDDEN_PROJECTS.has(proj)) {
      throw new Error(
        `Safety Guard (Fail-Closed): Container ${id} belongs to project "${proj}", not "${ISOLATED_PROJECT_NAME}". Refusing down.`,
      );
    }
  }
}

async function ensureIsolatedPostgresReadyForCleanup() {
  // 1. Validate container metadata fail-closed BEFORE starting postgres
  const pgId = assertIsolatedPostgresTarget({ requireLiveSql: false });
  const initialState = inspectContainer(pgId, '{{.State.Status}}:{{.State.Health.Status}}');

  if (initialState !== 'running:healthy') {
    console.log(
      `[SCRUM-92] Isolated postgres state is "${initialState}"; starting/recovering postgres before cleanup...`,
    );
    runDockerCompose(['start', 'postgres']);
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      const currentPgId = runDockerCompose(['ps', '-a', '-q', 'postgres']);
      if (currentPgId) {
        const health = inspectContainer(currentPgId, '{{.State.Status}}:{{.State.Health.Status}}');
        if (health === 'running:healthy') {
          ready = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) {
      throw new Error(
        `Failed to recover isolated postgres container (${ISOLATED_PROJECT_NAME}) to running:healthy within 45s for cleanup.`,
      );
    }
  }

  // 2. Revalidate live SQL database connection fail-closed AFTER postgres is healthy
  assertIsolatedPostgresTarget({ requireLiveSql: true });
}

function runPsql(sql) {
  return runDockerCompose(
    ['exec', '-T', 'postgres', 'sh', '-c', 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    sql,
  );
}

function runPsqlTuple(sql) {
  return runDockerCompose(
    ['exec', '-T', 'postgres', 'sh', '-c', 'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    sql,
  );
}

function saveArtifactStateFile(createdArtifacts) {
  const payload = {
    project: ISOLATED_PROJECT_NAME,
    database: ISOLATED_DATABASE_NAME,
    volume: ISOLATED_VOLUME_NAME,
    updatedAt: new Date().toISOString(),
    userIds: Array.from(createdArtifacts.userIds || []),
    orderIds: Array.from(createdArtifacts.orderIds || []),
    paymentIds: Array.from(createdArtifacts.paymentIds || []),
    couponId: createdArtifacts.couponId || null,
  };
  fs.writeFileSync(ARTIFACT_STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function removeArtifactStateFile() {
  if (fs.existsSync(ARTIFACT_STATE_FILE)) {
    fs.unlinkSync(ARTIFACT_STATE_FILE);
  }
}

function loadArtifactStateFile() {
  const artifacts = {
    userIds: new Set(),
    orderIds: new Set(),
    paymentIds: new Set(),
    couponId: null,
  };
  if (!fs.existsSync(ARTIFACT_STATE_FILE)) {
    return artifacts;
  }
  const raw = JSON.parse(fs.readFileSync(ARTIFACT_STATE_FILE, 'utf8'));
  for (const id of raw.userIds || []) artifacts.userIds.add(assertUuid(id, 'saved userId'));
  for (const id of raw.orderIds || []) artifacts.orderIds.add(assertUuid(id, 'saved orderId'));
  for (const id of raw.paymentIds || []) artifacts.paymentIds.add(assertUuid(id, 'saved paymentId'));
  if (raw.couponId) artifacts.couponId = assertUuid(raw.couponId, 'saved couponId');
  return artifacts;
}

function seedIsolatedZeroCoupon(createdArtifacts) {
  assertIsolatedPostgresTarget({ requireLiveSql: true });
  assertUuid(TEST_COUPON_ID, 'TEST_COUPON_ID');
  const existingRowsRaw = runPsqlTuple(
    `SELECT id || '|' || code || '|' || active_usage_count
       FROM coupons
      WHERE code = '${TEST_COUPON_CODE}'
         OR id = '${TEST_COUPON_ID}';`,
  );

  if (existingRowsRaw) {
    const lines = existingRowsRaw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const [id, code, activeUsageCount] = line.split('|');
      if (id !== TEST_COUPON_ID || code !== TEST_COUPON_CODE) {
        throw new Error(
          `Safety Guard: Coupon collision detected in database (found id="${id}", code="${code}"). ` +
            `Expected unused fixture id="${TEST_COUPON_ID}" and code="${TEST_COUPON_CODE}". Refusing to overwrite or delete.`,
        );
      }
      if (Number(activeUsageCount) > 0) {
        throw new Error(
          `Safety Guard: Fixture coupon "${TEST_COUPON_CODE}" (${TEST_COUPON_ID}) already exists with active_usage_count=${activeUsageCount}. ` +
            `Run recovery cleanup first: node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts`,
        );
      }
    }
    throw new Error(
      `Safety Guard: Fixture coupon "${TEST_COUPON_CODE}" (${TEST_COUPON_ID}) already exists before test start. ` +
        `Run recovery cleanup first: node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts`,
    );
  }

  const insertSql = `
INSERT INTO coupons (
  id, code, type, value, min_subtotal_vnd, max_discount_vnd,
  starts_at, expires_at, usage_limit, per_user_limit, active_usage_count
) VALUES (
  '${TEST_COUPON_ID}',
  '${TEST_COUPON_CODE}',
  'PERCENT',
  100,
  0,
  NULL,
  NOW() - INTERVAL '1 day',
  NOW() + INTERVAL '7 days',
  100,
  10,
  0
);
`;
  runPsqlTuple(insertSql);
  createdArtifacts.couponId = TEST_COUPON_ID;
  saveArtifactStateFile(createdArtifacts);
}

export function buildExactIdCleanupSql(createdArtifacts) {
  const orderIds = Array.from(createdArtifacts.orderIds || []).map((id) => `'${assertUuid(id, 'orderId')}'`);
  const paymentIds = Array.from(createdArtifacts.paymentIds || []).map((id) => `'${assertUuid(id, 'paymentId')}'`);
  const userIds = Array.from(createdArtifacts.userIds || []).map((id) => `'${assertUuid(id, 'userId')}'`);
  const couponId = createdArtifacts.couponId ? assertUuid(createdArtifacts.couponId, 'couponId') : null;

  const statements = ['BEGIN;'];

  if (orderIds.length > 0) {
    const orderInList = orderIds.join(', ');
    statements.push(`
WITH target_orders AS (
  SELECT id, status
  FROM orders
  WHERE id IN (${orderInList})
),
stock_to_restore AS (
  SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0)::int AS qty
  FROM order_items oi
  JOIN target_orders o ON o.id = oi.order_id
  WHERE o.status <> 'CANCELLED'
  GROUP BY oi.product_id
)
UPDATE products p
SET stock = p.stock + s.qty
FROM stock_to_restore s
WHERE p.id = s.product_id;
`);

    if (couponId) {
      statements.push(`
DELETE FROM coupon_redemptions
WHERE order_id IN (${orderInList})
  AND coupon_id = '${couponId}';
`);
    }

    statements.push(`
DELETE FROM payment_gateway_events
WHERE payment_id IN (
  SELECT id FROM payments WHERE order_id IN (${orderInList})
);
`);

    statements.push(`
DELETE FROM payments
WHERE order_id IN (${orderInList});
`);

    statements.push(`
DELETE FROM order_item_toppings
WHERE order_item_id IN (
  SELECT id FROM order_items WHERE order_id IN (${orderInList})
);
`);

    statements.push(`
DELETE FROM order_items
WHERE order_id IN (${orderInList});
`);

    statements.push(`
DELETE FROM orders
WHERE id IN (${orderInList});
`);
  }

  if (paymentIds.length > 0) {
    const paymentInList = paymentIds.join(', ');
    statements.push(`
DELETE FROM payment_gateway_events
WHERE payment_id IN (${paymentInList});
`);
    statements.push(`
DELETE FROM payments
WHERE id IN (${paymentInList});
`);
  }

  if (couponId) {
    statements.push(`
DELETE FROM coupons
WHERE id = '${couponId}'
  AND code = '${TEST_COUPON_CODE}'
  AND NOT EXISTS (
    SELECT 1 FROM coupon_redemptions WHERE coupon_id = '${couponId}'
  );
`);
  }

  if (userIds.length > 0) {
    const userInList = userIds.join(', ');
    statements.push(`
DELETE FROM users
WHERE id IN (${userInList})
  AND NOT EXISTS (
    SELECT 1 FROM orders WHERE user_id = users.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM coupon_redemptions WHERE user_id = users.id
  );
`);
  }

  statements.push('COMMIT;');
  return statements.join('\n');
}

async function cleanupExactTestArtifacts(createdArtifacts) {
  const hasWork =
    createdArtifacts.orderIds.size > 0 ||
    createdArtifacts.paymentIds.size > 0 ||
    createdArtifacts.userIds.size > 0 ||
    Boolean(createdArtifacts.couponId);
  if (!hasWork) return false;

  await ensureIsolatedPostgresReadyForCleanup();
  const sql = buildExactIdCleanupSql(createdArtifacts);
  runPsqlTuple(sql);
  removeArtifactStateFile();
  return true;
}

async function runExplicitArtifactCleanupRecovery() {
  await ensureIsolatedPostgresReadyForCleanup();
  const artifacts = loadArtifactStateFile();

  // Also check if the exact fixture coupon ID exists in the isolated DB (e.g. from --keep-artifacts)
  const couponMatch = runPsqlTuple(
    `SELECT id FROM coupons WHERE id = '${TEST_COUPON_ID}' AND code = '${TEST_COUPON_CODE}';`,
  );
  if (couponMatch === TEST_COUPON_ID) {
    artifacts.couponId = TEST_COUPON_ID;
    const redemptionRows = runPsqlTuple(
      `SELECT order_id || '|' || user_id FROM coupon_redemptions WHERE coupon_id = '${TEST_COUPON_ID}';`,
    );
    for (const row of redemptionRows.split(/\r?\n/).filter(Boolean)) {
      const [orderId, userId] = row.split('|');
      if (orderId) artifacts.orderIds.add(assertUuid(orderId, 'redemption orderId'));
      if (userId) artifacts.userIds.add(assertUuid(userId, 'redemption userId'));
    }
  }

  const cleaned = await cleanupExactTestArtifacts(artifacts);
  console.log(
    '[SCRUM-92] Recovery cleanup completed:',
    JSON.stringify({
      cleaned,
      cleanedUserCount: artifacts.userIds.size,
      cleanedOrderCount: artifacts.orderIds.size,
      cleanedPaymentCount: artifacts.paymentIds.size,
      cleanedCouponId: artifacts.couponId,
    }),
  );
}

async function fetchWithRetry(url, options = {}, retries = 4, delayMs = 400) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function jsonFetch(url, options = {}) {
  const res = await fetchWithRetry(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

function sanitizeVnpayUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.searchParams.has('vnp_TmnCode')) {
    parsed.searchParams.set('vnp_TmnCode', '<REDACTED_TMN_CODE>');
  }
  if (parsed.searchParams.has('vnp_SecureHash')) {
    parsed.searchParams.set('vnp_SecureHash', '<REDACTED_SECURE_HASH>');
  }
  return parsed.toString();
}

async function waitForStackReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const migrateId = runDockerCompose(['ps', '-a', '-q', 'migrate']);
    const pgId = runDockerCompose(['ps', '-q', 'postgres']);
    const beId = runDockerCompose(['ps', '-q', 'backend']);
    const feId = runDockerCompose(['ps', '-q', 'frontend']);

    if (migrateId && pgId && beId && feId) {
      const migrateState = inspectContainer(migrateId, '{{.State.Status}}:{{.State.ExitCode}}');
      const pgHealth = inspectContainer(pgId, '{{.State.Status}}:{{.State.Health.Status}}');
      const beHealth = inspectContainer(beId, '{{.State.Status}}:{{.State.Health.Status}}');
      const feHealth = inspectContainer(feId, '{{.State.Status}}:{{.State.Health.Status}}');

      if (
        migrateState === 'exited:0' &&
        pgHealth === 'running:healthy' &&
        beHealth === 'running:healthy' &&
        feHealth === 'running:healthy'
      ) {
        try {
          const [feRes, beRes] = await Promise.all([fetch(`${FE_URL}/`), fetch(`${BE_URL}/`)]);
          if (feRes.ok && beRes.ok) {
            return { migrateState, pgHealth, beHealth, feHealth };
          }
        } catch {
          // Wait until HTTP sockets are ready
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `Timed out waiting for isolated Compose stack "${ISOLATED_PROJECT_NAME}" (postgres, migrate, backend, frontend) to become ready.`,
  );
}

function ensureCatalogSeededIfEmpty() {
  assertIsolatedPostgresTarget({ requireLiveSql: true });
  const productCount = Number(runPsqlTuple('SELECT count(*) FROM products;'));
  if (productCount === 0) {
    console.log(
      `Isolated database "${ISOLATED_DATABASE_NAME}" has 0 products; running Prisma demo seed inside migrate service...`,
    );
    runDockerCompose(['run', '--rm', '--no-deps', 'migrate', 'npm', 'run', 'db:seed']);
  }
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const allowedFlags = new Set(['--up', '--down', '--keep-artifacts', '--cleanup-artifacts']);
  if (cliArgs.some((arg) => !allowedFlags.has(arg))) {
    console.error(
      'Usage: node scripts/scrum92/verify_compose_e2e.mjs [--up] [--keep-artifacts] [--cleanup-artifacts] [--down]',
    );
    process.exit(2);
  }

  const shouldUp = cliArgs.includes('--up');
  const shouldDown = cliArgs.includes('--down');
  const keepArtifacts = cliArgs.includes('--keep-artifacts');
  const shouldCleanupArtifacts = cliArgs.includes('--cleanup-artifacts');

  console.log('=== [0] Preflight & Isolated Test Stack Verification ===');
  checkPreflight();
  const envCfg = parseEnvFile(ENV_FILE);
  isolatedComposeEnv = buildIsolatedComposeEnv(envCfg, process.env);

  if (shouldDown) {
    assertIsolatedDownTarget();
    console.log(`Stopping isolated test stack "${ISOLATED_PROJECT_NAME}"...`);
    runDockerCompose(['down', '--remove-orphans']);
    console.log(
      `[SCRUM-92] Isolated stack "${ISOLATED_PROJECT_NAME}" stopped (volume "${ISOLATED_VOLUME_NAME}" preserved).`,
    );
    return;
  }

  if (shouldCleanupArtifacts) {
    await runExplicitArtifactCleanupRecovery();
    return;
  }

  if (shouldUp) {
    console.log(
      `Starting isolated Compose stack "-p ${ISOLATED_PROJECT_NAME}" (DB="${ISOLATED_DATABASE_NAME}", volume="${ISOLATED_VOLUME_NAME}", ports=${ISOLATED_FRONTEND_HOST_PORT}/${ISOLATED_BACKEND_HOST_PORT}/${ISOLATED_POSTGRES_HOST_PORT})...`,
    );
    runDockerCompose(['up', '-d', '--build']);
  }

  const states = await waitForStackReady();
  const targetMeta = assertIsolatedComposeTarget();
  console.log('Isolated Target Verified:', JSON.stringify(targetMeta));
  console.log('Container health states:', JSON.stringify(states));
  console.log(runDockerCompose(['ps', '-a']));

  console.log('\n=== [1] Database Migration & Seed Verification (psql) ===');
  ensureCatalogSeededIfEmpty();
  const dbCheckOut = runPsql(
    `SELECT current_database() AS database_name,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed_migrations,
            (SELECT count(*) FROM categories) AS categories,
            (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM toppings) AS toppings,
            (SELECT stock FROM products WHERE id = 'a3000000-0000-4000-8000-000000000001') AS sample_product_stock;`,
  );
  console.log(dbCheckOut);
  assert.match(
    dbCheckOut,
    new RegExp(`${ISOLATED_DATABASE_NAME}\\s+\\|\\s+9\\s+\\|\\s+4\\s+\\|\\s+9\\s+\\|\\s+5\\s+\\|\\s+25`),
  );

  const createdArtifacts = {
    userIds: new Set(),
    orderIds: new Set(),
    paymentIds: new Set(),
    couponId: null,
  };

  let primaryError = null;

  try {
    console.log('\n=== [2] Smoke Check: Frontend, Backend Liveness & Swagger ===');
    const feHome = await fetchWithRetry(`${FE_URL}/`);
    const beHome = await fetchWithRetry(`${BE_URL}/`);
    const swaggerRes = await fetchWithRetry(`${BE_URL}/api-docs`);
    const imgRes = await fetchWithRetry(`${FE_URL}/images/bac-xiu-kem-beo-phin.jpg`);
    assert.equal(feHome.status, 200);
    assert.equal(beHome.status, 200);
    assert.equal(swaggerRes.status, 200);
    assert.equal(imgRes.status, 200);
    console.log(
      JSON.stringify({
        frontendHomeStatus: feHome.status,
        backendLivenessStatus: beHome.status,
        swaggerDocsStatus: swaggerRes.status,
        staticProductImageStatus: imgRes.status,
      }),
    );

    console.log('\n=== [3] FE -> BE -> DB Catalog via Reverse Proxy (/api/backend/products) ===');
    const productsRes = await jsonFetch(`${PROXY_API}/products`);
    assert.equal(productsRes.status, 200);
    assert.equal(productsRes.body.items.length, 9);
    const firstProduct = productsRes.body.items[0];
    const detailRes = await jsonFetch(`${PROXY_API}/products/${firstProduct.id}`);
    assert.equal(detailRes.status, 200);
    const sizeS = detailRes.body.sizes.find((s) => s.size === 'S');
    const firstTopping = detailRes.body.toppings[0];
    assert.ok(sizeS && firstTopping);
    assert.equal(detailRes.body.isAvailable, true, 'Sample product must be available');
    console.log(
      JSON.stringify({
        endpoint: 'GET /api/backend/products',
        status: productsRes.status,
        productCount: productsRes.body.items.length,
        sampleProduct: {
          id: detailRes.body.id,
          name: detailRes.body.name,
          isAvailable: detailRes.body.isAvailable,
          selectedSize: sizeS.size,
          firstTopping: { id: firstTopping.id, name: firstTopping.name },
        },
      }),
    );

    console.log('\n=== [4] Auth Flow via Reverse Proxy (Register -> Login -> GET /auth/me) ===');
    const email = `scrum92.verify.${Date.now()}.${randomUUID().slice(0, 6)}@brewlite.vn`;
    const password = `BrewLite#${randomUUID().slice(0, 8)}!`;

    const regRes = await jsonFetch(`${PROXY_API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName: 'SCRUM-92 Clean Verifier' }),
    });
    assert.equal(regRes.status, 201, `Register failed: ${JSON.stringify(regRes.body)}`);
    const primaryUserId =
      regRes.body?.user?.id ||
      regRes.body?.id ||
      runPsqlTuple(`SELECT id FROM users WHERE email = '${email}';`);
    createdArtifacts.userIds.add(assertUuid(primaryUserId, 'primaryUserId'));
    saveArtifactStateFile(createdArtifacts);

    const loginRes = await jsonFetch(`${PROXY_API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(loginRes.status, 200, `Login failed: ${JSON.stringify(loginRes.body)}`);
    const token = loginRes.body.accessToken;
    assert.ok(typeof token === 'string' && token.length > 20);

    const meRes = await jsonFetch(`${PROXY_API}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.email, email);
    assert.equal(meRes.body.loyaltyPoints, 0);
    createdArtifacts.userIds.add(assertUuid(meRes.body.id, 'meRes.body.id'));
    saveArtifactStateFile(createdArtifacts);
    console.log(
      JSON.stringify({
        registerStatus: regRes.status,
        loginStatus: loginRes.status,
        accessToken: '<REDACTED_JWT>',
        meProfile: meRes.body,
      }),
    );

    console.log('\n=== [5] Create Order via Reverse Proxy (POST /api/backend/orders) ===');
    const createOrderRes = await jsonFetch(`${PROXY_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        items: [
          {
            productId: detailRes.body.id,
            size: sizeS.size,
            quantity: 2,
            toppingIds: [firstTopping.id],
          },
        ],
      }),
    });
    assert.equal(createOrderRes.status, 201, `Create order failed: ${JSON.stringify(createOrderRes.body)}`);
    assert.equal(createOrderRes.body.status, 'PENDING');
    const orderId = assertUuid(createOrderRes.body.id, 'orderId');
    createdArtifacts.orderIds.add(orderId);
    saveArtifactStateFile(createdArtifacts);
    console.log(
      JSON.stringify({
        status: createOrderRes.status,
        orderId,
        orderStatus: createOrderRes.body.status,
        subtotalVnd: createOrderRes.body.subtotalVnd,
        totalVnd: createOrderRes.body.totalVnd,
      }),
    );

    console.log('\n=== [6] Payment APIs via Reverse Proxy (SCRUM-85 Mock Guard & SCRUM-84 ZERO_AMOUNT Settlement) ===');
    const mockAttemptRes = await jsonFetch(`${PROXY_API}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `scrum92-mock-${randomUUID()}`,
      },
      body: JSON.stringify({
        orderId,
        method: 'CARD',
        paymentDetails: { cardNumber: '4111111111111234' },
      }),
    });
    assert.equal(mockAttemptRes.status, 403, `Expected 403 MOCK_PAYMENT_DISABLED: ${JSON.stringify(mockAttemptRes.body)}`);
    assert.equal(mockAttemptRes.body.code, 'MOCK_PAYMENT_DISABLED');

    const nonZeroRejectRes = await jsonFetch(`${PROXY_API}/payments/zero-amount`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `scrum92-nonzero-${randomUUID()}`,
      },
      body: JSON.stringify({ orderId }),
    });
    assert.equal(nonZeroRejectRes.status, 409);
    assert.equal(nonZeroRejectRes.body.code, 'ORDER_NOT_ZERO_AMOUNT');

    seedIsolatedZeroCoupon(createdArtifacts);
    const zeroEmail = `scrum92.verify.zero.${Date.now()}.${randomUUID().slice(0, 6)}@brewlite.vn`;
    const zeroRegRes = await jsonFetch(`${PROXY_API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: zeroEmail, password, fullName: 'SCRUM-92 Zero Amount Verifier' }),
    });
    assert.equal(zeroRegRes.status, 201);
    const zeroUserId =
      zeroRegRes.body?.user?.id ||
      zeroRegRes.body?.id ||
      runPsqlTuple(`SELECT id FROM users WHERE email = '${zeroEmail}';`);
    createdArtifacts.userIds.add(assertUuid(zeroUserId, 'zeroUserId'));
    saveArtifactStateFile(createdArtifacts);

    const zeroLoginRes = await jsonFetch(`${PROXY_API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: zeroEmail, password }),
    });
    assert.equal(zeroLoginRes.status, 200);
    const zeroToken = zeroLoginRes.body.accessToken;

    const zeroOrderRes = await jsonFetch(`${PROXY_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zeroToken}`,
      },
      body: JSON.stringify({
        couponCode: TEST_COUPON_CODE,
        items: [{ productId: detailRes.body.id, size: sizeS.size, quantity: 1, toppingIds: [] }],
      }),
    });
    assert.equal(zeroOrderRes.status, 201, `Create zero order failed: ${JSON.stringify(zeroOrderRes.body)}`);
    assert.equal(zeroOrderRes.body.totalVnd, 0);
    const zeroOrderId = assertUuid(zeroOrderRes.body.id, 'zeroOrderId');
    createdArtifacts.orderIds.add(zeroOrderId);
    saveArtifactStateFile(createdArtifacts);

    const zeroKey = `scrum92-zero-${randomUUID()}`;
    const zeroPayRes = await jsonFetch(`${PROXY_API}/payments/zero-amount`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zeroToken}`,
        'Idempotency-Key': zeroKey,
      },
      body: JSON.stringify({ orderId: zeroOrderId }),
    });
    assert.equal(zeroPayRes.status, 201, `ZERO_AMOUNT payment failed: ${JSON.stringify(zeroPayRes.body)}`);
    assert.equal(zeroPayRes.body.provider, 'ZERO_AMOUNT');
    assert.equal(zeroPayRes.body.paymentStatus, 'SUCCESS');
    assert.equal(zeroPayRes.body.orderStatus, 'PAID');
    assert.equal(zeroPayRes.body.amountVnd, 0);
    assert.equal(zeroPayRes.headers.get('idempotency-replayed'), 'false');
    createdArtifacts.paymentIds.add(assertUuid(zeroPayRes.body.paymentId, 'zeroPaymentId'));
    saveArtifactStateFile(createdArtifacts);

    const zeroReplayRes = await jsonFetch(`${PROXY_API}/payments/zero-amount`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zeroToken}`,
        'Idempotency-Key': zeroKey,
      },
      body: JSON.stringify({ orderId: zeroOrderId }),
    });
    assert.equal(zeroReplayRes.status, 200);
    assert.equal(zeroReplayRes.headers.get('idempotency-replayed'), 'true');
    assert.equal(zeroReplayRes.body.paymentId, zeroPayRes.body.paymentId);

    console.log(
      JSON.stringify({
        mockProductionPolicy: {
          status: mockAttemptRes.status,
          code: mockAttemptRes.body.code,
        },
        zeroAmountPositiveOrderRejection: {
          status: nonZeroRejectRes.status,
          code: nonZeroRejectRes.body.code,
        },
        zeroAmountSettlement: {
          status: zeroPayRes.status,
          orderId: zeroOrderId,
          paymentId: zeroPayRes.body.paymentId,
          provider: zeroPayRes.body.provider,
          paymentStatus: zeroPayRes.body.paymentStatus,
          orderStatus: zeroPayRes.body.orderStatus,
          amountVnd: zeroPayRes.body.amountVnd,
        },
        zeroAmountReplay: {
          status: zeroReplayRes.status,
          idempotencyReplayedHeader: zeroReplayRes.headers.get('idempotency-replayed'),
          samePaymentId: zeroReplayRes.body.paymentId === zeroPayRes.body.paymentId,
        },
      }),
    );

    if (
      isolatedComposeEnv.VNPAY_TMN_CODE &&
      isolatedComposeEnv.VNPAY_HASH_SECRET &&
      isolatedComposeEnv.VNPAY_RETURN_URL
    ) {
      console.log('\n=== [6b] VNPay Sandbox Initiation & Replay (/api/backend/payments/vnpay/initiate) ===');
      const vnpKey = `scrum92-vnp-${randomUUID()}`;
      const vnpInitRes = await jsonFetch(`${PROXY_API}/payments/vnpay/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': vnpKey,
        },
        body: JSON.stringify({ orderId }),
      });
      assert.equal(vnpInitRes.status, 201, `VNPay initiate failed: ${JSON.stringify(vnpInitRes.body)}`);
      assert.equal(vnpInitRes.body.provider, 'VNPAY');
      assert.equal(vnpInitRes.body.paymentStatus, 'PENDING');
      createdArtifacts.paymentIds.add(assertUuid(vnpInitRes.body.paymentId, 'vnpPaymentId'));
      saveArtifactStateFile(createdArtifacts);

      const vnpReplayRes = await jsonFetch(`${PROXY_API}/payments/vnpay/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': vnpKey,
        },
        body: JSON.stringify({ orderId }),
      });
      assert.equal(vnpReplayRes.status, 200);
      assert.equal(vnpReplayRes.headers.get('idempotency-replayed'), 'true');
      console.log(
        JSON.stringify({
          initiateStatus: vnpInitRes.status,
          replayStatus: vnpReplayRes.status,
          idempotencyReplayedHeader: vnpReplayRes.headers.get('idempotency-replayed'),
          provider: vnpInitRes.body.provider,
          paymentStatus: vnpInitRes.body.paymentStatus,
          orderStatus: vnpInitRes.body.orderStatus,
          sanitizedPaymentUrl: sanitizeVnpayUrl(vnpInitRes.body.paymentUrl),
        }),
      );
    }

    console.log('\n=== [7] Pre-Restart Snapshot (API & PostgreSQL) ===');
    const ordersBefore = await jsonFetch(`${PROXY_API}/orders/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ordersBefore.status, 200);
    const pendingOrderBefore = ordersBefore.body.items.find((o) => o.id === orderId);
    assert.ok(pendingOrderBefore);
    assert.equal(pendingOrderBefore.status, 'PENDING');

    const sqlSnapshotQuery = `SELECT o.id AS order_id, o.status AS order_status, o.total_vnd,
            p.id AS payment_id, p.provider, p.status AS payment_status
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.id IN ('${orderId}', '${zeroOrderId}')
      ORDER BY o.total_vnd DESC;`;
    const sqlBefore = runPsql(sqlSnapshotQuery);
    console.log(
      'Pre-Restart API Snapshot:',
      JSON.stringify({
        primaryOrder: {
          orderId: pendingOrderBefore.id,
          orderStatus: pendingOrderBefore.status,
          totalVnd: pendingOrderBefore.totalVnd,
        },
        zeroAmountPaidOrder: {
          orderId: zeroOrderId,
          paymentId: zeroPayRes.body.paymentId,
          orderStatus: zeroPayRes.body.orderStatus,
          paymentStatus: zeroPayRes.body.paymentStatus,
        },
      }),
    );
    console.log('Pre-Restart SQL Snapshot:\n' + sqlBefore);

    console.log('\n=== [8] Restart Isolated Stack (docker compose -p brewlite_scrum92_e2e stop -> start) ===');
    assertIsolatedComposeTarget();
    runDockerCompose(['stop']);
    runDockerCompose(['start']);
    const postStates = await waitForStackReady();
    assertIsolatedComposeTarget();
    console.log('Post-Restart Container States:', JSON.stringify(postStates));

    const ordersAfter = await jsonFetch(`${PROXY_API}/orders/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ordersAfter.status, 200);
    const pendingOrderAfter = ordersAfter.body.items.find((o) => o.id === orderId);
    assert.ok(pendingOrderAfter);
    assert.equal(pendingOrderAfter.status, 'PENDING');

    const zeroReplayAfterRestart = await jsonFetch(`${PROXY_API}/payments/zero-amount`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${zeroToken}`,
        'Idempotency-Key': zeroKey,
      },
      body: JSON.stringify({ orderId: zeroOrderId }),
    });
    assert.equal(zeroReplayAfterRestart.status, 200);
    assert.equal(zeroReplayAfterRestart.headers.get('idempotency-replayed'), 'true');
    assert.equal(zeroReplayAfterRestart.body.paymentId, zeroPayRes.body.paymentId);
    assert.equal(zeroReplayAfterRestart.body.orderStatus, 'PAID');

    const sqlAfter = runPsql(sqlSnapshotQuery);
    console.log(
      'Post-Restart API Snapshot:',
      JSON.stringify({
        primaryOrder: {
          orderId: pendingOrderAfter.id,
          orderStatus: pendingOrderAfter.status,
          totalVnd: pendingOrderAfter.totalVnd,
        },
        zeroAmountPaidOrder: {
          orderId: zeroOrderId,
          paymentId: zeroReplayAfterRestart.body.paymentId,
          orderStatus: zeroReplayAfterRestart.body.orderStatus,
          paymentStatus: zeroReplayAfterRestart.body.paymentStatus,
        },
      }),
    );
    console.log('Post-Restart SQL Snapshot:\n' + sqlAfter);
    assert.equal(sqlAfter, sqlBefore, 'PostgreSQL snapshot before and after restart must match identically');

    console.log('\n[SCRUM-92] ALL VERIFICATION CHECKS PASSED.');
  } catch (err) {
    primaryError = err;
  } finally {
    if (keepArtifacts) {
      saveArtifactStateFile(createdArtifacts);
      console.log(
        '\n[SCRUM-92] --keep-artifacts enabled: preserving created test records in isolated database:',
        JSON.stringify({
          stateFile: ARTIFACT_STATE_FILE,
          recoveryCommand: 'node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts',
          userIds: Array.from(createdArtifacts.userIds),
          orderIds: Array.from(createdArtifacts.orderIds),
          paymentIds: Array.from(createdArtifacts.paymentIds),
          couponId: createdArtifacts.couponId,
        }),
      );
    } else {
      console.log('\n=== [9] Scoped Exact-ID Cleanup & Stock Restoration (finally) ===');
      try {
        await cleanupExactTestArtifacts(createdArtifacts);
        console.log(
          'Cleaned up exact test records and restored stock:',
          JSON.stringify({
            cleanedUserCount: createdArtifacts.userIds.size,
            cleanedOrderCount: createdArtifacts.orderIds.size,
            cleanedPaymentCount: createdArtifacts.paymentIds.size,
            cleanedCouponId: createdArtifacts.couponId,
          }),
        );
      } catch (cleanupErr) {
        saveArtifactStateFile(createdArtifacts);
        const cleanupMsg =
          `[SCRUM-92] CRITICAL CLEANUP FAILURE in finally: ${cleanupErr.message || cleanupErr}\n` +
          `Saved artifact IDs to ${ARTIFACT_STATE_FILE}. ` +
          `Recover & clean up with: node scripts/scrum92/verify_compose_e2e.mjs --cleanup-artifacts`;
        console.error(cleanupMsg);
        if (primaryError) {
          throw new Error(
            `Primary failure: ${primaryError.message || primaryError}\nCleanup also failed: ${cleanupMsg}`,
          );
        }
        throw new Error(cleanupMsg);
      }
    }

    if (primaryError) {
      throw primaryError;
    }
  }
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[SCRUM-92] VERIFICATION FAILED:', err.message || err);
    process.exit(1);
  });
}
