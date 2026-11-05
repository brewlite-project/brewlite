import {
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
import { money, priceCart } from './cart-pricing.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { readPaymentSnapshot } from '../payments/payment-snapshot.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { GetMyOrdersQueryDto } from './dto/get-my-orders-query.dto.js';
import {
  expireOrderInTransaction,
  inventoryQuantities,
  reserveInventory,
} from './inventory-policy.js';
import { runInventoryTransaction } from './inventory-transaction.js';
import { ORDER_TTL_MS } from './order-expiration.config.js';

const pending = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'PENDING_ORDER_EXISTS',
    message: 'An active order already exists',
  });
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
                where: { status: { in: ['SUCCESS', 'FAILED'] } },
                select: {
                  id: true,
                  status: true,
                  method: true,
                  methodLast4: true,
                  amountVnd: true,
                  mockReference: true,
                  responseSnapshot: true,
                  createdAt: true,
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              },
            },
          });

      return {
        items: orders.map((order) => {
          const payment =
            order.payments.find((candidate) => candidate.status === 'SUCCESS') ??
            order.payments.find((candidate) => candidate.status === 'FAILED');
          const snapshot = payment
            ? readPaymentSnapshot(payment.responseSnapshot, payment.id, order.id)
            : null;
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
            payment: payment
              ? {
                  id: payment.id,
                  status: payment.status,
                  method: payment.method,
                  methodLast4: payment.methodLast4,
                  amountVnd: money(payment.amountVnd),
                  mockReference: payment.mockReference,
                  failureReason: snapshot!.failureReason,
                  createdAt: payment.createdAt.toISOString(),
                }
              : null,
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
          // An expired Order with VNPay PENDING remains active during Grace.
          // Use the same locked policy as the Scheduler before reserving again.
          const status = await expireOrderInTransaction(tx, active.id);
          if (status === 'PENDING' || status === 'PAYMENT_FAILED')
            throw pending();
          return null; // Commit cleanup, then recheck in a fresh transaction.
        }
        const quantities = inventoryQuantities(dto.items);
        const { lines: pricedLines, subtotal } = await priceCart(tx, dto.items);
        let discount = 0n;
        let coupon = dto.couponCode
          ? await tx.coupon.findUnique({ where: { code: dto.couponCode } })
          : null;
        // A missing code can be rejected immediately. Validity/configuration
        // decisions use the fresh DB clock and row data after the Coupon lock.
        if (dto.couponCode && !coupon)
          assertCouponValid(null, subtotal, new Date());
        await reserveInventory(tx, quantities);
        let now: Date;
        if (coupon) {
          const reservation = await reserveCoupon(
            tx,
            userId,
            coupon.id,
            subtotal,
            dto.couponCode!,
          );
          coupon = reservation.coupon;
          discount = reservation.discount;
          now = reservation.now;
        } else {
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`
            SELECT clock_timestamp() AS now`;
          if (!clock) throw new Error('Missing Order creation clock');
          now = clock.now;
        }
        const order = await tx.order.create({
          data: {
            userId,
            status: 'PENDING',
            createdAt: now,
            expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
            subtotalVnd: subtotal,
            discountVnd: discount,
            totalVnd: subtotal - discount,
            couponId: coupon?.id,
            couponCodeSnapshot: coupon?.code,
            items: {
              create: pricedLines.map((line) => ({
                productId: line.productId,
                productNameSnapshot: line.productNameSnapshot,
                size: line.size,
                sizePercentSnapshot: line.sizePercentSnapshot,
                basePriceSnapshotVnd: line.basePriceSnapshotVnd,
                quantity: line.quantity,
                unitPriceVnd: line.unitPriceVnd,
                lineTotalVnd: line.lineTotalVnd,
                toppings: {
                  create: line.selectedToppings.map((topping) => ({
                    toppingId: topping.id,
                    toppingCodeSnapshot: topping.code,
                    toppingNameSnapshot: topping.name,
                    toppingPriceSnapshotVnd: topping.priceVnd,
                  })),
                },
              })),
            },
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
