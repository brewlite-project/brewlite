import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { getJwtSecret } from '../src/auth/jwt.config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const userId = 'abcdef00-0000-4000-8000-000000000001';
const productId = '550e8400-e29b-41d4-a716-446655440001';
const coupon = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  code: 'WELCOME20',
  type: 'PERCENT',
  value: 20,
  minSubtotalVnd: 0n,
  maxDiscountVnd: 1000n,
  startsAt: new Date(0),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  activeUsageCount: 0,
  usageLimit: 10,
  perUserLimit: 1,
};

describe('POST /coupons/preview HTTP/JWT/Swagger', () => {
  let app: INestApplication<App>;
  let token: string;
  const database = {
    product: { findMany: vi.fn() },
    topping: { findMany: vi.fn() },
    coupon: { findUnique: vi.fn() },
    couponRedemption: { count: vi.fn() },
    $queryRaw: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('ORDER_EXPIRATION_ENABLED', 'false');
    database.product.findMany.mockResolvedValue([
      {
        id: productId,
        name: 'Coffee',
        basePriceVnd: 12347n,
        sizePolicy: 'STANDARD',
        category: { isActive: true },
        productToppings: [],
      },
    ]);
    database.topping.findMany.mockResolvedValue([]);
    database.coupon.findUnique.mockResolvedValue(coupon);
    database.couponRedemption.count.mockResolvedValue(0);
    database.$queryRaw.mockResolvedValue([{ now: new Date('2026-11-04T00:00:00Z') }]);

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(database)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    token = new JwtService({ secret: getJwtSecret() }).sign(
      { sub: userId },
      { expiresIn: 3600 },
    );
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/coupons/preview')
      .auth(token, { type: 'bearer' })
      .send(body);

  it('normalizes code and computes price/discount from database data, ignoring client totals and userId', async () => {
    const result = await post({
      couponCode: ' welcome20 ',
      items: [
        { productId, size: 'L', quantity: 1, toppingIds: [] },
      ],
      userId: 'attacker',
      subtotalVnd: 1,
      amountVnd: 1,
      discountVnd: 1,
      totalVnd: 1,
      valid: false,
    }).expect(200);

    // API Contract v4.0 §14.1: 12347 × 140% = 17285.8 rounds half-up to 17286.
    expect(result.body).toEqual({
      couponCode: 'WELCOME20',
      subtotalVnd: 17286,
      discountVnd: 1000,
      totalVnd: 16286,
      valid: true,
    });
    expect(database.couponRedemption.count).toHaveBeenCalledWith({
      where: {
        userId,
        couponId: coupon.id,
        status: { in: ['HELD', 'CONSUMED'] },
      },
    });
    expect(database.product.findMany).toHaveBeenCalledOnce();
    expect(database.topping.findMany).toHaveBeenCalledOnce();
  });

  it('rejects invalid coupons and exhausted quota using existing HTTP codes', async () => {
    database.coupon.findUnique.mockResolvedValue(null);
    await post({ couponCode: 'missing', items: [{ productId, size: 'S', quantity: 1, toppingIds: [] }] })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('INVALID_COUPON'));

    database.coupon.findUnique.mockResolvedValue(coupon);
    database.couponRedemption.count.mockResolvedValue(1);
    await post({ couponCode: 'WELCOME20', items: [{ productId, size: 'S', quantity: 1, toppingIds: [] }] })
      .expect(409)
      .expect((response) => expect(response.body.code).toBe('COUPON_UNAVAILABLE'));
  });

  it('requires JWT and validates the request shape', async () => {
    await request(app.getHttpServer())
      .post('/coupons/preview')
      .send({ couponCode: 'WELCOME20', items: [] })
      .expect(401);
    await post({ couponCode: 'WELCOME20', items: [] })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('VALIDATION_ERROR'));
    expect(database.product.findMany).not.toHaveBeenCalled();
  });

  it('documents JWT, request/response and the non-creation 200 status', () => {
    const document = SwaggerModule.createDocument(
      app,
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
    });
    expect(document.components?.schemas?.CouponPreviewResponseDto).toMatchObject({
      properties: { valid: { enum: [true] } },
    });
  });
});
