import type { Prisma } from '../generated/prisma/client.js';
import { expireOrderInTransaction } from './inventory-policy.js';

const orderId = '550e8400-e29b-41d4-a716-446655440010';
const productA = '550e8400-e29b-41d4-a716-446655440001';
const productB = '550e8400-e29b-41d4-a716-446655440002';
const dbNow = new Date('2026-10-31T12:13:00.000Z');

function makeTx(options: { graceEnded: boolean; hasPendingVnpay: boolean }) {
  let status = 'PENDING';
  const raw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (sql.includes('WITH db_clock'))
      return [
        {
          now: dbNow,
          expired: true,
          graceEnded: options.graceEnded,
          hasPendingVnpay: options.hasPendingVnpay,
        },
      ];
    if (sql.includes('FROM orders') && sql.includes('FOR UPDATE'))
      return [{ id: orderId }];
    return [];
  });
  const tx = {
    $queryRaw: raw,
    order: {
      findUniqueOrThrow: vi.fn(async () => ({
        status,
        couponId: null,
        userId: 'abcdef00-0000-4000-8000-000000000001',
      })),
      findUnique: vi.fn(async () => ({ status })),
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
        status = data.status;
        return { count: 1 };
      }),
    },
    orderItem: {
      findMany: vi.fn().mockResolvedValue([
        { productId: productB, quantity: 3 },
        { productId: productA, quantity: 2 },
      ]),
    },
    product: { update: vi.fn().mockResolvedValue({}) },
    couponRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
    coupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw, delegates: tx };
}

describe('shared Order expiration primitive', () => {
  it('keeps an expired Order active while VNPay is pending and dbNow < G', async () => {
    const { tx, delegates } = makeTx({
      graceEnded: false,
      hasPendingVnpay: true,
    });

    await expect(expireOrderInTransaction(tx, orderId)).resolves.toBe('PENDING');

    expect(delegates.order.updateMany).not.toHaveBeenCalled();
    expect(delegates.product.update).not.toHaveBeenCalled();
    expect(delegates.couponRedemption.findUnique).not.toHaveBeenCalled();
  });

  it('cancels at G and releases reserved inventory once using DB time', async () => {
    const { tx, delegates } = makeTx({
      graceEnded: true,
      hasPendingVnpay: true,
    });

    await expect(expireOrderInTransaction(tx, orderId)).resolves.toBe('CANCELLED');

    expect(delegates.order.updateMany).toHaveBeenCalledWith({
      where: { id: orderId, status: { in: ['PENDING', 'PAYMENT_FAILED'] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: dbNow,
        updatedAt: dbNow,
      },
    });
    expect(delegates.product.update).toHaveBeenNthCalledWith(1, {
      where: { id: productA },
      data: { stock: { increment: 2 } },
    });
    expect(delegates.product.update).toHaveBeenNthCalledWith(2, {
      where: { id: productB },
      data: { stock: { increment: 3 } },
    });
    expect(delegates.couponRedemption.findUnique).toHaveBeenCalledTimes(1);
  });
});
