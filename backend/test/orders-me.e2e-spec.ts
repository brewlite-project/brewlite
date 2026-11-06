import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { getJwtSecret } from '../src/auth/jwt.config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const userId = '550e8400-e29b-41d4-a716-446655440000';
const otherUserId = '550e8400-e29b-41d4-a716-446655440001';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const itemId = '550e8400-e29b-41d4-a716-446655440011';
const toppingId = '550e8400-e29b-41d4-a716-446655440012';
const successPaymentId = '550e8400-e29b-41d4-a716-446655440020';
const failedPaymentId = '550e8400-e29b-41d4-a716-446655440021';
const createdAt = new Date('2026-10-25T01:50:00.000Z');
const paymentAt = new Date('2026-10-25T02:00:00.000Z');

const paymentSnapshot = (
  id: string,
  status: 'SUCCESS' | 'FAILED',
) => ({
  paymentId: id,
  orderId,
  paymentStatus: status,
  orderStatus: status === 'SUCCESS' ? 'PAID' : 'PAYMENT_FAILED',
  amountVnd: 98000,
  method: 'CARD',
  methodLast4: '1234',
  mockReference: `MOCK-${id}`,
  pointsEarned: status === 'SUCCESS' ? 9 : 0,
  failureReason: status === 'SUCCESS' ? null : 'PAYMENT_DECLINED',
  createdAt: paymentAt.toISOString(),
});

const order = {
  id: orderId,
  status: 'PAID' as const,
  createdAt,
  expiresAt: new Date('2026-10-25T02:05:00.000Z'),
  subtotalVnd: 118000n,
  discountVnd: 20000n,
  totalVnd: 98000n,
  couponCodeSnapshot: 'WELCOME20',
  pointsEarned: 9,
  items: [
    {
      id: itemId,
      productId: '550e8400-e29b-41d4-a716-446655440002',
      productNameSnapshot: 'Coffee',
      size: 'M' as const,
      sizePercentSnapshot: 120,
      basePriceSnapshotVnd: 45000n,
      quantity: 2,
      unitPriceVnd: 59000n,
      lineTotalVnd: 118000n,
      toppings: [
        {
          toppingId,
          toppingNameSnapshot: 'Pearl',
          toppingPriceSnapshotVnd: 5000n,
        },
      ],
    },
  ],
  payments: [
    {
      id: failedPaymentId,
      status: 'FAILED' as const,
      method: 'CARD' as const,
      methodLast4: '1234',
      amountVnd: 98000n,
      mockReference: `MOCK-${failedPaymentId}`,
      responseSnapshot: paymentSnapshot(failedPaymentId, 'FAILED'),
      createdAt: new Date('2026-10-25T02:01:00.000Z'),
    },
    {
      id: successPaymentId,
      status: 'SUCCESS' as const,
      method: 'CARD' as const,
      methodLast4: '1234',
      amountVnd: 98000n,
      mockReference: `MOCK-${successPaymentId}`,
      responseSnapshot: paymentSnapshot(successPaymentId, 'SUCCESS'),
      createdAt: paymentAt,
    },
  ],
};

describe('GET /orders/me', () => {
  let app: INestApplication<App>;
  let token: string;
  const prisma = {
    order: { count: vi.fn(), findMany: vi.fn() },
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.order.count.mockResolvedValue(0);
    prisma.order.findMany.mockResolvedValue([]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

  const get = (query = '') =>
    request(app.getHttpServer())
      .get(`/orders/me${query}`)
      .auth(token, { type: 'bearer' });

  it('requires JWT before querying orders', async () => {
    await request(app.getHttpServer()).get('/orders/me').expect(401);
    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('filters with the verified JWT owner and returns only public snapshots', async () => {
    prisma.order.count.mockResolvedValue(1);
    prisma.order.findMany.mockResolvedValue([order]);

    const { body } = await get().expect(200);

    expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId } });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(body).toEqual({
      items: [
        expect.objectContaining({
          id: orderId,
          status: 'PAID',
          createdAt: createdAt.toISOString(),
          expiresAt: '2026-10-25T02:05:00.000Z',
          totalVnd: 98000,
          items: [
            expect.objectContaining({
              productName: 'Coffee',
              basePriceVnd: 45000,
              toppings: [{ id: toppingId, name: 'Pearl', priceVnd: 5000 }],
            }),
          ],
          payment: expect.objectContaining({
            id: successPaymentId,
            status: 'SUCCESS',
            failureReason: null,
          }),
        }),
      ],
      meta: { page: null, limit: null, total: 1, totalPages: null },
    });
    expect(JSON.stringify(body)).not.toContain('responseSnapshot');
    expect(JSON.stringify(body)).not.toContain('idempotencyKey');
  });

  it('applies both pagination fields and returns empty items beyond the last page', async () => {
    prisma.order.count.mockResolvedValue(2);
    prisma.order.findMany.mockResolvedValue([order]);

    await get('?page=2&limit=1').expect(200);
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 1 }),
    );

    prisma.order.count.mockResolvedValue(1);
    prisma.order.findMany.mockClear();
    const { body } = await get('?page=2&limit=1').expect(200);
    expect(body).toEqual({
      items: [],
      meta: { page: 2, limit: 1, total: 1, totalPages: 1 },
    });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it.each(['?page=1', '?limit=10', '?page=1.5&limit=10', '?page=1&limit=101'])
  ('rejects invalid pagination query %s', async (query) => {
    const { body } = await get(query).expect(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(prisma.order.count).not.toHaveBeenCalled();
  });

  it('does not accept a userId query parameter as an ownership override', async () => {
    await get(`?userId=${otherUserId}`).expect(200);
    expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId } });
  });

  it('maps Phase 2 VNPay PENDING payment without calling readPaymentSnapshot and blocks retry', async () => {
    const vnpayPendingPaymentId = '550e8400-e29b-41d4-a716-446655440030';
    const futureExpiry = new Date(Date.now() + 10 * 60_000);
    prisma.order.count.mockResolvedValue(1);
    prisma.order.findMany.mockResolvedValue([
      {
        ...order,
        status: 'PENDING',
        pointsEarned: 0,
        expiresAt: futureExpiry,
        payments: [
          {
            id: vnpayPendingPaymentId,
            status: 'PENDING',
            provider: 'VNPAY',
            method: null,
            methodLast4: null,
            amountVnd: 98000n,
            mockReference: null,
            responseSnapshot: null,
            finalOutcomeSnapshot: null,
            reconciliationState: 'SCHEDULED',
            hasFinancialException: false,
            createdAt: paymentAt,
            updatedAt: paymentAt,
            gatewayEvents: [],
          },
          {
            id: failedPaymentId,
            status: 'FAILED',
            provider: 'VNPAY',
            method: null,
            methodLast4: null,
            amountVnd: 98000n,
            mockReference: null,
            responseSnapshot: null,
            finalOutcomeSnapshot: {
              provider: 'VNPAY',
              outcome: 'FAILED',
              responseCode: '24',
              transactionStatus: '02',
            },
            reconciliationState: 'RESOLVED',
            hasFinancialException: false,
            createdAt: new Date(paymentAt.getTime() - 60_000),
            updatedAt: new Date(paymentAt.getTime() - 60_000),
            gatewayEvents: [],
          },
        ],
      },
    ]);

    const { body } = await get().expect(200);
    expect(body.items[0]).toMatchObject({
      id: orderId,
      status: 'PENDING',
      hasFinancialException: false,
      payment: {
        id: vnpayPendingPaymentId,
        status: 'PENDING',
        provider: 'VNPAY',
        method: null,
        methodLast4: null,
        amountVnd: 98000,
        mockReference: null,
        failureReason: null,
        resolution: 'PROCESSING',
        requiresReview: false,
        canRetry: false,
        createdAt: paymentAt.toISOString(),
      },
    });
  });

  it('maps VNPay SUCCESS, VNPay FAILED (with canRetry), ZERO_AMOUNT SUCCESS, and CANCELLED + PENDING (RECONCILING)', async () => {
    const vnpaySuccessOrder = {
      ...order,
      id: '550e8400-e29b-41d4-a716-446655440041',
      status: 'PAID',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      payments: [
        {
          id: '550e8400-e29b-41d4-a716-446655440051',
          status: 'SUCCESS',
          provider: 'VNPAY',
          method: null,
          methodLast4: null,
          amountVnd: 98000n,
          mockReference: null,
          responseSnapshot: null,
          finalOutcomeSnapshot: {
            provider: 'VNPAY',
            outcome: 'SUCCESS',
            responseCode: '00',
            transactionStatus: '00',
          },
          reconciliationState: 'RESOLVED',
          hasFinancialException: false,
          createdAt: paymentAt,
          gatewayEvents: [],
        },
      ],
    };

    const vnpayFailedOrder = {
      ...order,
      id: '550e8400-e29b-41d4-a716-446655440042',
      status: 'PAYMENT_FAILED',
      pointsEarned: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      payments: [
        {
          id: '550e8400-e29b-41d4-a716-446655440052',
          status: 'FAILED',
          provider: 'VNPAY',
          method: null,
          methodLast4: null,
          amountVnd: 98000n,
          mockReference: null,
          responseSnapshot: null,
          finalOutcomeSnapshot: {
            provider: 'VNPAY',
            outcome: 'FAILED',
            responseCode: '24',
            transactionStatus: '02',
          },
          reconciliationState: 'RESOLVED',
          hasFinancialException: false,
          createdAt: paymentAt,
          gatewayEvents: [],
        },
      ],
    };

    const zeroAmountOrder = {
      ...order,
      id: '550e8400-e29b-41d4-a716-446655440043',
      status: 'PAID',
      subtotalVnd: 20000n,
      discountVnd: 20000n,
      totalVnd: 0n,
      pointsEarned: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      payments: [
        {
          id: '550e8400-e29b-41d4-a716-446655440053',
          status: 'SUCCESS',
          provider: 'ZERO_AMOUNT',
          method: null,
          methodLast4: null,
          amountVnd: 0n,
          mockReference: null,
          responseSnapshot: {
            paymentId: '550e8400-e29b-41d4-a716-446655440053',
            orderId: '550e8400-e29b-41d4-a716-446655440043',
            provider: 'ZERO_AMOUNT',
            paymentStatus: 'SUCCESS',
            orderStatus: 'PAID',
            amountVnd: 0,
            pointsEarned: 0,
            createdAt: paymentAt.toISOString(),
          },
          finalOutcomeSnapshot: null,
          reconciliationState: 'NONE',
          hasFinancialException: false,
          createdAt: paymentAt,
          gatewayEvents: [],
        },
      ],
    };

    const cancelledReconcilingOrder = {
      ...order,
      id: '550e8400-e29b-41d4-a716-446655440044',
      status: 'CANCELLED',
      pointsEarned: 0,
      expiresAt: new Date(Date.now() - 10 * 60_000),
      payments: [
        {
          id: '550e8400-e29b-41d4-a716-446655440054',
          status: 'PENDING',
          provider: 'VNPAY',
          method: null,
          methodLast4: null,
          amountVnd: 98000n,
          mockReference: null,
          responseSnapshot: null,
          finalOutcomeSnapshot: null,
          reconciliationState: 'SCHEDULED',
          hasFinancialException: false,
          createdAt: paymentAt,
          gatewayEvents: [],
        },
      ],
    };

    prisma.order.count.mockResolvedValue(4);
    prisma.order.findMany.mockResolvedValue([
      vnpaySuccessOrder,
      vnpayFailedOrder,
      zeroAmountOrder,
      cancelledReconcilingOrder,
    ]);

    const { body } = await get().expect(200);
    expect(body.items[0].payment).toMatchObject({
      provider: 'VNPAY',
      status: 'SUCCESS',
      method: null,
      methodLast4: null,
      mockReference: null,
      failureReason: null,
      resolution: 'PAYMENT_ACCEPTED',
      requiresReview: false,
      canRetry: false,
    });
    expect(body.items[1].payment).toMatchObject({
      provider: 'VNPAY',
      status: 'FAILED',
      method: null,
      failureReason: 'VNPAY_RESPONSE_24',
      resolution: 'FAILED',
      requiresReview: false,
      canRetry: true,
    });
    expect(body.items[2].payment).toMatchObject({
      provider: 'ZERO_AMOUNT',
      status: 'SUCCESS',
      method: null,
      amountVnd: 0,
      failureReason: null,
      resolution: 'PAYMENT_ACCEPTED',
      requiresReview: false,
      canRetry: false,
    });
    expect(body.items[3].payment).toMatchObject({
      provider: 'VNPAY',
      status: 'PENDING',
      resolution: 'RECONCILING',
      requiresReview: false,
      canRetry: false,
    });
  });

  it('surfaces Order-level hasFinancialException and FINANCIAL_EXCEPTION resolution even when representative payment is SUCCESS', async () => {
    prisma.order.count.mockResolvedValue(1);
    prisma.order.findMany.mockResolvedValue([
      {
        ...order,
        status: 'PAID',
        expiresAt: new Date(Date.now() + 10 * 60_000),
        payments: [
          {
            id: successPaymentId,
            status: 'SUCCESS',
            provider: 'MOCK',
            method: 'CARD',
            methodLast4: '1234',
            amountVnd: 98000n,
            mockReference: `MOCK-${successPaymentId}`,
            responseSnapshot: paymentSnapshot(successPaymentId, 'SUCCESS'),
            reconciliationState: 'NONE',
            hasFinancialException: false,
            createdAt: paymentAt,
            gatewayEvents: [],
          },
          {
            id: failedPaymentId,
            status: 'PENDING',
            provider: 'VNPAY',
            method: null,
            methodLast4: null,
            amountVnd: 98000n,
            mockReference: null,
            responseSnapshot: null,
            reconciliationState: 'REQUIRES_REVIEW',
            hasFinancialException: true,
            createdAt: new Date(paymentAt.getTime() - 60_000),
            gatewayEvents: [
              {
                outcome: 'SUCCESS',
                disposition: 'FINANCIAL_EXCEPTION',
                exceptionReason: 'ANOTHER_PAYMENT_ALREADY_SUCCEEDED',
              },
            ],
          },
        ],
      },
    ]);

    const { body } = await get().expect(200);
    expect(body.items[0]).toMatchObject({
      id: orderId,
      status: 'PAID',
      hasFinancialException: true,
      payment: {
        id: successPaymentId,
        status: 'SUCCESS',
        provider: 'MOCK',
        resolution: 'FINANCIAL_EXCEPTION',
        requiresReview: true,
        canRetry: false,
      },
    });
  });
});
