
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVnpayConfig } from './vnpay.config.js';

const validPaymentUrl =
  'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';

function stubValidConfig(): void {
  vi.stubEnv('VNPAY_TMN_CODE', 'TESTMERCHANT');
  vi.stubEnv('VNPAY_HASH_SECRET', 'test-secret-not-real');
  vi.stubEnv('VNPAY_PAYMENT_URL', validPaymentUrl);
  vi.stubEnv(
    'VNPAY_RETURN_URL',
    'https://brewlite.example.com/payment/result',
  );
  vi.stubEnv('NODE_ENV', 'test');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('VNPay configuration', () => {
  it('loads valid Sandbox configuration', () => {
    stubValidConfig();

    expect(loadVnpayConfig()).toEqual({
      tmnCode: 'TESTMERCHANT',
      hashSecret: 'test-secret-not-real',
      paymentUrl: validPaymentUrl,
      returnUrl: 'https://brewlite.example.com/payment/result',
    });
  });

  it('rejects missing TMN Code', () => {
    stubValidConfig();
    vi.stubEnv('VNPAY_TMN_CODE', undefined);

    expect(() => loadVnpayConfig()).toThrow(
      'Missing required environment variable: VNPAY_TMN_CODE',
    );
  });

  it('rejects missing HashSecret', () => {
    stubValidConfig();
    vi.stubEnv('VNPAY_HASH_SECRET', undefined);

    expect(() => loadVnpayConfig()).toThrow(
      'Missing required environment variable: VNPAY_HASH_SECRET',
    );
  });

  it('rejects HashSecret with surrounding whitespace', () => {
    stubValidConfig();
    vi.stubEnv('VNPAY_HASH_SECRET', ' test-secret ');

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid whitespace in environment variable: VNPAY_HASH_SECRET',
    );
  });

  it('rejects whitespace-only HashSecret', () => {
    stubValidConfig();
    vi.stubEnv('VNPAY_HASH_SECRET', '   ');

    expect(() => loadVnpayConfig()).toThrow(
      'Missing required environment variable: VNPAY_HASH_SECRET',
    );
  });

  it('rejects a fake VNPay Sandbox domain', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      'https://sandbox.vnpayment.vn.attacker.com/paymentv2/vpcpay.html',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPay Sandbox payment URL configuration.',
    );
  });

  it('rejects an incorrect VNPay payment path', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      'https://sandbox.vnpayment.vn/invalid-path',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPay Sandbox payment URL configuration.',
    );
  });

  it('rejects an HTTP VNPay payment URL', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      'http://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'VNPAY_PAYMENT_URL must be HTTPS',
    );
  });

  it('rejects query parameters in configured payment URL', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_PAYMENT_URL',
      `${validPaymentUrl}?vnp_Amount=100`,
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPay Sandbox payment URL configuration.',
    );
  });

  it('accepts HTTP localhost Return URL in development', () => {
    stubValidConfig();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'http://localhost:3000/payment/result',
    );

    expect(loadVnpayConfig().returnUrl).toBe(
      'http://localhost:3000/payment/result',
    );
  });

  it('rejects HTTP localhost Return URL in production', () => {
    stubValidConfig();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'http://localhost:3000/payment/result',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL configuration.',
    );
  });

  it('rejects HTTP Return URL on a public domain', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'http://brewlite.example.com/payment/result',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL configuration.',
    );
  });

  it('rejects Return URL containing credentials', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'https://user:password@example.com/payment/result',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL configuration.',
    );
  });

  it('rejects Return URL containing query parameters', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'https://brewlite.example.com/payment/result?status=success',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL configuration.',
    );
  });

  it('rejects Return URL containing a fragment', () => {
    stubValidConfig();
    vi.stubEnv(
      'VNPAY_RETURN_URL',
      'https://brewlite.example.com/payment/result#success',
    );

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL configuration.',
    );
  });

  it('rejects a malformed Return URL', () => {
    stubValidConfig();
    vi.stubEnv('VNPAY_RETURN_URL', 'not-a-url');

    expect(() => loadVnpayConfig()).toThrow(
      'Invalid VNPAY_RETURN_URL',
    );
  });
});
