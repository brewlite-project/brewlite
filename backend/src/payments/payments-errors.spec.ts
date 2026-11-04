import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PaymentsService } from './payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MockPaymentService } from './mock-payment.service.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
const dto = {
  orderId: '550e8400-e29b-41d4-a716-446655440010',
  method: 'CARD' as const,
  paymentDetails: { cardNumber: '1234567890121234' },
};
describe('Payment transaction error contract', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function service(error: unknown) {
    const transaction = vi.fn().mockRejectedValue(error);
    const value = new PaymentsService(
      { $transaction: transaction } as unknown as PrismaService,
      new MockPaymentService(),
      new PaymentFinalizationService(),
      new CreatePaymentPipe(),
      new IdempotencyKeyPipe(),
    );
    return { value, transaction };
  }
  it.each([
    { code: '55P03' },
    { driverAdapterError: { cause: { originalCode: '55P03' } } },
  ])('maps expected lock contention to PAYMENT_IN_PROGRESS', async (meta) => {
    const { value } = service(
      new Prisma.PrismaClientKnownRequestError('private database details', {
        code: 'P2010',
        clientVersion: '7.10.1',
        meta,
      }),
    );
    try {
      await value.execute('user', 'valid-key', dto);
      expect.fail('Expected conflict');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getResponse()).toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_IN_PROGRESS',
      });
    }
  });
  it('bounds serialization retries and returns a safe system error without fake FAILED attempts', async () => {
    const logError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { value, transaction } = service(
      new Prisma.PrismaClientKnownRequestError('private SQL', {
        code: 'P2034',
        clientVersion: '7.10.1',
      }),
    );
    try {
      await value.execute('user', 'valid-key', dto);
      expect.fail('Expected error');
    } catch (e) {
      expect((e as HttpException).getResponse()).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    }
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      'Failed to process payment',
    );
  });
});
