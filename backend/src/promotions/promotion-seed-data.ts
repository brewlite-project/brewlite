export interface PromotionCouponSeedDefinition {
  code: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  minSubtotalVnd: bigint;
  maxDiscountVnd: bigint | null;
  startsAt: Date;
  expiresAt: Date;
  usageLimit: number;
  perUserLimit: number;
}

export function buildDemoPromotionCoupons(
  now: Date = new Date(),
): PromotionCouponSeedDefinition[] {
  const startsAt = new Date(now);
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const expiredStartsAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const expiredAt = new Date(now.getTime() - 1);

  return [
    {
      code: 'WELCOME20',
      type: 'PERCENT',
      value: 20,
      minSubtotalVnd: 50000n,
      maxDiscountVnd: 30000n,
      startsAt,
      expiresAt,
      usageLimit: 100,
      perUserLimit: 1,
    },
    {
      code: 'GIAM50K',
      type: 'FIXED',
      value: 50000,
      minSubtotalVnd: 100000n,
      maxDiscountVnd: null,
      startsAt,
      expiresAt,
      usageLimit: 100,
      perUserLimit: 1,
    },
    {
      code: 'FREE100',
      type: 'PERCENT',
      value: 100,
      minSubtotalVnd: 0n,
      maxDiscountVnd: null,
      startsAt,
      expiresAt,
      usageLimit: 100,
      perUserLimit: 1,
    },
    {
      code: 'EXPIRED10',
      type: 'PERCENT',
      value: 10,
      minSubtotalVnd: 0n,
      maxDiscountVnd: null,
      startsAt: expiredStartsAt,
      expiresAt: expiredAt,
      usageLimit: 100,
      perUserLimit: 1,
    },
    // Keep the existing SCRUM-53 demo coupons.
    {
      code: 'BREWLITE10K',
      type: 'FIXED',
      value: 10000,
      minSubtotalVnd: 50000n,
      maxDiscountVnd: null,
      startsAt,
      expiresAt,
      usageLimit: 100,
      perUserLimit: 2,
    },
    {
      code: 'QUOTA1K',
      type: 'FIXED',
      value: 1000,
      minSubtotalVnd: 10000n,
      maxDiscountVnd: null,
      startsAt,
      expiresAt,
      usageLimit: 1,
      perUserLimit: 1,
    },
  ];
}

/** Existing rows are never updated; only new demo coupon codes are inserted. */
export function promotionCouponCreateManyArgs(
  coupons: readonly PromotionCouponSeedDefinition[],
) {
  return {
    data: coupons.map((coupon) => ({ ...coupon, activeUsageCount: 0 })),
    skipDuplicates: true as const,
  };
}
