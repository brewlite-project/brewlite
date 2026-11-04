/**
 * SCRUM-92 / P2-18 — Reproducible Docker Compose Clean Setup & E2E Integration Verification
 * Works on both Git Bash and Windows PowerShell:
 *   node scripts/scrum92/verify_compose_e2e.mjs
 *   node scripts/scrum92/verify_compose_e2e.mjs --cleanup-only
 *
 * Determinism & Safety Guarantees:
 * - Never runs `docker volume rm` or `docker compose down -v`.
 * - Uses container-internal `$POSTGRES_USER` and `$POSTGRES_DB` via `sh -c 'psql ...'`.
 * - Before running E2E flows, deterministically cleans up any prior SCRUM-92 synthetic test
 *   records (`scrum92.verify.%@brewlite.vn`, coupon `SCRUM92FREE`) and restores their reserved
 *   product stock inside a single SQL transaction, so repeated runs never exhaust product stock.
 * - Verifies Phase 2 payment behavior on current `dev` (`SCRUM-84` & `SCRUM-85`):
 *   1. `POST /api/backend/payments` (Mock) -> `403 MOCK_PAYMENT_DISABLED` in Compose (`NODE_ENV=production`).
 *   2. `POST /api/backend/payments/zero-amount` -> `409 ORDER_NOT_ZERO_AMOUNT` on positive order,
 *      and `201 Created` (`PAID` / `SUCCESS`) + `200 OK` (`idempotency-replayed: true`) on a 0 VND order.
 *   3. `POST /api/backend/payments/vnpay/initiate` -> `201 Created` (`PENDING`) + `200 OK` replay
 *      when VNPay sandbox variables are configured in `compose.env`.
 * - Automatically redacts sensitive values (`<REDACTED_JWT>`, `<REDACTED_TMN_CODE>`,
 *   `<REDACTED_SECURE_HASH>`) and strips trailing whitespace from console output.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_FILE = path.join(ROOT, 'compose.env');
const FE_URL = 'http://localhost:3000';
const BE_URL = 'http://localhost:3001';
const PROXY_API = `${FE_URL}/api/backend`;

const COMPOSE_VARIABLES = [
  'DATABASE_URL',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'JWT_SECRET',
  'INTERNAL_SECRET',
  'VNPAY_TMN_CODE',
  'VNPAY_HASH_SECRET',
  'VNPAY_PAYMENT_URL',
  'VNPAY_RETURN_URL',
  'VNPAY_QUERYDR_URL',
  'VNPAY_QUERYDR_TIMEOUT_MS',
  'COMPOSE_PROJECT_NAME',
];

function stripTrailingWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function checkPreflight() {
  const conflicts = COMPOSE_VARIABLES.filter((name) => process.env[name] !== undefined);
  if (conflicts.length > 0) {
    throw new Error(
      `Compose preflight failed: exported variable(s) would override compose.env: ${conflicts.join(', ')}`,
    );
  }
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('Missing compose.env in repository root. Copy compose.env.example to compose.env first.');
  }
}

function parseEnvFile(filePath) {
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

function runDockerCompose(args, input) {
  const res = spawnSync('docker', ['compose', '--env-file', 'compose.env', ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed (exit ${res.status}):\n${res.stdout || ''}\n${res.stderr || ''}`,
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

function cleanupScrum92TestData() {
  const cleanupSql = `
BEGIN;

WITH target_users AS (
  SELECT id
  FROM users
  WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
     OR email LIKE 'scrum92.docker.%@brewlite.vn'
),
target_orders AS (
  SELECT id, status
  FROM orders
  WHERE user_id IN (SELECT id FROM target_users)
),
stock_to_restore AS (
  SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0)::int AS qty
  FROM order_items oi
  JOIN target_orders o ON o.id = oi.order_id
  WHERE o.status <> 'CANCELLED'
  GROUP BY oi.product_id
),
restored_products AS (
  UPDATE products p
  SET stock = p.stock + s.qty
  FROM stock_to_restore s
  WHERE p.id = s.product_id
  RETURNING p.id, s.qty
)
SELECT COALESCE(SUM(qty), 0)::int AS restored_stock_units FROM restored_products;

DELETE FROM payment_gateway_events
WHERE payment_id IN (
  SELECT id FROM payments
  WHERE user_id IN (
    SELECT id FROM users
    WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
       OR email LIKE 'scrum92.docker.%@brewlite.vn'
  )
);

DELETE FROM payments
WHERE user_id IN (
  SELECT id FROM users
  WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
     OR email LIKE 'scrum92.docker.%@brewlite.vn'
);

DELETE FROM coupon_redemptions
WHERE user_id IN (
  SELECT id FROM users
  WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
     OR email LIKE 'scrum92.docker.%@brewlite.vn'
);

DELETE FROM order_item_toppings
WHERE order_item_id IN (
  SELECT oi.id
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN users u ON u.id = o.user_id
  WHERE u.email LIKE 'scrum92.verify.%@brewlite.vn'
     OR u.email LIKE 'scrum92.docker.%@brewlite.vn'
);

DELETE FROM order_items
WHERE order_id IN (
  SELECT o.id
  FROM orders o
  JOIN users u ON u.id = o.user_id
  WHERE u.email LIKE 'scrum92.verify.%@brewlite.vn'
     OR u.email LIKE 'scrum92.docker.%@brewlite.vn'
);

DELETE FROM orders
WHERE user_id IN (
  SELECT id FROM users
  WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
     OR email LIKE 'scrum92.docker.%@brewlite.vn'
);

DELETE FROM coupons
WHERE code = 'SCRUM92FREE';

DELETE FROM users
WHERE email LIKE 'scrum92.verify.%@brewlite.vn'
   OR email LIKE 'scrum92.docker.%@brewlite.vn';

COMMIT;
`;
  runPsqlTuple(cleanupSql);
}

function seedScrum92ZeroCoupon() {
  const couponSql = `
INSERT INTO coupons (
  id, code, type, value, min_subtotal_vnd, max_discount_vnd,
  starts_at, expires_at, usage_limit, per_user_limit, active_usage_count
) VALUES (
  'c9200000-0000-4000-8000-000000000092',
  'SCRUM92FREE',
  'PERCENT',
  100,
  0,
  NULL,
  NOW() - INTERVAL '1 day',
  NOW() + INTERVAL '7 days',
  100,
  10,
  0
)
ON CONFLICT (code) DO UPDATE
SET active_usage_count = 0,
    starts_at = NOW() - INTERVAL '1 day',
    expires_at = NOW() + INTERVAL '7 days';
`;
  runPsqlTuple(couponSql);
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
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
  const pgIdInitial = runDockerCompose(['ps', '-a', '-q', 'postgres']);
  if (pgIdInitial && inspectContainer(pgIdInitial, '{{.State.Status}}') !== 'running') {
    runDockerCompose(['start']);
  }
  const deadline = Date.now() + 90_000;
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
  throw new Error('Timed out waiting for Compose services (postgres, migrate, backend, frontend) to become ready.');
}

async function main() {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.some((arg) => arg !== '--cleanup-only')) {
    console.error('Usage: node scripts/scrum92/verify_compose_e2e.mjs [--cleanup-only]');
    process.exit(2);
  }
  const cleanupOnly = cliArgs.includes('--cleanup-only');

  console.log('=== [0] Preflight & Deterministic Container/Migration Check ===');
  checkPreflight();
  const envCfg = parseEnvFile(ENV_FILE);
  const expectedDb = envCfg.POSTGRES_DB || 'brewlite_compose';

  const states = await waitForStackReady();
  console.log('Container health states:', JSON.stringify(states));
  console.log(runDockerCompose(['ps', '-a']));

  const actualDb = runPsqlTuple('SELECT current_database();');
  if (actualDb !== expectedDb || actualDb === 'brewlite_db') {
    throw new Error(
      `Refusing to run E2E verification on unexpected database "${actualDb}" (expected isolated Compose database "${expectedDb}").`,
    );
  }

  console.log('\n=== [1] Database Migration, Seed & Scoped Test-Data Cleanup (psql) ===');
  cleanupScrum92TestData();
  const dbCheckOut = runPsql(
    `SELECT current_database() AS database_name,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed_migrations,
            (SELECT count(*) FROM categories) AS categories,
            (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM toppings) AS toppings,
            (SELECT stock FROM products WHERE id = 'a3000000-0000-4000-8000-000000000001') AS sample_product_stock;`,
  );
  console.log(dbCheckOut);
  assert.match(dbCheckOut, new RegExp(`${expectedDb}\\s+\\|\\s+9\\s+\\|\\s+4\\s+\\|\\s+9\\s+\\|\\s+5\\s+\\|\\s+25`));

  if (cleanupOnly) {
    console.log('\n[SCRUM-92] Scoped test-data cleanup and stock restoration completed.');
    return;
  }

  console.log('\n=== [2] Smoke Check: Frontend, Backend Liveness & Swagger ===');
  const feHome = await fetch(`${FE_URL}/`);
  const beHome = await fetch(`${BE_URL}/`);
  const swaggerRes = await fetch(`${BE_URL}/api-docs`);
  const imgRes = await fetch(`${FE_URL}/images/bac-xiu-kem-beo-phin.jpg`);
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
  const email = `scrum92.verify.${Date.now()}@brewlite.vn`;
  const password = `BrewLite#${randomUUID().slice(0, 8)}!`;

  const regRes = await jsonFetch(`${PROXY_API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fullName: 'SCRUM-92 Clean Verifier' }),
  });
  assert.equal(regRes.status, 201, `Register failed: ${JSON.stringify(regRes.body)}`);

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
  const orderId = createOrderRes.body.id;
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

  seedScrum92ZeroCoupon();
  const zeroEmail = `scrum92.verify.zero.${Date.now()}@brewlite.vn`;
  const zeroRegRes = await jsonFetch(`${PROXY_API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: zeroEmail, password, fullName: 'SCRUM-92 Zero Amount Verifier' }),
  });
  assert.equal(zeroRegRes.status, 201);
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
      couponCode: 'SCRUM92FREE',
      items: [{ productId: detailRes.body.id, size: sizeS.size, quantity: 1, toppingIds: [] }],
    }),
  });
  assert.equal(zeroOrderRes.status, 201, `Create zero order failed: ${JSON.stringify(zeroOrderRes.body)}`);
  assert.equal(zeroOrderRes.body.totalVnd, 0);
  const zeroOrderId = zeroOrderRes.body.id;

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

  if (envCfg.VNPAY_TMN_CODE && envCfg.VNPAY_HASH_SECRET && envCfg.VNPAY_RETURN_URL) {
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

  console.log('\n=== [8] Restart Stack (docker compose stop -> start) & Post-Restart Persistence Check ===');
  runDockerCompose(['stop']);
  runDockerCompose(['start']);
  const postStates = await waitForStackReady();
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
}

main().catch((err) => {
  console.error('[SCRUM-92] VERIFICATION FAILED:', err.message || err);
  process.exit(1);
});
