import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expireOrderInTransaction } from '../orders/inventory-policy.js';

vi.mock('../orders/inventory-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orders/inventory-policy.js')>()),
  expireOrderInTransaction: vi.fn(),
}));
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PaymentFinalizationService } from './payment-finalization.service.js';
import { VnpayQueryDrService } from './vnpay-querydr.service.js';

const orderId = '550e8400-e29b-41d4-a716-446655440010';
const paymentId = '550e8400-e29b-41d4-a716-446655440011';
const expiresAt = new Date('2026-11-03T10:00:00Z');
const now = new Date('2026-11-03T10:00:00Z');
const horizon = new Date('2026-11-03T11:05:00Z');
const base = {
  id: paymentId, orderId, provider: 'VNPAY', status: 'PENDING',
  reconciliationState: 'SCHEDULED', nextQueryAt: now, reconcileUntil: horizon,
  claimToken: null, leaseExpiresAt: null,
};

describe('QueryDR PostgreSQL lease and horizon', () => {
  const tx = {
    payment: { findUnique: vi.fn(), updateMany: vi.fn() },
    order: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  };
  const prisma = {
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  const finalization = {} as PaymentFinalizationService;
  const service = new VnpayQueryDrService(prisma, finalization);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(expireOrderInTransaction).mockResolvedValue('CANCELLED');
    tx.payment.findUnique.mockResolvedValueOnce({ orderId }).mockResolvedValue(base);
    tx.order.findUnique.mockResolvedValue({ expiresAt });
    tx.$queryRaw.mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: paymentId }])
      .mockResolvedValueOnce([{ now }]);
    tx.payment.updateMany.mockResolvedValue({ count: 1 });
  });

  it('claims atomically with next query due in 10 minutes and DB lease token', async () => {
    const claim = await service.claim(paymentId, 60_000, 600_000);
    expect(claim?.claimToken).toMatch(/[0-9a-f-]{36}/);
    expect(claim?.requestId).toMatch(/^[0-9a-f]{32}$/);
    const update = tx.payment.updateMany.mock.calls[0]?.[0];
    expect(update.data.nextQueryAt).toEqual(new Date('2026-11-03T10:10:00Z'));
    expect(update.data.leaseExpiresAt).toEqual(new Date('2026-11-03T10:01:00Z'));
    expect(update.data.queryAttempts).toEqual({ increment: 1 });
    // Order is locked first, Payment second, then DB time is sampled.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('does not acquire a second claim while a live lease exists', async () => {
    tx.payment.findUnique.mockReset().mockResolvedValueOnce({ orderId })
      .mockResolvedValue({ ...base, leaseExpiresAt: new Date('2026-11-03T10:00:30Z'), claimToken: 'old' });
    expect(await service.claim(paymentId, 60_000)).toBeNull();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('does not issue QueryDR when the horizon has elapsed', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: paymentId }])
      .mockResolvedValueOnce([{ now: horizon }]);
    expect(await service.claim(paymentId, 60_000)).toBeNull();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('marks unresolved Payment for review at H without setting FAILED', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: paymentId }])
      .mockResolvedValueOnce([{ now: horizon }]);
    expect(await service.markExhausted(paymentId)).toBe(true);
    expect(tx.payment.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      reconciliationState: 'REQUIRES_REVIEW',
      reviewReason: 'AUTO_RECONCILIATION_EXHAUSTED',
      nextQueryAt: null, claimToken: null, leaseExpiresAt: null,
    });
    expect(tx.payment.updateMany.mock.calls[0]?.[0]?.data.status).toBeUndefined();
  });

  it('does not mark review before active lease expires', async () => {
    tx.payment.findUnique.mockReset().mockResolvedValueOnce({ orderId })
      .mockResolvedValue({ ...base, leaseExpiresAt: new Date('2026-11-03T11:05:30Z'), claimToken: 'other' });
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: paymentId }])
      .mockResolvedValueOnce([{ now: horizon }]);
    expect(await service.markExhausted(paymentId)).toBe(false);
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('uses lease expiry and matching token as a fence on cleanup', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ now }]);
    expect(await service.releaseClaim(paymentId, 'owned-token', 'QUERYDR_UNVERIFIED_OR_TEMPORARY_FAILURE')).toBe(true);
    const update = tx.payment.updateMany.mock.calls[0]?.[0];
    expect(update.where.claimToken).toBe('owned-token');
    expect(update.where.leaseExpiresAt).toEqual({ gt: now });
    expect(update.data.status).toBeUndefined();
    expect(update.data.nextQueryAt).toBeUndefined();
  });
});
