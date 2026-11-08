import {
  buildDemoPromotionCoupons,
  promotionCouponCreateManyArgs,
} from './promotion-seed-data.js';

describe('demo promotion seed definitions', () => {
  const now = new Date('2026-11-04T00:00:00.000Z');

  it('defines requested active, expired, and legacy demo coupons', () => {
    const coupons = buildDemoPromotionCoupons(now);
    const byCode = new Map(coupons.map((coupon) => [coupon.code, coupon]));

    expect(byCode.get('WELCOME20')).toMatchObject({
      type: 'PERCENT',
      value: 20,
      minSubtotalVnd: 50000n,
      maxDiscountVnd: 30000n,
    });
    expect(byCode.get('GIAM50K')).toMatchObject({
      type: 'FIXED',
      value: 50000,
      minSubtotalVnd: 100000n,
    });
    expect(byCode.get('FREE100')).toMatchObject({
      type: 'PERCENT',
      value: 100,
      usageLimit: 100,
      perUserLimit: 1,
      minSubtotalVnd: 0n,
    });
    expect(byCode.get('EXPIRED10')!.expiresAt.getTime()).toBeLessThan(
      now.getTime(),
    );
    expect(byCode.has('BREWLITE10K')).toBe(true);
    expect(byCode.has('QUOTA1K')).toBe(true);
  });

  it('inserts only missing codes and initializes counters only for new rows', () => {
    const args = promotionCouponCreateManyArgs(buildDemoPromotionCoupons(now));
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(6);
    expect(args.data.every((coupon) => coupon.activeUsageCount === 0)).toBe(true);
  });
});
