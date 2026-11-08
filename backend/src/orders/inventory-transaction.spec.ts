import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { runInventoryTransaction } from './inventory-transaction.js';

describe('Inventory transaction retry policy', () => {
  it.each(['P2034', '40P01', '40001', '55P03'])(
    'restarts the whole transaction after an aborted %s',
    async (code) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce({
          meta: { driverAdapterError: { cause: { originalCode: code } } },
        })
        .mockResolvedValue('committed');
      const prisma = { $transaction: transaction } as unknown as PrismaService;
      await expect(runInventoryTransaction(prisma, vi.fn())).resolves.toBe(
        'committed',
      );
      expect(transaction).toHaveBeenCalledTimes(2);
    },
  );

  it('stops after three failed attempts', async () => {
    const error = { code: '40P01' };
    const transaction = vi.fn().mockRejectedValue(error);
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    await expect(runInventoryTransaction(prisma, vi.fn())).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    new ConflictException('Insufficient stock'),
    { code: 'P2002' },
    { code: 'P2028' },
    new Error('Connection lost; commit outcome unknown'),
  ])(
    'does not retry business/unique/unknown-commit failures %#',
    async (error) => {
      const transaction = vi.fn().mockRejectedValue(error);
      const prisma = { $transaction: transaction } as unknown as PrismaService;
      await expect(runInventoryTransaction(prisma, vi.fn())).rejects.toBe(
        error,
      );
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );
});
