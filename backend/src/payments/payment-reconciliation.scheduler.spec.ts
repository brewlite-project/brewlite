import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { VnpayQueryDrService } from './vnpay-querydr.service.js';
import { PaymentReconciliationScheduler } from './payment-reconciliation.scheduler.js';
import type { PaymentReconciliationOptions } from './payment-reconciliation.config.js';

const a = '550e8400-e29b-41d4-a716-446655440001';
const b = '550e8400-e29b-41d4-a716-446655440002';
const c = '550e8400-e29b-41d4-a716-446655440003';
const cutoff = '2026-11-03 03:00:00+00';
const options: PaymentReconciliationOptions = {
  enabled: true, intervalMs: 60_000, batchSize: 2,
  leaseMs: 60_000, cooldownMs: 600_000, ipAddr: '203.0.113.10',
};

describe('Payment reconciliation scheduler', () => {
  const query = vi.fn();
  const claim = vi.fn();
  const reconcileClaimed = vi.fn();
  const releaseClaim = vi.fn();
  const markExhausted = vi.fn();
  const prisma = { $queryRaw: query } as unknown as PrismaService;
  const querydr = { claim, reconcileClaimed, releaseClaim, markExhausted } as unknown as VnpayQueryDrService;
  let scheduler: PaymentReconciliationScheduler;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    query.mockResolvedValueOnce([{ cutoff }]).mockResolvedValue([]);
    claim.mockResolvedValue({ claimToken: 'token', requestId: 'request' });
    reconcileClaimed.mockResolvedValue({ disposition: 'OBSERVED' });
    releaseClaim.mockResolvedValue(true);
    markExhausted.mockResolvedValue(true);
    scheduler = new PaymentReconciliationScheduler(prisma, querydr, options);
  });
  afterEach(async () => {
    await scheduler.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts a timer only when enabled and stops it on destroy', async () => {
    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('does not start automatically when disabled', async () => {
    scheduler = new PaymentReconciliationScheduler(prisma, querydr, { ...options, enabled: false });
    scheduler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).not.toHaveBeenCalled();
  });
  it('coalesces overlapping sweeps within one instance', async () => {
    let resume!: (value: { cutoff: string }[]) => void;
    query.mockReset().mockImplementationOnce(() => new Promise(resolve => { resume = resolve; })).mockResolvedValue([]);
    const first = scheduler.runOnce();
    expect(scheduler.runOnce()).toBe(first);
    resume([{ cutoff }]);
    await first;
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('handles due and exhausted payments across batches, without retry bursts', async () => {
    query.mockReset()
      .mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: a, horizonReached: false }, { id: b, horizonReached: true }])
      .mockResolvedValueOnce([{ id: c, horizonReached: false }]);
    await scheduler.runOnce();
    expect(claim.mock.calls.map(row => row[0])).toEqual([a, c]);
    expect(claim.mock.calls[0]?.slice(1)).toEqual([60_000, 600_000]);
    expect(markExhausted).toHaveBeenCalledTimes(1);
    expect(markExhausted).toHaveBeenCalledWith(b);
    expect(reconcileClaimed).toHaveBeenCalledTimes(2);
    expect(reconcileClaimed).toHaveBeenCalledWith(a, 'request', 'token', '203.0.113.10');
    expect(releaseClaim).toHaveBeenCalledWith(a, 'token', null);
  });
  it('never calls gateway if another worker owns the claim', async () => {
    query.mockReset().mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: a, horizonReached: false }]);
    claim.mockResolvedValue(null);
    await scheduler.runOnce();
    expect(reconcileClaimed).not.toHaveBeenCalled();
    expect(releaseClaim).not.toHaveBeenCalled();
  });
  it('retains PENDING, records sanitized error and schedules cooldown after a timeout', async () => {
    query.mockReset().mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: a, horizonReached: false }]);
    reconcileClaimed.mockRejectedValue(new Error('raw gateway secret must not be logged'));
    await scheduler.runOnce();
    expect(releaseClaim).toHaveBeenCalledWith(a, 'token', 'QUERYDR_UNVERIFIED_OR_TEMPORARY_FAILURE');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
  });
  it('does not abort a sweep after an individual payment fails', async () => {
    query.mockReset().mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: a, horizonReached: false }, { id: b, horizonReached: true }])
      .mockResolvedValueOnce([]);
    claim.mockRejectedValueOnce(new Error('database private details'));
    await scheduler.runOnce();
    expect(markExhausted).toHaveBeenCalledWith(b);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('database private details');
  });
});
