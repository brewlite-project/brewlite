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
    await prisma.couponRedemption.deleteMany({ where: { userId } });
    await prisma.orderItemTopping.deleteMany({
      where: { orderItem: { order: { userId } } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { userId } } });
    await prisma.order.deleteMany({ where: { userId } });
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
  it('saves floor pricing and topping snapshots from the database', async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { basePriceVnd: 45003n },
    });
    const order = await service.create(userId, {
      items: [{ ...dto.items[0], toppingIds: [toppingId] }],
    });
    expect(order.totalVnd).toBe(118006);
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
});
