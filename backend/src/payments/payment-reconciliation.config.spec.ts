import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPaymentReconciliationOptions } from './payment-reconciliation.config.js';

afterEach(() => vi.unstubAllEnvs());

describe('Payment reconciliation runtime configuration', () => {
  it('allows explicitly disabled scheduler only in non-production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'false');
    expect(getPaymentReconciliationOptions()).toMatchObject({
      enabled: false, intervalMs: 60_000, batchSize: 50,
      cooldownMs: 600_000, leaseMs: 60_000,
    });
  });
  it('rejects invalid scheduling configuration and too-fast retries', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', '0');
    expect(() => getPaymentReconciliationOptions()).toThrow('BATCH_SIZE');
    vi.stubEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', '50');
    vi.stubEnv('PAYMENT_RECONCILIATION_COOLDOWN_MS', '500000');
    expect(() => getPaymentReconciliationOptions()).toThrow('COOLDOWN_MS');
  });
  it('requires a real IP, signed QueryDR configuration and an adequate lease when enabled', () => {
    vi.stubEnv('NODE_ENV', 'test');
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
  it('defaults to disabled only for development and tests when flag is absent', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', undefined);
    expect(getPaymentReconciliationOptions().enabled).toBe(false);
  });

  it('fails closed in production when the enabled flag is missing or false', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', undefined);
    expect(() => getPaymentReconciliationOptions()).toThrow('Production requires PAYMENT_RECONCILIATION_ENABLED=true');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'false');
    expect(() => getPaymentReconciliationOptions()).toThrow('Production requires PAYMENT_RECONCILIATION_ENABLED=true');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'yes');
    expect(() => getPaymentReconciliationOptions()).toThrow('Production requires PAYMENT_RECONCILIATION_ENABLED=true');
  });

  it('fails production startup for incomplete gateway or invalid lease even when enabled', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true');
    vi.stubEnv('PAYMENT_RECONCILIATION_IP_ADDR', '203.0.113.10');
    vi.stubEnv('VNPAY_TMN_CODE', undefined);
    vi.stubEnv('VNPAY_HASH_SECRET', undefined);
    expect(() => getPaymentReconciliationOptions()).toThrow();
    vi.stubEnv('VNPAY_TMN_CODE', 'TESTMERCHANT');
    vi.stubEnv('VNPAY_HASH_SECRET', 'unit-only-secret');
    vi.stubEnv('VNPAY_QUERYDR_URL', 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction');
    vi.stubEnv('VNPAY_QUERYDR_TIMEOUT_MS', '15000');
    vi.stubEnv('PAYMENT_RECONCILIATION_LEASE_MS', '20000');
    expect(() => getPaymentReconciliationOptions()).toThrow('LEASE_MS');
    vi.stubEnv('PAYMENT_RECONCILIATION_LEASE_MS', '60000');
    expect(getPaymentReconciliationOptions().enabled).toBe(true);
  });
  it('also fails closed for an unknown runtime if the enable flag is missing', () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', undefined);
    expect(() => getPaymentReconciliationOptions()).toThrow('must be explicit outside development/test');
  });

});
