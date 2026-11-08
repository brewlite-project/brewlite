import { setTimeout } from 'node:timers/promises';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function isRetryable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  if (
    [value.code, value.originalCode].some((code) =>
      ['P2034', '40P01', '40001', '55P03'].includes(String(code)),
    )
  )
    return true;
  return [value.meta, value.driverAdapterError, value.cause].some((child) =>
    isRetryable(child, depth + 1),
  );
}

/** Retry only aborted lock/deadlock/serialization transactions, never an uncertain commit. */
export async function runInventoryTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
          return work(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 2000,
          timeout: 8000,
        },
      );
    } catch (error) {
      if (attempt >= 2 || !isRetryable(error)) throw error;
      await setTimeout(25 * (attempt + 1));
    }
  }
}
