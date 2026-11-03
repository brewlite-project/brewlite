export const ORDER_EXPIRATION_OPTIONS = Symbol('ORDER_EXPIRATION_OPTIONS');
export const ORDER_EXPIRATION_INTERVAL_MS = 60_000;
// Business deadlines stay fixed; tests move fixture timestamps instead of waiting.
export const ORDER_TTL_MS = 15 * 60_000;
export const ORDER_GRACE_MS = 5 * 60_000;

export type OrderExpirationOptions = { enabled: boolean; batchSize: number };

export function getOrderExpirationOptions(): OrderExpirationOptions {
  const enabled = process.env.ORDER_EXPIRATION_ENABLED ?? 'true';
  const batchSize = process.env.ORDER_EXPIRATION_BATCH_SIZE ?? '50';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('ORDER_EXPIRATION_ENABLED must be true or false.');
  if (!/^[1-9]\d*$/.test(batchSize) || Number(batchSize) > 1000)
    throw new Error(
      'ORDER_EXPIRATION_BATCH_SIZE must be an integer from 1 to 1000.',
    );
  return { enabled: enabled === 'true', batchSize: Number(batchSize) };
}
