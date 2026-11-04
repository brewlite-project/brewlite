import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { promotionCouponCreateManyArgs } from '../src/promotions/promotion-seed-data.js';

type Customer = { userId: string; token: string };
type CartItem = {
  productId: string;
  size: 'S' | 'M' | 'L' | 'ONE_SIZE';
  quantity: number;
  toppingIds: string[];
};
type Fixture = Customer & {
  productId: string;
  couponId: string;
  code: string;
  basePriceVnd: bigint;
  startingUsageCount: number;
};

describe('SCRUM-96 Coupon Preview and ZERO_AMOUNT PostgreSQL HTTP integration', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let jwt: JwtService;
  const categoryId = randomUUID();
  const users: string[] = [];
  const products: string[] = [];
  const toppings: string[] = [];
  const coupons: string[] = [];
  const touchedExistingCoupons = new Set<string>();

  beforeAll(async () => {
    const url = process.env.ORDERS_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to a migrated PostgreSQL test database.',
      );
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!/^brewlite(?:_[a-z0-9]+)*_test$/i.test(databaseName))
      throw new Error(
        'Coupon preview integration requires a dedicated BrewLite *_test database.',
      );
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'false');
    vi.stubEnv('ORDER_EXPIRATION_ENABLED', 'false');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = module.get(PrismaService);
    jwt = module.get(JwtService);
    app = module.createNestApplication({ logger: false });
    await app.init();
    await prisma.category.create({
      data: { id: categoryId, code: categoryId, name: 'SCRUM-96 test' },
    });
  });

  afterAll(async () => {
    try {
      if (prisma) {
        const where = { userId: { in: users } };
        const ownRedemptions = await prisma.couponRedemption.findMany({
          where,
          select: { couponId: true },
        });
        await prisma.payment.deleteMany({ where });
        await prisma.couponRedemption.deleteMany({ where });
        for (const couponId of touchedExistingCoupons) {
          const redeemedByTest = ownRedemptions.filter(
            (redemption) => redemption.couponId === couponId,
          ).length;
          if (redeemedByTest > 0) {
            const restored = await prisma.coupon.updateMany({
              where: { id: couponId, activeUsageCount: { gte: redeemedByTest } },
              data: { activeUsageCount: { decrement: redeemedByTest } },
            });
            if (restored.count !== 1)
              throw new Error('Unable to restore test usage on existing Coupon');
          }
        }
        await prisma.orderItemTopping.deleteMany({
          where: { orderItem: { order: where } },
        });
        await prisma.orderItem.deleteMany({ where: { order: where } });
        await prisma.order.deleteMany({ where });
        await prisma.productTopping.deleteMany({
          where: { productId: { in: products } },
        });
        await prisma.coupon.deleteMany({ where: { id: { in: coupons } } });
        await prisma.product.deleteMany({ where: { id: { in: products } } });
        await prisma.topping.deleteMany({ where: { id: { in: toppings } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
    }
  });

  async function fixture(options: {
    price?: bigint;
    code?: string;
    coupon?: Partial<Prisma.CouponUncheckedCreateInput>;
  } = {}): Promise<Fixture> {
    const userId = randomUUID();
    users.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `scrum96-${userId}@example.com`,
        passwordHash: 'test-only-no-login',
        loyaltyPoints: 0,
      },
    });
    const productId = randomUUID();
    products.push(productId);
    const basePriceVnd = options.price ?? 100000n;
    await prisma.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Coupon preview test drink',
        imageUrl: '/test',
        basePriceVnd,
        stock: 10,
      },
    });
    const code = options.code ?? `C${randomUUID().replaceAll('-', '').slice(0, 20)}`.toUpperCase();
    const existing = await prisma.coupon.findUnique({ where: { code } });
    const couponId = existing?.id ?? randomUUID();
    if (
      existing &&
      (existing.type !== 'PERCENT' ||
        existing.value !== 100 ||
        existing.minSubtotalVnd > basePriceVnd ||
        (existing.maxDiscountVnd !== null &&
          existing.maxDiscountVnd < basePriceVnd) ||
        existing.startsAt > new Date() ||
        existing.expiresAt <= new Date() ||
        existing.activeUsageCount >= existing.usageLimit)
    )
      throw new Error('Existing FREE100 is not available for the integration flow');
    if (existing) {
      touchedExistingCoupons.add(existing.id);
    } else {
      coupons.push(couponId);
      await prisma.coupon.create({
        data: {
          id: couponId,
          code,
          type: 'PERCENT',
          value: 100,
          minSubtotalVnd: 0n,
          startsAt: new Date(0),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          usageLimit: 10,
          perUserLimit: 1,
          ...options.coupon,
        },
      });
    }
    return {
      userId,
      token: await jwt.signAsync({ sub: userId }),
      productId,
      couponId,
      code,
      basePriceVnd,
      startingUsageCount: existing?.activeUsageCount ?? 0,
    };
  }

  function cart(f: Fixture): CartItem[] {
    return [
      { productId: f.productId, size: 'S', quantity: 1, toppingIds: [] },
    ];
  }

  function preview(f: Fixture, body: object = { couponCode: f.code, items: cart(f) }) {
    return request(app!.getHttpServer())
      .post('/coupons/preview')
      .set('Authorization', `Bearer ${f.token}`)
      .send(body);
  }

  function createOrder(f: Fixture, items: CartItem[] = cart(f)) {
    return request(app!.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ items, couponCode: f.code });
  }

  function payZero(f: Customer, orderId: string, key: string) {
    return request(app!.getHttpServer())
      .post('/payments/zero-amount')
      .set('Authorization', `Bearer ${f.token}`)
      .set('Idempotency-Key', key)
      .send({ orderId });
  }

  async function waitForBlockedBy(blockerPid: number) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const [state] = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND ${blockerPid} = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%coupons%'
        ) AS waiting`;
      if (state?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Create Order did not wait on the held Coupon row lock');
  }

  it('previews without side effects, creates a FREE100 Order, and settles through ZERO_AMOUNT only', async () => {
    expect(process.env.MOCK_PAYMENT_ENABLED).toBe('false');
    const f = await fixture({ code: 'FREE100' });
    const item = cart(f)[0]!;
    const previewBody = await preview(f, {
      couponCode: ` ${f.code.toLowerCase()} `,
      items: cart(f),
      userId: 'attacker',
      subtotalVnd: 1,
      amountVnd: 1,
      discountVnd: 1,
      totalVnd: 1,
      valid: false,
    })
      .expect(200)
      .then((response) => response.body);
    expect(previewBody).toEqual({
      couponCode: f.code,
      subtotalVnd: Number(f.basePriceVnd),
      discountVnd: Number(f.basePriceVnd),
      totalVnd: 0,
      valid: true,
    });
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      await prisma.couponRedemption.count({ where: { userId: f.userId } }),
    ).toBe(0);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
        .activeUsageCount,
    ).toBe(f.startingUsageCount);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(10);

    const order = await request(app!.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        items: [item],
        couponCode: ` ${f.code.toLowerCase()} `,
        userId: 'attacker',
        subtotalVnd: 1,
        discountVnd: 1,
        totalVnd: 1,
      })
      .expect(201);
    expect(order.body).toMatchObject({
      couponCode: f.code,
      subtotalVnd: Number(f.basePriceVnd),
      discountVnd: Number(f.basePriceVnd),
      totalVnd: 0,
    });
    const orderId = order.body.id as string;
    expect(
      (await prisma.couponRedemption.findUniqueOrThrow({
        where: { orderId },
      })).status,
    ).toBe('HELD');
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(9);

    const key = randomUUID();
    const payment = await payZero(f, orderId, key).expect(201);
    expect(payment.body).toMatchObject({
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      amountVnd: 0,
      pointsEarned: 0,
    });
    await payZero(f, orderId, key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(payment.body);

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    const finalCoupon = await prisma.coupon.findUniqueOrThrow({
      where: { id: f.couponId },
    });
    const redemption = await prisma.couponRedemption.findUniqueOrThrow({
      where: { orderId },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: f.userId },
    });
    expect(finalOrder.status).toBe('PAID');
    expect(finalOrder.pointsEarned).toBe(0);
    expect(finalCoupon.activeUsageCount).toBe(f.startingUsageCount + 1);
    expect(redemption.status).toBe('CONSUMED');
    expect(user.loyaltyPoints).toBe(0);
    expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { orderId } })).provider,
    ).toBe('ZERO_AMOUNT');
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(9);

    const originalExpiry = finalCoupon.expiresAt;
    const changedSeedDefinition = {
      code: f.code,
      type: 'FIXED' as const,
      value: 1,
      minSubtotalVnd: 999999n,
      maxDiscountVnd: null,
      startsAt: new Date('2098-01-01T00:00:00.000Z'),
      expiresAt: new Date('2098-02-01T00:00:00.000Z'),
      usageLimit: 1,
      perUserLimit: 1,
    };
    await prisma.coupon.createMany(
      promotionCouponCreateManyArgs([changedSeedDefinition]),
    );
    const afterSeedRerun = await prisma.coupon.findUniqueOrThrow({
      where: { id: f.couponId },
    });
    expect(afterSeedRerun.expiresAt).toEqual(originalExpiry);
    expect(afterSeedRerun.activeUsageCount).toBe(f.startingUsageCount + 1);
    expect(
      (await prisma.couponRedemption.findUniqueOrThrow({
        where: { orderId },
      })).status,
    ).toBe('CONSUMED');
  });

  it('returns contract errors and rejects bad cart data instead of a successful invalid preview', async () => {
    const f = await fixture();
    await preview(f, { couponCode: 'MISSING', items: cart(f) })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('INVALID_COUPON'));
    await preview(f, {
      couponCode: f.code,
      items: [{ ...cart(f)[0]!, size: 'ONE_SIZE' }],
    })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('INVALID_CART'));
    await preview(f, {
      couponCode: f.code,
      items: [{ ...cart(f)[0]!, quantity: 0 }],
    })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('VALIDATION_ERROR'));
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
  });

  it.each([
    {
      label: 'before startsAt',
      coupon: { startsAt: new Date('2098-01-01T00:00:00.000Z') },
      message: 'Coupon is not active yet',
    },
    {
      label: 'at expiresAt',
      coupon: { expiresAt: new Date(1000) },
      message: 'Coupon has expired',
    },
    {
      label: 'below minSubtotalVnd',
      coupon: { minSubtotalVnd: 100001n },
      message: 'Order subtotal does not meet coupon minimum',
    },
  ])('rejects preview $label', async ({ coupon: changes, message }) => {
    const f = await fixture({ coupon: changes });
    await preview(f)
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'INVALID_COUPON',
          message,
        });
      });
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(10);
  });

  it('rejects preview when this Customer already has a HELD redemption', async () => {
    const f = await fixture({ coupon: { usageLimit: 10 } });
    const order = await createOrder(f).expect(201);
    await preview(f)
      .expect(409)
      .expect((response) =>
        expect(response.body.code).toBe('COUPON_UNAVAILABLE'),
      );
    expect(
      (await prisma.couponRedemption.findUniqueOrThrow({
        where: { orderId: order.body.id },
      })).status,
    ).toBe('HELD');
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
        .activeUsageCount,
    ).toBe(1);
  });

  it('rejects preview when the global active usage count is exhausted', async () => {
    const f = await fixture({ coupon: { usageLimit: 1, activeUsageCount: 1 } });
    await preview(f)
      .expect(409)
      .expect((response) =>
        expect(response.body.code).toBe('COUPON_UNAVAILABLE'),
      );
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      await prisma.couponRedemption.count({ where: { userId: f.userId } }),
    ).toBe(0);
  });

  it('rechecks global quota at Create Order after a previously valid preview', async () => {
    const f = await fixture({ coupon: { usageLimit: 1 } });
    await preview(f).expect(200);
    await prisma.coupon.update({
      where: { id: f.couponId },
      data: { activeUsageCount: 1 },
    });

    await createOrder(f)
      .expect(409)
      .expect((response) =>
        expect(response.body.code).toBe('COUPON_UNAVAILABLE'),
      );
    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      await prisma.couponRedemption.count({ where: { userId: f.userId } }),
    ).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(10);
  });

  it('rounds size half-up before adding toppings, shares price with Create Order, and preserves old snapshots', async () => {
    const f = await fixture({ price: 10003n, coupon: { value: 20 } });
    const historical = await fixture({ price: 10003n });
    const historicalOrder = await prisma.order.create({
      data: {
        userId: historical.userId,
        status: 'PENDING',
        subtotalVnd: 12003n,
        discountVnd: 0n,
        totalVnd: 12003n,
        expiresAt: new Date(Date.now() + 15 * 60_000),
        items: {
          create: {
            productId: historical.productId,
            productNameSnapshot: 'Historical price snapshot',
            size: 'M',
            sizePercentSnapshot: 120,
            basePriceSnapshotVnd: 10003n,
            quantity: 1,
            unitPriceVnd: 12003n,
            lineTotalVnd: 12003n,
          },
        },
      },
    });
    const toppingId = randomUUID();
    toppings.push(toppingId);
    await prisma.topping.create({
      data: {
        id: toppingId,
        code: `S96-${randomUUID()}`,
        name: 'Half-up pricing test topping',
        priceVnd: 500n,
      },
    });
    await prisma.productTopping.create({
      data: { productId: f.productId, toppingId },
    });
    const items: CartItem[] = [
      { productId: f.productId, size: 'M', quantity: 1, toppingIds: [toppingId] },
    ];
    const previewResponse = await preview(f, {
      couponCode: f.code,
      items,
    }).expect(200);
    const orderResponse = await createOrder(f, items).expect(201);
    expect(previewResponse.body).toMatchObject({
      subtotalVnd: 12504,
      discountVnd: 2501,
      totalVnd: 10003,
    });
    expect(orderResponse.body).toMatchObject({
      subtotalVnd: previewResponse.body.subtotalVnd,
      discountVnd: previewResponse.body.discountVnd,
      totalVnd: previewResponse.body.totalVnd,
      items: [
        {
          size: 'M',
          sizeMultiplierPercent: 120,
          basePriceVnd: 10003,
          quantity: 1,
          unitPriceVnd: 12504,
          lineTotalVnd: 12504,
          toppings: [{ id: toppingId, priceVnd: 500 }],
        },
      ],
    });
    const historicalAfter = await prisma.order.findUniqueOrThrow({
      where: { id: historicalOrder.id },
      include: { items: true },
    });
    expect(historicalAfter).toMatchObject({
      subtotalVnd: 12003n,
      totalVnd: 12003n,
      items: [
        {
          basePriceSnapshotVnd: 10003n,
          unitPriceVnd: 12003n,
          lineTotalVnd: 12003n,
        },
      ],
    });
  });

  it('revalidates changed coupon expiry after waiting for the PostgreSQL Coupon lock', async () => {
    const f = await fixture();
    await preview(f).expect(200);

    let ready!: (pid: number) => void;
    let release!: () => void;
    const lockReady = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`
        SELECT id FROM coupons WHERE id = ${f.couponId}::uuid FOR UPDATE`;
      if (!backend) throw new Error('Missing PostgreSQL backend PID');
      ready(backend.pid);
      await gate;
      await tx.coupon.update({
        where: { id: f.couponId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    });

    let orderRequest: Promise<request.Response> | undefined;
    try {
      const blockerPid = await lockReady;
      orderRequest = createOrder(f).then((response) => response);
      await waitForBlockedBy(blockerPid);
      release();
      const response = await orderRequest;
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_COUPON');
      await holder;
    } finally {
      release();
      await Promise.allSettled([holder, ...(orderRequest ? [orderRequest] : [])]);
    }

    expect(await prisma.order.count({ where: { userId: f.userId } })).toBe(0);
    expect(
      await prisma.couponRedemption.count({ where: { userId: f.userId } }),
    ).toBe(0);
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } }))
        .activeUsageCount,
    ).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: f.productId } }))
        .stock,
    ).toBe(10);
  });

  it('documents JWT, request/response shape, 200 and existing error statuses in Swagger', async () => {
    const document = SwaggerModule.createDocument(
      app!,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const operation = document.paths['/coupons/preview'].post!;
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '409',
      '500',
    ]);
    expect(document.components?.schemas?.CouponPreviewDto).toMatchObject({
      required: ['couponCode', 'items'],
      properties: {
        couponCode: { type: 'string', maxLength: 30 },
        items: { type: 'array' },
      },
    });
    expect(
      document.components?.schemas?.CouponPreviewResponseDto,
    ).toMatchObject({
      properties: {
        couponCode: { type: 'string' },
        subtotalVnd: { type: 'number' },
        discountVnd: { type: 'number' },
        totalVnd: { type: 'number' },
        valid: { enum: [true] },
      },
    });
  });
});
