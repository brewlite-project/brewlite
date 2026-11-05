import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertCouponQuotaAvailable,
  assertCouponValid,
  calculateDiscount,
  calculateLoyaltyPoints,
} from './promotion-policy.js';
const fixed = { type: 'FIXED' as const, value: 20000, maxDiscountVnd: null };
const percent = { type: 'PERCENT' as const, value: 15, maxDiscountVnd: null };
describe('SCRUM-56 promotion and loyalty rules', () => {
  it.each([
    [100000n, fixed, 20000n],
    [15000n, fixed, 15000n],
    [100000n, { ...percent, value: 10 }, 10000n],
    [500000n, { ...percent, value: 10, maxDiscountVnd: 30000n }, 30000n],
    [12345n, percent, 1852n],
    [10n, percent, 2n],
    [0n, fixed, 0n],
    [10000n, { ...percent, value: 100 }, 10000n],
    [10000n, { ...percent, maxDiscountVnd: 0n }, 0n],
    [9007199254740991n, percent, 1351079888211149n],
  ] as const)(
    'calculates exact discount for %s VND',
    (subtotal, coupon, expected) => {
      expect(calculateDiscount(subtotal, coupon)).toBe(expected);
      expect(subtotal - expected).toBeGreaterThanOrEqual(0n);
    },
  );
  it('caps PERCENT discounts and preserves FIXED maxDiscountVnd semantics', () => {
    expect(
      calculateDiscount(500000n, {
        type: 'PERCENT',
        value: 20,
        maxDiscountVnd: 30000n,
      }),
    ).toBe(30000n);
    expect(
      calculateDiscount(100000n, {
        type: 'FIXED',
        value: 50000,
        maxDiscountVnd: 10000n,
      }),
    ).toBe(50000n);
  });
  it('rejects exhausted global and per-user quotas', () => {
    expect(() =>
      assertCouponQuotaAvailable(
        { activeUsageCount: 1, usageLimit: 1, perUserLimit: 2 },
        0,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      assertCouponQuotaAvailable(
        { activeUsageCount: 0, usageLimit: 1, perUserLimit: 2 },
        2,
      ),
    ).toThrow(ConflictException);
    expect(() =>
      assertCouponQuotaAvailable(
        { activeUsageCount: 0, usageLimit: 1, perUserLimit: 2 },
        1,
      ),
    ).not.toThrow();
  });
  it.each([
    [0n, 0],
    [9999n, 0],
    [10000n, 1],
    [12004n, 1],
    [19999n, 1],
    [20000n, 2],
    [98000n, 9],
    [21474836479999n, 2147483647],
  ] as const)('awards points on paid total %s', (total, points) => {
    expect(calculateLoyaltyPoints(total)).toBe(points);
  });
  it.each([-1n, 21474836480000n])(
    'rejects invalid point totals %s',
    (total) => {
      expect(() => calculateLoyaltyPoints(total)).toThrow(RangeError);
    },
  );
  it.each([
    [-1n, fixed],
    [100n, { ...fixed, value: 0 }],
    [100n, { ...percent, value: 101 }],
    [100n, { ...percent, maxDiscountVnd: -1n }],
  ] as const)(
    'rejects invalid promotion configuration %#',
    (subtotal, coupon) => {
      expect(() => calculateDiscount(subtotal, coupon)).toThrow(RangeError);
    },
  );
  it('uses inclusive start/minimum and exclusive expiry', () => {
    const c = {
      startsAt: new Date(1000),
      expiresAt: new Date(2000),
      minSubtotalVnd: 100n,
    };
    expect(() => assertCouponValid(c, 100n, new Date(1000))).not.toThrow();
    expect(() => assertCouponValid(c, 100n, new Date(2000))).toThrow(
      BadRequestException,
    );
    expect(() => assertCouponValid(c, 99n, new Date(1500))).toThrow(
      BadRequestException,
    );
    expect(() => assertCouponValid(c, 100n, new Date(999))).toThrow(
      BadRequestException,
    );
    expect(() => assertCouponValid(null, 100n, new Date(1500))).toThrow(
      BadRequestException,
    );
  });
});
