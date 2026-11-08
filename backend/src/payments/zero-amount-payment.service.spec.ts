import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import {
  IdempotencyKeyPipe,
  ZeroAmountPaymentPipe,
} from './payment-validation.pipe.js';
import { ZeroAmountPaymentService } from './zero-amount-payment.service.js';

const userId = 'abcdef00-0000-4000-8000-000000000001';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const response = {
  paymentId: '550e8400-e29b-41d4-a716-446655440020',
  orderId,
  provider: 'ZERO_AMOUNT' as const,
  paymentStatus: 'SUCCESS' as const,
  orderStatus: 'PAID' as const,
  amountVnd: 0 as const,
  pointsEarned: 0 as const,
  createdAt: '2026-11-03T00:00:00.000Z',
};
function subject() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    order: { findFirst: vi.fn().mockResolvedValue({ id: orderId }) },
    payment: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
    work(tx),
  );
  const finalize = vi
    .fn()
    .mockResolvedValue({
      disposition: 'FINALIZED',
      zeroAmountResponse: response,
    });
  const service = new ZeroAmountPaymentService(
    { $transaction: transaction } as unknown as PrismaService,
    {
      finalizeInTransaction: finalize,
    } as unknown as PaymentFinalizationService,
    new ZeroAmountPaymentPipe(),
    new IdempotencyKeyPipe(),
  );
  return { service, tx, transaction, finalize };
}
async function errorBody(work: Promise<unknown>) {
  try {
    await work;
    expect.fail('Expected an HTTP error');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getResponse();
  }
}

describe('ZERO_AMOUNT orchestration', () => {
  it('uses verified owner, canonical Order ID and only Shared Finalization for completion', async () => {
    const { service, tx, finalize } = subject();
    expect(
      await service.execute(userId.toUpperCase(), 'zero-key-001', {
        orderId: orderId.toUpperCase(),
        amountVnd: 0,
        userId: 'attacker',
        provider: 'MOCK',
      }),
    ).toEqual({ response, replayed: false });
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { id: orderId, userId },
      select: { id: true },
    });
    expect(finalize).toHaveBeenCalledExactlyOnceWith(
      tx,
      expect.objectContaining({
        provider: 'ZERO_AMOUNT',
        userId,
        orderId,
        idempotencyKey: 'zero-key-001',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });
  it('checks ownership before reading a key or acquiring a processing lock', async () => {
    const { service, tx, finalize } = subject();
    tx.order.findFirst.mockResolvedValue(null);
    expect(
      await errorBody(service.execute(userId, 'zero-key-001', { orderId })),
    ).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
  it('replays a completed snapshot through Shared Finalization before a processing lock', async () => {
    const { service, tx, finalize } = subject();
    tx.payment.findUnique.mockResolvedValue({ id: response.paymentId });
    finalize.mockResolvedValue({
      disposition: 'DUPLICATE',
      zeroAmountResponse: response,
    });
    expect(await service.execute(userId, 'zero-key-001', { orderId })).toEqual({
      response,
      replayed: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('rechecks for a winner that committed while the advisory key was busy', async () => {
    const { service, tx, finalize } = subject();
    tx.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: response.paymentId });
    tx.$queryRaw.mockResolvedValue([{ acquired: false }]);
    finalize.mockResolvedValue({
      disposition: 'DUPLICATE',
      zeroAmountResponse: response,
    });
    expect(await service.execute(userId, 'zero-key-001', { orderId })).toEqual({
      response,
      replayed: true,
    });
  });
  it('bounds a busy key with PAYMENT_IN_PROGRESS without calling finalization', async () => {
    const { service, tx, finalize } = subject();
    tx.$queryRaw.mockResolvedValue([{ acquired: false }]);
    expect(
      await errorBody(service.execute(userId, 'zero-key-001', { orderId })),
    ).toMatchObject({ statusCode: 409, code: 'PAYMENT_IN_PROGRESS' });
    expect(finalize).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    'short',
    'x'.repeat(65),
    ['duplicate-key', 'duplicate-key'],
  ])(
    'rejects an invalid key before opening a transaction (%j)',
    async (key) => {
      const { service, transaction } = subject();
      expect(
        await errorBody(service.execute(userId, key, { orderId })),
      ).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each([null, [], {}, { orderId: 1 }, { orderId: 'invalid' }])(
    'rejects an invalid request before opening a transaction (%j)',
    async (body) => {
      const { service, transaction } = subject();
      expect(
        await errorBody(service.execute(userId, 'zero-key-001', body)),
      ).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['55P03', '40P01', '40001', 'P2034'])(
    'maps aborted lock/serialization transactions to a bounded conflict (%s)',
    async (code) => {
      const { service, transaction } = subject();
      transaction.mockRejectedValue({
        meta: { driverAdapterError: { cause: { originalCode: code } } },
      });
      expect(
        await errorBody(service.execute(userId, 'zero-key-001', { orderId })),
      ).toMatchObject({ statusCode: 409, code: 'PAYMENT_IN_PROGRESS' });
    },
  );
  it('sanitizes unexpected database failures', async () => {
    const { service, transaction } = subject();
    transaction.mockRejectedValue(
      new Error('private SQL credentials and connection details'),
    );
    expect(
      await errorBody(service.execute(userId, 'zero-key-001', { orderId })),
    ).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
  it('rejects missing finalization snapshots so the caller transaction rolls back', async () => {
    const { service, finalize } = subject();
    finalize.mockResolvedValue({ disposition: 'FINALIZED' });
    expect(
      await errorBody(service.execute(userId, 'zero-key-001', { orderId })),
    ).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });
});
