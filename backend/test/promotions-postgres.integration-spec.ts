import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { releaseHeldCoupon } from '../src/promotions/promotion-policy.js';
type Customer = { userId: string; token: string };
type Fixture = Customer & { productId: string; couponId: string; code: string };
// Full HTTP Order -> Payment -> persisted promotion/loyalty, no DB mocks.
describe('SCRUM-56 promotion and loyalty PostgreSQL integration', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let jwt: JwtService;
  const categoryId = randomUUID();
  const users: string[] = [];
  const products: string[] = [];
  const coupons: string[] = [];
  beforeAll(async () => {
    const url = process.env.AUTH_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set AUTH_TEST_DATABASE_URL to a migrated test database.',
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
      data: { id: categoryId, code: categoryId, name: 'SCRUM-56 test' },
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
  async function fixture(
    options: {
      price?: bigint;
      stock?: number;
      points?: number;
      coupon?: Partial<Prisma.CouponUncheckedCreateInput>;
    } = {},
  ): Promise<Fixture> {
    const userId = randomUUID();
    users.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `promo-${userId}@example.com`,
        passwordHash: 'test-only-no-login',
        loyaltyPoints: options.points ?? 0,
      },
    });
    const productId = randomUUID();
    products.push(productId);
    await prisma.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Promotion test',
        imageUrl: '/test',
        basePriceVnd: options.price ?? 118000n,
        stock: options.stock ?? 100,
      },
    });
    const couponId = randomUUID();
    coupons.push(couponId);
    const code = `P${couponId.replaceAll('-', '').slice(0, 20)}`.toUpperCase();
    await prisma.coupon.create({
      data: {
        id: couponId,
        code,
        type: 'FIXED',
        value: 20000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 10,
        perUserLimit: 1,
        ...options.coupon,
      },
    });
    return {
      userId,
      token: await jwt.signAsync({ sub: userId }),
      productId,
      couponId,
      code,
    };
  }
  function order(f: Fixture, extra: object = {}) {
    return request(app!.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [
          { productId: f.productId, size: 'S', quantity: 1, toppingIds: [] },
        ],
        couponCode: f.code,
        ...extra,
      });
  }
  function pay(
    f: Customer,
    orderId: string,
    key: string = randomUUID(),
    cardNumber = '1234567890121234',
  ) {
    return request(app!.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${f.token}`)
      .set('Idempotency-Key', key)
      .send({
        orderId,
        method: 'CARD',
        paymentDetails: { cardNumber },
        pointsEarned: 99999,
      });
  }
  async function state(f: Fixture, orderId: string) {
    return {
      order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      user: await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }),
      coupon: await prisma.coupon.findUniqueOrThrow({
        where: { id: f.couponId },
      }),
      redemption: await prisma.couponRedemption.findUnique({
        where: { orderId },
      }),
      stock: (
        await prisma.product.findUniqueOrThrow({ where: { id: f.productId } })
      ).stock,
      attempts: await prisma.payment.count({ where: { orderId } }),
    };
  }
  // Test harness for coupon release helper; does NOT represent a real Scheduler.
  async function cancelCoupon(orderId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      return releaseHeldCoupon(tx, orderId);
    });
  }
  it('uses normalized code and server discount; awards post-discount points once', async () => {
    const [session] = await prisma.$queryRaw<{ offsetSeconds: number }[]>`
      SELECT EXTRACT(TIMEZONE FROM clock_timestamp())::int AS "offsetSeconds"`;
    expect(session?.offsetSeconds).toBe(0);
    const f = await fixture({ points: 7 });
    const r = await order(f, {
      couponCode: ` ${f.code.toLowerCase()} `,
      discountVnd: 118000,
      totalVnd: 0,
    }).expect(201);
    expect(r.body).toMatchObject({
      subtotalVnd: 118000,
      discountVnd: 20000,
      totalVnd: 98000,
      couponCode: f.code,
    });
    const [clock] = await prisma.$queryRaw<
      {
        createdAt: Date;
        expiresAt: Date;
        now: Date;
        expired: boolean;
      }[]
    >`
      SELECT created_at AS "createdAt", expires_at AS "expiresAt",
             clock_timestamp() AS now, expires_at <= clock_timestamp() AS expired
      FROM orders WHERE id = ${r.body.id}::uuid`;
    expect(clock?.expired).toBe(false);
    expect(clock!.expiresAt.getTime() - clock!.createdAt.getTime()).toBe(
      900000,
    );
    expect(clock!.expiresAt.getTime()).toBeGreaterThan(clock!.now.getTime());
    expect((await state(f, r.body.id)).user.loyaltyPoints).toBe(7);
    const key = randomUUID();
    const paid = await pay(f, r.body.id, key).expect(200);
    expect(paid.body).toMatchObject({ amountVnd: 98000, pointsEarned: 9 });
    await pay(f, r.body.id, key).expect(200).expect(paid.body);
    const s = await state(f, r.body.id);
    expect(s.user.loyaltyPoints).toBe(16);
    expect(s.order.pointsEarned).toBe(9);
    expect(s.redemption?.status).toBe('CONSUMED');
    expect(s.redemption?.consumedAt).toBeInstanceOf(Date);
    expect(s.coupon.activeUsageCount).toBe(1);
    expect(s.stock).toBe(99);
    expect(s.attempts).toBe(1);
  });
  it.each([
    {
      price: 12345n,
      coupon: { type: 'PERCENT' as const, value: 15 },
      discount: 1852,
      total: 10493,
    },
    {
      price: 500000n,
      coupon: { type: 'PERCENT' as const, value: 10, maxDiscountVnd: 30000n },
      discount: 30000,
      total: 470000,
    },
    { price: 15000n, coupon: { value: 20000 }, discount: 15000, total: 0 },
  ])(
    'persists exact discount and applies payment policy for total $total',
    async ({ price, coupon, discount, total }) => {
      const f = await fixture({ price, coupon });
      const r = await order(f).expect(201);
      expect(r.body).toMatchObject({ discountVnd: discount, totalVnd: total });
      if (total === 0) {
        const before = await state(f, r.body.id);
        expect(before.order.status).toBe('PENDING');
        expect(before.redemption?.status).toBe('HELD');
        expect(before.coupon.activeUsageCount).toBe(1);
        expect(before.stock).toBe(99);
        const rejected = await pay(f, r.body.id).expect(409);
        expect(rejected.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          code: 'INVALID_TRANSITION',
          message: 'Order cannot accept a new payment',
        });
        expect(await state(f, r.body.id)).toEqual(before);
        return;
      }
      const paid = await pay(f, r.body.id).expect(200);
      expect(paid.body.pointsEarned).toBe(Math.floor(total / 10000));
      expect((await state(f, r.body.id)).redemption?.status).toBe('CONSUMED');
    },
  );
  it.each([0, 9999, 10000, 19999, 20000])(
    'applies zero-amount Mock policy and floor points for no-coupon total %i',
    async (total) => {
      const f = await fixture({ price: BigInt(total), points: 7 });
      const r = await order(f, { couponCode: undefined }).expect(201);
      if (total === 0) {
        const before = await state(f, r.body.id);
        expect(before.order.status).toBe('PENDING');
        expect(before.order.pointsEarned).toBe(0);
        expect(before.user.loyaltyPoints).toBe(7);
        expect(before.coupon.activeUsageCount).toBe(0);
        expect(before.redemption).toBeNull();
        expect(before.stock).toBe(99);
        const rejected = await pay(f, r.body.id).expect(409);
        expect(rejected.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          code: 'INVALID_TRANSITION',
          message: 'Order cannot accept a new payment',
        });
        expect(await state(f, r.body.id)).toEqual(before);
        return;
      }
      await pay(f, r.body.id)
        .expect(200)
        .expect((p) =>
          expect(p.body.pointsEarned).toBe(Math.floor(total / 10000)),
        );
      const s = await state(f, r.body.id);
      expect(s.user.loyaltyPoints).toBe(7 + Math.floor(total / 10000));
      expect(s.coupon.activeUsageCount).toBe(0);
      expect(s.redemption).toBeNull();
    },
  );
  it.each([
    { startsAt: new Date('2098-01-01') },
    { expiresAt: new Date(1000) },
    { minSubtotalVnd: 118001n },
  ])('rejects invalid coupon conditions %#', async (coupon) => {
    const f = await fixture({ coupon });
    await order(f)
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_COUPON'));
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(100);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
        .activeUsageCount,
    ).toBe(0);
  });
  it('prioritizes stock error over exhausted coupon quota', async () => {
    const f = await fixture({
      stock: 0,
      coupon: { usageLimit: 1, activeUsageCount: 1 },
    });
    await order(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INSUFFICIENT_STOCK'));
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
  });
  it('rolls back stock if global coupon quota is exhausted', async () => {
    const f = await fixture({ coupon: { usageLimit: 1, activeUsageCount: 1 } });
    await order(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('COUPON_UNAVAILABLE'));
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(100);
    expect(
      await prisma.couponRedemption.count({ where: { userId: f.userId } }),
    ).toBe(0);
  });
  it('counts CONSUMED against per-user quota and rolls back the next Order', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await pay(f, r.body.id).expect(200);
    await order(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('COUPON_UNAVAILABLE'));
    const s = await state(f, r.body.id);
    expect(s.stock).toBe(99);
    expect(s.user.loyaltyPoints).toBe(9);
    expect(s.coupon.activeUsageCount).toBe(1);
  });
  it('accumulates points and honors a per-user limit greater than one', async () => {
    const f = await fixture({ points: 7, coupon: { perUserLimit: 2 } });
    for (let i = 0; i < 2; i++) {
      const r = await order(f).expect(201);
      await pay(f, r.body.id).expect(200);
    }
    await order(f)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('COUPON_UNAVAILABLE'));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
        .loyaltyPoints,
    ).toBe(25);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
        .activeUsageCount,
    ).toBe(2);
  });
  it('keeps HELD and points on FAILED/replay, then consumes and awards once on retry', async () => {
    const f = await fixture({ points: 7 });
    const r = await order(f).expect(201);
    const key = randomUUID();
    const card = '1234567890120002';
    const failed = await pay(f, r.body.id, key, card).expect(200);
    await pay(f, r.body.id, key, card).expect(200).expect(failed.body);
    let s = await state(f, r.body.id);
    expect(s.redemption?.status).toBe('HELD');
    expect(s.user.loyaltyPoints).toBe(7);
    expect(s.order.pointsEarned).toBe(0);
    expect(s.coupon.activeUsageCount).toBe(1);
    await pay(f, r.body.id).expect(200);
    s = await state(f, r.body.id);
    expect(s.redemption?.status).toBe('CONSUMED');
    expect(s.user.loyaltyPoints).toBe(16);
    expect(s.coupon.activeUsageCount).toBe(1);
    expect(s.attempts).toBe(2);
    expect(s.stock).toBe(99);
  });
  it('keeps Order amount, coupon snapshot and points after coupon configuration changes', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await prisma.coupon.update({
      where: { id: f.couponId },
      data: { code: `X${f.code}`, value: 1, expiresAt: new Date(1000) },
    });
    await pay(f, r.body.id)
      .expect(200)
      .expect((p) =>
        expect(p.body).toMatchObject({ amountVnd: 98000, pointsEarned: 9 }),
      );
    const h = await request(app!.getHttpServer())
      .get('/orders/me')
      .set('Authorization', `Bearer ${f.token}`)
      .expect(200);
    expect(h.body.items[0]).toMatchObject({
      couponCode: f.code,
      discountVnd: 20000,
      totalVnd: 98000,
      pointsEarned: 9,
    });
  });
  it('rolls back PAID if HELD redemption is missing and permits same-key retry after repair', async () => {
    const f = await fixture({ points: 7 });
    const r = await order(f).expect(201);
    const key = randomUUID();
    await prisma.couponRedemption.delete({ where: { orderId: r.body.id } });
    await pay(f, r.body.id, key)
      .expect(500)
      .expect((p) => expect(p.body.code).toBe('INTERNAL_ERROR'));
    let s = await state(f, r.body.id);
    expect(s.order.status).toBe('PENDING');
    expect(s.attempts).toBe(0);
    expect(s.user.loyaltyPoints).toBe(7);
    await prisma.couponRedemption.create({
      data: { orderId: r.body.id, userId: f.userId, couponId: f.couponId },
    });
    await pay(f, r.body.id, key).expect(200);
    s = await state(f, r.body.id);
    expect(s.user.loyaltyPoints).toBe(16);
    expect(s.attempts).toBe(1);
  });
  it('rolls back coupon consumption when points overflow', async () => {
    const f = await fixture({ points: 2147483647 });
    const r = await order(f).expect(201);
    await pay(f, r.body.id).expect(500);
    const s = await state(f, r.body.id);
    expect(s.order.status).toBe('PENDING');
    expect(s.order.pointsEarned).toBe(0);
    expect(s.redemption?.status).toBe('HELD');
    expect(s.user.loyaltyPoints).toBe(2147483647);
    expect(s.attempts).toBe(0);
  });
  it('releases a cancelled coupon once and excludes RELEASED from per-user quota', async () => {
    const f = await fixture({ coupon: { usageLimit: 1 } });
    const r = await order(f).expect(201);
    expect(await cancelCoupon(r.body.id)).toBe(true);
    expect(await cancelCoupon(r.body.id)).toBe(false);
    const s = await state(f, r.body.id);
    expect(s.redemption?.status).toBe('RELEASED');
    expect(s.redemption?.releasedAt).toBeInstanceOf(Date);
    expect(s.coupon.activeUsageCount).toBe(0);
    expect(s.user.loyaltyPoints).toBe(0);
    await order(f).expect(201);
  });
  it('rolls back cancellation if a coupon reservation is missing', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await prisma.couponRedemption.delete({ where: { orderId: r.body.id } });
    await expect(cancelCoupon(r.body.id)).rejects.toThrow(
      'reservation is missing',
    );
    const s = await state(f, r.body.id);
    expect(s.order.status).toBe('PENDING');
    expect(s.coupon.activeUsageCount).toBe(1);
  });
  it('does not release CONSUMED quota or commit cancellation of a paid Order', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await pay(f, r.body.id).expect(200);
    await expect(cancelCoupon(r.body.id)).rejects.toThrow('Consumed coupon');
    const s = await state(f, r.body.id);
    expect(s.order.status).toBe('PAID');
    expect(s.redemption?.status).toBe('CONSUMED');
    expect(s.coupon.activeUsageCount).toBe(1);
    expect(s.user.loyaltyPoints).toBe(9);
  });
  it('refuses release before cancellation', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await expect(
      prisma.$transaction((tx) => releaseHeldCoupon(tx, r.body.id)),
    ).rejects.toThrow('CANCELLED');
    expect((await state(f, r.body.id)).redemption?.status).toBe('HELD');
  });
  it('rolls back cancellation and release if coupon counter is inconsistent', async () => {
    const f = await fixture();
    const r = await order(f).expect(201);
    await prisma.coupon.update({
      where: { id: f.couponId },
      data: { activeUsageCount: 0 },
    });
    await expect(cancelCoupon(r.body.id)).rejects.toThrow('inconsistent');
    const s = await state(f, r.body.id);
    expect(s.order.status).toBe('PENDING');
    expect(s.redemption?.status).toBe('HELD');
  });
  describe.skipIf(process.env.PAYMENT_CONCURRENCY_TESTS !== '1')(
    'PostgreSQL coupon concurrency',
    () => {
      it('reserves the last global slot for only one Customer', async () => {
        const f = await fixture({ coupon: { usageLimit: 1 } });
        const other = await fixture();
        const g = { ...other, couponId: f.couponId, code: f.code };
        const results = await Promise.all([order(f), order(g)]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409,
        ]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'COUPON_UNAVAILABLE',
        );
        expect(
          (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
            .activeUsageCount,
        ).toBe(1);
        expect(
          await prisma.couponRedemption.count({
            where: { couponId: f.couponId },
          }),
        ).toBe(1);
        const loser = results[0].status === 409 ? f : g;
        expect(
          (
            await prisma.product.findUniqueOrThrow({
              where: { id: loser.productId },
            })
          ).stock,
        ).toBe(100);
      });
      it('does not reserve twice for simultaneous Orders of one Customer', async () => {
        const f = await fixture();
        const results = await Promise.all([order(f), order(f)]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409,
        ]);
        expect(['PENDING_ORDER_EXISTS', 'COUPON_UNAVAILABLE']).toContain(
          results.find((r) => r.status === 409)!.body.code,
        );
        expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(
          1,
        );
        expect(
          (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
            .activeUsageCount,
        ).toBe(1);
        expect(
          (
            await prisma.product.findUniqueOrThrow({
              where: { id: f.productId },
            })
          ).stock,
        ).toBe(99);
      });
      it('serializes repeated cancellation coupon release without double decrement', async () => {
        const f = await fixture();
        const r = await order(f).expect(201);
        const results = await Promise.all([
          cancelCoupon(r.body.id),
          cancelCoupon(r.body.id),
        ]);
        expect(results.sort()).toEqual([false, true]);
        const s = await state(f, r.body.id);
        expect(s.redemption?.status).toBe('RELEASED');
        expect(s.coupon.activeUsageCount).toBe(0);
        expect(s.user.loyaltyPoints).toBe(0);
      });
    },
  );
});
