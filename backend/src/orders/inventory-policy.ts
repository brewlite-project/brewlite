import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { OrderStatus } from '../generated/prisma/enums.js';
import { releaseHeldCoupon } from '../promotions/promotion-policy.js';
import { ORDER_GRACE_MS } from './order-expiration.config.js';

export function inventoryQuantities(
  items: readonly { productId: string; quantity: number }[],
) {
  const quantities = new Map<string, number>();
  for (const item of items) {
    // PostgreSQL UUIDs are case-insensitive; group and lock by the canonical ID.
    const id = item.productId.toLowerCase();
    quantities.set(id, (quantities.get(id) ?? 0) + item.quantity);
  }
  return [...quantities].sort(([a], [b]) => a.localeCompare(b));
}

/** Caller must keep reservation and Order creation in the SAME transaction. */
export async function reserveInventory(
  tx: Prisma.TransactionClient,
  quantities: readonly [string, number][],
): Promise<void> {
  for (const [productId, quantity] of quantities) {
    // This conditional UPDATE takes a row lock and rechecks stock after waiting.
    const reserved = await tx.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });
    if (reserved.count !== 1) {
      const product = await tx.product.findUnique({ where: { id: productId } });
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INSUFFICIENT_STOCK',
        message: 'Insufficient product stock',
        details: [
          {
            productId,
            requestedQuantity: quantity,
            availableQuantity: product?.stock ?? 0,
          },
        ],
      });
    }
  }
}

/**
 * Shared expiration primitive for Create Order and the Scheduler.
 * Caller owns the transaction. CANCELLED is the one-time release marker; never
 * set it separately or swallow an error and commit a partial release.
 */
export async function expireOrderInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderStatus | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  if (!locked.length) return null;
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  });
  if (order.status !== 'PENDING' && order.status !== 'PAYMENT_FAILED')
    return order.status;
  // DB time, persisted expiresAt and VNPay pending state are checked together
  // AFTER the Order lock. A candidate scan must never cancel during Grace.
  const [clock] = await tx.$queryRaw<
    {
      now: Date;
      expired: boolean;
      graceEnded: boolean;
      hasPendingVnpay: boolean;
    }[]
  >`
    WITH db_clock AS MATERIALIZED (
      SELECT clock_timestamp() AS now
    )
    SELECT db_clock.now AS now,
           db_clock.now >= orders.expires_at AS expired,
           db_clock.now >= orders.expires_at + (${ORDER_GRACE_MS} * INTERVAL '1 millisecond') AS "graceEnded",
           EXISTS (
             SELECT 1 FROM payments
             WHERE payments.order_id = orders.id
               AND payments.provider = 'VNPAY'
               AND payments.status = 'PENDING'
           ) AS "hasPendingVnpay"
    FROM orders CROSS JOIN db_clock
    WHERE orders.id = ${orderId}::uuid`;
  if (!clock) throw new Error('Missing Order expiration clock');
  if (!clock.expired) return order.status;
  if (clock.hasPendingVnpay && !clock.graceEnded) return order.status;

  return cancelLockedOrderAndReleaseInTransaction(tx, orderId, clock.now);
}

/**
 * Caller must already hold the Order row lock and own the transaction.
 * CANCELLED is the one-time marker for inventory and coupon release.
 */
export async function cancelLockedOrderAndReleaseInTransaction(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date,
): Promise<OrderStatus | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  if (!order) return null;
  if (order.status !== 'PENDING' && order.status !== 'PAYMENT_FAILED')
    return order.status;
  const cancelled = await tx.order.updateMany({
    where: { id: orderId, status: { in: ['PENDING', 'PAYMENT_FAILED'] } },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      updatedAt: now,
    },
  });
  if (cancelled.count !== 1) {
    const current = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return current?.status ?? null;
  }
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { productId: true, quantity: true },
  });
  // The same Product order is used for reserve and release, including mixed sizes.
  for (const [productId, quantity] of inventoryQuantities(items)) {
    await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: quantity } },
    });
  }
  await releaseHeldCoupon(tx, orderId, now);
  return 'CANCELLED';
}
