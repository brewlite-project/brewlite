import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  assertCouponQuotaAvailable,
  assertCouponValid,
  calculateDiscount,
} from '../promotions/promotion-policy.js';
import { money, priceCart } from '../orders/cart-pricing.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CouponPreviewDto } from './dto/coupon-preview.dto.js';

@Injectable()
export class CouponsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async preview(userId: string, dto: CouponPreviewDto) {
    try {
      const { subtotal } = await priceCart(this.prisma, dto.items);
      const coupon = await this.prisma.coupon.findUnique({
        where: { code: dto.couponCode },
      });
      const [clock] = await this.prisma.$queryRaw<{ now: Date }[]>`
        SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Missing coupon preview clock');
      assertCouponValid(coupon, subtotal, clock.now);

      const userUsageCount = await this.prisma.couponRedemption.count({
        where: {
          userId: userId.toLowerCase(),
          couponId: coupon.id,
          status: { in: ['HELD', 'CONSUMED'] },
        },
      });
      assertCouponQuotaAvailable(coupon, userUsageCount);

      const discount = calculateDiscount(subtotal, coupon);
      const total = subtotal > discount ? subtotal - discount : 0n;
      return {
        couponCode: dto.couponCode,
        subtotalVnd: money(subtotal),
        discountVnd: money(discount),
        totalVnd: money(total),
        valid: true as const,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    }
  }
}
