import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPaymentReconciliationOptions } from './payment-reconciliation.config.js';

afterEach(() => vi.unstubAllEnvs());

describe('Payment reconciliation runtime configuration', () => {
  it('is opt-in, validates policy without requiring gateway secrets when disabled', () => {
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'false');
    expect(getPaymentReconciliationOptions()).toMatchObject({
      enabled: false, intervalMs: 60_000, batchSize: 50,
      cooldownMs: 600_000, leaseMs: 60_000,
    });
  });
  it('rejects invalid scheduling configuration and too-fast retries', () => {
    vi.stubEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', '0');
    expect(() => getPaymentReconciliationOptions()).toThrow('BATCH_SIZE');
    vi.stubEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', '50');
    vi.stubEnv('PAYMENT_RECONCILIATION_COOLDOWN_MS', '500000');
    expect(() => getPaymentReconciliationOptions()).toThrow('COOLDOWN_MS');
  });
  it('requires a real IP, signed QueryDR configuration and an adequate lease when enabled', () => {
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true');
    vi.stubEnv('PAYMENT_RECONCILIATION_IP_ADDR', 'invalid');
    expect(() => getPaymentReconciliationOptions()).toThrow('IP_ADDR');
    vi.stubEnv('PAYMENT_RECONCILIATION_IP_ADDR', '203.0.113.10');
    vi.stubEnv('VNPAY_TMN_CODE', 'TMN');
    vi.stubEnv('VNPAY_HASH_SECRET', 'test-only-secret');
    vi.stubEnv('VNPAY_QUERYDR_URL', 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction');
    vi.stubEnv('VNPAY_QUERYDR_TIMEOUT_MS', '58000');
    expect(() => getPaymentReconciliationOptions()).toThrow('LEASE_MS');
    vi.stubEnv('VNPAY_QUERYDR_TIMEOUT_MS', '15000');
    expect(getPaymentReconciliationOptions()).toMatchObject({
      enabled: true, ipAddr: '203.0.113.10',
    });
  });
});
