import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { expireOrderInTransaction } from './inventory-policy.js';
import { runInventoryTransaction } from './inventory-transaction.js';
import { OrderExpirationService } from './order-expiration.service.js';

vi.mock('./inventory-policy.js', () => ({ expireOrderInTransaction: vi.fn() }));
vi.mock('./inventory-transaction.js', () => ({
  runInventoryTransaction: vi.fn(),
}));
const cutoff = '2026-10-27 01:00:00.123456+00';
const first = '550e8400-e29b-41d4-a716-446655440001';
const second = '550e8400-e29b-41d4-a716-446655440002';
const third = '550e8400-e29b-41d4-a716-446655440003';

describe('Order expiration runner', () => {
  const query = vi.fn();
  const prisma = { $queryRaw: query } as unknown as PrismaService;
  const transaction = vi.mocked(runInventoryTransaction);
  const expire = vi.mocked(expireOrderInTransaction);
  let service: OrderExpirationService;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    query.mockResolvedValueOnce([{ cutoff }]).mockResolvedValue([]);
    transaction.mockImplementation((_prisma, work) => work({} as never));
    expire.mockResolvedValue('CANCELLED');
    service = new OrderExpirationService(prisma, {
      enabled: true,
      batchSize: 2,
    });
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs at one-minute intervals and stops the timer on shutdown', async () => {
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not start an automatic timer when disabled', async () => {
    service = new OrderExpirationService(prisma, {
      enabled: false,
      batchSize: 2,
    });
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(query).not.toHaveBeenCalled();
    await service.runOnce();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping sweeps on one instance', async () => {
    let release!: (rows: { cutoff: string }[]) => void;
    query
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([]);
    const a = service.runOnce();
    const b = service.runOnce();
    expect(a).toBe(b);
    expect(query).toHaveBeenCalledTimes(1);
    release([{ cutoff }]);
    await Promise.all([a, b]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('continues through batches after one failed Order and never logs driver details', async () => {
    query
      .mockReset()
      .mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: first }, { id: second }])
      .mockResolvedValueOnce([{ id: third }]);
    expire.mockRejectedValueOnce(new Error('private SQL credentials'));
    await service.runOnce();
    expect(expire.mock.calls.map((call) => call[1])).toEqual([
      first,
      second,
      third,
    ]);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2].slice(1)).toEqual([
      cutoff,
      300_000,
      cutoff,
      second,
      second,
      2,
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private SQL');
  });

  it('recovers on the next sweep after a scan failure', async () => {
    query
      .mockReset()
      .mockRejectedValueOnce(new Error('private database URL'))
      .mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValue([]);
    await expect(service.runOnce()).resolves.toBeUndefined();
    await service.runOnce();
    expect(query).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private database');
  });

  it('drains the in-flight Order, skips remaining candidates and rejects new work on shutdown', async () => {
    query
      .mockReset()
      .mockResolvedValueOnce([{ cutoff }])
      .mockResolvedValueOnce([{ id: first }, { id: second }]);
    let release!: () => void;
    transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('CANCELLED');
        }),
    );
    const running = service.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(transaction).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([running, stopping]);
    await service.runOnce();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
