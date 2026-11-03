import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { ORDER_EXPIRATION_OPTIONS } from '../src/orders/order-expiration.config.js';
import { OrderExpirationService } from '../src/orders/order-expiration.service.js';
import { MockPaymentService } from '../src/payments/mock-payment.service.js';
import { PaymentFinalizationService } from '../src/payments/payment-finalization.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type Fixture = {
  userId: string;
  token: string;
  productId: string;
  couponId: string | null;
  orderId: string;
};
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('SCRUM-84 ZERO_AMOUNT endpoint on PostgreSQL', () => {
  let app: INestApplication<App> | undefined;
  let db: PrismaService;
  let jwt: JwtService;
  let scheduler: OrderExpirationService;
  const categoryId = randomUUID();
  const users: string[] = [],
    products: string[] = [],
    coupons: string[] = [];
  const internalKey = 'scrum84-test-only-internal-key';
  const configureProviders = () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'false');
    vi.stubEnv('VNPAY_TMN_CODE', 'SCRUM84TEST');
    vi.stubEnv('VNPAY_HASH_SECRET', 'scrum84-test-only-hmac-secret');
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );
    vi.stubEnv('VNPAY_RETURN_URL', 'https://merchant.example/return');
  };
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
        'This suite requires the dedicated localhost:5433/brewlite_test database.',
      );
    vi.stubEnv('DATABASE_URL', value);
    vi.stubEnv('INTERNAL_SECRET', internalKey);
    configureProviders();
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
    const [identity] = await db.$queryRaw<
      { database: string }[]
    >`SELECT current_database() AS database`;
    expect(identity.database).toBe('brewlite_test');
    await db.category.create({
      data: { id: categoryId, code: categoryId, name: 'SCRUM-84 test' },
    });
  });
  beforeEach(configureProviders);
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

  async function fixture(
    options: { coupon?: boolean; positive?: boolean; owner?: string } = {},
  ): Promise<Fixture> {
    const userId = options.owner ?? randomUUID(),
      productId = randomUUID();
    if (!options.owner) {
      users.push(userId);
      await db.user.create({
        data: {
          id: userId,
          email: `${userId}@scrum84.test`,
          passwordHash: 'test-only-unused',
          loyaltyPoints: 7,
        },
      });
    }
    products.push(productId);
    const useCoupon = options.coupon !== false;
    await db.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Zero payment test',
        imageUrl: '/test',
        basePriceVnd: useCoupon || options.positive ? 50000n : 0n,
        stock: 5,
      },
    });
    const couponId = useCoupon ? randomUUID() : null;
    let couponCode: string | undefined;
    if (couponId) {
      coupons.push(couponId);
      couponCode = couponId.replaceAll('-', '').slice(0, 20).toUpperCase();
      await db.coupon.create({
        data: {
          id: couponId,
          code: couponCode,
          type: 'FIXED',
          value: options.positive ? 10000 : 100000,
          startsAt: new Date(0),
          expiresAt: new Date('2099-01-01'),
          usageLimit: 1,
          perUserLimit: 1,
        },
      });
    }
    const token = jwt.sign({ sub: userId });
    const result = await request(app!.getHttpServer())
      .post('/orders')
      .auth(token, { type: 'bearer' })
      .send({
        ...(couponCode ? { couponCode } : {}),
        items: [{ productId, size: 'S', quantity: 2, toppingIds: [] }],
      })
      .expect(201);
    expect(result.body.totalVnd).toBe(
      options.positive ? (useCoupon ? 90000 : 100000) : 0,
    );
    return {
      userId,
      token,
      productId,
      couponId,
      orderId: result.body.id as string,
    };
  }
  const complete = (
    f: Fixture,
    key: string = randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    request(app!.getHttpServer())
      .post('/payments/zero-amount')
      .auth(f.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({ ...extra, orderId: f.orderId });
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
      f.couponId
        ? db.coupon.findUniqueOrThrow({ where: { id: f.couponId } })
        : null,
      db.user.findUniqueOrThrow({ where: { id: f.userId } }),
    ]);
    return { order, product, coupon, user };
  }
  async function assertPaid(f: Fixture) {
    const state = await snapshot(f);
    expect(state.order.status).toBe('PAID');
    expect(state.order.pointsEarned).toBe(0);
    expect(state.product.stock).toBe(3);
    expect(state.user.loyaltyPoints).toBe(7);
    expect(
      state.order.payments.filter((p) => p.status === 'SUCCESS'),
    ).toHaveLength(1);
    expect(
      state.order.payments.find((p) => p.status === 'SUCCESS'),
    ).toMatchObject({
      provider: 'ZERO_AMOUNT',
      amountVnd: 0n,
      method: null,
      methodLast4: null,
      mockReference: null,
    });
    if (f.couponId) {
      expect(state.order.couponRedemption?.status).toBe('CONSUMED');
      expect(state.coupon?.activeUsageCount).toBe(1);
    } else expect(state.order.couponRedemption).toBeNull();
    return state;
  }
  const expire = (f: Fixture, offsetMs = 0) => db.$executeRaw`
    UPDATE orders SET expires_at = clock_timestamp() + (${offsetMs} * INTERVAL '1 millisecond') WHERE id = ${f.orderId}::uuid`;

  async function addUnresolvedVnpay(f: Fixture, review: boolean) {
    // Adversarial/legacy persisted state: even a zero Order must not bypass an
    // existing unresolved positive-VND gateway attempt or financial exception.
    const [clock] = await db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return db.payment.create({
      data: {
        orderId: f.orderId,
        userId: f.userId,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        provider: 'VNPAY',
        status: 'PENDING',
        amountVnd: 1n,
        createdAt: clock.now,
        vnpTxnRef: randomUUID().replaceAll('-', ''),
        vnpTmnCode: 'SCRUM84TEST',
        vnpCreateDate: '20261103000000',
        gatewayExpiresAt: new Date(clock.now.getTime() + 900_000),
        initiationSnapshot: { test: true },
        reconcileUntil: new Date(clock.now.getTime() + 3900_000),
        reconciliationState: review ? 'REQUIRES_REVIEW' : 'SCHEDULED',
        nextQueryAt: review ? null : clock.now,
        reviewReason: review ? 'TEST_FINANCIAL_EXCEPTION' : null,
        hasFinancialException: review,
      },
    });
  }
  function holdNextCommit() {
    const ready = gate<number>(),
      release = gate<void>();
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
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`;
          return row.waiting;
        },
        { timeout: 1000, interval: 10 },
      )
      .toBe(true);
  }

  it.each([true, false])(
    'settles a real zero Order with coupon=%s without Mock, gateway, redirect or extra inventory reservation',
    async (coupon) => {
      const f = await fixture({ coupon });
      const initial = await snapshot(f);
      const mock = vi.spyOn(app!.get(MockPaymentService), 'evaluate');
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('ZERO_AMOUNT must not call a gateway'));
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('MOCK_PAYMENT_ENABLED', 'false');
      vi.stubEnv('VNPAY_HASH_SECRET', undefined);
      vi.stubEnv('VNPAY_PAYMENT_URL', undefined);
      const result = await complete(f)
        .expect(201)
        .expect('Idempotency-Replayed', 'false');
      expect(result.body).toEqual({
        paymentId: expect.any(String),
        orderId: f.orderId,
        provider: 'ZERO_AMOUNT',
        paymentStatus: 'SUCCESS',
        orderStatus: 'PAID',
        amountVnd: 0,
        pointsEarned: 0,
        createdAt: expect.any(String),
      });
      expect(result.headers.location).toBeUndefined();
      expect(result.body).not.toHaveProperty('paymentUrl');
      expect(mock).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      const paid = await assertPaid(f);
      expect(paid.order.expiresAt).toEqual(initial.order.expiresAt);
      expect(paid.order.payments[0].responseSnapshot).toEqual(result.body);
    },
  );

  it('replays the original response after expiry and fulfillment without repeating side effects', async () => {
    const f = await fixture(),
      key = randomUUID();
    const first = await complete(f, key).expect(201);
    for (const from of ['PAID', 'PREPARING', 'READY'])
      await request(app!.getHttpServer())
        .post(`/internal/orders/${f.orderId}/advance`)
        .set('X-Internal-Key', internalKey)
        .send({ from })
        .expect(200);
    await expire(f);
    const before = await snapshot(f);
    expect(before.order.status).toBe('COMPLETED');
    await complete(f, key, { amountVnd: 50000, userId: 'attacker' })
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(first.body);
    await scheduler.runOnce();
    expect(await snapshot(f)).toEqual(before);
  });

  it('canonicalizes uppercase JWT/Order UUIDs for replay', async () => {
    const f = await fixture(),
      key = randomUUID();
    const first = await complete(f, key).expect(201);
    await complete(
      {
        ...f,
        orderId: f.orderId.toUpperCase(),
        token: jwt.sign({ sub: f.userId.toUpperCase() }),
      },
      key,
    )
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(first.body);
    await assertPaid(f);
  });

  it('uses persisted amount and rejects a forged zero amount for a positive Order', async () => {
    const f = await fixture({ positive: true });
    const before = await snapshot(f);
    await complete(f, randomUUID(), {
      amountVnd: 0,
      totalVnd: 0,
      provider: 'ZERO_AMOUNT',
    })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ORDER_NOT_ZERO_AMOUNT'));
    expect(await snapshot(f)).toEqual(before);
  });

  it('hides foreign/missing Orders before revealing replay or key state', async () => {
    const owner = await fixture(),
      other = await fixture(),
      key = randomUUID();
    await complete(owner, key).expect(201);
    const before = await snapshot(owner);
    const foreign = await complete(
      { ...owner, token: other.token },
      key,
    ).expect(404);
    const missing = await complete(
      { ...other, orderId: randomUUID() },
      key,
    ).expect(404);
    expect(foreign.body).toEqual(missing.body);
    expect(foreign.body.code).toBe('NOT_FOUND');
    expect(await snapshot(owner)).toEqual(before);
  });

  it.each([undefined, 'short', 'x'.repeat(65)])(
    'rejects an absent/invalid key without creating a Payment (%s)',
    async (key) => {
      const f = await fixture();
      const call = request(app!.getHttpServer())
        .post('/payments/zero-amount')
        .auth(f.token, { type: 'bearer' })
        .send({ orderId: f.orderId });
      if (key !== undefined) call.set('Idempotency-Key', key);
      const before = await snapshot(f);
      await call
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('VALIDATION_ERROR'));
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('rejects at/after E before the Scheduler runs, with no Grace for a new ZERO_AMOUNT', async () => {
    const f = await fixture();
    await expire(f);
    const before = await snapshot(f);
    await complete(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ORDER_EXPIRED'));
    expect(await snapshot(f)).toEqual(before);
    await scheduler.runOnce();
    const cancelled = await snapshot(f);
    expect(cancelled.order.status).toBe('CANCELLED');
    expect(cancelled.product.stock).toBe(5);
    expect(cancelled.coupon?.activeUsageCount).toBe(0);
    expect(cancelled.order.couponRedemption?.status).toBe('RELEASED');
    expect(cancelled.order.payments).toHaveLength(0);
  });

  it.each(['PAID', 'CANCELLED'] as const)(
    'rejects a new key for an ineligible %s Order',
    async (status) => {
      const f = await fixture();
      if (status === 'PAID') await complete(f).expect(201);
      else {
        await expire(f);
        await scheduler.runOnce();
      }
      const before = await snapshot(f);
      await complete(f)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('INVALID_TRANSITION'));
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it.each([false, true])(
    'blocks an unresolved gateway attempt (financial review=%s)',
    async (review) => {
      const f = await fixture();
      await addUnresolvedVnpay(f, review);
      const before = await snapshot(f);
      await complete(f)
        .expect(409)
        .expect((r) =>
          expect(r.body.code).toBe(
            review
              ? 'FINANCIAL_EXCEPTION_REQUIRES_REVIEW'
              : 'PAYMENT_IN_PROGRESS',
          ),
        );
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('rejects reuse of a key for a different owned Order', async () => {
    const first = await fixture(),
      key = randomUUID();
    await complete(first, key).expect(201);
    const next = await fixture({ owner: first.userId }),
      before = await snapshot(next);
    await complete(next, key)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
    expect(await snapshot(next)).toEqual(before);
  });

  it.each(['MOCK', 'VNPAY'] as const)(
    'shares the key namespace with an earlier %s operation',
    async (provider) => {
      const prior = await fixture({ positive: true }),
        key = randomUUID();
      if (provider === 'MOCK') {
        vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
        await request(app!.getHttpServer())
          .post('/payments')
          .auth(prior.token, { type: 'bearer' })
          .set('Idempotency-Key', key)
          .send({
            orderId: prior.orderId,
            method: 'CARD',
            paymentDetails: { cardNumber: '1234567890121234' },
          })
          .expect(200);
      } else {
        await request(app!.getHttpServer())
          .post('/payments/vnpay/initiate')
          .auth(prior.token, { type: 'bearer' })
          .set('Idempotency-Key', key)
          .send({ orderId: prior.orderId })
          .expect(201);
        await expire(prior, -360_000);
        await scheduler.runOnce();
      }
      const next = await fixture({ owner: prior.userId }),
        before = await snapshot(next);
      await complete(next, key)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
      expect(await snapshot(next)).toEqual(before);
    },
  );

  it('allows two Customers to use the same key independently', async () => {
    const first = await fixture(),
      second = await fixture(),
      key = randomUUID();
    await Promise.all([
      complete(first, key).expect(201),
      complete(second, key).expect(201),
    ]);
    await assertPaid(first);
    await assertPaid(second);
  });

  it('settles a Phase 1 zero Order with a legacy FAILED Mock attempt and preserves that attempt', async () => {
    const f = await fixture(),
      id = randomUUID();
    await db.payment.create({
      data: {
        id,
        userId: f.userId,
        orderId: f.orderId,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID(),
        provider: 'MOCK',
        status: 'FAILED',
        method: 'CARD',
        methodLast4: '0002',
        mockReference: `MOCK-${id}`,
        amountVnd: 0n,
        responseSnapshot: {
          paymentId: id,
          orderId: f.orderId,
          paymentStatus: 'FAILED',
          orderStatus: 'PAYMENT_FAILED',
          amountVnd: 0,
          method: 'CARD',
          methodLast4: '0002',
          mockReference: `MOCK-${id}`,
          pointsEarned: 0,
          failureReason: 'PAYMENT_DECLINED',
          createdAt: new Date().toISOString(),
        },
      },
    });
    await db.order.update({
      where: { id: f.orderId },
      data: { status: 'PAYMENT_FAILED' },
    });
    const legacy = await db.payment.findUniqueOrThrow({ where: { id } });
    await complete(f).expect(201);
    await assertPaid(f);
    expect(await db.payment.findUniqueOrThrow({ where: { id } })).toEqual(
      legacy,
    );
  });

  it('rolls back Payment, Order and consumed coupon after a post-finalization failure, then safely retries', async () => {
    const f = await fixture(),
      key = randomUUID(),
      before = await snapshot(f);
    const service = app!.get(PaymentFinalizationService),
      original = service.finalizeInTransaction.bind(service);
    const fault = vi
      .spyOn(service, 'finalizeInTransaction')
      .mockImplementationOnce(async (tx, command) => {
        await original(tx, command);
        throw new Error('Test-only failure after Payment and Coupon writes');
      });
    const failed = await complete(f, key).expect(500);
    expect(failed.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(await snapshot(f)).toEqual(before);
    fault.mockRestore();
    await complete(f, key).expect(201);
    await assertPaid(f);
  });

  it('bounds a concurrent same-key request and replays after its winner commits', async () => {
    const f = await fixture(),
      key = randomUUID(),
      held = holdNextCommit();
    const first = complete(f, key).then((r) => r);
    try {
      await Promise.race([
        held.ready,
        first.then(() => {
          throw new Error('Completion did not reach COMMIT barrier');
        }),
      ]);
      await complete(f, key)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('PAYMENT_IN_PROGRESS'));
      expect(await db.payment.count({ where: { orderId: f.orderId } })).toBe(0);
    } finally {
      held.release();
      await Promise.allSettled([first]);
      held.restore();
    }
    const winner = await first;
    expect(winner.status).toBe(201);
    await complete(f, key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(winner.body);
    await assertPaid(f);
  });

  it('serializes different keys on the same Order with one SUCCESS and one coupon consumption', async () => {
    const f = await fixture(),
      held = holdNextCommit();
    const first = complete(f).then((r) => r);
    let second: Promise<request.Response> | undefined;
    try {
      const pid = await Promise.race([
        held.ready,
        first.then(() => {
          throw new Error('Completion did not reach COMMIT barrier');
        }),
      ]);
      second = complete(f).then((r) => r);
      await waitForBlockedBy(pid);
    } finally {
      held.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      held.restore();
    }
    expect((await first).status).toBe(201);
    expect((await second)!.status).toBe(409);
    expect((await second)!.body.code).toBe('INVALID_TRANSITION');
    await assertPaid(f);
  });

  it('maps a real PostgreSQL Order lock timeout to PAYMENT_IN_PROGRESS, then allows a safe retry', async () => {
    const f = await fixture(),
      before = await snapshot(f);
    const ready = gate<void>(),
      release = gate<void>();
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${f.orderId}::uuid FOR UPDATE`;
      ready.resolve();
      await release.promise;
    });
    try {
      await Promise.race([
        ready.promise,
        holder.then(() => {
          throw new Error('Order lock holder ended too soon');
        }),
      ]);
      await complete(f)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('PAYMENT_IN_PROGRESS'));
      expect(await snapshot(f)).toEqual(before);
    } finally {
      release.resolve();
      await holder;
    }
    await complete(f).expect(201);
    await assertPaid(f);
  });

  it('rejects a completion waiting behind actual Scheduler cancellation', async () => {
    const f = await fixture();
    await expire(f);
    const held = holdNextCommit(),
      sweep = scheduler.runOnce();
    let payment: Promise<request.Response> | undefined;
    try {
      const pid = await Promise.race([
        held.ready,
        sweep.then(() => {
          throw new Error('Scheduler did not reach COMMIT barrier');
        }),
      ]);
      payment = complete(f).then((r) => r);
      await waitForBlockedBy(pid);
    } finally {
      held.release();
      await Promise.allSettled([sweep, ...(payment ? [payment] : [])]);
      held.restore();
    }
    expect((await payment)!.status).toBe(409);
    expect((await payment)!.body.code).toBe('INVALID_TRANSITION');
    const state = await snapshot(f);
    expect(state.order.status).toBe('CANCELLED');
    expect(state.order.payments).toHaveLength(0);
    expect(state.product.stock).toBe(5);
    expect(state.coupon?.activeUsageCount).toBe(0);
    expect(state.order.couponRedemption?.status).toBe('RELEASED');
    expect(state.user.loyaltyPoints).toBe(7);
  });

  it('preserves a completion admitted before E when the Scheduler waits for its commit after E', async () => {
    const f = await fixture();
    await expire(f, 2000);
    const held = holdNextCommit(),
      payment = complete(f).then((r) => r);
    let sweep: Promise<void> | undefined;
    try {
      const pid = await Promise.race([
        held.ready,
        payment.then(() => {
          throw new Error('Completion did not reach COMMIT barrier');
        }),
      ]);
      await expect
        .poll(
          async () => {
            const [clock] = await db.$queryRaw<
              { expired: boolean }[]
            >`SELECT clock_timestamp() >= expires_at AS expired FROM orders WHERE id = ${f.orderId}::uuid`;
            return clock.expired;
          },
          { timeout: 3000, interval: 20 },
        )
        .toBe(true);
      sweep = scheduler.runOnce();
      await waitForBlockedBy(pid);
    } finally {
      held.release();
      await Promise.allSettled([payment, ...(sweep ? [sweep] : [])]);
      held.restore();
    }
    expect((await payment).status).toBe(201);
    await assertPaid(f);
    const before = await snapshot(f);
    await scheduler.runOnce();
    expect(await snapshot(f)).toEqual(before);
  });
});
