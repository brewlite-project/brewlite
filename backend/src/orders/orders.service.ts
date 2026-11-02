import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  assertCouponValid,
  reserveCoupon,
} from '../promotions/promotion-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { GetMyOrdersQueryDto } from './dto/get-my-orders-query.dto.js';
import {
  expireOrderInTransaction,
  inventoryQuantities,
  reserveInventory,
} from './inventory-policy.js';
import { runInventoryTransaction } from './inventory-transaction.js';
import { mapOrderPaymentPresentation } from './order-payment-presentation.mapper.js';

const SIZE_PERCENT = { S: 100, M: 120, L: 140, ONE_SIZE: 100 } as const;
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

  async getMine(userId: string, query: GetMyOrdersQueryDto) {
    try {
      const paginated = query.page !== undefined && query.limit !== undefined;
      const page = query.page ?? null;
      const limit = query.limit ?? null;
      const where = { userId };
      const total = await this.prisma.order.count({ where });
      const skip = paginated ? (page! - 1) * limit! : 0;

      // Avoid passing an impractically large offset to Prisma; an out-of-range
      // page is contractually an empty successful response.
      const orders = paginated && skip >= total
        ? []
        : await this.prisma.order.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...(paginated ? { skip, take: limit! } : {}),
            include: {
              items: { include: { toppings: true } },
              payments: {
                select: {
                  id: true,
                  status: true,
                  provider: true,
                  method: true,
                  methodLast4: true,
                  amountVnd: true,
                  mockReference: true,
                  responseSnapshot: true,
                  finalOutcomeSnapshot: true,
                  reconciliationState: true,
                  hasFinancialException: true,
                  createdAt: true,
                  updatedAt: true,
                  gatewayEvents: {
                    select: {
                      outcome: true,
                      disposition: true,
                      responseCode: true,
                      transactionStatus: true,
                      exceptionReason: true,
                      verifiedAt: true,
                      createdAt: true,
                    },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              },
            },
          });

      const now = new Date();
      return {
        items: orders.map((order) => {
          const presentation = mapOrderPaymentPresentation(order, now);
          return {
            id: order.id,
            status: order.status,
            createdAt: order.createdAt.toISOString(),
            expiresAt: order.expiresAt.toISOString(),
            subtotalVnd: money(order.subtotalVnd),
            discountVnd: money(order.discountVnd),
            totalVnd: money(order.totalVnd),
            couponCode: order.couponCodeSnapshot,
            pointsEarned: order.pointsEarned,
            hasFinancialException: presentation.hasFinancialException,
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
              toppings: item.toppings.map((topping) => ({
                id: topping.toppingId,
                name: topping.toppingNameSnapshot,
                priceVnd: money(topping.toppingPriceSnapshotVnd),
              })),
            })),
            payment: presentation.payment,
          };
        }),
        meta: {
          page,
          limit,
          total,
          totalPages: paginated ? Math.ceil(total / limit!) : null,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    }
  }

  async create(userId: string, dto: CreateOrderDto) {
    userId = userId.toLowerCase();
    try {
      const createOrCleanup = async (tx: Prisma.TransactionClient) => {
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
        // Serialize Create Order for the same customer before stock checks. Do
        // not lock User: Payment locks Order first and updates User for loyalty.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'create-order:' + userId}, 0))::text`;
        const active = await tx.order.findFirst({
          where: { userId, status: { in: ['PENDING', 'PAYMENT_FAILED'] } },
          select: { id: true },
        });
        if (active) {
          const status = await expireOrderInTransaction(tx, active.id);
          if (status === 'PENDING' || status === 'PAYMENT_FAILED')
            throw pending();
          return null; // Commit cleanup, then recheck in a fresh transaction.
        }
        const quantities = inventoryQuantities(dto.items);
        const products = await tx.product.findMany({
          where: { id: { in: quantities.map(([id]) => id) } },
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
          const product = products.find(
            (p) => p.id === item.productId.toLowerCase(),
          );
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
        let coupon = dto.couponCode
          ? await tx.coupon.findUnique({ where: { code: dto.couponCode } })
          : null;
        // Invalid code/validity stays 400; quota follows stock per Contract v3.0.
        if (dto.couponCode) assertCouponValid(coupon, subtotal, now);
        await reserveInventory(tx, quantities);
        if (coupon) {
          const reservation = await reserveCoupon(
            tx,
            userId,
            coupon.id,
            subtotal,
          );
          coupon = reservation.coupon;
          discount = reservation.discount;
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
      };
      // Cleanup commits before a new reservation to avoid Coupon -> Product lock
      // inversion between old/new carts. A failed cleanup never creates an Order.
      for (let phase = 0; phase < 2; phase++) {
        const result = await runInventoryTransaction(
          this.prisma,
          createOrCleanup,
        );
        if (result !== null) return result;
      }
      throw new Error('Active Order changed repeatedly during creation');
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
      throw new InternalServerErrorException({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    }
  }
}
