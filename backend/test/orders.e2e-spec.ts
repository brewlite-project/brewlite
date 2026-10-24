import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { getJwtSecret } from '../src/auth/jwt.config.js';

const userId = '550e8400-e29b-41d4-a716-446655440000';
const productId = '550e8400-e29b-41d4-a716-446655440001';
const toppingId = '550e8400-e29b-41d4-a716-446655440002';
const item = { productId, size: 'M', quantity: 2, toppingIds: [toppingId] };
const product = {
  id: productId,
  name: 'Coffee',
  basePriceVnd: 45000n,
  stock: 5,
  sizePolicy: 'STANDARD',
  category: { isActive: true },
  productToppings: [{ toppingId }],
};
const topping = {
  id: toppingId,
  code: 'PEARL',
  name: 'Pearl',
  priceVnd: 5000n,
  isAvailable: true,
};
const coupon = {
  id: 'coupon',
  code: 'WELCOME20',
  type: 'FIXED',
  value: 20000,
  minSubtotalVnd: 0n,
  maxDiscountVnd: null,
  startsAt: new Date(0),
  expiresAt: new Date('2099-01-01'),
  activeUsageCount: 0,
  usageLimit: 10,
  perUserLimit: 1,
};

describe('POST /orders (real guard/controller/service; mocked database)', () => {
  let app: INestApplication<App>;
  let token: string;
  const tx = {
    user: { findUnique: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn() },
    product: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    topping: { findMany: vi.fn() },
    coupon: { findUnique: vi.fn(), updateMany: vi.fn() },
    couponRedemption: { count: vi.fn() },
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    tx.user.findUnique.mockResolvedValue({ id: userId });
    tx.order.findFirst.mockResolvedValue(null);
    tx.product.findMany.mockResolvedValue([product]);
    tx.topping.findMany.mockResolvedValue([topping]);
    tx.product.updateMany.mockResolvedValue({ count: 1 });
    tx.coupon.findUnique.mockResolvedValue(coupon);
    tx.coupon.updateMany.mockResolvedValue({ count: 1 });
    tx.couponRedemption.count.mockResolvedValue(0);
    tx.order.create.mockImplementation(({ data }) => ({
      ...data,
      id: 'order',
      couponCodeSnapshot: data.couponCodeSnapshot ?? null,
      items: data.items.create.map(
        (line: { toppings: { create: object[] } }) => ({
          ...line,
          id: 'line',
          toppings: line.toppings.create,
        }),
      ),
    }));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
      })
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
  });
  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/orders')
      .auth(token, { type: 'bearer' })
      .send(body);

  it('uses token owner and database prices, returning JSON numbers and snapshots', async () => {
    const { body } = await post({
      items: [{ ...item, price: 1 }],
      userId: 'attacker',
      status: 'PAID',
      totalVnd: 1,
    }).expect(201);
    expect(body).toMatchObject({
      status: 'PENDING',
      subtotalVnd: 118000,
      discountVnd: 0,
      totalVnd: 118000,
      couponCode: null,
    });
    expect(body.items[0]).toMatchObject({
      productName: 'Coffee',
      unitPriceVnd: 59000,
      lineTotalVnd: 118000,
      sizeMultiplierPercent: 120,
    });
    const data = tx.order.create.mock.calls[0][0].data;
    expect(data.userId).toBe(userId);
    expect(data.expiresAt.getTime() - data.createdAt.getTime()).toBe(900000);
  });
  it('rejects missing JWT before reaching storage', async () => {
    await request(app.getHttpServer())
      .post('/orders')
      .send({ items: [item] })
      .expect(401);
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });
  it('rejects a tampered JWT', async () => {
    token = new JwtService({ secret: 'wrong-secret' }).sign({ sub: userId });
    await post({ items: [item] }).expect(401);
  });
  it('rejects an expired JWT', async () => {
    token = new JwtService({ secret: getJwtSecret() }).sign(
      { sub: userId },
      { expiresIn: -1 },
    );
    await post({ items: [item] }).expect(401);
  });
  it.each([
    [],
    Array(21).fill(item),
    [{ ...item, quantity: 0 }],
    [{ ...item, quantity: 11 }],
    [{ ...item, quantity: '2' }],
    [{ ...item, size: 'XL' }],
    [{ ...item, productId: 'bad' }],
    [{ ...item, toppingIds: null }],
  ])('rejects malformed items %#', async (items) => {
    const { body } = await post({ items }).expect(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('aggregates quantities across different sizes before reserving stock', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 });
    tx.product.findUnique.mockResolvedValue({ stock: 5 });
    const { body } = await post({
      items: [item, { ...item, size: 'L', quantity: 4 }],
    }).expect(409);
    expect(body).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ requestedQuantity: 6, availableQuantity: 5 }],
    });
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it.each([
    { ids: [toppingId, toppingId], reason: 'DUPLICATE_TOPPING' },
    {
      ids: [
        '550e8400-e29b-41d4-a716-446655440010',
        '550e8400-e29b-41d4-a716-446655440011',
        '550e8400-e29b-41d4-a716-446655440012',
        '550e8400-e29b-41d4-a716-446655440013',
      ],
      reason: 'TOO_MANY_TOPPINGS',
    },
  ])('returns INVALID_CART for $reason', async ({ ids, reason }) => {
    const { body } = await post({
      items: [{ ...item, toppingIds: ids }],
    }).expect(400);
    expect(body).toMatchObject({ code: 'INVALID_CART', details: [{ reason }] });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });
  it('rejects nonexistent product', async () => {
    tx.product.findMany.mockResolvedValue([]);
    expect((await post({ items: [item] }).expect(400)).body.code).toBe(
      'INVALID_CART',
    );
  });
  it('rejects nonexistent topping', async () => {
    tx.topping.findMany.mockResolvedValue([]);
    expect((await post({ items: [item] }).expect(400)).body.code).toBe(
      'INVALID_CART',
    );
  });
  it('normalizes coupon, reserves quota and saves HELD redemption', async () => {
    const { body } = await post({
      items: [item],
      couponCode: ' welcome20 ',
    }).expect(201);
    expect(body).toMatchObject({
      couponCode: 'WELCOME20',
      discountVnd: 20000,
      totalVnd: 98000,
    });
    expect(
      tx.order.create.mock.calls[0][0].data.couponRedemption.create,
    ).toMatchObject({ userId, couponId: 'coupon', status: 'HELD' });
  });
  it('caps percent discounts', async () => {
    tx.coupon.findUnique.mockResolvedValue({
      ...coupon,
      type: 'PERCENT',
      value: 20,
      maxDiscountVnd: 10000n,
    });
    expect(
      (await post({ items: [item], couponCode: 'WELCOME20' }).expect(201)).body
        .discountVnd,
    ).toBe(10000);
  });
  it('caps fixed discount at subtotal', async () => {
    tx.coupon.findUnique.mockResolvedValue({ ...coupon, value: 999999 });
    expect(
      (await post({ items: [item], couponCode: 'WELCOME20' }).expect(201)).body
        .totalVnd,
    ).toBe(0);
  });
  it.each([
    null,
    { ...coupon, expiresAt: new Date(0) },
    { ...coupon, startsAt: new Date('2098-01-01') },
    { ...coupon, minSubtotalVnd: 200000n },
    { ...coupon, activeUsageCount: 10 },
  ])('rejects unavailable coupon %#', async (value) => {
    tx.coupon.findUnique.mockResolvedValue(value);
    expect(
      (await post({ items: [item], couponCode: 'WELCOME20' }).expect(400)).body
        .code,
    ).toBe('INVALID_COUPON');
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
  it('rejects per-user coupon limit', async () => {
    tx.couponRedemption.count.mockResolvedValue(1);
    expect(
      (await post({ items: [item], couponCode: 'WELCOME20' }).expect(400)).body
        .code,
    ).toBe('INVALID_COUPON');
  });
  it('handles quota consumed since the read', async () => {
    tx.coupon.updateMany.mockResolvedValue({ count: 0 });
    expect(
      (await post({ items: [item], couponCode: 'WELCOME20' }).expect(400)).body
        .code,
    ).toBe('INVALID_COUPON');
  });
  it('rejects existing active orders', async () => {
    tx.order.findFirst.mockResolvedValue({ id: 'existing' });
    expect((await post({ items: [item] }).expect(409)).body.code).toBe(
      'PENDING_ORDER_EXISTS',
    );
  });
  it('rejects token whose user no longer exists', async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await post({ items: [item] }).expect(401);
  });
  it('does not expose database error details', async () => {
    tx.order.create.mockRejectedValue(new Error('private-db-detail'));
    const { body } = await post({ items: [item] }).expect(500);
    expect(JSON.stringify(body)).not.toContain('private-db-detail');
  });
  it('uses floor for fractional VND and rejects amounts outside safe JSON integers', async () => {
    tx.product.findMany.mockResolvedValue([
      { ...product, basePriceVnd: 45003n },
    ]);
    expect(
      (await post({ items: [item] }).expect(201)).body.items[0].unitPriceVnd,
    ).toBe(59003);
    tx.product.findMany.mockResolvedValue([
      {
        ...product,
        basePriceVnd: 9007199254740992n,
        stock: 5,
      },
    ]);
    await post({ items: [item] }).expect(500);
  });
  it.each([
    [
      { ...product, category: { isActive: false } },
      item,
      'PRODUCT_UNAVAILABLE',
    ],
    [product, { ...item, size: 'ONE_SIZE' }, 'INVALID_SIZE'],
    [{ ...product, sizePolicy: 'ONE_SIZE' }, item, 'INVALID_SIZE'],
    [{ ...product, productToppings: [] }, item, 'TOPPING_NOT_ALLOWED'],
  ])(
    'enforces catalog v2.1 rule %# before any stock/coupon writes',
    async (catalog, line, reason) => {
      tx.product.findMany.mockResolvedValue([catalog]);
      const { body } = await post({
        items: [line],
        couponCode: 'WELCOME20',
      }).expect(400);
      expect(body).toMatchObject({
        code: 'INVALID_CART',
        details: [{ productId, reason }],
      });
      expect(tx.product.updateMany).not.toHaveBeenCalled();
      expect(tx.coupon.updateMany).not.toHaveBeenCalled();
      expect(tx.order.create).not.toHaveBeenCalled();
    },
  );
  it('rejects a linked but unavailable topping', async () => {
    tx.topping.findMany.mockResolvedValue([{ ...topping, isAvailable: false }]);
    expect((await post({ items: [item] }).expect(400)).body).toMatchObject({
      code: 'INVALID_CART',
      details: [{ reason: 'TOPPING_UNAVAILABLE' }],
    });
  });
  it('prices ONE_SIZE at 100 percent and saves the size snapshot', async () => {
    tx.product.findMany.mockResolvedValue([
      { ...product, sizePolicy: 'ONE_SIZE' },
    ]);
    const { body } = await post({
      items: [{ ...item, size: 'ONE_SIZE', toppingIds: [] }],
    }).expect(201);
    expect(body).toMatchObject({
      totalVnd: 90000,
      items: [
        { size: 'ONE_SIZE', sizeMultiplierPercent: 100, unitPriceVnd: 45000 },
      ],
    });
  });
});
