import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { VnpayInitiationService } from '../src/payments/vnpay-initiation.service.js';
import { VnpayQueryDrService } from '../src/payments/vnpay-querydr.service.js';
import { PaymentReconciliationScheduler } from '../src/payments/payment-reconciliation.scheduler.js';

/**
 * Local PostgreSQL integration verification only. NEVER run against a shared DB.
 * QueryDR HTTP is always mocked here; this suite tests durable DB scheduling.
 */
describe('SCRUM-82 reconciliation scheduler / PostgreSQL', () => {
  let app: INestApplication;
  let db: PrismaService;
  let initiation: VnpayInitiationService;
  let querydr: VnpayQueryDrService;
  let scheduler: PaymentReconciliationScheduler;
  const users: string[] = [];
  const runId = randomUUID();

  beforeAll(async () => {
    const connection = process.env.AUTH_TEST_DATABASE_URL;
    if (!connection) throw new Error('Set AUTH_TEST_DATABASE_URL to the isolated localhost:5433/brewlite_test DB');
    const url = new URL(connection);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' ||
        url.port !== '5433' || url.pathname !== '/brewlite_test')
      throw new Error('REFUSE: SCRUM-82 requires isolated localhost:5433/brewlite_test');
    vi.stubEnv('DATABASE_URL', connection);
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'false');
    vi.stubEnv('VNPAY_TMN_CODE', 'SCRUM82TEST');
    vi.stubEnv('VNPAY_HASH_SECRET', 'scrum82-test-only-secret');
    vi.stubEnv('VNPAY_PAYMENT_URL', 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html');
    vi.stubEnv('VNPAY_RETURN_URL', 'https://merchant.example/return');
    vi.stubEnv('VNPAY_QUERYDR_URL', 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction');
    vi.stubEnv('VNPAY_QUERYDR_TIMEOUT_MS', '15000');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    db = app.get(PrismaService);
    initiation = app.get(VnpayInitiationService);
    querydr = app.get(VnpayQueryDrService);
    scheduler = app.get(PaymentReconciliationScheduler);
    const [identity] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    expect(identity?.name).toBe('brewlite_test');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!db || users.length === 0) return;
    const where = { userId: { in: users } };
    await db.paymentGatewayEvent.deleteMany({ where: { payment: where } });
    await db.payment.deleteMany({ where });
    await db.order.deleteMany({ where });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = 0;
  });
  afterAll(async () => {
    try { await app?.close(); } finally { vi.unstubAllEnvs(); }
  });

  async function fixture() {
    const userId = randomUUID();
    users.push(userId);
    await db.user.create({ data: {
      id: userId, email: `scrum82-${runId}-${userId}@test.local`, passwordHash: 'test-only',
    } });
    const order = await db.order.create({ data: {
      userId, subtotalVnd: 85000n, totalVnd: 85000n,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    } });
    const initiated = await initiation.initiate(userId, randomUUID(), { orderId: order.id }, '127.0.0.1');
    return { userId, orderId: order.id, paymentId: initiated.response.paymentId };
  }

  it('two workers can claim the same due payment only once; crash respects persisted cooldown', async () => {
    const f = await fixture();
    await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const [a, b] = await Promise.all([
      querydr.claim(f.paymentId, 30_000, 600_000),
      querydr.claim(f.paymentId, 30_000, 600_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b)!;
    const claimed = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(claimed.queryAttempts).toBe(1);
    expect(claimed.claimToken).toBe(winner.claimToken);
    expect(claimed.lastQueryRequestId).toBe(winner.requestId);
    expect(claimed.nextQueryAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await querydr.releaseClaim(f.paymentId, winner.claimToken, null)).toBe(true);
    expect(await querydr.claim(f.paymentId, 30_000, 600_000)).toBeNull();
  });

  it('after Grace, shared expiration cancels Order while Payment remains PENDING', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.orderId }, data: { expiresAt: new Date(Date.now() - 6 * 60_000) } });
    await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    expect(await querydr.claim(f.paymentId, 30_000, 600_000)).toBeTruthy();
    expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('CANCELLED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).status).toBe('PENDING');
  });

  it('marks horizon for manual review without auto-failing Payment or resurrecting Order', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.orderId }, data: { expiresAt: new Date(Date.now() - 70 * 60_000) } });
    await db.payment.update({ where: { id: f.paymentId }, data: {
      reconcileUntil: new Date(Date.now() - 60_000),
      nextQueryAt: new Date(Date.now() - 120_000),
    } });
    expect(await querydr.markExhausted(f.paymentId)).toBe(true);
    const p = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(p).toMatchObject({ status: 'PENDING', reconciliationState: 'REQUIRES_REVIEW',
      reviewReason: 'AUTO_RECONCILIATION_EXHAUSTED', nextQueryAt: null, claimToken: null });
    expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('CANCELLED');
    expect(await querydr.claim(f.paymentId, 30_000)).toBeNull();
  });

  it('scheduler stores an inconclusive retry without causing overlapping QueryDR HTTP', async () => {
    const f = await fixture();
    await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const transport = vi.spyOn(querydr, 'reconcileClaimed').mockRejectedValue(new Error('test-only network timeout'));
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment.status).toBe('PENDING');
    expect(payment.queryAttempts).toBe(1);
    expect(payment.claimToken).toBeNull();
    expect(payment.lastQueryError).toBe('QUERYDR_UNVERIFIED_OR_TEMPORARY_FAILURE');
    expect(payment.nextQueryAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
