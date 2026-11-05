import { describe, expect, it } from 'vitest';
import { describePromotionDrift, promotionFixtures, validatePromotionSeedTarget } from './seed-compose-coupons.policy.js';
const url = 'postgresql://user:password@postgres:5432/brewlite_compose?schema=public';
const valid = { NODE_ENV:'development', SEED_PROMO_ENV:'dev-compose', DATABASE_URL:url, SEED_PROMO_ALLOWED_DATABASE:'brewlite_compose', SEED_PROMO_CONFIRM:'SEED_PROMO_brewlite_compose' };
describe('promotion seed target guard', () => {
  it('accepts only an explicit dev-compose target', () => expect(validatePromotionSeedTarget(valid)).toBe('brewlite_compose'));
  it.each(['production', 'staging', undefined])('rejects runtime %s', runtime => {
    expect(() => validatePromotionSeedTarget({...valid, NODE_ENV:runtime})).toThrow();
  });
  it.each(['SEED_PROMO_ENV','SEED_PROMO_ALLOWED_DATABASE','SEED_PROMO_CONFIRM','DATABASE_URL'])('rejects missing %s', key => {
    expect(() => validatePromotionSeedTarget({...valid, [key]:undefined})).toThrow();
  });
  it.each([
    'postgresql://u:p@remote.example.com:5432/brewlite_compose',
    'postgresql://u:p@postgres:5433/brewlite_compose',
    'postgresql://u:p@postgres:5432/brewlite_prod',
    'postgresql://u:p@postgres:5432/brewlite_compose?host=remote',
    'postgresql://u:p@postgres:5432/brewlite_compose?socket=/var/run/postgresql',
    'mysql://u:p@postgres:5432/brewlite_compose',
  ])('rejects unsafe URL %s', bad => expect(() => validatePromotionSeedTarget({...valid,DATABASE_URL:bad})).toThrow());
});
describe('promotion fixtures and drift', () => {
  it('contains five distinct expected coupon codes', () => expect(promotionFixtures.map(x=>x.code)).toEqual(['WELCOME20','GIAM50K','FREE100','BREWLITE10K','QUOTA1K']));
  it('allows FREE100 to reduce an entire subtotal', () => {
    const coupon = promotionFixtures.find(x=>x.code==='FREE100')!;
    expect(coupon.value).toBe(100);
    expect(coupon.maxDiscountVnd).toBeNull();
  });
  it('reports existing coupon config drift without rewriting it', () => {
    const now = new Date('2026-11-05T00:00:00.000Z');
    const coupon = promotionFixtures.find(x=>x.code==='BREWLITE10K')!;
    expect(describePromotionDrift({...coupon, perUserLimit: 2, startsAt: new Date('2026-11-01'), expiresAt: new Date('2026-12-01')}, coupon, now)).toEqual(['perUserLimit']);
  });
});
