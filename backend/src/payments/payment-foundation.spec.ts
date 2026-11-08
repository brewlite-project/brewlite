import { BadRequestException } from '@nestjs/common';
import { MockPaymentService } from './mock-payment.service.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
import { readPaymentSnapshot } from './payment-snapshot.js';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const body = {
  orderId,
  method: 'CARD',
  paymentDetails: { cardNumber: '1234567890121234' },
};
describe('Payment v3.0 validation and mock', () => {
  const pipe = new CreatePaymentPipe();
  const keyPipe = new IdempotencyKeyPipe();
  const mock = new MockPaymentService();
  it.each([
    ['CARD', '1234567890121234', 'SUCCESS'],
    ['CARD', '1234567890120002', 'FAILED'],
    ['CARD', '0000000000000000', 'SUCCESS'],
    ['WALLET', '0912345678', 'SUCCESS'],
    ['WALLET', '0912340000', 'FAILED'],
    ['WALLET', '0912340002', 'SUCCESS'],
  ] as const)(
    'evaluates %s deterministically',
    (method, credential, expected) => {
      const dto = pipe.transform({
        orderId,
        method,
        paymentDetails:
          method === 'CARD'
            ? { cardNumber: credential }
            : { phoneNumber: credential },
      });
      const result = mock.evaluate(dto);
      expect(result).toEqual({
        paymentStatus: expected,
        methodLast4: credential.slice(-4),
        failureReason: expected === 'FAILED' ? 'PAYMENT_DECLINED' : null,
      });
      expect(mock.evaluate(dto)).toEqual(result);
      expect(JSON.stringify(result)).not.toContain(credential);
    },
  );
  it.each([
    null,
    [],
    'CARD',
    {},
    { ...body, orderId: 'bad' },
    { ...body, method: 'card' },
    { ...body, method: 'CASH' },
    { ...body, paymentDetails: null },
    { ...body, paymentDetails: [] },
    { ...body, paymentDetails: { cardNumber: 1234567890121234 } },
    { ...body, paymentDetails: { cardNumber: '123456789012123' } },
    { ...body, paymentDetails: { cardNumber: '12345678901212345' } },
    { ...body, paymentDetails: { cardNumber: ' 1234567890121234' } },
    {
      ...body,
      paymentDetails: { cardNumber: '１２３４５６７８９０１２３４５６' },
    },
    {
      ...body,
      paymentDetails: {
        cardNumber: '1234567890121234',
        phoneNumber: '0912345678',
      },
    },
    { ...body, method: 'WALLET' },
    { ...body, method: 'WALLET', paymentDetails: { phoneNumber: '912345678' } },
    {
      ...body,
      method: 'WALLET',
      paymentDetails: { phoneNumber: '09123456789' },
    },
  ])('rejects malformed input without reflecting credentials', (value) => {
    let response: unknown;
    try {
      pipe.transform(value);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      response = (error as BadRequestException).getResponse();
    }
    expect(response).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(JSON.stringify(response)).not.toContain('1234567890121234');
  });
  it('whitelists accepted fields and preserves leading zeros', () => {
    const input = {
      ...body,
      userId: 'attacker',
      amount: 1,
      status: 'SUCCESS',
      paymentDetails: { cardNumber: '0000000000001234', amount: 1 },
    };
    expect(pipe.transform(input)).toEqual({
      ...body,
      paymentDetails: { cardNumber: '0000000000001234' },
    });
    expect(input).toHaveProperty('amount', 1);
  });
  it.each([undefined, null, [], 12345678, '', 'x'.repeat(7), 'x'.repeat(65)])(
    'rejects invalid keys',
    (key) => {
      expect(() => keyPipe.transform(key)).toThrow(BadRequestException);
    },
  );
  it.each(['x'.repeat(8), 'x'.repeat(64), 'CaseSensitive-key'])(
    'keeps keys opaque',
    (key) => {
      expect(keyPipe.transform(key)).toBe(key);
    },
  );
  it('does not expose arbitrary stored snapshot fields', () => {
    const paymentId = '550e8400-e29b-41d4-a716-446655440020';
    const expected = {
      paymentId,
      orderId,
      paymentStatus: 'FAILED',
      orderStatus: 'PAYMENT_FAILED',
      amountVnd: 98000,
      method: 'CARD',
      methodLast4: '0002',
      mockReference: 'MOCK-test',
      pointsEarned: 0,
      failureReason: 'PAYMENT_DECLINED',
      createdAt: '2026-10-25T02:00:00.000Z',
    };
    expect(
      readPaymentSnapshot(
        { ...expected, requestHash: 'private', cardNumber: '1234567890120002' },
        paymentId,
        orderId,
      ),
    ).toEqual(expected);
    expect(() =>
      readPaymentSnapshot({ ...expected, pointsEarned: 9 }, paymentId, orderId),
    ).toThrow();
  });
});
