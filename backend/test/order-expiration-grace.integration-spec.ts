import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { ORDER_EXPIRATION_OPTIONS } from '../src/orders/order-expiration.config.js';
import { OrderExpirationService } from '../src/orders/order-expiration.service.js';
import {
  PaymentFinalizationService,
  type VerifiedGatewayOutcome,
} from '../src/payments/payment-finalization.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type Fixture = {
  userId: string;
  token: string;
  productId: string;
  couponId: string;
  couponCode: string;
  orderId: string;
};
type Attempt = { id: string; key: string };
const barrier = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('SCRUM-83 Order expiration and bounded VNPay Grace on PostgreSQL', () => {
  let app: INestApplication<App> | undefined;
  let db: PrismaService;
  let jwt: JwtService;
  let scheduler: OrderExpirationService;
  let finalizer: PaymentFinalizationService;
  const categoryId = randomUUID();
  const users: string[] = [];
  const products: string[] = [];
  const coupons: string[] = [];

  beforeAll(async () => {
    const value = process.env.ORDERS_TEST_DATABASE_URL;
    if (!value)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to localhost:5433/brewlite_test.',
      );
    const url = new URL(value);
    if (
      url.hostname !== 'localhost' ||
      url.port !== '5433' ||
      url.pathname !== '/brewlite_test' ||
      !['postgres:', 'postgresql:'].includes(url.protocol)
    )
      throw new Error(
        'This Scheduler suite requires the dedicated localhost:5433/brewlite_test database.',
      );
    vi.stubEnv('DATABASE_URL', value);
    vi.stubEnv('VNPAY_TMN_CODE', 'SCRUM83TEST');
    vi.stubEnv('VNPAY_HASH_SECRET', 'scrum83-test-only-hmac-secret');
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );
    vi.stubEnv('VNPAY_RETURN_URL', 'https://merchant.example/return');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ORDER_EXPIRATION_OPTIONS)
      .useValue({ enabled: false, batchSize: 1 })
      .compile();
    app = module.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    await app.init();
    db = app.get(PrismaService);
    jwt = app.get(JwtService);
    scheduler = app.get(OrderExpirationService);
    finalizer = app.get(PaymentFinalizationService);
    const [identity] = await db.$queryRaw<{ database: string }[]>`
      SELECT current_database() AS database`;
    expect(identity.database).toBe('brewlite_test');
    await db.category.create({
      data: { id: categoryId, code: categoryId, name: 'SCRUM-83 test' },
    });
  });

  async function cleanup() {
    if (!db || !users.length) return;
    const where = { userId: { in: users } };
    await db.paymentGatewayEvent.deleteMany({ where: { payment: where } });
    await db.payment.deleteMany({ where });
    await db.couponRedemption.deleteMany({ where });
    await db.orderItemTopping.deleteMany({
      where: { orderItem: { order: where } },
    });
    await db.orderItem.deleteMany({ where: { order: where } });
    await db.order.deleteMany({ where });
    await db.coupon.deleteMany({ where: { id: { in: coupons } } });
    await db.product.deleteMany({ where: { id: { in: products } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    users.length = products.length = coupons.length = 0;
  }
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await cleanup();
  });
  afterAll(async () => {
    try {
      await cleanup();
      if (db) await db.category.deleteMany({ where: { id: categoryId } });
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
    }
  });

  const create = (f: Pick<Fixture, 'token' | 'productId' | 'couponCode'>) =>
    request(app!.getHttpServer())
      .post('/orders')
      .auth(f.token, { type: 'bearer' })
      .send({
        couponCode: f.couponCode,
        items: [
          { productId: f.productId, size: 'S', quantity: 2, toppingIds: [] },
        ],
      });
  const initiate = (f: Fixture, key: string = randomUUID()) =>
    request(app!.getHttpServer())
      .post('/payments/vnpay/initiate')
      .auth(f.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ orderId: f.orderId });

  async function fixture(): Promise<Fixture> {
    const userId = randomUUID(),
      productId = randomUUID(),
      couponId = randomUUID();
    users.push(userId);
    products.push(productId);
    coupons.push(couponId);
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@scrum83.test`,
        passwordHash: 'test-only-unused',
      },
    });
    await db.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Grace test',
        imageUrl: '/test',
        basePriceVnd: 50000n,
        stock: 5,
      },
    });
    const couponCode = couponId.replaceAll('-', '').slice(0, 20).toUpperCase();
    await db.coupon.create({
      data: {
        id: couponId,
        code: couponCode,
        type: 'FIXED',
        value: 10000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 1,
        perUserLimit: 1,
      },
    });
    const f = {
      userId,
      productId,
      couponId,
      couponCode,
      token: jwt.sign({ sub: userId }),
    };
    const response = await create(f).expect(201);
    return { ...f, orderId: response.body.id as string };
  }
  async function attempt(f: Fixture): Promise<Attempt> {
    const key = randomUUID();
    const response = await initiate(f, key).expect(201);
    return { id: response.body.paymentId as string, key };
  }
  // Move a test-owned timeline using DB time, retaining the exact 15-minute TTL.
  // No test sleeps for a production deadline or changes the business constants.
  async function setExpiry(f: Fixture, offsetMs: number): Promise<Date> {
    const [row] = await db.$queryRaw<{ expiresAt: Date }[]>`
      WITH deadline AS MATERIALIZED (
        SELECT date_trunc('milliseconds', clock_timestamp())
          + (${offsetMs} * INTERVAL '1 millisecond') AS expiry
      )
      UPDATE orders SET expires_at = deadline.expiry,
        created_at = deadline.expiry - INTERVAL '15 minutes'
      FROM deadline WHERE orders.id = ${f.orderId}::uuid
      RETURNING expires_at AS "expiresAt"`;
    await db.payment.updateMany({
      where: { orderId: f.orderId, provider: 'VNPAY' },
      data: {
        createdAt: new Date(row.expiresAt.getTime() - 60_000),
        gatewayExpiresAt: row.expiresAt,
        nextQueryAt: row.expiresAt,
        reconcileUntil: new Date(row.expiresAt.getTime() + 65 * 60_000),
      },
    });
    return row.expiresAt;
  }
  async function snapshot(f: Fixture) {
    const [order, product, coupon, user] = await Promise.all([
      db.order.findUniqueOrThrow({
        where: { id: f.orderId },
        include: {
          payments: { orderBy: { id: 'asc' } },
          couponRedemption: true,
        },
      }),
      db.product.findUniqueOrThrow({ where: { id: f.productId } }),
      db.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
      db.user.findUniqueOrThrow({ where: { id: f.userId } }),
    ]);
    return { order, product, coupon, user };
  }
  async function assertCancelled(f: Fixture) {
    const state = await snapshot(f);
    expect(state.order.status).toBe('CANCELLED');
    expect(state.order.cancelledAt).toBeInstanceOf(Date);
    expect(state.order.pointsEarned).toBe(0);
    expect(state.product.stock).toBe(5);
    expect(state.coupon.activeUsageCount).toBe(0);
    expect(state.order.couponRedemption?.status).toBe('RELEASED');
    expect(state.user.loyaltyPoints).toBe(0);
    return state;
  }
  async function evidence(
    f: Fixture,
    a: Attempt,
    options: {
      source?: VerifiedGatewayOutcome['source'];
      outcome?: VerifiedGatewayOutcome['outcome'];
      paidAt?: Date | null;
    } = {},
  ): Promise<VerifiedGatewayOutcome> {
    const payment = await db.payment.findUniqueOrThrow({ where: { id: a.id } });
    const [clock] = await db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const source = options.source ?? 'IPN',
      outcome = options.outcome ?? 'SUCCESS';
    const order = await db.order.findUniqueOrThrow({
      where: { id: f.orderId },
    });
    return {
      source,
      outcome,
      eventIdentity: createHash('sha256').update(randomUUID()).digest('hex'),
      queryRequestId: source === 'QUERYDR' ? randomUUID() : null,
      vnpTxnRef: payment.vnpTxnRef!,
      vnpTmnCode: payment.vnpTmnCode!,
      responseCode: outcome === 'FAILED' ? '24' : '00',
      transactionStatus:
        outcome === 'FAILED' ? '02' : outcome === 'UNKNOWN' ? '01' : '00',
      gatewayTransactionNo: `TEST-${randomUUID()}`,
      amountVnd: payment.amountVnd,
      gatewayPaidAt:
        options.paidAt === undefined ? order.expiresAt : options.paidAt,
      verifiedAt: clock.now,
      receivedAt: clock.now,
    };
  }
  const finalize = (a: Attempt, verifiedOutcome: VerifiedGatewayOutcome) =>
    db.$transaction((tx) =>
      finalizer.finalizeInTransaction(tx, {
        provider: 'VNPAY',
        paymentId: a.id,
        verifiedOutcome,
      }),
    );

  // Hold a real service transaction just before COMMIT; the competing service
  // must actually wait on its PostgreSQL lock, not on a mocked database method.
  function holdNextCommit() {
    const ready = barrier<number>(),
      release = barrier<void>();
    const original = db.$transaction.bind(db);
    const held = async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ) =>
      original(async (tx) => {
        const [backend] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const result = await work(tx);
        ready.resolve(backend.pid);
        await release.promise;
        return result;
      }, options);
    const spy = vi
      .spyOn(db, '$transaction')
      .mockImplementationOnce(held as PrismaService['$transaction']);
    return {
      ready: ready.promise,
      release: () => release.resolve(),
      restore: () => spy.mockRestore(),
    };
  }
  async function waitForBlockedBy(pid: number) {
    await expect
      .poll(
        async () => {
          const [row] = await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`;
          return row.waiting;
        },
        { timeout: 1000, interval: 10 },
      )
      .toBe(true);
  }

  it('creates a 15-minute Order using DB time even if the application clock is wrong', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2040-01-01') });
    const f = await fixture();
    const state = await snapshot(f);
    const [clock] = await db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    expect(
      state.order.expiresAt.getTime() - state.order.createdAt.getTime(),
    ).toBe(900_000);
    expect(
      Math.abs(state.order.createdAt.getTime() - clock.now.getTime()),
    ).toBeLessThan(10_000);
  });

  it.each(['PENDING', 'PAYMENT_FAILED'] as const)(
    'expires %s at E without VNPay PENDING and releases only once',
    async (status) => {
      const f = await fixture();
      await db.order.update({ where: { id: f.orderId }, data: { status } });
      await setExpiry(f, 0);
      await scheduler.runOnce();
      const cancelled = await assertCancelled(f);
      await scheduler.runOnce();
      expect(await snapshot(f)).toEqual(cancelled);
    },
  );

  it.each(['PENDING', 'PAYMENT_FAILED'] as const)(
    'keeps %s active in Grace and blocks POST /orders without changing resources',
    async (status) => {
      const f = await fixture();
      const a = await attempt(f);
      await db.order.update({ where: { id: f.orderId }, data: { status } });
      await setExpiry(f, -60_000);
      const before = await snapshot(f);
      await scheduler.runOnce();
      await create(f)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('PENDING_ORDER_EXISTS'));
      expect(await snapshot(f)).toEqual(before);
      expect(before.product.stock).toBe(3);
      expect(before.order.couponRedemption?.status).toBe('HELD');
      expect(before.order.payments[0].id).toBe(a.id);
      expect(await db.order.count({ where: { userId: f.userId } })).toBe(1);
    },
  );

  it.each([-240_000, -300_000, -360_000])(
    'applies the Grace end boundary with expiry offset %i ms',
    async (offset) => {
      const f = await fixture();
      await attempt(f);
      await setExpiry(f, offset);
      const before = await snapshot(f);
      await scheduler.runOnce();
      if (offset > -300_000) expect(await snapshot(f)).toEqual(before);
      else {
        const state = await assertCancelled(f);
        expect(state.order.payments[0]).toEqual(before.order.payments[0]);
        expect(state.order.payments[0].status).toBe('PENDING');
      }
    },
  );

  it('rejects new attempts after E before a sweep, but permits an existing initiation replay', async () => {
    const f = await fixture();
    await setExpiry(f, 0);
    await initiate(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ORDER_EXPIRED'));
    expect(await db.payment.count({ where: { orderId: f.orderId } })).toBe(0);
    const pending = await fixture(),
      a = await attempt(pending);
    await setExpiry(pending, -60_000);
    const before = await snapshot(pending);
    await initiate(pending)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ORDER_EXPIRED'));
    await initiate(pending, a.key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
    expect(await snapshot(pending)).toEqual(before);
  });

  it('POST /orders cleans up at G before reserving a replacement without a Scheduler tick', async () => {
    const f = await fixture();
    await attempt(f);
    await setExpiry(f, -300_000);
    const replacement = await create(f).expect(201);
    const old = await db.order.findUniqueOrThrow({
      where: { id: f.orderId },
      include: { couponRedemption: true, payments: true },
    });
    expect(old.status).toBe('CANCELLED');
    expect(old.couponRedemption?.status).toBe('RELEASED');
    expect(old.payments[0].status).toBe('PENDING');
    const next = { ...f, orderId: replacement.body.id as string };
    const state = await snapshot(next);
    expect(state.product.stock).toBe(3);
    expect(state.coupon.activeUsageCount).toBe(1);
    expect(state.order.couponRedemption?.status).toBe('HELD');
    await scheduler.runOnce();
    expect(await snapshot(next)).toEqual(state);
  });

  it.each(['IPN', 'QUERYDR'] as const)(
    'accepts verified timely %s SUCCESS in Grace, consumes once and preserves expiry',
    async (source) => {
      const f = await fixture(),
        a = await attempt(f);
      const expiresAt = await setExpiry(f, -60_000);
      const proof = await evidence(f, a, { source, paidAt: expiresAt });
      expect((await finalize(a, proof)).disposition).toBe('FINALIZED');
      const paid = await snapshot(f);
      expect(paid.order.status).toBe('PAID');
      expect(paid.order.expiresAt).toEqual(expiresAt);
      expect(paid.product.stock).toBe(3);
      expect(paid.order.couponRedemption?.status).toBe('CONSUMED');
      expect(paid.coupon.activeUsageCount).toBe(1);
      expect(paid.user.loyaltyPoints).toBe(9);
      expect((await finalize(a, proof)).disposition).toBe('DUPLICATE');
      await scheduler.runOnce();
      expect(await snapshot(f)).toEqual(paid);
    },
  );

  it.each(['IPN', 'QUERYDR'] as const)(
    'cancels immediately on verified %s FAILED inside Grace',
    async (source) => {
      const f = await fixture(),
        a = await attempt(f);
      await setExpiry(f, -60_000);
      expect(
        (
          await finalize(
            a,
            await evidence(f, a, { source, outcome: 'FAILED', paidAt: null }),
          )
        ).disposition,
      ).toBe('FINALIZED');
      const state = await assertCancelled(f);
      expect(state.order.payments[0].status).toBe('FAILED');
      await scheduler.runOnce();
      expect(await snapshot(f)).toEqual(state);
    },
  );

  it('records payment after E as a financial exception and releases without granting PAID', async () => {
    const f = await fixture(),
      a = await attempt(f);
    const expiry = await setExpiry(f, -60_000);
    const proof = await evidence(f, a, {
      paidAt: new Date(expiry.getTime() + 1000),
    });
    expect((await finalize(a, proof)).disposition).toBe('FINANCIAL_EXCEPTION');
    const state = await assertCancelled(f);
    expect(state.order.payments[0]).toMatchObject({
      status: 'PENDING',
      hasFinancialException: true,
      reconciliationState: 'REQUIRES_REVIEW',
    });
    expect((await finalize(a, proof)).disposition).toBe('DUPLICATE');
    expect(await snapshot(f)).toEqual(state);
  });

  it('keeps unresolved evidence pending and cancels at G when SUCCESS has no trusted paidAt', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await setExpiry(f, -60_000);
    expect(
      (await finalize(a, await evidence(f, a, { paidAt: null }))).disposition,
    ).toBe('OBSERVED');
    await scheduler.runOnce();
    expect((await snapshot(f)).order.status).toBe('PENDING');
    await setExpiry(f, -300_000);
    await scheduler.runOnce();
    const state = await assertCancelled(f);
    expect(state.order.payments[0].status).toBe('PENDING');
  });

  it('preserves late SUCCESS evidence after cancellation without reviving or releasing twice', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await setExpiry(f, -300_000);
    await scheduler.runOnce();
    await assertCancelled(f);
    const proof = await evidence(f, a);
    expect((await finalize(a, proof)).disposition).toBe('FINANCIAL_EXCEPTION');
    const state = await assertCancelled(f);
    expect(state.order.payments[0].hasFinancialException).toBe(true);
    expect(
      await db.paymentGatewayEvent.count({
        where: { paymentId: a.id, disposition: 'FINANCIAL_EXCEPTION' },
      }),
    ).toBe(1);
    await finalize(a, proof);
    await scheduler.runOnce();
    expect(await snapshot(f)).toEqual(state);
  });

  it('processes later batches and repeated instances while preserving Grace and fresh Orders', async () => {
    const grace = await fixture(),
      expired = await fixture(),
      fresh = await fixture();
    await attempt(grace);
    await attempt(expired);
    await setExpiry(grace, -60_000);
    await setExpiry(expired, -300_000);
    const graceBefore = await snapshot(grace),
      freshBefore = await snapshot(fresh);
    const other = new OrderExpirationService(db, {
      enabled: false,
      batchSize: 1,
    });
    try {
      await Promise.all([scheduler.runOnce(), other.runOnce()]);
      const cancelled = await assertCancelled(expired);
      await Promise.all([scheduler.runOnce(), other.runOnce()]);
      expect(await snapshot(expired)).toEqual(cancelled);
      expect(await snapshot(grace)).toEqual(graceBefore);
      expect(await snapshot(fresh)).toEqual(freshBefore);
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('rolls back cancellation and stock release if coupon release fails in either cleanup path', async () => {
    const f = await fixture();
    await attempt(f);
    await setExpiry(f, -300_000);
    await db.coupon.update({
      where: { id: f.couponId },
      data: { activeUsageCount: 0 },
    });
    const before = await snapshot(f);
    await scheduler.runOnce();
    expect(await snapshot(f)).toEqual(before);
    await create(f).expect(500);
    expect(await snapshot(f)).toEqual(before);
    expect(await db.order.count({ where: { userId: f.userId } })).toBe(1);
    await db.coupon.update({
      where: { id: f.couponId },
      data: { activeUsageCount: 1 },
    });
    await scheduler.runOnce();
    await assertCancelled(f);
  });

  it.each(['IPN', 'QUERYDR'] as const)(
    'serializes Scheduler cancellation before late %s finalization at G',
    async (source) => {
      const f = await fixture(),
        a = await attempt(f);
      await setExpiry(f, -300_000);
      const proof = await evidence(f, a, { source });
      const held = holdNextCommit();
      const sweep = scheduler.runOnce();
      let result: ReturnType<typeof finalize> | undefined;
      try {
        const pid = await Promise.race([
          held.ready,
          sweep.then(() => {
            throw new Error('Scheduler never reached COMMIT barrier');
          }),
        ]);
        result = finalize(a, proof);
        void result.catch(() => undefined);
        await waitForBlockedBy(pid);
      } finally {
        held.release();
        await Promise.allSettled([sweep, ...(result ? [result] : [])]);
        held.restore();
      }
      expect((await result)!.disposition).toBe('FINANCIAL_EXCEPTION');
      await assertCancelled(f);
    },
  );

  it.each(['IPN', 'QUERYDR'] as const)(
    'rechecks after %s finalization cancels at G before the Scheduler commits',
    async (source) => {
      const f = await fixture(),
        a = await attempt(f);
      await setExpiry(f, -300_000);
      const proof = await evidence(f, a, { source });
      const held = holdNextCommit();
      const payment = finalize(a, proof);
      void payment.catch(() => undefined);
      let sweep: Promise<void> | undefined;
      try {
        const pid = await Promise.race([
          held.ready,
          payment.then(() => {
            throw new Error('Finalization never reached COMMIT barrier');
          }),
        ]);
        sweep = scheduler.runOnce();
        await waitForBlockedBy(pid);
      } finally {
        held.release();
        await Promise.allSettled([payment, ...(sweep ? [sweep] : [])]);
        held.restore();
      }
      expect((await payment).disposition).toBe('FINANCIAL_EXCEPTION');
      await assertCancelled(f);
    },
  );

  it('handles concurrent IPN, QueryDR and Scheduler inside Grace with one accepted SUCCESS', async () => {
    const f = await fixture(),
      a = await attempt(f);
    await setExpiry(f, -60_000);
    const ipn = await evidence(f, a),
      query = await evidence(f, a, { source: 'QUERYDR' });
    const held = holdNextCommit();
    const first = finalize(a, ipn);
    void first.catch(() => undefined);
    let second: ReturnType<typeof finalize> | undefined;
    try {
      const pid = await Promise.race([
        held.ready,
        first.then(() => {
          throw new Error('IPN never reached COMMIT barrier');
        }),
      ]);
      second = finalize(a, query);
      void second.catch(() => undefined);
      await scheduler.runOnce();
      await waitForBlockedBy(pid);
    } finally {
      held.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      held.restore();
    }
    expect((await first).disposition).toBe('FINALIZED');
    expect((await second)!.disposition).toBe('DUPLICATE');
    const state = await snapshot(f);
    expect(state.order.status).toBe('PAID');
    expect(state.product.stock).toBe(3);
    expect(state.order.couponRedemption?.status).toBe('CONSUMED');
    expect(state.coupon.activeUsageCount).toBe(1);
    expect(state.user.loyaltyPoints).toBe(9);
    expect(
      state.order.payments.filter((p) => p.status === 'SUCCESS'),
    ).toHaveLength(1);
  });

  it.each(['Scheduler', 'POST /orders'] as const)(
    'coordinates replacement with %s winning the expired Order lock',
    async (first) => {
      const f = await fixture();
      await attempt(f);
      await setExpiry(f, -300_000);
      const held = holdNextCommit();
      const createOrder = () => create(f).then((r) => r);
      const initial =
        first === 'Scheduler' ? scheduler.runOnce() : createOrder();
      let sweep: Promise<void> | undefined,
        replacement: Promise<request.Response> | undefined;
      try {
        const pid = await Promise.race([
          held.ready,
          initial.then(() => {
            throw new Error('Cleanup never reached COMMIT barrier');
          }),
        ]);
        if (first === 'Scheduler') replacement = createOrder();
        else sweep = scheduler.runOnce();
        await waitForBlockedBy(pid);
      } finally {
        held.release();
        await Promise.allSettled([
          initial,
          ...(sweep ? [sweep] : []),
          ...(replacement ? [replacement] : []),
        ]);
        held.restore();
      }
      const response =
        first === 'Scheduler'
          ? await replacement!
          : ((await initial) as request.Response);
      expect(response.status).toBe(201);
      expect(
        (await db.order.findUniqueOrThrow({ where: { id: f.orderId } })).status,
      ).toBe('CANCELLED');
      const state = await snapshot({
        ...f,
        orderId: response.body.id as string,
      });
      expect(state.product.stock).toBe(3);
      expect(state.coupon.activeUsageCount).toBe(1);
      expect(state.order.couponRedemption?.status).toBe('HELD');
      expect(
        await db.order.count({
          where: {
            userId: f.userId,
            status: { in: ['PENDING', 'PAYMENT_FAILED'] },
          },
        }),
      ).toBe(1);
    },
  );
});
