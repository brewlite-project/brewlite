/**
 * SCRUM-92 / P2-18 — Reproducible Docker Compose Clean Setup & E2E Integration Verification
 * Works on both Git Bash and Windows PowerShell:
 *   node scripts/scrum92/verify_compose_e2e.mjs
 *
 * All sensitive values (JWT access tokens, passwords, VNPay signatures/TmnCode) are
 * automatically sanitized in console output so logs can be pasted safely into PRs/docs.
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
  return (res.stdout || '').trim();
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
  return res.stdout.trim();
}

function runPsql(pgUser, pgDb, sql) {
  return runDockerCompose(
    ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', pgDb, '-c', sql],
  );
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
  console.log('=== [0] Preflight & Deterministic Container/Migration Check ===');
  checkPreflight();
  const envCfg = parseEnvFile(ENV_FILE);
  const pgUser = envCfg.POSTGRES_USER || 'brewlite';
  const pgDb = envCfg.POSTGRES_DB || 'brewlite_compose';

  const states = await waitForStackReady();
  console.log('Container health states:', JSON.stringify(states));
  console.log(runDockerCompose(['ps', '-a']));

  console.log('\n=== [1] Database Migration & Seed Verification (psql) ===');
  const dbCheckOut = runPsql(
    pgUser,
    pgDb,
    `SELECT current_database() AS database_name,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed_migrations,
            (SELECT count(*) FROM categories) AS categories,
            (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM toppings) AS toppings;`,
  );
  console.log(dbCheckOut);
  assert.match(dbCheckOut, /brewlite_compose\s+\|\s+9\s+\|\s+4\s+\|\s+9\s+\|\s+5/);

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
  console.log(
    JSON.stringify({
      endpoint: 'GET /api/backend/products',
      status: productsRes.status,
      productCount: productsRes.body.items.length,
      sampleProduct: {
        id: detailRes.body.id,
        name: detailRes.body.name,
        selectedSize: sizeS.size,
        selectedSizePrice: sizeS.price,
        firstTopping: { id: firstTopping.id, name: firstTopping.name, price: firstTopping.price },
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

  console.log('\n=== [6] Payment Flow via Reverse Proxy (FAILED -> Retry SUCCESS -> Idempotent Replay) ===');
  const failKey = `scrum92-fail-${randomUUID()}`;
  const failPayRes = await jsonFetch(`${PROXY_API}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': failKey,
    },
    body: JSON.stringify({
      orderId,
      method: 'CARD',
      paymentDetails: { cardNumber: '4111111111110002' },
    }),
  });
  assert.equal(failPayRes.status, 200, `Failed payment call error: ${JSON.stringify(failPayRes.body)}`);
  assert.equal(failPayRes.body.paymentStatus, 'FAILED');
  assert.equal(failPayRes.body.orderStatus, 'PAYMENT_FAILED');
  assert.equal(failPayRes.body.failureReason, 'PAYMENT_DECLINED');

  const okKey = `scrum92-ok-${randomUUID()}`;
  const okPayRes = await jsonFetch(`${PROXY_API}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': okKey,
    },
    body: JSON.stringify({
      orderId,
      method: 'CARD',
      paymentDetails: { cardNumber: '4111111111111234' },
    }),
  });
  assert.equal(okPayRes.status, 200, `Success payment call error: ${JSON.stringify(okPayRes.body)}`);
  assert.equal(okPayRes.body.paymentStatus, 'SUCCESS');
  assert.equal(okPayRes.body.orderStatus, 'PAID');
  assert.equal(okPayRes.body.pointsEarned, 10);

  const replayPayRes = await jsonFetch(`${PROXY_API}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': okKey,
    },
    body: JSON.stringify({
      orderId,
      method: 'CARD',
      paymentDetails: { cardNumber: '4111111111111234' },
    }),
  });
  assert.equal(replayPayRes.status, 200);
  assert.equal(replayPayRes.headers.get('idempotency-replayed'), 'true');
  assert.equal(replayPayRes.body.paymentId, okPayRes.body.paymentId);
  console.log(
    JSON.stringify({
      failedAttempt: {
        paymentId: failPayRes.body.paymentId,
        paymentStatus: failPayRes.body.paymentStatus,
        orderStatus: failPayRes.body.orderStatus,
        failureReason: failPayRes.body.failureReason,
      },
      retrySuccess: {
        paymentId: okPayRes.body.paymentId,
        paymentStatus: okPayRes.body.paymentStatus,
        orderStatus: okPayRes.body.orderStatus,
        pointsEarned: okPayRes.body.pointsEarned,
      },
      idempotentReplay: {
        status: replayPayRes.status,
        idempotencyReplayedHeader: replayPayRes.headers.get('idempotency-replayed'),
        samePaymentId: replayPayRes.body.paymentId === okPayRes.body.paymentId,
      },
    }),
  );

  if (envCfg.VNPAY_TMN_CODE && envCfg.VNPAY_HASH_SECRET && envCfg.VNPAY_RETURN_URL) {
    console.log('\n=== [6b] VNPay Sandbox Initiation & Replay (/api/backend/payments/vnpay/initiate) ===');
    const vnpOrderRes = await jsonFetch(`${PROXY_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        items: [{ productId: detailRes.body.id, size: sizeS.size, quantity: 1, toppingIds: [] }],
      }),
    });
    assert.equal(vnpOrderRes.status, 201);
    const vnpOrderId = vnpOrderRes.body.id;
    const vnpKey = `scrum92-vnp-${randomUUID()}`;
    const vnpInitRes = await jsonFetch(`${PROXY_API}/payments/vnpay/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': vnpKey,
      },
      body: JSON.stringify({ orderId: vnpOrderId }),
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
      body: JSON.stringify({ orderId: vnpOrderId }),
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
  const paidOrderBefore = ordersBefore.body.items.find((o) => o.id === orderId);
  assert.ok(paidOrderBefore);
  assert.equal(paidOrderBefore.status, 'PAID');
  assert.equal(paidOrderBefore.payment.id, okPayRes.body.paymentId);
  assert.equal(paidOrderBefore.payment.status, 'SUCCESS');

  const meBefore = await jsonFetch(`${PROXY_API}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(meBefore.status, 200);
  assert.equal(meBefore.body.loyaltyPoints, 10);

  const sqlSnapshotQuery = `SELECT o.id AS order_id, o.status AS order_status, o.total_vnd,
            (SELECT count(*) FROM payments p WHERE p.order_id = o.id) AS payment_attempts,
            (SELECT p.status FROM payments p WHERE p.id = '${okPayRes.body.paymentId}') AS winning_payment_status,
            u.loyalty_points
       FROM orders o
       JOIN users u ON u.id = o.user_id
      WHERE o.id = '${orderId}';`;
  const sqlBefore = runPsql(pgUser, pgDb, sqlSnapshotQuery);
  console.log(
    'Pre-Restart API Snapshot:',
    JSON.stringify({
      orderId: paidOrderBefore.id,
      orderStatus: paidOrderBefore.status,
      totalVnd: paidOrderBefore.totalVnd,
      paymentId: paidOrderBefore.payment.id,
      paymentStatus: paidOrderBefore.payment.status,
      loyaltyPoints: meBefore.body.loyaltyPoints,
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
  const paidOrderAfter = ordersAfter.body.items.find((o) => o.id === orderId);
  assert.ok(paidOrderAfter);
  assert.equal(paidOrderAfter.status, 'PAID');
  assert.equal(paidOrderAfter.payment.id, okPayRes.body.paymentId);
  assert.equal(paidOrderAfter.payment.status, 'SUCCESS');

  const meAfter = await jsonFetch(`${PROXY_API}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(meAfter.status, 200);
  assert.equal(meAfter.body.loyaltyPoints, 10);

  const sqlAfter = runPsql(pgUser, pgDb, sqlSnapshotQuery);
  console.log(
    'Post-Restart API Snapshot:',
    JSON.stringify({
      orderId: paidOrderAfter.id,
      orderStatus: paidOrderAfter.status,
      totalVnd: paidOrderAfter.totalVnd,
      paymentId: paidOrderAfter.payment.id,
      paymentStatus: paidOrderAfter.payment.status,
      loyaltyPoints: meAfter.body.loyaltyPoints,
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
