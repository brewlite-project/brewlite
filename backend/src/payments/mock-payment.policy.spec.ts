import { ForbiddenException } from '@nestjs/common';
import { MockPaymentService } from './mock-payment.service.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import { assertMockPaymentEnabled } from './mock-payment.policy.js';
import { PaymentsService } from './payments.service.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('Mock environment access policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['development', 'test', undefined])(
    'permits explicit opt-in outside production (%s)',
    (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
      expect(() => assertMockPaymentEnabled()).not.toThrow();
    },
  );

  it.each([
    ['test', undefined],
    ['test', ''],
    ['test', 'false'],
    ['test', 'TRUE'],
    ['test', '1'],
    ['test', 'yes'],
    ['test', ' true'],
    ['test', 'true '],
    [undefined, undefined],
    ['production', undefined],
    ['production', 'false'],
    ['production', 'true'],
  ])('denies NODE_ENV=%s, MOCK_PAYMENT_ENABLED=%s', (environment, flag) => {
    vi.stubEnv('NODE_ENV', environment);
    vi.stubEnv('MOCK_PAYMENT_ENABLED', flag);
    try {
      assertMockPaymentEnabled();
      expect.fail('Expected Mock to be disabled');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        statusCode: 403,
        message: 'Mock payment is disabled in this environment',
        error: 'Forbidden',
        code: 'MOCK_PAYMENT_DISABLED',
      });
    }
  });

  it('also rejects direct service calls before validation, database lookup or evaluation', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    const transaction = vi.fn();
    const mock = new MockPaymentService();
    const evaluate = vi.spyOn(mock, 'evaluate');
    const bodyPipe = new CreatePaymentPipe();
    const validate = vi.spyOn(bodyPipe, 'transform');
    const service = new PaymentsService(
      { $transaction: transaction } as unknown as PrismaService,
      mock,
      new PaymentFinalizationService(),
      bodyPipe,
      new IdempotencyKeyPipe(),
    );
    await expect(
      service.execute('user', 'bad-key', {
        orderId: 'invalid',
        method: 'CARD',
        paymentDetails: { cardNumber: 'invalid' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });
});
