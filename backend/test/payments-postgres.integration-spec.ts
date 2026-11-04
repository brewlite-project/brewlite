import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

type Fixture = {
  userId: string;
  orderId: string;
  token: string;
  couponId: string | null;
};
const runId = randomUUID();
const categoryId = randomUUID();
const productId = randomUUID();
const users: string[] = [];
const coupons: string[] = [];
const fullCard = '1234567890121234';

describe('Payments real database transactions', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService;
  let jwt: JwtService;
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
    await prisma.payment.count();
    await prisma.category.create({
      data: {
        id: categoryId,
        code: `test-${runId}`,
        name: 'Payment test category',
      },
    });
    await prisma.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Payment test product',
        basePriceVnd: 49000n,
        imageUrl: '/test.svg',
        stock: 8,
      },
    });
  });
  afterAll(async () => {
    try {
      if (prisma && users.length) {
        await prisma.payment.deleteMany({ where: { userId: { in: users } } });
        await prisma.couponRedemption.deleteMany({
          where: { userId: { in: users } },
        });
        await prisma.orderItem.deleteMany({
          where: { order: { userId: { in: users } } },
        });
        await prisma.order.deleteMany({ where: { userId: { in: users } } });
        await prisma.coupon.deleteMany({ where: { id: { in: coupons } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
      }
      if (prisma) {
        await prisma.product.deleteMany({ where: { id: productId } });
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
    }
  });

  async function fixture(
    options: {
      coupon?: boolean;
      status?: 'PENDING' | 'PAYMENT_FAILED' | 'CANCELLED';
      total?: bigint;
      expired?: boolean;
      points?: number;
    } = {},
  ): Promise<Fixture> {
    const userId = randomUUID();
    users.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `payment-${userId}@example.com`,
        passwordHash: 'test-only-no-login',
        loyaltyPoints: options.points ?? 0,
      },
    });
    let couponId: string | null = null;
    if (options.coupon) {
      couponId = randomUUID();
      coupons.push(couponId);
      await prisma.coupon.create({
        data: {
          id: couponId,
          code: couponId.slice(0, 30),
          type: 'FIXED',
          value: 1000,
          startsAt: new Date(Date.now() - 60000),
          expiresAt: new Date(Date.now() + 3600000),
          usageLimit: 10,
          activeUsageCount: 1,
        },
      });
    }
    const order = await prisma.order.create({
      data: {
        userId,
        couponId,
        status: options.status ?? 'PENDING',
        subtotalVnd: options.total ?? 98000n,
        totalVnd: options.total ?? 98000n,
        expiresAt: new Date(Date.now() + (options.expired ? -1000 : 900000)),
        items: {
          create: {
            productId,
            productNameSnapshot: 'Payment test product',
            size: 'S',
            sizePercentSnapshot: 100,
            basePriceSnapshotVnd: 49000n,
            unitPriceVnd: 49000n,
            quantity: 2,
            lineTotalVnd: 98000n,
          },
        },
      },
    });
    // Build deadline in PostgreSQL, the same clock used by PaymentsService.
    // This keeps fixtures valid even when the workstation and database clocks differ.
    await prisma.$executeRaw`
      UPDATE orders
      SET expires_at = clock_timestamp() + (${options.expired ? -1000 : 900000} * INTERVAL '1 millisecond')
      WHERE id = ${order.id}::uuid`;
    if (couponId)
      await prisma.couponRedemption.create({
        data: { couponId, orderId: order.id, userId },
      });
    return {
      userId,
      orderId: order.id,
      couponId,
      token: await jwt.signAsync({ sub: userId }),
    };
  }
  function pay(
    f: Fixture,
    key: string = randomUUID(),
    details: object = { cardNumber: fullCard },
    method = 'CARD',
    extra: object = {},
  ) {
    return request(app!.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${f.token}`)
      .set('Idempotency-Key', key)
      .send({ orderId: f.orderId, method, paymentDetails: details, ...extra });
  }
  async function count(f: Fixture) {
    return prisma.payment.count({ where: { orderId: f.orderId } });
  }

  describe('SCRUM-85 Mock environment and cross-provider policy', () => {
    afterEach(() => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    });

    async function state(f: Fixture) {
      return {
        order: await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } }),
        payments: await prisma.payment.findMany({
          where: { orderId: f.orderId },
        }),
        user: await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }),
        product: await prisma.product.findUniqueOrThrow({
          where: { id: productId },
        }),
        coupon: f.couponId
          ? await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId } })
          : null,
        redemptions: await prisma.couponRedemption.findMany({
          where: { orderId: f.orderId },
        }),
      };
    }

    it.each([
      ['test', undefined],
      ['test', 'false'],
      ['test', 'TRUE'],
      ['production', 'true'],
    ])(
      'rejects a new attempt without side effects: %s, flag %s',
      async (environment, flag) => {
        const f = await fixture({ coupon: true, points: 10 });
        const before = await state(f);
        vi.stubEnv('NODE_ENV', environment);
        vi.stubEnv('MOCK_PAYMENT_ENABLED', flag);
        await pay(f)
          .expect(403)
          .expect((r) => expect(r.body.code).toBe('MOCK_PAYMENT_DISABLED'));
        expect(await state(f)).toEqual(before);
      },
    );

    it.each(['SUCCESS', 'FAILED'])(
      'blocks an actual saved %s receipt after disabling Mock, then permits replay when re-enabled',
      async (status) => {
        const f = await fixture({ coupon: true });
        const key = randomUUID();
        const details = {
          cardNumber: status === 'SUCCESS' ? fullCard : '1234567890120002',
        };
        const first = await pay(f, key, details).expect(200);
        expect(first.body.paymentStatus).toBe(status);
        // Old receipts remain immutable even after expiry and a policy change.
        await prisma.order.update({
          where: { id: f.orderId },
          data: { expiresAt: new Date(0) },
        });
        const before = await state(f);
        for (const [environment, flag] of [
          ['production', 'true'],
          ['test', 'false'],
        ]) {
          vi.stubEnv('NODE_ENV', environment);
          vi.stubEnv('MOCK_PAYMENT_ENABLED', flag);
          const denied = await pay(f, key, details).expect(403);
          expect(denied.body.code).toBe('MOCK_PAYMENT_DISABLED');
          expect(denied.headers['idempotency-replayed']).toBeUndefined();
          expect(await state(f)).toEqual(before);
        }
        vi.stubEnv('NODE_ENV', 'test');
        vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
        await pay(f, key, details)
          .expect(200)
          .expect('Idempotency-Replayed', 'true')
          .expect(first.body);
        expect(await state(f)).toEqual(before);
      },
    );

    async function priorVnpay(
      f: Fixture,
      options: {
        failed?: boolean;
        error?: string;
        review?: boolean;
        exception?: boolean;
      } = {},
    ) {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: f.orderId },
      });
      const [clock] = await prisma.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      return prisma.payment.create({
        data: {
          orderId: f.orderId,
          userId: f.userId,
          idempotencyKey: randomUUID(),
          requestHash: 'vnpay-policy-fixture',
          provider: 'VNPAY',
          status: options.failed ? 'FAILED' : 'PENDING',
          amountVnd: order.totalVnd,
          vnpTxnRef: randomUUID().replaceAll('-', ''),
          vnpTmnCode: 'POLICY_TEST',
          vnpCreateDate: '20261103120000',
          gatewayExpiresAt: order.expiresAt,
          initiationSnapshot: { schemaVersion: 1, fixture: true },
          reconcileUntil: new Date(order.expiresAt.getTime() + 65 * 60_000),
          reconciliationState: options.review
            ? 'REQUIRES_REVIEW'
            : options.failed
              ? 'RESOLVED'
              : 'SCHEDULED',
          nextQueryAt: options.review || options.failed ? null : order.expiresAt,
          reviewReason: options.review ? 'Policy test: unresolved outcome' : null,
          hasFinancialException: options.exception ?? false,
          lastQueryError: options.error ?? null,
          queryAttempts: options.error ? 1 : 0,
          lastQueryAt: options.error ? clock.now : null,
          lastQueryRequestId: options.error ? randomUUID() : null,
          ...(options.failed
            ? {
                finalOutcomeSnapshot: { outcome: 'FAILED' },
                verifiedAt: clock.now,
                finalizedAt: clock.now,
              }
            : {}),
        },
      });
    }

    it.each([
      { options: {}, code: 'PAYMENT_IN_PROGRESS' },
      { options: { error: 'TIMEOUT' }, code: 'PAYMENT_IN_PROGRESS' },
      { options: { error: 'NETWORK_ERROR' }, code: 'PAYMENT_IN_PROGRESS' },
      { options: { review: true }, code: 'FINANCIAL_EXCEPTION_REQUIRES_REVIEW' },
      {
        options: { failed: true, review: true, exception: true },
        code: 'FINANCIAL_EXCEPTION_REQUIRES_REVIEW',
      },
    ])(
      'blocks a direct Mock attempt for unresolved/exception VNPay: $options',
      async ({ options, code }) => {
        const f = await fixture({ coupon: true });
        await priorVnpay(f, options);
        const before = await state(f);
        await pay(f)
          .expect(409)
          .expect((r) => expect(r.body.code).toBe(code));
        expect(await state(f)).toEqual(before);
      },
    );

    it('allows an explicitly requested Mock attempt after terminal VNPay FAILED while Order remains valid', async () => {
      const f = await fixture({ status: 'PAYMENT_FAILED' });
      const prior = await priorVnpay(f, { failed: true });
      await pay(f)
        .expect(200)
        .expect((r) => expect(r.body.paymentStatus).toBe('SUCCESS'));
      expect(await count(f)).toBe(2);
      expect(
        await prisma.payment.findUniqueOrThrow({ where: { id: prior.id } }),
      ).toEqual(prior);
    });
  });

  it('persists SUCCESS, safe snapshot, PAID and points atomically using server amount; consumes coupon once', async () => {
    const f = await fixture({ coupon: true });
    const key = randomUUID();
    const result = await pay(f, key, undefined, undefined, {
      userId: 'attacker',
      amount: 1,
      status: 'FAILED',
      pointsEarned: 999,
    })
      .expect((response) => {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      })
      .expect('Idempotency-Replayed', 'false');
    expect(result.body).toMatchObject({
      orderId: f.orderId,
      amountVnd: 98000,
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 9,
      methodLast4: '1234',
      failureReason: null,
    });
    expect(Object.keys(result.body).sort()).toEqual(
      [
        'paymentId',
        'orderId',
        'paymentStatus',
        'orderStatus',
        'amountVnd',
        'method',
        'methodLast4',
        'mockReference',
        'pointsEarned',
        'failureReason',
        'createdAt',
      ].sort(),
    );
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: result.body.paymentId },
    });
    expect(row.responseSnapshot).toEqual(result.body);
    expect(row.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(row, (_k, v: unknown) =>
        typeof v === 'bigint' ? String(v) : v,
      ),
    ).not.toContain(fullCard);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } }))
        .status,
    ).toBe('PAID');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
        .loyaltyPoints,
    ).toBe(9);
    expect(
      (
        await prisma.couponRedemption.findUniqueOrThrow({
          where: { orderId: f.orderId },
        })
      ).status,
    ).toBe('CONSUMED');
    expect(
      (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId! } }))
        .activeUsageCount,
    ).toBe(1);
    await pay(f, key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(result.body);
    expect(await count(f)).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
        .loyaltyPoints,
    ).toBe(9);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .stock,
    ).toBe(8);
  });
  it.each([
    ['CARD', { cardNumber: '1234567890120002' }],
    ['WALLET', { phoneNumber: '0912340000' }],
  ] as const)(
    'persists %s FAILED, retaining coupon/stock/points; retries SUCCESS with a new key',
    async (method, details) => {
      const f = await fixture({ coupon: true });
      const key = randomUUID();
      const failed = await pay(f, key, details, method).expect(200);
      expect(failed.body).toMatchObject({
        paymentStatus: 'FAILED',
        orderStatus: 'PAYMENT_FAILED',
        pointsEarned: 0,
        failureReason: 'PAYMENT_DECLINED',
      });
      await pay(f, key, details, method)
        .expect(200)
        .expect('Idempotency-Replayed', 'true')
        .expect(failed.body);
      expect(
        (
          await prisma.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          })
        ).status,
      ).toBe('HELD');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
          .loyaltyPoints,
      ).toBe(0);
      await pay(f)
        .expect(200)
        .expect((r) => {
          expect(r.body.paymentStatus).toBe('SUCCESS');
        });
      expect(await count(f)).toBe(2);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
          .loyaltyPoints,
      ).toBe(9);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(8);
    },
  );
  it('supports WALLET success for a positive amount', async () => {
    const f = await fixture();
    const r = await pay(
      f,
      undefined,
      { phoneNumber: '0912345678' },
      'WALLET',
    ).expect(200);
    expect(r.body).toMatchObject({
      paymentStatus: 'SUCCESS',
      method: 'WALLET',
      amountVnd: 98000,
      pointsEarned: 9,
      methodLast4: '5678',
    });
  });
  it('rejects zero-VND through Mock without payment-side effects', async () => {
    const f = await fixture({ total: 0n, coupon: true });
    const before = {
      order: await prisma.order.findUniqueOrThrow({
        where: { id: f.orderId },
      }),
      redemption: await prisma.couponRedemption.findUnique({
        where: { orderId: f.orderId },
      }),
      coupon: await prisma.coupon.findUniqueOrThrow({
        where: { id: f.couponId! },
      }),
      user: await prisma.user.findUniqueOrThrow({
        where: { id: f.userId },
      }),
      stock: (
        await prisma.product.findUniqueOrThrow({
          where: { id: productId },
        })
      ).stock,
      attempts: await count(f),
    };
    const rejected = await pay(
      f,
      randomUUID(),
      { phoneNumber: '0912345678' },
      'WALLET',
    ).expect(409);
    expect(rejected.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'INVALID_TRANSITION',
      message: 'Order cannot accept a new payment',
    });
    expect({
      order: await prisma.order.findUniqueOrThrow({
        where: { id: f.orderId },
      }),
      redemption: await prisma.couponRedemption.findUnique({
        where: { orderId: f.orderId },
      }),
      coupon: await prisma.coupon.findUniqueOrThrow({
        where: { id: f.couponId! },
      }),
      user: await prisma.user.findUniqueOrThrow({
        where: { id: f.userId },
      }),
      stock: (
        await prisma.product.findUniqueOrThrow({
          where: { id: productId },
        })
      ).stock,
      attempts: await count(f),
    }).toEqual(before);
  });
  it('rejects key reuse with a different full credential despite the same last4', async () => {
    const f = await fixture();
    const key = randomUUID();
    await pay(f, key).expect(200);
    await pay(f, key, { cardNumber: '9999999999991234' })
      .expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
    expect(await count(f)).toBe(1);
  });
  it('ignores extra fields when comparing the canonical request', async () => {
    const f = await fixture();
    const key = randomUUID();
    const r = await pay(f, key).expect(200);
    await pay(f, key, { cardNumber: fullCard, mockResult: 'FAILED' }, 'CARD', {
      amount: 0,
      role: 'ADMIN',
    })
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(r.body);
  });
  it('replays FAILED snapshot after expiry/cancellation, before state validation', async () => {
    const f = await fixture();
    const key = randomUUID();
    const details = { cardNumber: '1234567890120002' };
    const r = await pay(f, key, details).expect(200);
    await prisma.order.update({
      where: { id: f.orderId },
      data: { status: 'CANCELLED', expiresAt: new Date(Date.now() - 1000) },
    });
    await pay(f, key, details)
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(r.body);
    await pay(f)
      .expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('INVALID_TRANSITION');
      });
  });
  it('replays SUCCESS after expiry and later preparation state, with original orderStatus', async () => {
    const f = await fixture();
    const key = randomUUID();
    const r = await pay(f, key).expect(200);
    await prisma.order.update({
      where: { id: f.orderId },
      data: { status: 'PREPARING', expiresAt: new Date(Date.now() - 1000) },
    });
    await pay(f, key).expect(200).expect(r.body);
  });
  it.each([{ expired: true }, { status: 'CANCELLED' as const }])(
    'rejects invalid state/expiry without creating attempts',
    async (options) => {
      const f = await fixture(options);
      await pay(f)
        .expect(409)
        .expect((r) => {
          expect(r.body.code).toBe('INVALID_TRANSITION');
        });
      expect(await count(f)).toBe(0);
    },
  );
  it('rejects another success with a new key', async () => {
    const f = await fixture();
    await pay(f).expect(200);
    await pay(f)
      .expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('INVALID_TRANSITION');
      });
    expect(await count(f)).toBe(1);
  });
  it('isolates ownership and user-scoped keys, including replay', async () => {
    const a = await fixture();
    const b = await fixture();
    const key = randomUUID();
    await pay(a, key).expect(200);
    await pay({ ...a, token: b.token }, key)
      .expect(404)
      .expect((r) => {
        expect(r.body.code).toBe('NOT_FOUND');
      });
    await pay({ ...b, orderId: randomUUID() }, key).expect(404);
    await pay(b, key).expect(200); // same key is independent across users
  });
  it('rolls back coupon mutation when points update fails; same key can retry after rollback', async () => {
    const f = await fixture({ coupon: true, points: 2147483647 });
    const key = randomUUID();
    await pay(f, key).expect(500).expect({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
    expect(await count(f)).toBe(0);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } }))
        .status,
    ).toBe('PENDING');
    expect(
      (
        await prisma.couponRedemption.findUniqueOrThrow({
          where: { orderId: f.orderId },
        })
      ).status,
    ).toBe('HELD');
    await prisma.user.update({
      where: { id: f.userId },
      data: { loyaltyPoints: 0 },
    });
    await pay(f, key).expect(200).expect('Idempotency-Replayed', 'false');
  });
  it('rejects unsafe monetary serialization and rolls back without an attempt', async () => {
    const f = await fixture({ total: 9007199254740993n });
    await pay(f)
      .expect(500)
      .expect((r) => {
        expect(r.body.code).toBe('INTERNAL_ERROR');
      });
    expect(await count(f)).toBe(0);
  });
  it('verifies the database partial SUCCESS index', async () => {
    const f = await fixture();
    const r = await pay(f).expect(200);
    await expect(
      prisma.payment.create({
        data: {
          orderId: f.orderId,
          userId: f.userId,
          idempotencyKey: randomUUID(),
          requestHash: 'test',
          amountVnd: 98000n,
          provider: 'MOCK',
          method: 'CARD',
          status: 'SUCCESS',
          responseSnapshot: r.body,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  describe('SCRUM-55 canonical requests and immutable receipts', () => {
    it('replays reordered fields, uppercase UUIDs and ignored extras', async () => {
      const f = await fixture({ coupon: true });
      const key = randomUUID();
      const first = await pay(f, key).expect(200);
      const token = await jwt.signAsync({ sub: f.userId.toUpperCase() });
      await request(app!.getHttpServer())
        .post('/payments')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          paymentDetails: { ignored: true, cardNumber: fullCard },
          method: 'CARD',
          orderId: f.orderId.toUpperCase(),
          pointsEarned: 999,
        })
        .expect(200)
        .expect('Idempotency-Replayed', 'true')
        .expect(first.body);
      expect(await count(f)).toBe(1);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
          .loyaltyPoints,
      ).toBe(9);
    });
    it('treats key casing as significant', async () => {
      const f = await fixture();
      const key = 'case-sensitive-key';
      await pay(f, key, { cardNumber: '1234567890120002' }).expect(200);
      await pay(f, key.toUpperCase(), { cardNumber: '1234567890120002' })
        .expect(200)
        .expect('Idempotency-Replayed', 'false');
      expect(await count(f)).toBe(2);
    });
    it.each([8, 64])(
      'accepts and replays a key of length %i',
      async (length) => {
        const f = await fixture();
        const key = 'k'.repeat(length);
        const first = await pay(f, key).expect(200);
        await pay(f, key)
          .expect(200)
          .expect('Idempotency-Replayed', 'true')
          .expect(first.body);
        expect(await count(f)).toBe(1);
      },
    );
    it('keeps FAILED receipt after a later attempt succeeds without repeating effects', async () => {
      const f = await fixture({ coupon: true });
      const key = randomUUID();
      const details = { cardNumber: '1234567890120002' };
      const failed = await pay(f, key, details).expect(200);
      await pay(f).expect(200);
      await pay(f, key, details)
        .expect(200)
        .expect('Idempotency-Replayed', 'true')
        .expect(failed.body);
      expect(await count(f)).toBe(2);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } }))
          .status,
      ).toBe('PAID');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
          .loyaltyPoints,
      ).toBe(9);
      expect(
        (
          await prisma.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          })
        ).status,
      ).toBe('CONSUMED');
      expect(
        (await prisma.coupon.findUniqueOrThrow({ where: { id: f.couponId! } }))
          .activeUsageCount,
      ).toBe(1);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .stock,
      ).toBe(8);
    });
    it('rejects reuse of a user key for another owned Order', async () => {
      const f = await fixture();
      const key = randomUUID();
      await pay(f, key).expect(200);
      const next = await prisma.order.create({
        data: {
          userId: f.userId,
          subtotalVnd: 98000n,
          totalVnd: 98000n,
          expiresAt: new Date(Date.now() + 900000),
        },
      });
      await pay({ ...f, orderId: next.id }, key)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
      expect(await prisma.payment.count({ where: { orderId: next.id } })).toBe(
        0,
      );
    });
    it('validates replay input and rejects a changed method', async () => {
      const f = await fixture();
      const key = randomUUID();
      await pay(f, key, { cardNumber: '1234567890120002' }).expect(200);
      await pay(f, key, { cardNumber: 'invalid' })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('VALIDATION_ERROR'));
      await pay(f, key, { phoneNumber: '0912345678' }, 'WALLET')
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
      expect(await count(f)).toBe(1);
    });
  });

  // Separate real-PostgreSQL connections are essential for lock/concurrency claims.
  describe.skipIf(process.env.PAYMENT_CONCURRENCY_TESTS !== '1')(
    'PostgreSQL concurrency (enable PAYMENT_CONCURRENCY_TESTS=1)',
    () => {
      async function withHeldLock(
        f: Fixture,
        key: string,
        orderLock: boolean,
        check: () => Promise<void>,
      ) {
        let release!: () => void;
        let ready!: () => void;
        let rejectReady!: (error: unknown) => void;
        let holderError: unknown;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Promise<void>((resolve, reject) => {
          ready = resolve;
          rejectReady = reject;
        });
        const holder = prisma
          .$transaction(
            async (tx) => {
              if (orderLock)
                await tx.$queryRaw`SELECT id FROM orders WHERE id = ${f.orderId}::uuid FOR UPDATE`;
              else
                await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([f.userId, key])}, 0))::text AS locked`;
              ready();
              await gate;
            },
            { timeout: 10000 },
          )
          .catch((error: unknown) => {
            holderError = error;
            rejectReady(error);
          });
        try {
          await held;
          await check();
        } finally {
          release();
          await holder;
        }
        if (holderError) throw holderError;
      }
      it('replays a committed receipt and detects conflict while its advisory key is held', async () => {
        const f = await fixture({ coupon: true });
        const key = randomUUID();
        const first = await pay(f, key).expect(200);
        await withHeldLock(f, key, false, async () => {
          await pay(f, key)
            .expect(200)
            .expect('Idempotency-Replayed', 'true')
            .expect(first.body);
          await pay(f, key, { cardNumber: '1234567890125678' })
            .expect(409)
            .expect((r) =>
              expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'),
            );
        });
        expect(await count(f)).toBe(1);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
            .loyaltyPoints,
        ).toBe(9);
      });
      it('bounds Order lock waiting and permits retry after timeout rollback', async () => {
        const f = await fixture();
        const key = randomUUID();
        await withHeldLock(f, key, true, async () => {
          const start = Date.now();
          await pay(f, key)
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('PAYMENT_IN_PROGRESS'));
          expect(Date.now() - start).toBeLessThan(6000);
          expect(await count(f)).toBe(0);
        });
        await pay(f, key).expect(200).expect('Idempotency-Replayed', 'false');
        expect(await count(f)).toBe(1);
      });
      it('parallel differing payloads cannot reuse the winning key', async () => {
        const f = await fixture();
        const key = randomUUID();
        const cards = [fullCard, '1234567890125678'];
        const results = await Promise.all(
          cards.map((cardNumber) => pay(f, key, { cardNumber })),
        );
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          200, 409,
        ]);
        const winner = results.findIndex((r) => r.status === 200);
        const loser = 1 - winner;
        expect(['PAYMENT_IN_PROGRESS', 'IDEMPOTENCY_KEY_CONFLICT']).toContain(
          results[loser].body.code,
        );
        await pay(f, key, { cardNumber: cards[winner] })
          .expect(200)
          .expect(results[winner].body);
        await pay(f, key, { cardNumber: cards[loser] })
          .expect(409)
          .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT'));
        expect(await count(f)).toBe(1);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
            .loyaltyPoints,
        ).toBe(9);
      });
      it('same-key parallel requests create one attempt, busy requests replay on retry', async () => {
        const f = await fixture();
        const key = randomUUID();
        const results = await Promise.all([
          pay(f, key),
          pay(f, key),
          pay(f, key),
        ]);
        expect(results.some((r) => r.status === 200)).toBe(true);
        for (const r of results)
          if (r.status !== 200) {
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('PAYMENT_IN_PROGRESS');
          }
        const r = await pay(f, key)
          .expect(200)
          .expect('Idempotency-Replayed', 'true');
        for (const result of results)
          if (result.status === 200) expect(result.body).toEqual(r.body);
        expect(await count(f)).toBe(1);
        expect(
          (await prisma.user.findUniqueOrThrow({ where: { id: f.userId } }))
            .loyaltyPoints,
        ).toBe(9);
      });
      it('different keys on one Order cannot both succeed', async () => {
        const f = await fixture();
        const results = await Promise.all([pay(f), pay(f)]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          200, 409,
        ]);
        expect(await count(f)).toBe(1);
      });
      it('busy advisory key returns bounded 409 without attempts; succeeds after rollback', async () => {
        const f = await fixture();
        const key = randomUUID();
        let unlock!: () => void;
        let ready!: () => void;
        const gate = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        let rejectReady!: (error: unknown) => void;
        const held = new Promise<void>((resolve, reject) => {
          ready = resolve;
          rejectReady = reject;
        });
        const owner = prisma
          .$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([f.userId, key])}, 0))::text AS locked`;
              ready();
              await gate;
              throw new Error('test rollback');
            },
            { timeout: 10000 },
          )
          .catch((error) => {
            if (
              !(error instanceof Error) ||
              error.message !== 'test rollback'
            ) {
              rejectReady(error);
              return error;
            }
          });
        let holderError: unknown;
        try {
          await held;
          await pay(f, key)
            .expect(409)
            .expect((r) => {
              expect(r.body.code).toBe('PAYMENT_IN_PROGRESS');
            });
          expect(await count(f)).toBe(0);
        } finally {
          unlock();
          holderError = await owner;
        }
        if (holderError) throw holderError;
        await pay(f, key).expect(200);
      });
      it('waits for an Order lock, then rejects cancellation observed after lock release', async () => {
        const f = await fixture();
        let unlock!: () => void;
        let ready!: () => void;
        const gate = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const held = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const cancel = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM orders WHERE id = ${f.orderId}::uuid FOR UPDATE`;
            ready();
            await gate;
            await tx.order.update({
              where: { id: f.orderId },
              data: { status: 'CANCELLED' },
            });
          },
          { timeout: 10000 },
        );
        await held;
        const pending = pay(f).then((r) => r);
        try {
          await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
          unlock();
          await cancel;
        }
        const result = await pending;
        expect(result.status).toBe(409);
        expect(result.body.code).toBe('INVALID_TRANSITION');
        expect(await count(f)).toBe(0);
      });
    },
  );
});
