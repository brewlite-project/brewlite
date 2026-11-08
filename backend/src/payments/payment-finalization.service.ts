import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrderStatus } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PaymentMethod } from './dto/create-payment.dto.js';
import type { PaymentResponseDto } from './dto/payment-response.dto.js';
import type { MockPaymentOutcome } from './mock-payment.service.js';
import { readPaymentSnapshot } from './payment-snapshot.js';
import { calculateLoyaltyPoints } from '../promotions/promotion-policy.js';
import { cancelLockedOrderAndReleaseInTransaction } from '../orders/inventory-policy.js';
import { ORDER_GRACE_MS } from '../orders/order-expiration.config.js';

type Tx = Prisma.TransactionClient;
type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type FinalizationProvider = 'MOCK' | 'VNPAY' | 'ZERO_AMOUNT';
export type FinalizationDisposition =
  | 'FINALIZED'
  | 'DUPLICATE'
  | 'OBSERVED'
  | 'CONFLICT'
  | 'FINANCIAL_EXCEPTION';

export type VerifiedGatewayOutcome = Readonly<{
  source: 'IPN' | 'QUERYDR';
  eventIdentity: string;
  queryRequestId: string | null;
  vnpTxnRef: string;
  vnpTmnCode: string;
  outcome: 'UNKNOWN' | 'SUCCESS' | 'FAILED';
  responseCode: string | null;
  transactionStatus: string | null;
  gatewayTransactionNo: string | null;
  amountVnd: bigint | null;
  gatewayPaidAt: Date | null;
  verifiedAt: Date;
  receivedAt: Date;
}>;

export type FinalizationCommand =
  | {
      provider: 'MOCK';
      userId: string;
      orderId: string;
      paymentId: string;
      idempotencyKey: string;
      requestHash: string;
      method: PaymentMethod;
      outcome: MockPaymentOutcome;
    }
  | {
      provider: 'ZERO_AMOUNT';
      userId: string;
      orderId: string;
      paymentId: string;
      idempotencyKey: string;
      requestHash: string;
    }
  | {
      provider: 'VNPAY';
      paymentId: string;
      verifiedOutcome: VerifiedGatewayOutcome;
    };

export type ZeroAmountResponseSnapshot = {
  paymentId: string;
  orderId: string;
  provider: 'ZERO_AMOUNT';
  paymentStatus: 'SUCCESS';
  orderStatus: 'PAID';
  amountVnd: 0;
  pointsEarned: 0;
  createdAt: string;
};

export type FinalizationResult = {
  disposition: FinalizationDisposition;
  paymentId: string;
  provider: FinalizationProvider;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  pointsEarned: number;
  mockResponse?: PaymentResponseDto;
  zeroAmountResponse?: ZeroAmountResponseSnapshot;
};

type LockedOrder = {
  id: string;
  userId: string;
  status: OrderStatus;
  totalVnd: bigint;
  couponId: string | null;
  pointsEarned: number;
};

type DbClock = {
  now: Date;
  beforeExpiry: boolean;
  beforeGraceEnd: boolean;
};

const transition = (message = 'Order cannot accept a new payment') =>
  new ConflictException({
    statusCode: 409,
    message,
    error: 'Conflict',
    code: 'INVALID_TRANSITION',
  });
const inProgress = () =>
  new ConflictException({
    statusCode: 409,
    message: 'Payment is being processed; retry with the same key',
    error: 'Conflict',
    code: 'PAYMENT_IN_PROGRESS',
  });
const reviewRequired = () =>
  new ConflictException({
    statusCode: 409,
    message: 'Payment requires financial review',
    error: 'Conflict',
    code: 'FINANCIAL_EXCEPTION_REQUIRES_REVIEW',
  });
const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    message: 'Order not found',
    error: 'Not Found',
    code: 'NOT_FOUND',
  });
const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, message, error: 'Conflict', code });

function isActiveOrder(status: OrderStatus): boolean {
  return status === 'PENDING' || status === 'PAYMENT_FAILED';
}

function safeMoney(value: bigint): number {
  const amount = Number(value);
  if (value < 0n || !Number.isSafeInteger(amount))
    throw new Error('Unsafe payment amount');
  return amount;
}

@Injectable()
export class PaymentFinalizationService {
  /**
   * The caller owns the transaction. This is the only method that mutates
   * payment/order financial state; callers must not open a nested transaction.
   */
  async finalizeInTransaction(
    tx: Tx,
    command: FinalizationCommand,
  ): Promise<FinalizationResult> {
    const orderId =
      command.provider === 'VNPAY'
        ? await this.findOrderIdForPayment(tx, command.paymentId)
        : command.orderId;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound();

    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        status: true,
        totalVnd: true,
        couponId: true,
        pointsEarned: true,
      },
    }) as LockedOrder;
    const [clock] = await tx.$queryRaw<DbClock[]>`
      WITH db_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS now
      )
      SELECT db_clock.now AS now,
             db_clock.now < orders.expires_at AS "beforeExpiry",
             db_clock.now < orders.expires_at + (${ORDER_GRACE_MS} * INTERVAL '1 millisecond') AS "beforeGraceEnd"
      FROM orders CROSS JOIN db_clock
      WHERE orders.id = ${orderId}::uuid`;
    if (!clock) throw new Error('Missing payment finalization clock');

    if (command.provider === 'VNPAY')
      return this.finalizeVnpay(tx, order, clock, command);
    return this.finalizeNewPayment(tx, order, clock, command);
  }

  private async findOrderIdForPayment(tx: Tx, paymentId: string) {
    // This is a non-locking identity lookup only. The Payment row is locked
    // after the Order row, then all identity/provider fields are re-read.
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: { orderId: true },
    });
    if (!payment) throw new Error('Payment attempt not found');
    return payment.orderId;
  }

  private async finalizeNewPayment(
    tx: Tx,
    order: LockedOrder,
    clock: DbClock,
    command: Extract<FinalizationCommand, { provider: 'MOCK' | 'ZERO_AMOUNT' }>,
  ): Promise<FinalizationResult> {
    if (order.userId !== command.userId) throw notFound();
    const replay = await this.replayNewPayment(tx, order, command);
    if (replay) return replay;
    if (!isActiveOrder(order.status)) throw transition();
    if (!clock.beforeExpiry) {
      if (command.provider === 'ZERO_AMOUNT')
        throw conflict('ORDER_EXPIRED', 'Order has expired');
      throw transition();
    }
    if (order.pointsEarned !== 0)
      throw new Error('Active Order already has loyalty points');

    if (command.provider === 'ZERO_AMOUNT' && order.totalVnd !== 0n)
      throw conflict('ORDER_NOT_ZERO_AMOUNT', 'Order total must be zero');
    if (command.provider === 'MOCK' && order.totalVnd === 0n)
      throw transition();
    if (
      command.provider === 'MOCK' &&
      (!/^[0-9]{4}$/.test(command.outcome.methodLast4) ||
        (command.outcome.paymentStatus === 'SUCCESS' &&
          command.outcome.failureReason !== null) ||
        (command.outcome.paymentStatus === 'FAILED' &&
          command.outcome.failureReason !== 'PAYMENT_DECLINED'))
    )
      throw new Error('Invalid server-evaluated Mock outcome');

    const amountVnd = safeMoney(order.totalVnd);
    const attempts = await tx.payment.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        provider: true,
        hasFinancialException: true,
        reconciliationState: true,
      },
    });
    if (
      attempts.some(
        (payment) =>
          payment.hasFinancialException ||
          payment.reconciliationState === 'REQUIRES_REVIEW',
      )
    )
      throw reviewRequired();
    if (attempts.some((payment) => payment.status === 'SUCCESS'))
      throw transition();
    if (attempts.some((payment) => payment.status === 'PENDING'))
      throw inProgress();
    if (
      order.status === 'PAYMENT_FAILED' &&
      attempts[0]?.status !== 'FAILED'
    )
      throw transition();

    const idempotencyKey = command.idempotencyKey;
    const requestHash = command.requestHash;
    const success =
      command.provider === 'ZERO_AMOUNT' ||
      command.outcome.paymentStatus === 'SUCCESS';
    const pointsEarned = success
      ? command.provider === 'ZERO_AMOUNT'
        ? 0
        : calculateLoyaltyPoints(order.totalVnd)
      : 0;
    const orderStatus: OrderStatus = success ? 'PAID' : 'PAYMENT_FAILED';
    const createdAt = clock.now.toISOString();

    if (success) {
      await this.consumeHeldCoupon(tx, order, clock.now);
      if (pointsEarned > 0) {
        const awarded = await tx.user.updateMany({
          where: {
            id: order.userId,
            loyaltyPoints: { lte: 2147483647 - pointsEarned },
          },
          data: { loyaltyPoints: { increment: pointsEarned } },
        });
        if (awarded.count !== 1)
          throw new Error('Unable to award loyalty points');
      }
    }

    let mockResponse: PaymentResponseDto | undefined;
    let zeroAmountResponse: ZeroAmountResponseSnapshot | undefined;
    if (command.provider === 'MOCK') {
      mockResponse = {
        paymentId: command.paymentId,
        orderId: order.id,
        paymentStatus: command.outcome.paymentStatus,
        orderStatus: orderStatus as 'PAID' | 'PAYMENT_FAILED',
        amountVnd,
        method: command.method,
        methodLast4: command.outcome.methodLast4,
        mockReference: `MOCK-${command.paymentId}`,
        pointsEarned,
        failureReason: command.outcome.failureReason,
        createdAt,
      };
    } else {
      zeroAmountResponse = {
        paymentId: command.paymentId,
        orderId: order.id,
        provider: 'ZERO_AMOUNT',
        paymentStatus: 'SUCCESS',
        orderStatus: 'PAID',
        amountVnd: 0,
        pointsEarned: 0,
        createdAt,
      };
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: orderStatus,
        pointsEarned,
        updatedAt: clock.now,
        ...(success ? { paidAt: clock.now } : {}),
      },
    });
    await tx.payment.create({
      data: {
        id: command.paymentId,
        orderId: order.id,
        userId: order.userId,
        idempotencyKey,
        requestHash,
        amountVnd: order.totalVnd,
        provider: command.provider,
        method: command.provider === 'MOCK' ? command.method : null,
        status: command.provider === 'MOCK'
          ? command.outcome.paymentStatus
          : 'SUCCESS',
        methodLast4: command.provider === 'MOCK' ? command.outcome.methodLast4 : null,
        mockReference: command.provider === 'MOCK'
          ? `MOCK-${command.paymentId}`
          : null,
        responseSnapshot: command.provider === 'MOCK'
          ? (mockResponse as unknown as Prisma.InputJsonObject)
          : (zeroAmountResponse as unknown as Prisma.InputJsonObject),
        createdAt: clock.now,
        updatedAt: clock.now,
      },
    });

    return {
      disposition: 'FINALIZED',
      paymentId: command.paymentId,
      provider: command.provider,
      paymentStatus: command.provider === 'MOCK'
        ? command.outcome.paymentStatus
        : 'SUCCESS',
      orderStatus,
      pointsEarned,
      ...(mockResponse ? { mockResponse } : {}),
      ...(zeroAmountResponse ? { zeroAmountResponse } : {}),
    };
  }

  private async consumeHeldCoupon(tx: Tx, order: LockedOrder, now: Date) {
    if (!order.couponId) {
      const redemption = await tx.couponRedemption.findUnique({
        where: { orderId: order.id },
        select: { id: true },
      });
      if (redemption) throw new Error('Unexpected coupon redemption');
      return;
    }
    const consumed = await tx.couponRedemption.updateMany({
      where: {
        orderId: order.id,
        userId: order.userId,
        couponId: order.couponId,
        status: 'HELD',
      },
      data: { status: 'CONSUMED', consumedAt: now },
    });
    if (consumed.count !== 1)
      throw new Error('Held coupon reservation is missing');
  }

  private async finalizeVnpay(
    tx: Tx,
    order: LockedOrder,
    clock: DbClock,
    command: Extract<FinalizationCommand, { provider: 'VNPAY' }>,
  ): Promise<FinalizationResult> {
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payments WHERE id = ${command.paymentId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUnique({
      where: { id: command.paymentId },
    });
    if (!payment || payment.orderId !== order.id)
      throw new Error('Payment/Order identity mismatch');
    if (payment.provider !== 'VNPAY')
      throw new Error('Gateway outcome does not match Payment provider');
    if (payment.userId !== order.userId)
      throw new Error('Payment/Order ownership mismatch');
    if (payment.amountVnd !== order.totalVnd)
      throw new Error('Payment amount does not match persisted Order total');

    const evidence = command.verifiedOutcome;
    this.validateGatewayEvidence(evidence, payment);
    const duplicate = await tx.paymentGatewayEvent.findUnique({
      where: {
        paymentId_source_eventIdentity: {
          paymentId: payment.id,
          source: evidence.source,
          eventIdentity: evidence.eventIdentity,
        },
      },
    });
    if (duplicate) {
      this.assertSameEvidence(duplicate, evidence);
      return this.gatewayResult(
        'DUPLICATE', payment.id, payment.status, order.status, order.pointsEarned,
      );
    }

    if (evidence.outcome === 'UNKNOWN') {
      await this.createGatewayEvent(tx, payment.id, evidence, 'OBSERVED', null);
      return this.gatewayResult(
        'OBSERVED', payment.id, payment.status, order.status, order.pointsEarned,
      );
    }

    const otherSuccess = await tx.payment.findFirst({
      where: {
        orderId: order.id,
        status: 'SUCCESS',
        id: { not: payment.id },
      },
      select: { id: true },
    });
    const hasOrderException = await tx.payment.findFirst({
      where: {
        orderId: order.id,
        OR: [
          { hasFinancialException: true },
          { reconciliationState: 'REQUIRES_REVIEW' },
        ],
      },
      select: { id: true },
    });

    if (evidence.outcome === 'FAILED') {
      if (payment.status === 'FAILED') {
        await this.createGatewayEvent(tx, payment.id, evidence, 'DUPLICATE', null);
        return this.gatewayResult(
          'DUPLICATE', payment.id, payment.status, order.status, order.pointsEarned,
        );
      }
      if (payment.status !== 'PENDING' || otherSuccess || hasOrderException) {
        const reason = otherSuccess
          ? 'ANOTHER_PAYMENT_ALREADY_SUCCEEDED'
          : 'TERMINAL_OUTCOME_CONFLICT';
        await this.createGatewayEvent(tx, payment.id, evidence, 'CONFLICT', reason);
        await this.markFinancialReview(tx, payment.id, clock.now, reason);
        return this.gatewayResult(
          'CONFLICT', payment.id, payment.status, order.status, order.pointsEarned,
        );
      }

      await this.createGatewayEvent(tx, payment.id, evidence, 'FINALIZED', null);
      const finalOutcomeSnapshot = this.gatewaySnapshot(evidence);
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          finalOutcomeSnapshot,
          verifiedAt: evidence.verifiedAt,
          verifiedPaidAt: null,
          finalizedAt: clock.now,
          reconciliationState: 'RESOLVED',
          nextQueryAt: null,
          claimToken: null,
          leaseExpiresAt: null,
          reviewReason: null,
          hasFinancialException: false,
          updatedAt: clock.now,
        },
      });
      let orderStatus = order.status;
      if (isActiveOrder(order.status)) {
        if (clock.beforeExpiry) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'PAYMENT_FAILED',
              pointsEarned: 0,
              updatedAt: clock.now,
            },
          });
          orderStatus = 'PAYMENT_FAILED';
        } else {
          orderStatus =
            (await cancelLockedOrderAndReleaseInTransaction(
              tx,
              order.id,
              clock.now,
            )) ?? order.status;
        }
      }
      return this.gatewayResult(
        'FINALIZED', payment.id, 'FAILED', orderStatus, 0,
      );
    }

    if (payment.status === 'SUCCESS' && !otherSuccess && order.status !== 'CANCELLED') {
      await this.createGatewayEvent(tx, payment.id, evidence, 'DUPLICATE', null);
      return this.gatewayResult(
        'DUPLICATE', payment.id, payment.status, order.status, order.pointsEarned,
      );
    }

    if (payment.status !== 'PENDING') {
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'TERMINAL_OUTCOME_CONFLICT',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }
    if (order.status === 'CANCELLED') {
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'ORDER_CANCELLED',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }
    if (otherSuccess || hasOrderException) {
      const orderStatus = await this.recordFinancialException(
        tx,
        payment,
        order,
        clock,
        evidence,
        otherSuccess ? 'ANOTHER_PAYMENT_ALREADY_SUCCEEDED' : 'ORDER_REQUIRES_REVIEW',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }

    if (!isActiveOrder(order.status)) {
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'ORDER_NOT_ACTIVE',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }

    const paidAt = evidence.gatewayPaidAt;
    if (!paidAt) {
      if (clock.beforeGraceEnd) {
        await this.createGatewayEvent(tx, payment.id, evidence, 'OBSERVED', null);
        return this.gatewayResult(
          'OBSERVED', payment.id, payment.status, order.status, order.pointsEarned,
        );
      }
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'UNTRUSTED_PAID_AT',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }

    const paidOnTime = await this.isPaidOnOrBeforeExpiry(tx, paidAt, order.id);
    if (!paidOnTime) {
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'LATE_SUCCESS',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }

    if (!clock.beforeGraceEnd) {
      const orderStatus = await this.recordFinancialException(
        tx, payment, order, clock, evidence, 'GRACE_ENDED',
      );
      return this.gatewayResult(
        'FINANCIAL_EXCEPTION', payment.id, payment.status, orderStatus, order.pointsEarned,
      );
    }

    if (order.pointsEarned !== 0)
      throw new Error('Active Order already has loyalty points');
    const pointsEarned = calculateLoyaltyPoints(order.totalVnd);
    const finalOutcomeSnapshot = this.gatewaySnapshot(evidence);
    await this.consumeHeldCoupon(tx, order, clock.now);
    if (pointsEarned > 0) {
      const awarded = await tx.user.updateMany({
        where: {
          id: order.userId,
          loyaltyPoints: { lte: 2147483647 - pointsEarned },
        },
        data: { loyaltyPoints: { increment: pointsEarned } },
      });
      if (awarded.count !== 1)
        throw new Error('Unable to award loyalty points');
    }
    await this.createGatewayEvent(tx, payment.id, evidence, 'FINALIZED', null);
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        finalOutcomeSnapshot,
        verifiedAt: evidence.verifiedAt,
        verifiedPaidAt: paidAt,
        finalizedAt: clock.now,
        reconciliationState: 'RESOLVED',
        nextQueryAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        reviewReason: null,
        hasFinancialException: false,
        updatedAt: clock.now,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        pointsEarned,
        paidAt: clock.now,
        updatedAt: clock.now,
      },
    });
    return this.gatewayResult(
      'FINALIZED', payment.id, 'SUCCESS', 'PAID', pointsEarned,
    );
  }

  private async isPaidOnOrBeforeExpiry(tx: Tx, paidAt: Date, orderId: string) {
    const [result] = await tx.$queryRaw<{ timely: boolean }[]>`
      SELECT ${paidAt}::timestamptz <= expires_at AS timely
      FROM orders WHERE id = ${orderId}::uuid`;
    if (!result) throw new Error('Missing gateway timestamp comparison');
    return result.timely;
  }

  private async replayNewPayment(
    tx: Tx,
    order: LockedOrder,
    command: Extract<FinalizationCommand, { provider: 'MOCK' | 'ZERO_AMOUNT' }>,
  ): Promise<FinalizationResult | null> {
    const requestHash = command.requestHash;
    const existing = await tx.payment.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: command.userId,
          idempotencyKey: command.idempotencyKey,
        },
      },
      select: {
        id: true,
        orderId: true,
        provider: true,
        status: true,
        requestHash: true,
        responseSnapshot: true,
      },
    });
    if (!existing) return null;
    if (
      existing.orderId !== order.id ||
      existing.provider !== command.provider ||
      existing.requestHash !== requestHash
    )
      throw conflict(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was used with a different payment request',
      );

    if (command.provider === 'MOCK') {
      const mockResponse = readPaymentSnapshot(
        existing.responseSnapshot,
        existing.id,
        existing.orderId,
      );
      if (mockResponse.paymentStatus !== existing.status)
        throw new Error('Payment status does not match its immutable snapshot');
      return {
        disposition: 'DUPLICATE',
        paymentId: existing.id,
        provider: 'MOCK',
        paymentStatus: existing.status,
        orderStatus: order.status,
        pointsEarned: mockResponse.pointsEarned,
        mockResponse,
      };
    }

    const zeroAmountResponse = this.readZeroAmountSnapshot(
      existing.responseSnapshot,
      existing.id,
      existing.orderId,
    );
    if (existing.status !== 'SUCCESS')
      throw new Error('ZERO_AMOUNT Payment must remain terminal SUCCESS');
    return {
      disposition: 'DUPLICATE',
      paymentId: existing.id,
      provider: 'ZERO_AMOUNT',
      paymentStatus: 'SUCCESS',
      orderStatus: order.status,
      pointsEarned: 0,
      zeroAmountResponse,
    };
  }

  private readZeroAmountSnapshot(
    value: unknown,
    paymentId: string,
    orderId: string,
  ): ZeroAmountResponseSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid ZERO_AMOUNT response snapshot');
    const snapshot = value as Record<string, unknown>;
    if (
      snapshot.paymentId !== paymentId ||
      snapshot.orderId !== orderId ||
      snapshot.provider !== 'ZERO_AMOUNT' ||
      snapshot.paymentStatus !== 'SUCCESS' ||
      snapshot.orderStatus !== 'PAID' ||
      snapshot.amountVnd !== 0 ||
      snapshot.pointsEarned !== 0 ||
      typeof snapshot.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.createdAt))
    )
      throw new Error('Invalid ZERO_AMOUNT response snapshot');
    return snapshot as ZeroAmountResponseSnapshot;
  }

  private validateGatewayEvidence(
    evidence: VerifiedGatewayOutcome,
    payment: {
      vnpTxnRef: string | null;
      vnpTmnCode: string | null;
      amountVnd: bigint;
    },
  ) {
    if (!/^[0-9a-f]{64}$/.test(evidence.eventIdentity))
      throw new Error('Invalid verified event identity');
    if (evidence.source === 'IPN' && evidence.queryRequestId !== null)
      throw new Error('IPN event cannot have a QueryDR request ID');
    if (evidence.source === 'IPN' && evidence.amountVnd === null)
      throw new Error('IPN evidence requires an amount');
    if (
      evidence.amountVnd !== null &&
      (evidence.amountVnd < 0n || evidence.amountVnd !== payment.amountVnd)
    )
      throw new Error('Verified gateway amount does not match Payment');
    if (
      evidence.source === 'QUERYDR' &&
      (!evidence.queryRequestId || evidence.queryRequestId.length > 64)
    )
      throw new Error('QueryDR event requires its request ID');
    if (
      !payment.vnpTxnRef ||
      !payment.vnpTmnCode ||
      evidence.vnpTxnRef !== payment.vnpTxnRef ||
      evidence.vnpTmnCode !== payment.vnpTmnCode
    )
      throw new Error('Verified gateway identity does not match Payment');
    if (evidence.outcome !== 'UNKNOWN') {
      if (
        evidence.amountVnd === null ||
        evidence.responseCode === null ||
        evidence.transactionStatus === null
      )
        throw new Error('Verified gateway amount does not match Payment');
      if (
        evidence.outcome === 'SUCCESS' &&
        (evidence.responseCode !== '00' || evidence.transactionStatus !== '00')
      )
        throw new Error('Gateway success outcome is not fully verified');
    }
    if (!(evidence.verifiedAt instanceof Date) || !(evidence.receivedAt instanceof Date))
      throw new Error('Verified gateway timestamps are required');
    if (
      !Number.isFinite(evidence.verifiedAt.getTime()) ||
      !Number.isFinite(evidence.receivedAt.getTime()) ||
      (evidence.gatewayPaidAt !== null &&
        !Number.isFinite(evidence.gatewayPaidAt.getTime()))
    )
      throw new Error('Invalid verified gateway timestamp');
  }

  private assertSameEvidence(
    existing: {
      outcome: string;
      responseCode: string | null;
      transactionStatus: string | null;
      gatewayTransactionNo: string | null;
      amountVnd: bigint | null;
      gatewayPaidAt: Date | null;
      queryRequestId: string | null;
    },
    incoming: VerifiedGatewayOutcome,
  ) {
    if (
      existing.outcome !== incoming.outcome ||
      existing.responseCode !== incoming.responseCode ||
      existing.transactionStatus !== incoming.transactionStatus ||
      existing.gatewayTransactionNo !== incoming.gatewayTransactionNo ||
      existing.amountVnd !== incoming.amountVnd ||
      existing.queryRequestId !== incoming.queryRequestId ||
      existing.gatewayPaidAt?.getTime() !== incoming.gatewayPaidAt?.getTime()
    )
      throw new Error('Event identity collision with different verified evidence');
  }

  private eventEvidence() {
    // Store only an allowlist. Never persist raw callbacks, credentials or secrets.
    return {
      verification: 'PROVIDER_ADAPTER_VERIFIED',
      correlationRechecked: true,
    } as Prisma.InputJsonObject;
  }

  private async createGatewayEvent(
    tx: Tx,
    paymentId: string,
    evidence: VerifiedGatewayOutcome,
    disposition: 'OBSERVED' | 'FINALIZED' | 'DUPLICATE' | 'CONFLICT' | 'FINANCIAL_EXCEPTION',
    exceptionReason: string | null,
  ) {
    await tx.paymentGatewayEvent.create({
      data: {
        id: randomUUID(),
        paymentId,
        source: evidence.source,
        eventIdentity: evidence.eventIdentity,
        queryRequestId: evidence.queryRequestId,
        responseCode: evidence.responseCode,
        transactionStatus: evidence.transactionStatus,
        gatewayTransactionNo: evidence.gatewayTransactionNo,
        amountVnd: evidence.amountVnd,
        gatewayPaidAt: evidence.gatewayPaidAt,
        outcome: evidence.outcome,
        disposition,
        exceptionReason,
        receivedAt: evidence.receivedAt,
        verifiedAt: evidence.verifiedAt,
        evidence: this.eventEvidence(),
      },
    });
  }

  private gatewaySnapshot(evidence: VerifiedGatewayOutcome): Prisma.InputJsonObject {
    return {
      provider: 'VNPAY',
      outcome: evidence.outcome,
      responseCode: evidence.responseCode,
      transactionStatus: evidence.transactionStatus,
      gatewayTransactionNo: evidence.gatewayTransactionNo,
      amountVnd: evidence.amountVnd === null ? null : safeMoney(evidence.amountVnd),
      gatewayPaidAt: evidence.gatewayPaidAt?.toISOString() ?? null,
      verifiedAt: evidence.verifiedAt.toISOString(),
    };
  }

  private async recordFinancialException(
    tx: Tx,
    payment: { id: string },
    order: LockedOrder,
    clock: DbClock,
    evidence: VerifiedGatewayOutcome,
    reason: string,
  ): Promise<OrderStatus> {
    await this.createGatewayEvent(
      tx, payment.id, evidence, 'FINANCIAL_EXCEPTION', reason,
    );
    await this.markFinancialReview(tx, payment.id, clock.now, reason);
    if (isActiveOrder(order.status) && (!clock.beforeExpiry || !clock.beforeGraceEnd))
      return (await cancelLockedOrderAndReleaseInTransaction(
        tx,
        order.id,
        clock.now,
      )) ?? order.status;
    return order.status;
  }

  private async markFinancialReview(
    tx: Tx,
    paymentId: string,
    now: Date,
    reason: string,
  ) {
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        hasFinancialException: true,
        reconciliationState: 'REQUIRES_REVIEW',
        nextQueryAt: null,
        claimToken: null,
        leaseExpiresAt: null,
        reviewReason: reason,
        updatedAt: now,
      },
    });
  }

  private gatewayResult(
    disposition: FinalizationDisposition,
    paymentId: string,
    paymentStatus: PaymentStatus,
    orderStatus: OrderStatus,
    pointsEarned: number,
  ): FinalizationResult {
    return {
      disposition,
      paymentId,
      provider: 'VNPAY',
      paymentStatus,
      orderStatus,
      pointsEarned,
    };
  }
}
