import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OrdersService } from '../src/orders/orders.service.js';

// Run only against a migrated, disposable PostgreSQL database.
describe('Orders PostgreSQL transaction integration', () => {
  let prisma: PrismaService;
  let service: OrdersService;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const productId = randomUUID();
  const categoryId = randomUUID();
  const toppingId = randomUUID();
  const otherId = randomUUID();
  const couponId = randomUUID();
  const code =
    `T${randomUUID().replaceAll('-', '').slice(0, 20)}`.toUpperCase();
  const dto = {
    items: [{ productId, size: 'M' as const, toppingIds: [], quantity: 2 }],
  };

  async function clearOrders() {
    const userIds = [userId, otherUserId];
    await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.couponRedemption.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.orderItemTopping.deleteMany({
      where: { orderItem: { order: { userId: { in: userIds } } } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: userIds } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  }
  async function createHistoryOrder({
    id = randomUUID(),
    ownerId = userId,
    createdAt = new Date(),
    status = 'PAID',
  }: {
    id?: string;
    ownerId?: string;
    createdAt?: Date;
    status?: 'PAID' | 'PAYMENT_FAILED';
  } = {}) {
    return prisma.order.create({
      data: {
        id,
        userId: ownerId,
        status,
        subtotalVnd: 118000n,
        discountVnd: 20000n,
        totalVnd: 98000n,
        pointsEarned: 9,
        couponCodeSnapshot: 'HISTORY20',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 15 * 60_000),
        items: {
          create: {
            productId,
            productNameSnapshot: 'Order test',
            size: 'M',
            sizePercentSnapshot: 120,
            basePriceSnapshotVnd: 45000n,
            quantity: 2,
            unitPriceVnd: 59000n,
            lineTotalVnd: 118000n,
            toppings: {
              create: {
                toppingId,
                toppingCodeSnapshot: code,
                toppingNameSnapshot: 'Order test topping',
                toppingPriceSnapshotVnd: 5000n,
              },
            },
          },
        },
      },
    });
  }
  async function createHistoryPayment(
    orderId: string,
    ownerId: string,
    status: 'SUCCESS' | 'FAILED',
    createdAt: Date,
  ) {
    const id = randomUUID();
    const success = status === 'SUCCESS';
    return prisma.payment.create({
      data: {
        id,
        orderId,
        userId: ownerId,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        amountVnd: 98000n,
        provider: 'MOCK',
        method: 'CARD',
        status,
        methodLast4: '1234',
        mockReference: `MOCK-${id}`,
        responseSnapshot: {
          paymentId: id,
          orderId,
          paymentStatus: status,
          orderStatus: success ? 'PAID' : 'PAYMENT_FAILED',
          amountVnd: 98000,
          method: 'CARD',
          methodLast4: '1234',
          mockReference: `MOCK-${id}`,
          pointsEarned: success ? 9 : 0,
          failureReason: success ? null : 'PAYMENT_DECLINED',
          createdAt: createdAt.toISOString(),
        },
        createdAt,
      },
    });
  }
  beforeAll(async () => {
    const url = process.env.ORDERS_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.',
      );
    vi.stubEnv('DATABASE_URL', url);
    prisma = new PrismaService();
    await prisma.$connect();
    service = new OrdersService(prisma);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@orders.test`,
        passwordHash: 'test-only-unused',
      },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        email: `${otherUserId}@orders.test`,
        passwordHash: 'test-only-unused',
      },
    });
    await prisma.category.create({
      data: { id: categoryId, code, name: 'Orders test category' },
    });
    await prisma.product.createMany({
      data: [productId, otherId].map((id) => ({
        id,
        categoryId,
        name: 'Order test',
        imageUrl: '/test',
        basePriceVnd: 45000n,
        stock: 5,
      })),
    });
    await prisma.coupon.create({
      data: {
        id: couponId,
        code,
        type: 'FIXED',
        value: 20000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 10,
      },
    });
    await prisma.topping.create({
      data: {
        id: toppingId,
        code,
        name: 'Order test topping',
        priceVnd: 5000n,
      },
    });
    await prisma.productTopping.create({ data: { productId, toppingId } });
  });
  beforeEach(async () => {
    await clearOrders();
    await prisma.product.updateMany({
      where: { id: { in: [productId, otherId] } },
      data: { stock: 5, basePriceVnd: 45000n, sizePolicy: 'STANDARD' },
    });
    await prisma.category.update({
      where: { id: categoryId },
      data: { isActive: true },
    });
    await prisma.topping.update({
      where: { id: toppingId },
      data: { isAvailable: true, priceVnd: 5000n },
    });
    await prisma.coupon.update({
      where: { id: couponId },
      data: { activeUsageCount: 0 },
    });
  });
  afterAll(async () => {
    try {
      if (prisma) {
        await clearOrders();
        await prisma.coupon.deleteMany({ where: { id: couponId } });
        await prisma.product.deleteMany({
          where: { id: { in: [productId, otherId] } },
        });
        await prisma.topping.deleteMany({ where: { id: toppingId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.user.deleteMany({ where: { id: otherUserId } });
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await prisma?.$disconnect();
      vi.unstubAllEnvs();
    }
  });
  it('persists order, reserves stock and coupon, preserving snapshots', async () => {
    const response = await service.create(userId, { ...dto, couponCode: code });
    expect(response.totalVnd).toBe(88000);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(3);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } }))
        .activeUsageCount,
    ).toBe(1);
    expect(
      (
        await prisma.couponRedemption.findUniqueOrThrow({
          where: { orderId: response.id },
        })
      ).status,
    ).toBe('HELD');
    await prisma.product.update({
      where: { id: productId },
      data: { basePriceVnd: 50000n },
    });
    expect(
      (
        await prisma.orderItem.findFirstOrThrow({
          where: { orderId: response.id },
        })
      ).basePriceSnapshotVnd,
    ).toBe(45000n);
    await prisma.product.update({
      where: { id: productId },
      data: { basePriceVnd: 45000n },
    });
  });
  it('rolls back previously reserved stock and coupon when a later product is insufficient', async () => {
    const [first, last] = [productId, otherId].sort((a, b) =>
      a.localeCompare(b),
    );
    await prisma.product.update({ where: { id: last }, data: { stock: 0 } });
    await expect(
      service.create(userId, {
        couponCode: code,
        items: [first, last].map((id) => ({ ...dto.items[0], productId: id })),
      }),
    ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK' } });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: first } })).stock,
    ).toBe(5);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } }))
        .activeUsageCount,
    ).toBe(0);
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
    expect(await prisma.couponRedemption.count({ where: { userId } })).toBe(0);
  });
  it('rejects an inactive category without changing stock or coupon quota', async () => {
    await prisma.category.update({
      where: { id: categoryId },
      data: { isActive: false },
    });
    await expect(
      service.create(userId, { ...dto, couponCode: code }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CART' } });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(5);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } }))
        .activeUsageCount,
    ).toBe(0);
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
  });
  it('persists ONE_SIZE under the current database constraints', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { sizePolicy: 'ONE_SIZE' },
    });
    const order = await service.create(userId, {
      items: [{ ...dto.items[0], size: 'ONE_SIZE' }],
    });
    expect(order.items[0]).toMatchObject({
      size: 'ONE_SIZE',
      sizeMultiplierPercent: 100,
    });
    await expect(
      prisma.orderItem.update({
        where: { id: order.items[0].id },
        data: { sizePercentSnapshot: 120 },
      }),
    ).rejects.toThrow();
    expect(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: order.items[0].id },
        })
      ).sizePercentSnapshot,
    ).toBe(100);
  });
  it('saves half-up size pricing and topping snapshots from the database', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { basePriceVnd: 45003n },
    });
    const order = await service.create(userId, {
      items: [{ ...dto.items[0], toppingIds: [toppingId] }],
    });
    expect(order.totalVnd).toBe(118008);
    expect(order.items[0]).toMatchObject({
      unitPriceVnd: 59004,
      lineTotalVnd: 118008,
      basePriceVnd: 45003,
      sizeMultiplierPercent: 120,
    });
    expect(order.items[0].toppings).toEqual([
      { id: toppingId, name: 'Order test topping', priceVnd: 5000 },
    ]);
    await prisma.topping.update({
      where: { id: toppingId },
      data: { priceVnd: 9000n },
    });
    expect(
      (
        await prisma.orderItemTopping.findFirstOrThrow({
          where: { orderItemId: order.items[0].id },
        })
      ).toppingPriceSnapshotVnd,
    ).toBe(5000n);
  });
  it('rejects topping belonging to a different product without writes', async () => {
    await expect(
      service.create(userId, {
        items: [
          { ...dto.items[0], productId: otherId, toppingIds: [toppingId] },
        ],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'INVALID_CART',
        details: [{ reason: 'TOPPING_NOT_ALLOWED' }],
      },
    });
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: otherId } }))
        .stock,
    ).toBe(5);
  });
  it('rejects unavailable topping without reserving quota', async () => {
    await prisma.topping.update({
      where: { id: toppingId },
      data: { isAvailable: false },
    });
    await expect(
      service.create(userId, {
        couponCode: code,
        items: [{ ...dto.items[0], toppingIds: [toppingId] }],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'INVALID_CART',
        details: [{ reason: 'TOPPING_UNAVAILABLE' }],
      },
    });
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: couponId } }))
        .activeUsageCount,
    ).toBe(0);
  });
  it('rejects a second active order without reserving stock twice', async () => {
    await service.create(userId, dto);
    await expect(service.create(userId, dto)).rejects.toMatchObject({
      response: { code: 'PENDING_ORDER_EXISTS' },
    });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(3);
  });
  it('returns an empty history for a user with no orders', async () => {
    await expect(service.getMine(userId, {})).resolves.toEqual({
      items: [],
      meta: { page: null, limit: null, total: 0, totalPages: null },
    });
  });
  it('scopes history and totals to its owner and maps snapshots to JSON-safe values', async () => {
    const own = await createHistoryOrder({
      createdAt: new Date('2026-10-25T01:50:00.000Z'),
    });
    await createHistoryOrder({
      ownerId: otherUserId,
      createdAt: new Date('2026-10-25T02:00:00.000Z'),
    });

    const result = await service.getMine(userId, {});

    expect(result.meta).toEqual({
      page: null,
      limit: null,
      total: 1,
      totalPages: null,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: own.id,
      subtotalVnd: 118000,
      discountVnd: 20000,
      totalVnd: 98000,
      couponCode: 'HISTORY20',
      items: [
        {
          productName: 'Order test',
          basePriceVnd: 45000,
          toppings: [{ name: 'Order test topping', priceVnd: 5000 }],
        },
      ],
      payment: null,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('sorts by createdAt then id and paginates the owner history', async () => {
    const oldest = await createHistoryOrder({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-10-25T01:00:00.000Z'),
    });
    const tieLow = await createHistoryOrder({
      id: '00000000-0000-4000-8000-000000000002',
      createdAt: new Date('2026-10-25T02:00:00.000Z'),
    });
    const tieHigh = await createHistoryOrder({
      id: '00000000-0000-4000-8000-000000000003',
      createdAt: new Date('2026-10-25T02:00:00.000Z'),
    });

    const all = await service.getMine(userId, {});
    expect(all.items.map((item) => item.id)).toEqual([
      tieHigh.id,
      tieLow.id,
      oldest.id,
    ]);

    const page = await service.getMine(userId, { page: 2, limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual([tieLow.id]);
    expect(page.meta).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
  });
  it('prefers SUCCESS payment, otherwise returns the newest FAILED payment', async () => {
    const successOrder = await createHistoryOrder({
      createdAt: new Date('2026-10-25T03:00:00.000Z'),
    });
    const failedOrder = await createHistoryOrder({
      createdAt: new Date('2026-10-25T02:00:00.000Z'),
      status: 'PAYMENT_FAILED',
    });
    const failedBeforeSuccess = await createHistoryPayment(
      successOrder.id,
      userId,
      'FAILED',
      new Date('2026-10-25T03:01:00.000Z'),
    );
    const success = await createHistoryPayment(
      successOrder.id,
      userId,
      'SUCCESS',
      new Date('2026-10-25T03:00:00.000Z'),
    );
    await createHistoryPayment(
      failedOrder.id,
      userId,
      'FAILED',
      new Date('2026-10-25T02:01:00.000Z'),
    );
    const newestFailure = await createHistoryPayment(
      failedOrder.id,
      userId,
      'FAILED',
      new Date('2026-10-25T02:02:00.000Z'),
    );

    const result = await service.getMine(userId, {});
    const successSummary = result.items.find(
      (item) => item.id === successOrder.id,
    )!.payment;
    const failedSummary = result.items.find(
      (item) => item.id === failedOrder.id,
    )!.payment;

    expect(successSummary).toMatchObject({
      id: success.id,
      status: 'SUCCESS',
      failureReason: null,
    });
    expect(failedSummary).toMatchObject({
      id: newestFailure.id,
      status: 'FAILED',
      failureReason: 'PAYMENT_DECLINED',
    });
    expect(successSummary?.id).not.toBe(failedBeforeSuccess.id);
  });
});
