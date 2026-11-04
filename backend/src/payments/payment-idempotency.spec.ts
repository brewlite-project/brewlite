import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MockPaymentService } from './mock-payment.service.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
const userId = 'abcdef00-0000-4000-8000-000000000001';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const paymentId = '550e8400-e29b-41d4-a716-446655440020';
const dto = {
  orderId,
  method: 'CARD' as const,
  paymentDetails: { cardNumber: '1234567890121234' },
};
const requestHash = createHash('sha256')
  .update(JSON.stringify(dto))
  .digest('hex');
const response = {
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
  createdAt: '2026-10-26T00:00:00.000Z',
};
const saved = {
  id: paymentId,
  orderId,
  requestHash,
  responseSnapshot: response,
};

function subject() {
  const tx = {
    order: { findFirst: vi.fn().mockResolvedValue({ id: orderId }) },
    payment: { findUnique: vi.fn().mockResolvedValue(saved) },
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: false }]),
  };
  const transaction = vi.fn(
    async (callback: (value: unknown) => Promise<unknown>) => callback(tx),
  );
  const mock = new MockPaymentService();
  const evaluate = vi.spyOn(mock, 'evaluate');
  const service = new PaymentsService(
    { $transaction: transaction } as unknown as PrismaService,
    mock,
    new PaymentFinalizationService(),
    new CreatePaymentPipe(),
    new IdempotencyKeyPipe(),
  );
  return { service, tx, evaluate };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    expect.fail('Expected an HTTP error');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getResponse();
  }
}

describe('SCRUM-55 immutable idempotency responses', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(['SUCCESS', 'FAILED'] as const)(
    'replays saved %s without acquiring a processing lock or evaluating mock',
    async (status) => {
      const { service, tx, evaluate } = subject();
      const snapshot =
        status === 'SUCCESS'
          ? response
          : {
              ...response,
              paymentStatus: 'FAILED',
              orderStatus: 'PAYMENT_FAILED',
              pointsEarned: 0,
              failureReason: 'PAYMENT_DECLINED',
            };
      tx.payment.findUnique.mockResolvedValue({
        ...saved,
        responseSnapshot: snapshot,
      });
      expect(await service.execute(userId, 'existing-key', dto)).toEqual({
        response: snapshot,
        replayed: true,
      });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it('checks ownership before exposing any saved key information', async () => {
    const { service, tx, evaluate } = subject();
    tx.order.findFirst.mockResolvedValue(null);
    expect(
      await code(service.execute(userId, 'existing-key', dto)),
    ).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('rechecks committed snapshots when try-lock races with a committing writer', async () => {
    const { service, tx, evaluate } = subject();
    tx.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saved);
    expect(await service.execute(userId, 'existing-key', dto)).toEqual({
      response,
      replayed: true,
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('returns key conflict if a different payload commits during try-lock', async () => {
    const { service, tx, evaluate } = subject();
    tx.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...saved, requestHash: 'different' });
    expect(
      await code(service.execute(userId, 'existing-key', dto)),
    ).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('returns in-progress only while the key is busy and no snapshot is visible', async () => {
    const { service, tx, evaluate } = subject();
    tx.payment.findUnique.mockResolvedValue(null);
    expect(
      await code(service.execute(userId, 'existing-key', dto)),
    ).toMatchObject({ statusCode: 409, code: 'PAYMENT_IN_PROGRESS' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('uses canonical UUID owner identity for lookup regardless of JWT letter casing', async () => {
    const { service, tx } = subject();
    await service.execute(userId.toUpperCase(), 'existing-key', dto);
    expect(tx.order.findFirst).toHaveBeenCalledWith({
      where: { id: orderId, userId },
      select: { id: true },
    });
    expect(
      tx.payment.findUnique.mock.calls[0][0].where.userId_idempotencyKey.userId,
    ).toBe(userId);
  });
});
