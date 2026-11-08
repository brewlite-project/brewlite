import { PaymentFinalizationService } from './payment-finalization.service.js';
import type { VerifiedGatewayOutcome } from './payment-finalization.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { MockPaymentOutcome } from './mock-payment.service.js';

const userId = 'abcdef00-0000-4000-8000-000000000001';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const paymentId = '550e8400-e29b-41d4-a716-446655440020';
const now = new Date('2026-10-31T12:10:00.000Z');
const expiresAt = new Date('2026-10-31T12:08:00.000Z');
const paidAt = new Date('2026-10-31T12:07:59.000Z');

function makeTx(options: {
  provider?: 'MOCK' | 'VNPAY' | 'ZERO_AMOUNT';
  paymentStatus?: 'PENDING' | 'SUCCESS' | 'FAILED';
  orderStatus?: 'PENDING' | 'PAYMENT_FAILED' | 'PAID' | 'CANCELLED';
  totalVnd?: bigint;
  couponId?: string | null;
  pointsEarned?: number;
  clockNow?: Date;
  beforeExpiry?: boolean;
  beforeGraceEnd?: boolean;
  existingEvent?: Partial<VerifiedGatewayOutcome> & {
    outcome: string;
    disposition: string;
  };
  existingIdempotentPayment?: {
    id: string;
    orderId: string;
    provider: 'MOCK' | 'ZERO_AMOUNT' | 'VNPAY';
    status: 'PENDING' | 'SUCCESS' | 'FAILED';
    requestHash: string;
    responseSnapshot: unknown;
  };
  otherSuccessId?: string;
  hasOrderException?: boolean;
} = {}) {
  let currentOrderStatus = options.orderStatus ?? 'PENDING';
  const order = {
    id: orderId,
    userId,
    status: currentOrderStatus,
    totalVnd: options.totalVnd ?? 98000n,
    couponId: options.couponId ?? null,
    pointsEarned: options.pointsEarned ?? 0,
    expiresAt,
  };
  const payment = {
    id: paymentId,
    orderId,
    userId,
    provider: options.provider ?? 'VNPAY',
    status: options.paymentStatus ?? 'PENDING',
    amountVnd: options.totalVnd ?? 98000n,
    vnpTxnRef: 'txn-ref-test',
    vnpTmnCode: 'TMN-TEST',
    hasFinancialException: false,
    reconciliationState: 'SCHEDULED',
    finalOutcomeSnapshot:
      options.paymentStatus === 'FAILED' || options.paymentStatus === 'SUCCESS'
        ? { outcome: options.paymentStatus }
        : null,
  };
  const clock = {
    now: options.clockNow ?? now,
    expiresAt,
    beforeExpiry: options.beforeExpiry ?? false,
    beforeGraceEnd: options.beforeGraceEnd ?? true,
  };
  const raw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ');
    if (sql.includes('AS timely'))
      return [
        {
          timely:
            (values[0] as Date).getTime() <= expiresAt.getTime(),
        },
      ];
    if (sql.includes('WITH db_clock')) return [clock];
    if (sql.includes('FROM payments') && sql.includes('FOR UPDATE'))
      return [{ id: paymentId }];
    if (sql.includes('FROM orders') && sql.includes('FOR UPDATE'))
      return [{ id: orderId }];
    return [];
  });
  const tx = {
    $queryRaw: raw,
    $executeRaw: vi.fn().mockResolvedValue(0),
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ ...order, status: currentOrderStatus })),
      findUnique: vi.fn(async () => ({ ...order, status: currentOrderStatus })),
      update: vi.fn(async ({ data }: { data: { status?: typeof currentOrderStatus } }) => {
        if (data.status) currentOrderStatus = data.status;
        return { ...order, ...data, status: currentOrderStatus };
      }),
      updateMany: vi.fn(async ({ data }: { data: { status?: typeof currentOrderStatus } }) => {
        if (data.status) currentOrderStatus = data.status;
        return { count: 1 };
      }),
    },
    orderItem: { findMany: vi.fn().mockResolvedValue([]) },
    product: { update: vi.fn().mockResolvedValue({}) },
    payment: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('userId_idempotencyKey' in where)
          return options.existingIdempotentPayment ?? null;
        return payment;
      }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(
          options.otherSuccessId ? { id: options.otherSuccessId } : null,
        )
        .mockResolvedValueOnce(
          options.hasOrderException ? { id: 'another-exception' } : null,
        ),
      create: vi.fn().mockResolvedValue({ id: paymentId }),
      update: vi.fn().mockResolvedValue(payment),
    },
    paymentGatewayEvent: {
      findUnique: vi.fn().mockResolvedValue(options.existingEvent ?? null),
      create: vi.fn().mockResolvedValue({}),
    },
    couponRedemption: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw, delegates: tx };
}

function mockCommand(
  outcome: 'SUCCESS' | 'FAILED' = 'SUCCESS',
) {
  const mockOutcome: MockPaymentOutcome = {
    paymentStatus: outcome,
    methodLast4: outcome === 'SUCCESS' ? '1234' : '0002',
    failureReason: outcome === 'SUCCESS' ? null : 'PAYMENT_DECLINED',
  };
  return {
    provider: 'MOCK' as const,
    userId,
    orderId,
    paymentId,
    idempotencyKey: 'mock-key-0001',
    requestHash: 'a'.repeat(64),
    method: 'CARD' as const,
    outcome: mockOutcome,
  };
}

function gatewayOutcome(
  overrides: Partial<VerifiedGatewayOutcome> = {},
): VerifiedGatewayOutcome {
  return {
    source: 'IPN',
    eventIdentity: 'a'.repeat(64),
    queryRequestId: null,
    vnpTxnRef: 'txn-ref-test',
    vnpTmnCode: 'TMN-TEST',
    outcome: 'SUCCESS',
    responseCode: '00',
    transactionStatus: '00',
    gatewayTransactionNo: 'gateway-txn-1',
    amountVnd: 98000n,
    gatewayPaidAt: paidAt,
    verifiedAt: now,
    receivedAt: now,
    ...overrides,
  };
}

describe('PaymentFinalizationService', () => {
  const service = new PaymentFinalizationService();

  it('finalizes Mock SUCCESS atomically and consumes the held coupon once', async () => {
    const { tx, delegates } = makeTx({ couponId: '660e8400-e29b-41d4-a716-446655440010', beforeExpiry: true });
    const result = await service.finalizeInTransaction(tx, mockCommand('SUCCESS'));
    expect(result).toMatchObject({
      disposition: 'FINALIZED',
      provider: 'MOCK',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 9,
      mockResponse: {
        paymentStatus: 'SUCCESS',
        orderStatus: 'PAID',
        pointsEarned: 9,
      },
    });
    expect(delegates.couponRedemption.updateMany).toHaveBeenCalledWith({
      where: {
        orderId,
        userId,
        couponId: '660e8400-e29b-41d4-a716-446655440010',
        status: 'HELD',
      },
      data: { status: 'CONSUMED', consumedAt: now },
    });
    expect(delegates.user.updateMany).toHaveBeenCalledWith({
      where: { id: userId, loyaltyPoints: { lte: 2147483638 } },
      data: { loyaltyPoints: { increment: 9 } },
    });
    expect(delegates.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: 'MOCK', status: 'SUCCESS' }),
      }),
    );
    expect(delegates.product.update).not.toHaveBeenCalled();
  });

  it('finalizes terminal Mock FAILED without consuming coupon or awarding points', async () => {
    const { tx, delegates } = makeTx({ couponId: '660e8400-e29b-41d4-a716-446655440010', beforeExpiry: true });
    const result = await service.finalizeInTransaction(tx, mockCommand('FAILED'));
    expect(result).toMatchObject({
      disposition: 'FINALIZED',
      paymentStatus: 'FAILED',
      orderStatus: 'PAYMENT_FAILED',
      pointsEarned: 0,
    });
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
  });

  it('returns the immutable Mock replay snapshot without repeating side effects', async () => {
    const snapshot = {
      paymentId,
      orderId,
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      amountVnd: 98000,
      method: 'CARD',
      methodLast4: '1234',
      mockReference: `MOCK-${paymentId}`,
      pointsEarned: 9,
      failureReason: null,
      createdAt: now.toISOString(),
    };
    const { tx, delegates } = makeTx({
      orderStatus: 'PAID',
      paymentStatus: 'SUCCESS',
      provider: 'MOCK',
      existingIdempotentPayment: {
        id: paymentId,
        orderId,
        provider: 'MOCK',
        status: 'SUCCESS',
        requestHash: 'a'.repeat(64),
        responseSnapshot: snapshot,
      },
    });
    const result = await service.finalizeInTransaction(tx, mockCommand());
    expect(result).toMatchObject({
      disposition: 'DUPLICATE',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      mockResponse: snapshot,
    });
    expect(delegates.payment.create).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
  });

  it('finalizes ZERO_AMOUNT with its own provider shape and no loyalty award', async () => {
    const { tx, delegates } = makeTx({
      provider: 'ZERO_AMOUNT',
      totalVnd: 0n,
      beforeExpiry: true,
    });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'ZERO_AMOUNT',
      userId,
      orderId,
      paymentId,
      idempotencyKey: 'zero-key-0001',
      requestHash: 'b'.repeat(64),
    });
    expect(result).toMatchObject({
      disposition: 'FINALIZED',
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 0,
      zeroAmountResponse: {
        provider: 'ZERO_AMOUNT',
        paymentStatus: 'SUCCESS',
        orderStatus: 'PAID',
        amountVnd: 0,
        pointsEarned: 0,
      },
    });
    expect(delegates.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'ZERO_AMOUNT',
          method: null,
          status: 'SUCCESS',
          amountVnd: 0n,
        }),
      }),
    );
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
    expect(delegates.product.update).not.toHaveBeenCalled();
  });

  it('returns the immutable ZERO_AMOUNT replay without repeating side effects', async () => {
    const snapshot = {
      paymentId,
      orderId,
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      amountVnd: 0,
      pointsEarned: 0,
      createdAt: now.toISOString(),
    };
    const { tx, delegates } = makeTx({
      orderStatus: 'PAID',
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      totalVnd: 0n,
      existingIdempotentPayment: {
        id: paymentId,
        orderId,
        provider: 'ZERO_AMOUNT',
        status: 'SUCCESS',
        requestHash: 'b'.repeat(64),
        responseSnapshot: snapshot,
      },
    });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'ZERO_AMOUNT',
      userId,
      orderId,
      paymentId,
      idempotencyKey: 'zero-key-0001',
      requestHash: 'b'.repeat(64),
    });
    expect(result).toMatchObject({
      disposition: 'DUPLICATE',
      zeroAmountResponse: snapshot,
    });
    expect(delegates.payment.create).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
  });

  it('accepts verified VNPay SUCCESS at E in Grace with trusted pay time', async () => {
    const { tx, delegates } = makeTx({ beforeExpiry: false, beforeGraceEnd: true });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome({ gatewayPaidAt: expiresAt }),
    });
    expect(result).toMatchObject({
      disposition: 'FINALIZED',
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 9,
    });
    expect(delegates.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          reconciliationState: 'RESOLVED',
          updatedAt: now,
        }),
      }),
    );
    expect(delegates.paymentGatewayEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'SUCCESS', disposition: 'FINALIZED' }),
      }),
    );
    expect(delegates.product.update).not.toHaveBeenCalled();
  });

  it('rejects PAID at exactly G, preserving PENDING and cancelling the Order', async () => {
    const atGraceEnd = new Date('2026-10-31T12:13:00.000Z');
    const { tx, delegates } = makeTx({
      clockNow: atGraceEnd,
      beforeExpiry: false,
      beforeGraceEnd: false,
    });

    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome({ gatewayPaidAt: paidAt }),
    });

    expect(result).toMatchObject({
      disposition: 'FINANCIAL_EXCEPTION',
      paymentStatus: 'PENDING',
      orderStatus: 'CANCELLED',
    });
    expect(delegates.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hasFinancialException: true,
          reconciliationState: 'REQUIRES_REVIEW',
          reviewReason: 'GRACE_ENDED',
        }),
      }),
    );
    const paymentUpdate = delegates.payment.update.mock.calls[0]?.[0];
    expect(paymentUpdate?.data).not.toHaveProperty('status');
    expect(delegates.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelledAt: atGraceEnd,
          updatedAt: atGraceEnd,
        }),
      }),
    );
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
  });

  it('finalizes verified VNPay FAILED without running success side effects', async () => {
    const { tx, delegates } = makeTx({ beforeExpiry: true });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome({
        outcome: 'FAILED',
        responseCode: '00',
        transactionStatus: '05',
        gatewayPaidAt: null,
      }),
    });
    expect(result).toMatchObject({
      disposition: 'FINALIZED',
      paymentStatus: 'FAILED',
      orderStatus: 'PAYMENT_FAILED',
      pointsEarned: 0,
    });
    expect(delegates.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          reconciliationState: 'RESOLVED',
          updatedAt: now,
        }),
      }),
    );
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
    expect(delegates.product.update).not.toHaveBeenCalled();
  });

  it('returns DUPLICATE without side effects for a committed gateway observation', async () => {
    const event = gatewayOutcome();
    const { tx, delegates } = makeTx({
      paymentStatus: 'SUCCESS',
      orderStatus: 'PAID',
      pointsEarned: 9,
      existingEvent: {
        ...event,
        outcome: 'SUCCESS',
        disposition: 'FINALIZED',
      },
    });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: event,
    });
    expect(result.disposition).toBe('DUPLICATE');
    expect(delegates.payment.update).not.toHaveBeenCalled();
    expect(delegates.order.update).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
    expect(delegates.paymentGatewayEvent.create).not.toHaveBeenCalled();
  });

  it('records a competing accepted SUCCESS as an exception without promoting Payment', async () => {
    const { tx, delegates } = makeTx({
      beforeExpiry: true,
      otherSuccessId: '550e8400-e29b-41d4-a716-446655440030',
    });

    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome(),
    });

    expect(result).toMatchObject({
      disposition: 'FINANCIAL_EXCEPTION',
      paymentStatus: 'PENDING',
      orderStatus: 'PENDING',
    });
    const paymentUpdate = delegates.payment.update.mock.calls[0]?.[0];
    expect(paymentUpdate?.data).toMatchObject({
      hasFinancialException: true,
      reconciliationState: 'REQUIRES_REVIEW',
      reviewReason: 'ANOTHER_PAYMENT_ALREADY_SUCCEEDED',
    });
    expect(paymentUpdate?.data).not.toHaveProperty('status');
    expect(delegates.paymentGatewayEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'SUCCESS',
          disposition: 'FINANCIAL_EXCEPTION',
          exceptionReason: 'ANOTHER_PAYMENT_ALREADY_SUCCEEDED',
        }),
      }),
    );
    expect(delegates.order.update).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
    expect(delegates.product.update).not.toHaveBeenCalled();
  });

  it('preserves a terminal FAILED Payment and records a late SUCCESS exception on a cancelled Order', async () => {
    const { tx, delegates } = makeTx({
      paymentStatus: 'FAILED',
      orderStatus: 'CANCELLED',
    });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome(),
    });
    expect(result).toMatchObject({
      disposition: 'FINANCIAL_EXCEPTION',
      paymentStatus: 'FAILED',
      orderStatus: 'CANCELLED',
    });
    expect(delegates.payment.update).toHaveBeenCalledWith({
      where: { id: paymentId },
      data: expect.objectContaining({
        hasFinancialException: true,
        reconciliationState: 'REQUIRES_REVIEW',
        reviewReason: 'TERMINAL_OUTCOME_CONFLICT',
      }),
    });
    const paymentUpdate = delegates.payment.update.mock.calls[0]?.[0];
    expect(paymentUpdate?.data).not.toHaveProperty('status');
    expect(delegates.order.update).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
    expect(delegates.paymentGatewayEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'SUCCESS',
          disposition: 'FINANCIAL_EXCEPTION',
          exceptionReason: 'TERMINAL_OUTCOME_CONFLICT',
        }),
      }),
    );
  });

  it('stores late SUCCESS evidence, leaves Payment PENDING, and cancels/releases atomically', async () => {
    const { tx, delegates } = makeTx({
      orderStatus: 'PENDING',
      beforeExpiry: false,
      beforeGraceEnd: true,
    });
    const result = await service.finalizeInTransaction(tx, {
      provider: 'VNPAY',
      paymentId,
      verifiedOutcome: gatewayOutcome({
        gatewayPaidAt: new Date('2026-10-31T12:08:01.000Z'),
      }),
    });
    expect(result).toMatchObject({
      disposition: 'FINANCIAL_EXCEPTION',
      paymentStatus: 'PENDING',
      orderStatus: 'CANCELLED',
    });
    expect(delegates.payment.update).toHaveBeenCalledWith({
      where: { id: paymentId },
      data: expect.objectContaining({
        hasFinancialException: true,
        reconciliationState: 'REQUIRES_REVIEW',
        reviewReason: 'LATE_SUCCESS',
      }),
    });
    const paymentUpdate = delegates.payment.update.mock.calls[0]?.[0];
    expect(paymentUpdate?.data).not.toHaveProperty('status');
    expect(delegates.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: orderId, status: { in: ['PENDING', 'PAYMENT_FAILED'] } },
        data: expect.objectContaining({ status: 'CANCELLED', updatedAt: now }),
      }),
    );
    expect(delegates.couponRedemption.updateMany).not.toHaveBeenCalled();
    expect(delegates.user.updateMany).not.toHaveBeenCalled();
  });

  it('propagates write failures so the transaction owner can roll back staged effects', async () => {
    const { tx, delegates } = makeTx({ couponId: '660e8400-e29b-41d4-a716-446655440010', beforeExpiry: true });
    delegates.payment.create.mockRejectedValue(new Error('simulated write failure'));
    await expect(
      service.finalizeInTransaction(tx, mockCommand('SUCCESS')),
    ).rejects.toThrow('simulated write failure');
    expect(delegates.couponRedemption.updateMany).toHaveBeenCalled();
    expect(delegates.user.updateMany).toHaveBeenCalled();
    expect(delegates.order.update).toHaveBeenCalled();
  });
});
