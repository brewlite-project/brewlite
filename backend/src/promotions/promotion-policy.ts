import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Coupon, Prisma } from '../generated/prisma/client.js';
type DiscountCoupon = Pick<Coupon, 'type' | 'value' | 'maxDiscountVnd'>;
type ValidityCoupon = Pick<Coupon, 'startsAt' | 'expiresAt' | 'minSubtotalVnd'>;
const unavailable = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'COUPON_UNAVAILABLE',
    message: 'Coupon usage limit reached',
  });

export function assertCouponQuotaAvailable(
  coupon: Pick<Coupon, 'activeUsageCount' | 'usageLimit' | 'perUserLimit'>,
  userUsageCount: number,
): void {
  if (
    coupon.activeUsageCount >= coupon.usageLimit ||
    userUsageCount >= coupon.perUserLimit
  )
    throw unavailable();
}
export function assertCouponValid(
  coupon: ValidityCoupon | null,
  subtotal: bigint,
  now: Date,
): asserts coupon is ValidityCoupon {
  const message = !coupon
    ? 'Coupon does not exist'
    : coupon.startsAt > now
      ? 'Coupon is not active yet'
      : coupon.expiresAt <= now
        ? 'Coupon has expired'
        : subtotal < coupon.minSubtotalVnd
          ? 'Order subtotal does not meet coupon minimum'
          : null;
  if (message)
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'INVALID_COUPON',
      message,
    });
}
export function calculateDiscount(
  subtotal: bigint,
  coupon: DiscountCoupon,
): bigint {
  if (
    subtotal < 0n ||
    !Number.isSafeInteger(coupon.value) ||
    coupon.value <= 0 ||
    (coupon.type === 'PERCENT' && coupon.value > 100) ||
    (coupon.maxDiscountVnd !== null && coupon.maxDiscountVnd < 0n)
  )
    throw new RangeError('Invalid promotion amount');
  let discount =
    coupon.type === 'FIXED'
      ? BigInt(coupon.value)
      : (subtotal * BigInt(coupon.value) + 50n) / 100n;
  if (
    coupon.type === 'PERCENT' &&
    coupon.maxDiscountVnd !== null &&
    discount > coupon.maxDiscountVnd
  )
    discount = coupon.maxDiscountVnd;
  return discount > subtotal ? subtotal : discount;
}
export function calculateLoyaltyPoints(totalVnd: bigint): number {
  if (totalVnd < 0n || totalVnd / 10000n > 2147483647n)
    throw new RangeError('Points exceed database range');
  return Number(totalVnd / 10000n);
}
/** Caller reserves stock first, within the same Order transaction. */
export async function reserveCoupon(
  tx: Prisma.TransactionClient,
  userId: string,
  couponId: string,
  subtotal: bigint,
  expectedCode: string,
) {
  // Lock before re-reading BOTH global and per-user quota. Under READ COMMITTED,
  // a waiting request sees the preceding holder's committed redemption rows.
  await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${couponId}::uuid FOR UPDATE`;
  const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error('Missing locked coupon validation clock');
  if (!coupon || coupon.code !== expectedCode)
    assertCouponValid(null, subtotal, clock.now);
  assertCouponValid(coupon, subtotal, clock.now);
  const used = await tx.couponRedemption.count({
    where: { userId, couponId, status: { in: ['HELD', 'CONSUMED'] } },
  });
  assertCouponQuotaAvailable(coupon, used);
  const discount = calculateDiscount(subtotal, coupon);
  const reserved = await tx.coupon.updateMany({
    where: { id: couponId, activeUsageCount: { lt: coupon.usageLimit } },
    data: { activeUsageCount: { increment: 1 } },
  });
  if (reserved.count !== 1) throw unavailable();
  return { coupon, discount, now: clock.now };
}
/** Lifecycle/Scheduler calls AFTER setting CANCELLED, in the SAME transaction.
 * Does not commit cancellation, release inventory or change loyalty itself. */
export async function releaseHeldCoupon(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, couponId: true, userId: true },
  });
  if (order.status !== 'CANCELLED')
    throw new Error('Coupon release requires CANCELLED Order');
  const redemption = await tx.couponRedemption.findUnique({
    where: { orderId },
  });
  if (!redemption) {
    if (order.couponId) throw new Error('Coupon reservation is missing');
    return false;
  }
  if (
    redemption.couponId !== order.couponId ||
    redemption.userId !== order.userId
  )
    throw new Error('Coupon reservation does not match Order');
  if (redemption.status === 'RELEASED') return false;
  if (redemption.status !== 'HELD')
    throw new Error('Consumed coupon cannot be released');
  await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${redemption.couponId}::uuid FOR UPDATE`;
  const released = await tx.couponRedemption.updateMany({
    where: {
      orderId,
      couponId: redemption.couponId,
      userId: order.userId,
      status: 'HELD',
    },
    data: { status: 'RELEASED', releasedAt: now },
  });
  if (released.count !== 1) throw new Error('Unable to release held coupon');
  const restored = await tx.coupon.updateMany({
    where: { id: redemption.couponId, activeUsageCount: { gte: 1 } },
    data: { activeUsageCount: { decrement: 1 } },
  });
  if (restored.count !== 1) throw new Error('Coupon quota is inconsistent');
  return true;
}
