import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { OrderStatus } from '../src/generated/prisma/enums.js';
import {
  expireOrderInTransaction,
  inventoryQuantities,
  reserveInventory,
} from '../src/orders/inventory-policy.js';
import { runInventoryTransaction } from '../src/orders/inventory-transaction.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type Customer = { id: string; token: string };
type Item = {
  productId: string;
  quantity: number;
  size: 'S' | 'M' | 'L';
  toppingIds: string[];
};
const item = (
  productId: string,
  quantity = 1,
  size: Item['size'] = 'M',
): Item => ({ productId, quantity, size, toppingIds: [] });
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('SCRUM-58 PostgreSQL inventory concurrency', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let jwt: JwtService;
  const categoryId = randomUUID();
  const users: string[] = [];
  const products: string[] = [];
  const coupons: string[] = [];

  beforeAll(async () => {
    const url = process.env.ORDERS_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.',
      );
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    prisma = module.get(PrismaService);
    jwt = module.get(JwtService);
    app = module.createNestApplication({ logger: false });
    await app.init();
    await prisma.category.create({
      data: { id: categoryId, code: categoryId, name: 'SCRUM-58 test' },
    });
  });

  afterAll(async () => {
    try {
      if (prisma) {
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
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
    }
  });

  async function customer(): Promise<Customer> {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: {
        id,
        email: `${id}@inventory.test`,
        passwordHash: 'test-only-unused',
      },
    });
    return { id, token: jwt.sign({ sub: id }) };
  }
  async function product(stock = 1) {
    const id = randomUUID();
    products.push(id);
    await prisma.product.create({
      data: {
        id,
        categoryId,
        name: 'Inventory test',
        imageUrl: '/test',
        basePriceVnd: 50000n,
        stock,
      },
    });
    return id;
  }
  async function coupon() {
    const id = randomUUID();
    coupons.push(id);
    const code = id.replaceAll('-', '').slice(0, 20).toUpperCase();
    await prisma.coupon.create({
      data: {
        id,
        code,
        type: 'FIXED',
        value: 10000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 1,
        perUserLimit: 1,
      },
    });
    return { id, code };
  }
  const create = (owner: Customer, items: Item[], couponCode?: string) =>
    request(app!.getHttpServer())
      .post('/orders')
      .auth(owner.token, { type: 'bearer' })
      .send({ items, couponCode });
  const pay = (owner: Customer, orderId: string, success = true) =>
    request(app!.getHttpServer())
      .post('/payments')
      .auth(owner.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({
        orderId,
        method: 'CARD',
        paymentDetails: {
          cardNumber: success ? '1234567890121234' : '1234567890120002',
        },
      });
  const stock = async (id: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;
  const order = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });
  const expire = (id: string) =>
    runInventoryTransaction(prisma, (tx) => expireOrderInTransaction(tx, id));
  const markExpired = (id: string) =>
    prisma.order.update({ where: { id }, data: { expiresAt: new Date(0) } });
  const redemption = (orderId: string) =>
    prisma.couponRedemption.findUniqueOrThrow({ where: { orderId } });

  async function reservationState(
    owner: Customer,
    productIds: string[],
    couponId: string,
    db: Prisma.TransactionClient = prisma,
  ) {
    const [stocks, orders, orderItems, redemptions, discount] =
      await Promise.all([
        db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, stock: true },
          orderBy: { id: 'asc' },
        }),
        db.order.count({ where: { userId: owner.id } }),
        db.orderItem.count({ where: { order: { userId: owner.id } } }),
        db.couponRedemption.count({ where: { userId: owner.id } }),
        db.coupon.findUniqueOrThrow({
          where: { id: couponId },
          select: { activeUsageCount: true },
        }),
      ]);
    return {
      stocks,
      orders,
      orderItems,
      redemptions,
      activeUsageCount: discount.activeUsageCount,
    };
  }

  async function waitForLock(queryPattern: string) {
    await expect
      .poll(
        async () => {
          const [activity] = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE ${queryPattern}
        ) AS waiting`;
          return activity.waiting;
        },
        { timeout: 1000, interval: 10 },
      )
      .toBe(true);
  }

  it('sells the last unit to exactly one of two customers', async () => {
    const productId = await product();
    const owners = await Promise.all([customer(), customer()]);
    const results = await Promise.all(
      owners.map((owner) => create(owner, [item(productId)])),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ productId, requestedQuantity: 1, availableQuantity: 0 }],
    });
    expect(await stock(productId)).toBe(0);
    expect(
      await prisma.order.count({
        where: { userId: { in: owners.map((owner) => owner.id) } },
      }),
    ).toBe(1);
  });

  it('aggregates mixed sizes and case variants before concurrent reservations', async () => {
    const productId = await product(5);
    const owners = await Promise.all([customer(), customer()]);
    const items = [
      item(productId, 1, 'S'),
      item(productId.toUpperCase(), 2, 'L'),
    ];
    const results = await Promise.all(
      owners.map((owner) => create(owner, items)),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(
      results.find((r) => r.status === 409)!.body.details[0].requestedQuantity,
    ).toBe(3);
    expect(await stock(productId)).toBe(2);
    expect(results.find((r) => r.status === 201)!.body.items).toHaveLength(2);
  });

  it('serializes same-user requests before stock checks, including uppercase JWT UUID', async () => {
    const productId = await product();
    const owner = await customer();
    const uppercase = {
      ...owner,
      token: jwt.sign({ sub: owner.id.toUpperCase() }),
    };
    const results = await Promise.all([
      create(owner, [item(productId)]),
      create(uppercase, [item(productId)]),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'PENDING_ORDER_EXISTS',
    );
    expect(await stock(productId)).toBe(0);
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });

  it('handles opposite cart order without deadlock or lost updates', async () => {
    const ids = await Promise.all([product(2), product(2)]);
    const owners = await Promise.all([customer(), customer()]);
    const results = await Promise.all([
      create(
        owners[0],
        ids.map((id) => item(id)),
      ),
      create(
        owners[1],
        [...ids].reverse().map((id) => item(id)),
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await Promise.all(ids.map(stock))).toEqual([0, 0]);
  });

  it('rolls back earlier product reservations when a later product is insufficient', async () => {
    const ids = (await Promise.all([product(2), product(2)])).sort((a, b) =>
      a.localeCompare(b),
    );
    await prisma.product.update({ where: { id: ids[1] }, data: { stock: 0 } });
    const owner = await customer();
    const discount = await coupon();
    const response = await create(
      owner,
      ids.map((id) => item(id)),
      discount.code,
    ).expect(409);
    expect(response.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await stock(ids[0])).toBe(2);
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(0);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: discount.id } }))
        .activeUsageCount,
    ).toBe(0);
  });

  it.each(['global', 'per-user'] as const)(
    'rolls back reserved stock and all rows when %s coupon quota rejects Create Order',
    async (quota) => {
      const productIds = await Promise.all([product(5), product(4)]);
      const previousOwner = await customer();
      const discount = await coupon();
      if (quota === 'per-user') {
        // Global quota still has room; the same customer's CONSUMED redemption
        // alone must reject the next use after their previous Order is PAID.
        await prisma.coupon.update({
          where: { id: discount.id },
          data: { usageLimit: 2 },
        });
      }
      const previous = await create(
        previousOwner,
        [item(productIds[0])],
        discount.code,
      ).expect(201);
      await pay(previousOwner, previous.body.id).expect(200);
      const owner = quota === 'global' ? await customer() : previousOwner;
      const before = await reservationState(owner, productIds, discount.id);
      expect(before).toMatchObject({
        orders: quota === 'global' ? 0 : 1,
        orderItems: quota === 'global' ? 0 : 1,
        redemptions: quota === 'global' ? 0 : 1,
        activeUsageCount: 1,
      });

      const reservedStocks: (typeof before.stocks)[] = [];
      const transaction = prisma.$transaction.bind(prisma);
      // Observe the real database transaction immediately before Prisma rolls
      // it back. Queries and the HTTP/service callback are NOT replaced.
      const observeFailure = async (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: {
          maxWait?: number;
          timeout?: number;
          isolationLevel?: Prisma.TransactionIsolationLevel;
        },
      ) =>
        transaction(async (tx) => {
          try {
            return await work(tx);
          } catch (error) {
            reservedStocks.push(
              (await reservationState(owner, productIds, discount.id, tx))
                .stocks,
            );
            throw error;
          }
        }, options);
      const spy = vi
        .spyOn(prisma, '$transaction')
        .mockImplementation(observeFailure as PrismaService['$transaction']);
      try {
        const response = await create(
          owner,
          productIds.map((id) => item(id)),
          discount.code,
        ).expect(409);
        expect(response.body).toMatchObject({
          statusCode: 409,
          code: 'COUPON_UNAVAILABLE',
        });
        expect(spy).toHaveBeenCalledTimes(1); // A quota rejection is not retryable.
        expect(reservedStocks).toEqual([
          before.stocks.map(({ id, stock }) => ({ id, stock: stock - 1 })),
        ]);
      } finally {
        spy.mockRestore();
      }

      // Both products are restored; no Order, OrderItem or redemption was added,
      // and the existing coupon's active_usage_count remains exactly one.
      expect(await reservationState(owner, productIds, discount.id)).toEqual(
        before,
      );
    },
  );

  it('returns 500 INTERNAL_ERROR after three real serialization aborts with no persisted side effects', async () => {
    const productIds = await Promise.all([product(5), product(4)]);
    const owner = await customer();
    const discount = await coupon();
    const before = await reservationState(owner, productIds, discount.id);
    expect(before).toMatchObject({
      orders: 0,
      orderItems: 0,
      redemptions: 0,
      activeUsageCount: 0,
    });
    const attempts: (typeof before)[] = [];
    const transaction = prisma.$transaction.bind(prisma);
    const abortAfterWrites = async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ) =>
      transaction(async (tx) => {
        const result = await work(tx);
        attempts.push(
          await reservationState(owner, productIds, discount.id, tx),
        );
        // Let PostgreSQL abort AFTER the real request reserved stock/coupon and
        // inserted Order/items/redemption. No fabricated Prisma error or result.
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'test retry exhaustion' USING ERRCODE = '40001'; END $$`;
        return result;
      }, options);
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementation(abortAfterWrites as PrismaService['$transaction']);
    try {
      const response = await create(
        owner,
        productIds.map((id) => item(id)),
        discount.code,
      ).expect(500);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(attempts).toHaveLength(3);
      for (const attempt of attempts) {
        expect(attempt).toEqual({
          stocks: before.stocks.map(({ id, stock }) => ({
            id,
            stock: stock - 1,
          })),
          orders: 1,
          orderItems: 2,
          redemptions: 1,
          activeUsageCount: 1,
        });
      }
    } finally {
      spy.mockRestore();
    }
    expect(await reservationState(owner, productIds, discount.id)).toEqual(
      before,
    );
  });

  it.each([true, false])(
    'rechecks stock after a competing writer commits=%s',
    async (commit) => {
      const productId = await product();
      const owner = await customer();
      const locked = barrier();
      const release = barrier();
      const rollback = new Error('test rollback');
      const writer = prisma
        .$transaction(async (tx) => {
          await tx.product.update({
            where: { id: productId },
            data: { stock: { decrement: 1 } },
          });
          locked.resolve();
          await release.promise;
          if (!commit) throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      await Promise.race([locked.promise, writer]);
      const response = create(owner, [item(productId)]).then((r) => r);
      try {
        await waitForLock('%UPDATE%products%');
      } finally {
        release.resolve();
        await writer;
        await response;
      }
      expect((await response).status).toBe(commit ? 409 : 201);
      expect(await stock(productId)).toBe(0);
    },
  );

  it('enforces nonnegative stock and one active order at the database level', async () => {
    const productId = await product();
    await expect(
      prisma.product.update({ where: { id: productId }, data: { stock: -1 } }),
    ).rejects.toThrow();
    expect(await stock(productId)).toBe(1);
    const owner = await customer();
    await create(owner, [item(productId)]).expect(201);
    await expect(
      prisma.order.create({
        data: {
          userId: owner.id,
          subtotalVnd: 0n,
          totalVnd: 0n,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });

  it.each([false, true])(
    'releases mixed-size stock and held coupon once under parallel expiration (failed payment=%s)',
    async (failedPayment) => {
      const productId = await product(3);
      const owner = await customer();
      const discount = await coupon();
      const { body } = await create(
        owner,
        [item(productId, 1, 'S'), item(productId, 2, 'L')],
        discount.code,
      ).expect(201);
      if (failedPayment) await pay(owner, body.id, false).expect(200);
      await markExpired(body.id);
      await Promise.all([expire(body.id), expire(body.id)]);
      const cancelled = await order(body.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).toBeInstanceOf(Date);
      expect(await stock(productId)).toBe(3);
      expect((await redemption(body.id)).status).toBe('RELEASED');
      expect(
        (await prisma.coupon.findUniqueOrThrow({ where: { id: discount.id } }))
          .activeUsageCount,
      ).toBe(0);
      await expire(body.id);
      expect(await order(body.id)).toEqual(cancelled);
      expect(await stock(productId)).toBe(3);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } }))
          .loyaltyPoints,
      ).toBe(0);
    },
  );

  it.each([
    'PENDING',
    'PAYMENT_FAILED',
    'PAID',
    'PREPARING',
    'READY',
    'COMPLETED',
  ] as OrderStatus[])(
    'does not release %s when not eligible for expiration',
    async (status) => {
      const productId = await product();
      const owner = await customer();
      const { body } = await create(owner, [item(productId)]).expect(201);
      const unpaid = status === 'PENDING' || status === 'PAYMENT_FAILED';
      await prisma.order.update({
        where: { id: body.id },
        data: {
          status,
          expiresAt: unpaid ? new Date(Date.now() + 60_000) : new Date(0),
        },
      });
      const before = await order(body.id);
      await expire(body.id);
      expect(await order(body.id)).toEqual(before);
      expect(await stock(productId)).toBe(0);
    },
  );

  it('cleans up an expired active order before reserving a replacement with the same coupon', async () => {
    const productId = await product(2);
    const owner = await customer();
    const discount = await coupon();
    const old = await create(owner, [item(productId, 2)], discount.code).expect(
      201,
    );
    await markExpired(old.body.id);
    const next = await create(owner, [item(productId)], discount.code).expect(
      201,
    );
    expect(next.body.id).not.toBe(old.body.id);
    expect((await order(old.body.id)).status).toBe('CANCELLED');
    expect((await redemption(old.body.id)).status).toBe('RELEASED');
    expect((await redemption(next.body.id)).status).toBe('HELD');
    expect(await stock(productId)).toBe(1);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: discount.id } }))
        .activeUsageCount,
    ).toBe(1);
  });

  it('does not double-release when Create Order competes with the shared expiration primitive', async () => {
    const productId = await product(2);
    const owner = await customer();
    const discount = await coupon();
    const old = await create(owner, [item(productId, 2)], discount.code).expect(
      201,
    );
    await markExpired(old.body.id);
    const [next] = await Promise.all([
      create(owner, [item(productId)], discount.code),
      expire(old.body.id),
    ]);
    expect(next.status).toBe(201);
    expect(await stock(productId)).toBe(1);
    expect((await redemption(old.body.id)).status).toBe('RELEASED');
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: discount.id } }))
        .activeUsageCount,
    ).toBe(1);
  });

  it('rolls back cancellation and stock release if coupon cleanup fails; creates no replacement', async () => {
    const productId = await product();
    const owner = await customer();
    const discount = await coupon();
    const old = await create(owner, [item(productId)], discount.code).expect(
      201,
    );
    await markExpired(old.body.id);
    await prisma.coupon.update({
      where: { id: discount.id },
      data: { activeUsageCount: 0 },
    });
    const before = await order(old.body.id);
    const response = await create(owner, [item(productId)]).expect(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(await order(old.body.id)).toEqual(before);
    expect(await stock(productId)).toBe(0);
    expect((await redemption(old.body.id)).status).toBe('HELD');
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });

  it('keeps committed cleanup if the replacement cart cannot be reserved', async () => {
    const productId = await product();
    const owner = await customer();
    const old = await create(owner, [item(productId)]).expect(201);
    await markExpired(old.body.id);
    await create(owner, [item(productId, 2)]).expect(409);
    expect((await order(old.body.id)).status).toBe('CANCELLED');
    expect(await stock(productId)).toBe(1);
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });

  it('rolls back all stock increments if a later product release fails', async () => {
    const ids = (await Promise.all([product(), product()])).sort((a, b) =>
      a.localeCompare(b),
    );
    const owner = await customer();
    const old = await create(
      owner,
      ids.map((id) => item(id)),
    ).expect(201);
    await markExpired(old.body.id);
    // Deliberately corrupt this test fixture so incrementing the last Int overflows.
    await prisma.product.update({
      where: { id: ids[1] },
      data: { stock: 2147483647 },
    });
    await expect(expire(old.body.id)).rejects.toThrow();
    expect((await order(old.body.id)).status).toBe('PENDING');
    expect(await stock(ids[0])).toBe(0);
    expect(await stock(ids[1])).toBe(2147483647);
  });

  it('keeps reservations on payment failure/retry and does not release a paid order', async () => {
    const productId = await product();
    const owner = await customer();
    const discount = await coupon();
    const created = await create(
      owner,
      [item(productId)],
      discount.code,
    ).expect(201);
    const failed = await pay(owner, created.body.id, false).expect(200);
    expect(failed.body.paymentStatus).toBe('FAILED');
    expect(await stock(productId)).toBe(0);
    expect((await redemption(created.body.id)).status).toBe('HELD');
    await pay(owner, created.body.id).expect(200);
    await markExpired(created.body.id);
    await expire(created.body.id);
    expect((await order(created.body.id)).status).toBe('PAID');
    expect(await stock(productId)).toBe(0);
    expect((await redemption(created.body.id)).status).toBe('CONSUMED');
  });

  it.each([false, true])(
    'coordinates real Payment with expiration when expired=%s',
    async (expired) => {
      const productId = await product();
      const owner = await customer();
      const created = await create(owner, [item(productId)]).expect(201);
      if (expired) await markExpired(created.body.id);
      const [payment] = await Promise.all([
        pay(owner, created.body.id),
        expire(created.body.id),
      ]);
      expect(payment.status).toBe(expired ? 409 : 200);
      expect((await order(created.body.id)).status).toBe(
        expired ? 'CANCELLED' : 'PAID',
      );
      expect(await stock(productId)).toBe(expired ? 1 : 0);
      expect(
        await prisma.payment.count({ where: { orderId: created.body.id } }),
      ).toBe(expired ? 0 : 1);
    },
  );

  it('retries a real serialization abort without reserving stock or creating Order twice', async () => {
    const productId = await product(2);
    const owner = await customer();
    let attempts = 0;
    await runInventoryTransaction(prisma, async (tx) => {
      await reserveInventory(tx, inventoryQuantities([item(productId)]));
      await tx.order.create({
        data: {
          userId: owner.id,
          subtotalVnd: 50000n,
          totalVnd: 50000n,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      if (++attempts === 1) {
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'test serialization abort' USING ERRCODE = '40001'; END $$`;
      }
    });
    expect(attempts).toBe(2);
    expect(await stock(productId)).toBe(1);
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });
});
