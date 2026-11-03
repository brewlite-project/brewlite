import 'reflect-metadata';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { VnpayInitiationService } from '../src/payments/vnpay-initiation.service.js';
import { VnpayQueryDrService } from '../src/payments/vnpay-querydr.service.js';
import { PaymentReconciliationScheduler } from '../src/payments/payment-reconciliation.scheduler.js';
import { PaymentFinalizationService, type VerifiedGatewayOutcome } from '../src/payments/payment-finalization.service.js';
import { VnpayQueryDrClient } from '../src/payments/vnpay-querydr.client.js';
import { VnpayIpnService } from '../src/payments/vnpay-ipn.service.js';
import { canonicalizeIpn } from '../src/payments/vnpay-gateway.protocol.js';
import { OrderExpirationService } from '../src/orders/order-expiration.service.js';
import type { PaymentReconciliationOptions } from '../src/payments/payment-reconciliation.config.js';

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
  let finalization: PaymentFinalizationService;
  let ipn: VnpayIpnService;
  let expiration: OrderExpirationService;
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
    vi.stubEnv('NODE_ENV', 'test');
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
    finalization = app.get(PaymentFinalizationService);
    ipn = app.get(VnpayIpnService);
    expiration = app.get(OrderExpirationService);
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

  async function due(paymentId: string) {
    await db.payment.update({
      where: { id: paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) },
    });
  }

  // The QueryDR client already has separate signed-HMAC protocol tests. Here we
  // supply an explicitly *verified* adapter result to exercise the real
  // PostgreSQL finalizer without calling VNPay or bypassing the service layer.
  function verifiedResult(
    attempt: { vnpTxnRef: string; vnpTmnCode: string; amountVnd: bigint },
    requestId: string,
    outcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN',
    gatewayPaidAt: Date | null = new Date(Date.now() - 60_000),
  ): VerifiedGatewayOutcome {
    const now = new Date();
    return {
      source: 'QUERYDR',
      eventIdentity: createHash('sha256').update(`SCRUM82-${requestId}-${outcome}`).digest('hex'),
      queryRequestId: requestId,
      vnpTxnRef: attempt.vnpTxnRef,
      vnpTmnCode: attempt.vnpTmnCode,
      outcome,
      responseCode: '00',
      transactionStatus: outcome === 'SUCCESS' ? '00' : outcome === 'FAILED' ? '02' : '01',
      gatewayTransactionNo: '123456789',
      amountVnd: attempt.amountVnd,
      gatewayPaidAt: outcome === 'SUCCESS' ? gatewayPaidAt : null,
      verifiedAt: now,
      receivedAt: now,
    };
  }

  function ipnSuccess(txnRef: string, paidAt: Date): string {
    // Same canonical HMAC-verification path as the real VnpayIpnService.
    const local = new Date(paidAt.getTime() + 7 * 60 * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = [local.getUTCFullYear(), pad(local.getUTCMonth() + 1), pad(local.getUTCDate()),
      pad(local.getUTCHours()), pad(local.getUTCMinutes()), pad(local.getUTCSeconds())].join('');
    const values = new Map(Object.entries({
      vnp_TmnCode: 'SCRUM82TEST', vnp_TxnRef: txnRef, vnp_Amount: '8500000',
      vnp_ResponseCode: '00', vnp_TransactionStatus: '00',
      vnp_TransactionNo: '123456789', vnp_PayDate: date,
    }));
    const canonical = canonicalizeIpn(values);
    const signature = createHmac('sha512', 'scrum82-test-only-secret')
      .update(canonical).digest('hex');
    return `${canonical}&vnp_SecureHash=${signature}`;
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  }

  // Bounded waits make a concurrency regression fail cleanly instead of
  // hanging app shutdown with an unresolved simulated HTTP request.
  async function within<T>(work: Promise<T>, label: string, ms = 5000): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function extraScheduler(batchSize = 1) {
    const options: PaymentReconciliationOptions = {
      enabled: false, intervalMs: 60_000, batchSize, leaseMs: 60_000,
      cooldownMs: 600_000, ipAddr: '127.0.0.1',
    };
    return new PaymentReconciliationScheduler(db, querydr, options);
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

  it('QueryDR verified SUCCESS uses shared finalization and awards loyalty exactly once', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const shared = vi.spyOn(finalization, 'finalizeInTransaction');
    const transport = vi.spyOn(VnpayQueryDrClient.prototype, 'query')
      .mockImplementation(async (attempt, requestId) => verifiedResult(attempt, requestId, 'SUCCESS'));
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'VNPAY', paymentId: f.paymentId,
      verifiedOutcome: expect.objectContaining({ source: 'QUERYDR', outcome: 'SUCCESS' }),
    }));
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.orderId } });
    const user = await db.user.findUniqueOrThrow({ where: { id: f.userId } });
    expect(payment).toMatchObject({ status: 'SUCCESS', reconciliationState: 'RESOLVED', claimToken: null, nextQueryAt: null });
    expect(order).toMatchObject({ status: 'PAID', pointsEarned: 8 });
    expect(user.loyaltyPoints).toBe(8);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, source: 'QUERYDR', disposition: 'FINALIZED' } })).toBe(1);
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).loyaltyPoints).toBe(8);
  });

  it('QueryDR verified FAILED uses shared finalization without awarding points or auto-cancelling an unexpired Order', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const shared = vi.spyOn(finalization, 'finalizeInTransaction');
    vi.spyOn(VnpayQueryDrClient.prototype, 'query')
      .mockImplementation(async (attempt, requestId) => verifiedResult(attempt, requestId, 'FAILED'));
    await scheduler.runOnce();
    expect(shared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'VNPAY', verifiedOutcome: expect.objectContaining({ outcome: 'FAILED' }),
    }));
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).toMatchObject({ status: 'FAILED', reconciliationState: 'RESOLVED' });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).toMatchObject({ status: 'PAYMENT_FAILED', pointsEarned: 0 });
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).loyaltyPoints).toBe(0);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, disposition: 'FINALIZED' } })).toBe(1);
  });

  it('verified UNKNOWN QueryDR evidence is observed and scheduled for retry, not marked FAILED', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const transport = vi.spyOn(VnpayQueryDrClient.prototype, 'query')
      .mockImplementation(async (attempt, requestId) => verifiedResult(attempt, requestId, 'UNKNOWN'));
    await scheduler.runOnce();
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment).toMatchObject({ status: 'PENDING', reconciliationState: 'SCHEDULED', claimToken: null, queryAttempts: 1 });
    expect(payment.nextQueryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, outcome: 'UNKNOWN', disposition: 'OBSERVED' } })).toBe(1);
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('network failure at the QueryDR client persists sanitized retry without converting PENDING to FAILED', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const transport = vi.spyOn(VnpayQueryDrClient.prototype, 'query')
      .mockRejectedValue(new Error('test-only gateway network message; must never persist'));
    await scheduler.runOnce();
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment).toMatchObject({ status: 'PENDING', queryAttempts: 1, claimToken: null,
      lastQueryError: 'QUERYDR_UNVERIFIED_OR_TEMPORARY_FAILURE' });
    expect(payment.nextQueryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(payment.lastQueryError).not.toContain('gateway network message');
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(0);
    await scheduler.runOnce();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('two independent scheduler workers never dispatch overlapping QueryDR for one claimed Payment', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const started = deferred(), releaseHttp = deferred();
    const transport = vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) => {
      started.resolve();
      await releaseHttp.promise;
      return verifiedResult(attempt, requestId, 'UNKNOWN');
    });
    const worker2 = extraScheduler();
    const first = scheduler.runOnce();
    try {
      await within(started.promise, 'QueryDR dispatch'); // First worker owns persisted lease; its HTTP is in flight.
      await within(worker2.runOnce(), 'second scheduler sweep');
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).queryAttempts).toBe(1);
    } finally {
      releaseHttp.resolve();
      await first;
      await worker2.onModuleDestroy();
    }
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).status).toBe('PENDING');
  });

  it('does not hold Order or Payment row locks while HTTP transport is pending', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const started = deferred(), releaseHttp = deferred();
    vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) => {
      started.resolve();
      await releaseHttp.promise;
      return verifiedResult(attempt, requestId, 'UNKNOWN');
    });
    const running = scheduler.runOnce();
    try {
      await within(started.promise, 'QueryDR dispatch');
      // PostgreSQL will block/timeout if claim kept either row locked over HTTP.
      await within(db.$transaction(async tx => {
        const orderLock = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${f.orderId}::uuid FOR UPDATE`;
        const paymentLock = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${f.paymentId}::uuid FOR UPDATE`;
        expect(orderLock).toHaveLength(1);
        expect(paymentLock).toHaveLength(1);
      }, { maxWait: 2000, timeout: 2000 }), 'PostgreSQL row locks during HTTP');
    } finally {
      releaseHttp.resolve();
      await running;
    }
  });

  it('verified IPN wins the race during QueryDR HTTP; finalization does not double-award loyalty', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    const started = deferred(), releaseHttp = deferred();
    vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) => {
      started.resolve();
      await releaseHttp.promise;
      return verifiedResult(attempt, requestId, 'SUCCESS');
    });
    const shared = vi.spyOn(finalization, 'finalizeInTransaction');
    const running = scheduler.runOnce();
    try {
      await within(started.promise, 'QueryDR dispatch');
      const ack = await within(ipn.handle(ipnSuccess(payment.vnpTxnRef!, new Date(Date.now() - 60_000))), 'IPN finalization while QueryDR HTTP waits');
      expect(ack.RspCode).toBe('00');
      expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('PAID');
    } finally {
      releaseHttp.resolve();
      await running;
    }
    expect(shared.mock.calls.filter(call => call[1].provider === 'VNPAY')).toHaveLength(2);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(2);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, disposition: 'FINALIZED' } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).loyaltyPoints).toBe(8);
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).status).toBe('SUCCESS');
  });

  it('expiration racing QueryDR keeps CANCELLED Order and records late financial SUCCESS as review', async () => {
    const f = await fixture();
    await due(f.paymentId);
    const started = deferred(), releaseHttp = deferred();
    vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) => {
      started.resolve();
      await releaseHttp.promise;
      return verifiedResult(attempt, requestId, 'SUCCESS');
    });
    const running = scheduler.runOnce();
    try {
      await within(started.promise, 'QueryDR dispatch');
      await db.order.update({ where: { id: f.orderId }, data: { expiresAt: new Date(Date.now() - 6 * 60_000) } });
      await within(expiration.runOnce(), 'expiration scheduler while QueryDR HTTP waits');
      expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('CANCELLED');
    } finally {
      releaseHttp.resolve();
      await running;
    }
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment).toMatchObject({ status: 'PENDING', reconciliationState: 'REQUIRES_REVIEW', hasFinancialException: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('CANCELLED');
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).loyaltyPoints).toBe(0);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, disposition: 'FINANCIAL_EXCEPTION' } })).toBe(1);
  });

  it('late SUCCESS for a previously cancelled Order never resurrects it or awards loyalty', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.orderId }, data: { expiresAt: new Date(Date.now() - 6 * 60_000) } });
    await due(f.paymentId);
    vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) =>
      verifiedResult(attempt, requestId, 'SUCCESS'));
    await scheduler.runOnce();
    expect((await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe('CANCELLED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).hasFinancialException).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.userId } })).loyaltyPoints).toBe(0);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId, disposition: 'FINANCIAL_EXCEPTION' } })).toBe(1);
  });

  it('isolates bad candidates across multiple DB scan batches; healthy payments still finalize', async () => {
    const f1 = await fixture();
    const f2 = await fixture();
    const [bad, good] = [f1, f2].sort((a, b) => a.paymentId.localeCompare(b.paymentId));
    await due(bad.paymentId);
    await due(good.paymentId);
    const transport = vi.spyOn(VnpayQueryDrClient.prototype, 'query').mockImplementation(async (attempt, requestId) => {
      if (attempt.id === bad.paymentId) throw new Error('test-only per-candidate network failure');
      return verifiedResult(attempt, requestId, 'SUCCESS');
    });
    const worker = extraScheduler(1);
    try { await worker.runOnce(); } finally { await worker.onModuleDestroy(); }
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await db.payment.findUniqueOrThrow({ where: { id: bad.paymentId } })).status).toBe('PENDING');
    expect((await db.payment.findUniqueOrThrow({ where: { id: good.paymentId } })).status).toBe('SUCCESS');
    expect((await db.order.findUniqueOrThrow({ where: { id: good.orderId } })).status).toBe('PAID');
  });

});
