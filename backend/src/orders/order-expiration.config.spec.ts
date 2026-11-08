import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrderExpirationOptions } from './order-expiration.config.js';

describe('Order expiration configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('enables the minute scheduler by default with small batches', () => {
    vi.stubEnv('ORDER_EXPIRATION_ENABLED', undefined);
    vi.stubEnv('ORDER_EXPIRATION_BATCH_SIZE', undefined);
    expect(getOrderExpirationOptions()).toEqual({
      enabled: true,
      batchSize: 50,
    });
  });
  it('allows disabling automatic scheduling and choosing batch size', () => {
    vi.stubEnv('ORDER_EXPIRATION_ENABLED', 'false');
    vi.stubEnv('ORDER_EXPIRATION_BATCH_SIZE', '2');
    expect(getOrderExpirationOptions()).toEqual({
      enabled: false,
      batchSize: 2,
    });
  });
  it.each(['', '1', 'FALSE', 'yes'])(
    'rejects invalid enabled value %s',
    (value) => {
      vi.stubEnv('ORDER_EXPIRATION_ENABLED', value);
      expect(getOrderExpirationOptions).toThrow('ORDER_EXPIRATION_ENABLED');
    },
  );
  it.each(['', '0', '-1', '1.5', '1e2', '1001', 'abc'])(
    'rejects invalid batch size %s',
    (value) => {
      vi.stubEnv('ORDER_EXPIRATION_BATCH_SIZE', value);
      expect(getOrderExpirationOptions).toThrow('ORDER_EXPIRATION_BATCH_SIZE');
    },
  );
});
