import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { ORDER_EXPIRATION_OPTIONS } from '../src/orders/order-expiration.config.js';
import { OrderExpirationService } from '../src/orders/order-expiration.service.js';
import { PaymentFinalizationService } from '../src/payments/payment-finalization.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type Fixture = {
  userId: string;
  token: string;
  productId: string;
  couponId: string;
  couponCode: string;
  orderId: string;
};
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('SCRUM-59 real Order–Payment–Scheduler lifecycle', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let jwt: JwtService;
  let scheduler: OrderExpirationService;
  const categoryId = randomUUID();
  const users: string[] = [];
  const products: string[] = [];
  const coupons: string[] = [];
  const internalKey = 'scrum59-test-only-internal-key';

  async function makeApp(enabled = false) {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ORDER_EXPIRATION_OPTIONS)
      .useValue({ enabled, batchSize: 1 })
      .compile();
    const instance = module.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    await instance.init();
    return instance;
  }
  beforeAll(async () => {
    const url = process.env.ORDERS_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.',
      );
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    vi.stubEnv('INTERNAL_SECRET', internalKey);
    app = await makeApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    scheduler = app.get(OrderExpirationService);
    await prisma.category.create({
      data: {
        id: categoryId,
        code: categoryId,
        name: 'SCRUM-59 lifecycle test',
      },
    });
  });
  async function cleanup() {
    if (!prisma) return;
    const where = { userId: { in: users } };
    await prisma.payment.deleteMany({ where });
    await prisma.couponRedemption.deleteMany({ where });
    await prisma.orderItemTopping.deleteMany({
      where: { orderItem: { order: where } },
    });
    await prisma.orderItem.deleteMany({ where: { order: where } });
    await prisma.order.deleteMany({ where });
    await prisma.coupon.deleteMany({ where: { id: { in: coupons } } });
    await prisma.product.deleteMany({ where: { id: { in: products } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    users.length = products.length = coupons.length = 0;
  }
  beforeEach(cleanup);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  afterAll(async () => {
    try {
      await cleanup();
      if (prisma)
        await prisma.category.deleteMany({ where: { id: categoryId } });
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
  const pay = (f: Fixture, key = randomUUID(), success = true) =>
    request(app!.getHttpServer())
      .post('/payments')
      .auth(f.token, { type: 'bearer' })
      .set('Idempotency-Key', key)
      .send({
        orderId: f.orderId,
        method: 'CARD',
        paymentDetails: {
          cardNumber: success ? '1234567890121234' : '1234567890120002',
        },
      });
  const advance = (f: Fixture, from: string) =>
    request(app!.getHttpServer())
      .post(`/internal/orders/${f.orderId}/advance`)
      .set('X-Internal-Key', internalKey)
      .send({ from });
  async function fixture(zeroTotal = false): Promise<Fixture> {
    const userId = randomUUID();
    const productId = randomUUID();
    const couponId = randomUUID();
    users.push(userId);
    products.push(productId);
    coupons.push(couponId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@lifecycle.test`,
        passwordHash: 'test-only-unused',
      },
    });
    await prisma.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Lifecycle test',
        imageUrl: '/test',
        basePriceVnd: 50000n,
        stock: 5,
      },
    });
    const couponCode = couponId.replaceAll('-', '').slice(0, 20).toUpperCase();
    await prisma.coupon.create({
      data: {
        id: couponId,
        code: couponCode,
        type: 'FIXED',
        value: zeroTotal ? 100000 : 10000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 1,
        perUserLimit: 1,
      },
    });
    const partial = {
      userId,
      productId,
      couponId,
      couponCode,
      token: jwt.sign({ sub: userId }),
    };
    const { body } = await create(partial).expect(201);
    return { ...partial, orderId: body.id as string };
  }
  const markExpired = (id: string) => prisma.$executeRaw`
    UPDATE orders SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = ${id}::uuid`;
  const getOrder = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });
  async function snapshot(f: Fixture) {
    return {
      order: await prisma.order.findUniqueOrThrow({
        where: { id: f.orderId },
        include: { items: true, payments: true, couponRedemption: true },
      }),
      product: await prisma.product.findUniqueOrThrow({
        where: { id: f.productId },
      }),
      coupon: await prisma.coupon.findUniqueOrThrow({
        where: { id: f.couponId },
      }),
      user: await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }),
    };
  }
  async function waitForLock(pattern: string) {
    await expect
      .poll(
        async () => {
          const [row] = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE ${pattern}) AS waiting`;
          return row.waiting;
        },
        { timeout: 1000, interval: 10 },
      )
      .toBe(true);
  }

  // The callback and PostgreSQL transaction are real; the barrier only delays
  // COMMIT so the other actual service must wait for the same Order row lock.
  function holdNextCommit() {
    const ready = barrier();
    const release = barrier();
    const original = prisma.$transaction.bind(prisma);
    const held = async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ) =>
      original(async (tx) => {
        const result = await work(tx);
        ready.resolve();
        await release.promise;
        return result;
      }, options);
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(held as PrismaService['$transaction']);
    return { ready, release, restore: () => spy.mockRestore() };
  }

  it('runs Create → Payment SUCCESS → fulfillment → history and replays without double effects', async () => {
    const f = await fixture();
    const initial = await getOrder(f.orderId);
    expect(initial.status).toBe('PENDING');
    expect(initial.expiresAt.getTime() - initial.createdAt.getTime()).toBe(
      900_000,
    );
    const key = randomUUID();
    const success = await pay(f, key).expect(200);
    expect(success.body).toMatchObject({
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 9,
    });
    for (const [from, status] of [
      ['PAID', 'PREPARING'],
      ['PREPARING', 'READY'],
      ['READY', 'COMPLETED'],
    ]) {
      expect((await advance(f, from).expect(200)).body.status).toBe(status);
    }
    await markExpired(f.orderId);
    const before = await snapshot(f);
    await scheduler.runOnce();
    const replay = await pay(f, key).expect(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(success.body);
    expect(await snapshot(f)).toEqual(before);
    expect(before.product.stock).toBe(3);
    expect(before.coupon.activeUsageCount).toBe(1);
    expect(before.order.couponRedemption?.status).toBe('CONSUMED');
    expect(before.user.loyaltyPoints).toBe(9);
    const history = await request(app!.getHttpServer())
      .get('/orders/me')
      .auth(f.token, { type: 'bearer' })
      .expect(200);
    expect(history.body.items[0]).toMatchObject({
      id: f.orderId,
      status: 'COMPLETED',
      pointsEarned: 9,
      payment: { status: 'SUCCESS' },
    });
    await advance(f, 'COMPLETED').expect(409);
  });

  it('keeps stock, coupon and expiry on FAILED, then awards once on retry SUCCESS', async () => {
    const f = await fixture();
    const failedKey = randomUUID();
    const initial = await getOrder(f.orderId);
    const failed = await pay(f, failedKey, false).expect(200);
    const failedState = await snapshot(f);
    expect(failedState.order.status).toBe('PAYMENT_FAILED');
    expect(failedState.order.expiresAt).toEqual(initial.expiresAt);
    expect(failedState.product.stock).toBe(3);
    expect(failedState.order.couponRedemption?.status).toBe('HELD');
    expect(failedState.user.loyaltyPoints).toBe(0);
    await scheduler.runOnce();
    expect(await snapshot(f)).toEqual(failedState);
    await pay(f).expect(200);
    const paid = await snapshot(f);
    expect(paid.order.expiresAt).toEqual(initial.expiresAt);
    expect(paid.product.stock).toBe(3);
    expect(paid.user.loyaltyPoints).toBe(9);
    expect(paid.order.payments).toHaveLength(2);
    expect((await pay(f, failedKey, false).expect(200)).body).toEqual(
      failed.body,
    );
    expect(await snapshot(f)).toEqual(paid);
  });

  it('expires FAILED, restores resources once, allows old replay but rejects new payment', async () => {
    const f = await fixture();
    const key = randomUUID();
    const failed = await pay(f, key, false).expect(200);
    await markExpired(f.orderId);
    await scheduler.runOnce();
    const cancelled = await snapshot(f);
    expect(cancelled.order.status).toBe('CANCELLED');
    expect(cancelled.order.cancelledAt).toBeInstanceOf(Date);
    expect(cancelled.product.stock).toBe(5);
    expect(cancelled.coupon.activeUsageCount).toBe(0);
    expect(cancelled.order.couponRedemption?.status).toBe('RELEASED');
    expect(cancelled.user.loyaltyPoints).toBe(0);
    await scheduler.runOnce();
    expect((await pay(f, key, false).expect(200)).body).toEqual(failed.body);
    expect((await pay(f).expect(409)).body.code).toBe('INVALID_TRANSITION');
    await advance(f, 'CANCELLED').expect(409);
    expect(await snapshot(f)).toEqual(cancelled);
  });

  it('rejects expired payment before the scheduler has swept the pending order', async () => {
    const f = await fixture();
    await markExpired(f.orderId);
    const before = await snapshot(f);
    expect((await pay(f).expect(409)).body.code).toBe('INVALID_TRANSITION');
    expect(await snapshot(f)).toEqual(before);
    await scheduler.runOnce();
    expect((await getOrder(f.orderId)).status).toBe('CANCELLED');
    expect(await prisma.payment.count({ where: { orderId: f.orderId } })).toBe(
      0,
    );
  });

  it('runs ZERO_AMOUNT through Shared Finalization service integration without an API endpoint', async () => {
    const f = await fixture(true);
    const beforeMock = await snapshot(f);
    const rejected = await pay(f).expect(409);
    expect(rejected.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'INVALID_TRANSITION',
      message: 'Order cannot accept a new payment',
    });
    expect(await snapshot(f)).toEqual(beforeMock);

    const finalization = app!.get(PaymentFinalizationService);
    const command = {
      provider: 'ZERO_AMOUNT' as const,
      userId: f.userId,
      orderId: f.orderId,
      paymentId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256')
        .update(JSON.stringify({ orderId: f.orderId }))
        .digest('hex'),
    };
    const finalized = await prisma.$transaction((tx) =>
      finalization.finalizeInTransaction(tx, command),
    );
    expect(finalized.disposition).toBe('FINALIZED');
    expect(finalized.zeroAmountResponse).toMatchObject({
      paymentId: command.paymentId,
      orderId: f.orderId,
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      amountVnd: 0,
      pointsEarned: 0,
    });

    const paid = await snapshot(f);
    expect(paid.order.status).toBe('PAID');
    expect(paid.order.pointsEarned).toBe(0);
    expect(paid.order.payments).toHaveLength(1);
    expect(paid.order.payments[0]).toMatchObject({
      provider: 'ZERO_AMOUNT',
      status: 'SUCCESS',
      amountVnd: 0n,
      method: null,
    });
    expect(paid.order.couponRedemption?.status).toBe('CONSUMED');
    expect(paid.coupon.activeUsageCount).toBe(1);
    expect(paid.product.stock).toBe(3);
    expect(paid.user.loyaltyPoints).toBe(0);

    const duplicate = await prisma.$transaction((tx) =>
      finalization.finalizeInTransaction(tx, {
        ...command,
        paymentId: randomUUID(),
      }),
    );
    expect(duplicate.disposition).toBe('DUPLICATE');
    expect(duplicate.paymentId).toBe(command.paymentId);
    expect(duplicate.zeroAmountResponse).toEqual(finalized.zeroAmountResponse);
    expect(await snapshot(f)).toEqual(paid);

    for (const [from, status] of [
      ['PAID', 'PREPARING'],
      ['PREPARING', 'READY'],
      ['READY', 'COMPLETED'],
    ]) {
      expect((await advance(f, from).expect(200)).body.status).toBe(status);
    }
    const completed = await snapshot(f);
    expect(completed.order.status).toBe('COMPLETED');
    expect(completed.order.pointsEarned).toBe(0);
    expect(completed.order.payments[0]).toMatchObject({
      provider: 'ZERO_AMOUNT',
      status: 'SUCCESS',
      amountVnd: 0n,
      method: null,
    });
    expect(completed.order.couponRedemption?.status).toBe('CONSUMED');
    expect(completed.coupon.activeUsageCount).toBe(1);
    expect(completed.product.stock).toBe(3);
    expect(completed.user.loyaltyPoints).toBe(0);
  });

  it.each(['PREPARING', 'READY'] as const)(
    'preserves expired %s Order, stock, coupon and points across Scheduler sweeps',
    async (status) => {
      const f = await fixture();
      await pay(f).expect(200);
      expect((await advance(f, 'PAID').expect(200)).body.status).toBe(
        'PREPARING',
      );
      if (status === 'READY') {
        expect((await advance(f, 'PREPARING').expect(200)).body.status).toBe(
          'READY',
        );
      }
      await markExpired(f.orderId);
      const [clock] = await prisma.$queryRaw<{ expired: boolean }[]>`
        SELECT expires_at <= clock_timestamp() AS expired
        FROM orders WHERE id = ${f.orderId}::uuid`;
      expect(clock.expired).toBe(true);

      const before = await snapshot(f);
      expect(before.order.status).toBe(status);
      expect(before.order.cancelledAt).toBeNull();
      expect(before.product.stock).toBe(3);
      expect(before.coupon.activeUsageCount).toBe(1);
      expect(before.order.couponRedemption?.status).toBe('CONSUMED');
      expect(before.user.loyaltyPoints).toBe(9);
      expect(before.order.pointsEarned).toBe(9);

      await scheduler.runOnce();
      expect(await snapshot(f)).toEqual(before);
      await scheduler.runOnce();
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('processes multiple batches and two instances without double release, preserving fresh/paid orders', async () => {
    const expired = await Promise.all([fixture(), fixture(), fixture()]);
    const fresh = await fixture();
    const paid = await fixture();
    await pay(expired[1], randomUUID(), false).expect(200);
    await pay(paid).expect(200);
    for (const f of [...expired, paid]) await markExpired(f.orderId);
    const freshBefore = await snapshot(fresh);
    const paidBefore = await snapshot(paid);
    const other = new OrderExpirationService(prisma, {
      enabled: false,
      batchSize: 2,
    });
    await Promise.all([scheduler.runOnce(), other.runOnce()]);
    for (const f of expired) {
      const state = await snapshot(f);
      expect(state.order.status).toBe('CANCELLED');
      expect(state.product.stock).toBe(5);
      expect(state.coupon.activeUsageCount).toBe(0);
    }
    const after = await Promise.all(expired.map(snapshot));
    await scheduler.runOnce();
    expect(await Promise.all(expired.map(snapshot))).toEqual(after);
    expect(await snapshot(fresh)).toEqual(freshBefore);
    expect(await snapshot(paid)).toEqual(paidBefore);
    await other.onModuleDestroy();
  });

  it('rolls back one bad Order, continues later batches, then recovers on the next sweep', async () => {
    const fixtures = (
      await Promise.all([fixture(), fixture(), fixture()])
    ).sort((a, b) => a.orderId.localeCompare(b.orderId));
    for (const f of fixtures) await markExpired(f.orderId);
    const bad = fixtures[0];
    await prisma.coupon.update({
      where: { id: bad.couponId },
      data: { activeUsageCount: 0 },
    });
    const before = await snapshot(bad);
    await scheduler.runOnce();
    expect(await snapshot(bad)).toEqual(before);
    for (const f of fixtures.slice(1))
      expect((await getOrder(f.orderId)).status).toBe('CANCELLED');
    await prisma.coupon.update({
      where: { id: bad.couponId },
      data: { activeUsageCount: 1 },
    });
    await scheduler.runOnce();
    const recovered = await snapshot(bad);
    expect(recovered.order.status).toBe('CANCELLED');
    expect(recovered.product.stock).toBe(5);
    expect(recovered.coupon.activeUsageCount).toBe(0);
  });

  it('coordinates Scheduler and Create cleanup before reserving a replacement', async () => {
    const f = await fixture();
    await markExpired(f.orderId);
    const [created] = await Promise.all([create(f), scheduler.runOnce()]);
    expect(created.status).toBe(201);
    expect((await getOrder(f.orderId)).status).toBe('CANCELLED');
    const next = { ...f, orderId: created.body.id as string };
    const state = await snapshot(next);
    expect(state.order.status).toBe('PENDING');
    expect(state.product.stock).toBe(3);
    expect(state.coupon.activeUsageCount).toBe(1);
    expect(state.order.couponRedemption?.status).toBe('HELD');
  });

  it.each([true, false])(
    'rechecks after Payment commits at the deadline (success=%s)',
    async (success) => {
      const f = await fixture();
      await prisma.$executeRaw`UPDATE orders SET expires_at = clock_timestamp() + INTERVAL '750 milliseconds' WHERE id = ${f.orderId}::uuid`;
      const held = holdNextCommit();
      const payment = pay(f, randomUUID(), success).then(
        (response) => response,
      );
      let sweep: Promise<void> | undefined;
      try {
        await Promise.race([
          held.ready.promise,
          payment.then(() => {
            throw new Error('Payment did not reach the commit barrier');
          }),
        ]);
        await expect
          .poll(
            async () => {
              const [clock] = await prisma.$queryRaw<{ expired: boolean }[]>`
          SELECT expires_at <= clock_timestamp() AS expired FROM orders WHERE id = ${f.orderId}::uuid`;
              return clock.expired;
            },
            { timeout: 2000, interval: 20 },
          )
          .toBe(true);
        sweep = scheduler.runOnce();
        await waitForLock('%SELECT id FROM orders%FOR UPDATE%');
      } finally {
        held.release.resolve();
        await payment;
        await sweep;
        held.restore();
      }
      expect((await payment).status).toBe(200);
      const final = await snapshot(f);
      expect(final.order.status).toBe(success ? 'PAID' : 'CANCELLED');
      expect(final.product.stock).toBe(success ? 3 : 5);
      expect(final.coupon.activeUsageCount).toBe(success ? 1 : 0);
      expect(final.user.loyaltyPoints).toBe(success ? 9 : 0);
      expect(final.order.payments).toHaveLength(1);
    },
  );

  it('rejects Payment waiting behind Scheduler cancellation without creating an attempt', async () => {
    const f = await fixture();
    await markExpired(f.orderId);
    const held = holdNextCommit();
    const sweep = scheduler.runOnce();
    let payment: Promise<request.Response> | undefined;
    try {
      await Promise.race([
        held.ready.promise,
        sweep.then(() => {
          throw new Error('Scheduler did not reach the commit barrier');
        }),
      ]);
      payment = pay(f).then((response) => response);
      await waitForLock('%SELECT id FROM orders%user_id%FOR UPDATE%');
    } finally {
      held.release.resolve();
      await sweep;
      await payment;
      held.restore();
    }
    expect((await payment)!.status).toBe(409);
    expect((await payment)!.body.code).toBe('INVALID_TRANSITION');
    const final = await snapshot(f);
    expect(final.order.status).toBe('CANCELLED');
    expect(final.product.stock).toBe(5);
    expect(final.coupon.activeUsageCount).toBe(0);
    expect(final.order.payments).toHaveLength(0);
  });

  it('starts the automatic minute runner through Nest application bootstrap', async () => {
    const f = await fixture();
    await markExpired(f.orderId);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const automatic = await makeApp(true);
    const runner = automatic.get(OrderExpirationService);
    const tick = vi.spyOn(runner, 'runOnce');
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(tick).not.toHaveBeenCalled();
      expect((await getOrder(f.orderId)).status).toBe('PENDING');
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(1);
      await runner.runOnce();
      expect((await getOrder(f.orderId)).status).toBe('CANCELLED');
    } finally {
      await automatic.close();
      vi.useRealTimers();
    }
  });

  it('drains an active expiration transaction before Nest disconnects Prisma on shutdown', async () => {
    const f = await fixture();
    await markExpired(f.orderId);
    const closing = await makeApp();
    const disconnect = vi.spyOn(closing.get(PrismaService), '$disconnect');
    const ready = barrier();
    const release = barrier();
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${f.productId}::uuid FOR UPDATE`;
      ready.resolve();
      await release.promise;
    });
    let sweep: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      await Promise.race([ready.promise, writer]);
      sweep = closing.get(OrderExpirationService).runOnce();
      await waitForLock('%UPDATE%products%');
      shutdown = closing.close();
      await new Promise((resolve) => setImmediate(resolve));
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await writer;
      await sweep;
      if (shutdown) await shutdown;
      else await closing.close();
    }
    expect(disconnect).toHaveBeenCalledTimes(1);
    const final = await snapshot(f);
    expect(final.order.status).toBe('CANCELLED');
    expect(final.product.stock).toBe(5);
    expect(final.coupon.activeUsageCount).toBe(0);
  });
});
