import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';

const SIZE_PERCENT = { S: 100, M: 120, L: 140, ONE_SIZE: 100 } as const;
const invalid = (code: string, message: string) =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
const pending = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'PENDING_ORDER_EXISTS',
    message: 'An active order already exists',
  });
const invalidCart = (productId: string, reason: string) =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'INVALID_CART',
    message: 'Invalid cart',
    details: [{ productId, reason }],
  });
const money = (value: bigint) => {
  const number = Number(value);
  if (value < 0n || !Number.isSafeInteger(number))
    throw new InternalServerErrorException('Invalid monetary amount');
  return number;
};

@Injectable()
export class OrdersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrderDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          !(await tx.user.findUnique({
            where: { id: userId },
            select: { id: true },
          }))
        ) {
          throw new UnauthorizedException({
            statusCode: 401,
            error: 'Unauthorized',
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          });
        }
        if (
          await tx.order.findFirst({
            where: { userId, status: { in: ['PENDING', 'PAYMENT_FAILED'] } },
            select: { id: true },
          })
        )
          throw pending();
        const quantities = new Map<string, number>();
        for (const item of dto.items)
          quantities.set(
            item.productId,
            (quantities.get(item.productId) ?? 0) + item.quantity,
          );
        const products = await tx.product.findMany({
          where: { id: { in: [...quantities.keys()] } },
          include: {
            category: { select: { isActive: true } },
            productToppings: { select: { toppingId: true } },
          },
        });
        const toppingIds = [
          ...new Set(dto.items.flatMap((item) => item.toppingIds)),
        ];
        const toppings = await tx.topping.findMany({
          where: { id: { in: toppingIds } },
        });
        const lines = dto.items.map((item) => {
          if (item.toppingIds.length > 3)
            throw invalidCart(item.productId, 'TOO_MANY_TOPPINGS');
          if (new Set(item.toppingIds).size !== item.toppingIds.length)
            throw invalidCart(item.productId, 'DUPLICATE_TOPPING');
          const product = products.find((p) => p.id === item.productId);
          if (!product) throw invalidCart(item.productId, 'PRODUCT_NOT_FOUND');
          if (!product.category.isActive)
            throw invalidCart(product.id, 'PRODUCT_UNAVAILABLE');
          if (
            (product.sizePolicy === 'ONE_SIZE') !==
            (item.size === 'ONE_SIZE')
          )
            throw invalidCart(product.id, 'INVALID_SIZE');
          const selected = item.toppingIds.map((id) => {
            const topping = toppings.find((t) => t.id === id);
            if (!topping) throw invalidCart(product.id, 'TOPPING_NOT_FOUND');
            if (!product.productToppings.some((link) => link.toppingId === id))
              throw invalidCart(product.id, 'TOPPING_NOT_ALLOWED');
            if (!topping.isAvailable)
              throw invalidCart(product.id, 'TOPPING_UNAVAILABLE');
            return topping;
          });
          money(product.basePriceVnd);
          selected.forEach((t) => money(t.priceVnd));
          const percent = SIZE_PERCENT[item.size];
          const unit =
            (product.basePriceVnd * BigInt(percent)) / 100n +
            selected.reduce((sum, t) => sum + t.priceVnd, 0n);
          return {
            productId: product.id,
            productNameSnapshot: product.name,
            size: item.size,
            sizePercentSnapshot: percent,
            basePriceSnapshotVnd: product.basePriceVnd,
            quantity: item.quantity,
            unitPriceVnd: unit,
            lineTotalVnd: unit * BigInt(item.quantity),
            toppings: {
              create: selected.map((t) => ({
                toppingId: t.id,
                toppingCodeSnapshot: t.code,
                toppingNameSnapshot: t.name,
                toppingPriceSnapshotVnd: t.priceVnd,
              })),
            },
          };
        });
        const subtotal = lines.reduce(
          (sum, line) => sum + line.lineTotalVnd,
          0n,
        );
        money(subtotal);
        const now = new Date();
        let discount = 0n;
        const coupon = dto.couponCode
          ? await tx.coupon.findUnique({ where: { code: dto.couponCode } })
          : null;
        if (dto.couponCode) {
          if (
            !coupon ||
            coupon.startsAt > now ||
            coupon.expiresAt <= now ||
            subtotal < coupon.minSubtotalVnd ||
            coupon.activeUsageCount >= coupon.usageLimit
          )
            throw invalid('INVALID_COUPON', 'Coupon is unavailable');
          const used = await tx.couponRedemption.count({
            where: {
              userId,
              couponId: coupon.id,
              status: { in: ['HELD', 'CONSUMED'] },
            },
          });
          if (used >= coupon.perUserLimit)
            throw invalid('INVALID_COUPON', 'Coupon usage limit reached');
          discount =
            coupon.type === 'FIXED'
              ? BigInt(coupon.value)
              : (subtotal * BigInt(coupon.value) + 50n) / 100n;
          if (
            coupon.type === 'PERCENT' &&
            coupon.maxDiscountVnd !== null &&
            discount > coupon.maxDiscountVnd
          )
            discount = coupon.maxDiscountVnd;
          if (discount > subtotal) discount = subtotal;
          const reserved = await tx.coupon.updateMany({
            where: {
              id: coupon.id,
              activeUsageCount: { lt: coupon.usageLimit },
            },
            data: { activeUsageCount: { increment: 1 } },
          });
          if (!reserved.count)
            throw invalid('INVALID_COUPON', 'Coupon usage limit reached');
        }
        // Aggregate all sizes of a product before reserving its shared stock.
        for (const [productId, quantity] of [...quantities].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const reserved = await tx.product.updateMany({
            where: { id: productId, stock: { gte: quantity } },
            data: { stock: { decrement: quantity } },
          });
          if (!reserved.count) {
            const product = await tx.product.findUnique({
              where: { id: productId },
            });
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
        const order = await tx.order.create({
          data: {
            userId,
            status: 'PENDING',
            createdAt: now,
            expiresAt: new Date(now.getTime() + 15 * 60_000),
            subtotalVnd: subtotal,
            discountVnd: discount,
            totalVnd: subtotal - discount,
            couponId: coupon?.id,
            couponCodeSnapshot: coupon?.code,
            items: { create: lines },
            ...(coupon
              ? {
                  couponRedemption: {
                    create: {
                      userId,
                      couponId: coupon.id,
                      status: 'HELD' as const,
                    },
                  },
                }
              : {}),
          },
          include: { items: { include: { toppings: true } } },
        });
        // Convert BigInt only at the HTTP boundary, after computing exact amounts.
        return {
          id: order.id,
          status: order.status,
          items: order.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            productName: item.productNameSnapshot,
            size: item.size,
            sizeMultiplierPercent: item.sizePercentSnapshot,
            basePriceVnd: money(item.basePriceSnapshotVnd),
            quantity: item.quantity,
            unitPriceVnd: money(item.unitPriceVnd),
            lineTotalVnd: money(item.lineTotalVnd),
            toppings: item.toppings.map((t) => ({
              id: t.toppingId,
              name: t.toppingNameSnapshot,
              priceVnd: money(t.toppingPriceSnapshotVnd),
            })),
          })),
          couponCode: order.couponCodeSnapshot,
          subtotalVnd: money(order.subtotalVnd),
          discountVnd: money(order.discountVnd),
          totalVnd: money(order.totalVnd),
          createdAt: order.createdAt.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        /user_id|userId|uq_orders_one_active_per_user/.test(
          JSON.stringify(error.meta ?? {}),
        )
      )
        throw pending();
      throw new InternalServerErrorException('Internal server error');
    }
  }
}
