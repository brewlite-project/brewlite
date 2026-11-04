import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { expireOrderInTransaction } from '../orders/inventory-policy.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import {
  PAYMENT_RECONCILIATION_COOLDOWN_MS,
  PAYMENT_RECONCILIATION_GRACE_MS,
} from './payment-reconciliation.config.js';
import { loadVnpayQueryDrConfig } from './vnpay.config.js';
import { VnpayQueryDrClient, type QueryDrTransport } from './vnpay-querydr.client.js';

type Tx = Prisma.TransactionClient;

/**
 * The scheduler owns cadence, retries and horizon policy. This service owns
 * transaction boundaries, DB claims and verified gateway finalization.
 */
@Injectable()
export class VnpayQueryDrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finalization: PaymentFinalizationService,
  ) {}

  async reconcileClaimed(
    paymentId: string, requestId: string, claimToken: string,
    ipAddr: string, transport?: QueryDrTransport,
  ) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    const [clock] = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (
      !clock || !payment || payment.provider !== 'VNPAY' || payment.status !== 'PENDING' ||
      payment.reconciliationState !== 'SCHEDULED' ||
      payment.claimToken !== claimToken || !payment.leaseExpiresAt ||
      payment.leaseExpiresAt <= clock.now || payment.lastQueryRequestId !== requestId ||
      !payment.vnpTxnRef || !payment.vnpTmnCode || !payment.vnpCreateDate
    ) throw new Error('QueryDR claim is not valid');
    // Never hold database row locks or an interactive transaction over HTTP.
    const outcome = await new VnpayQueryDrClient(loadVnpayQueryDrConfig(), transport).query({
      id: payment.id, vnpTxnRef: payment.vnpTxnRef, vnpTmnCode: payment.vnpTmnCode,
      vnpCreateDate: payment.vnpCreateDate, amountVnd: payment.amountVnd,
      initiationSnapshot: payment.initiationSnapshot,
    }, requestId, ipAddr, new Date());
    // Valid verified responses still go through shared finalization even if
    // another worker replaced our lease or an IPN finalized in the meantime.
    return this.prisma.$transaction(
      tx => this.finalization.finalizeInTransaction(tx, {
        provider: 'VNPAY', paymentId, verifiedOutcome: outcome,
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 },
    );
  }

  /**
   * Order row lock MUST precede Payment row lock, matching Finalization.
   * nextQueryAt is set when claimed, not when HTTP ends: a crash cannot cause
   * another gateway request before the configured cooldown has elapsed.
   */
  async claim(
    paymentId: string, leaseMs: number,
    cooldownMs: number = PAYMENT_RECONCILIATION_COOLDOWN_MS,
  ): Promise<{ requestId: string; claimToken: string } | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 ||
        !Number.isSafeInteger(cooldownMs) || cooldownMs < PAYMENT_RECONCILIATION_COOLDOWN_MS)
      throw new Error('QueryDR lease/cooldown policy is invalid');
    return this.prisma.$transaction(async tx => {
      const orderId = await this.lockOrderThenPayment(tx, paymentId);
      if (!orderId) return null;
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { expiresAt: true } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || !order) throw new Error('Missing reconciliation clock/order');
      if (
        !payment || payment.orderId !== orderId || payment.provider !== 'VNPAY' ||
        payment.status !== 'PENDING' || payment.reconciliationState !== 'SCHEDULED' ||
        !payment.nextQueryAt || payment.nextQueryAt > clock.now ||
        !payment.reconcileUntil || clock.now >= payment.reconcileUntil ||
        (payment.leaseExpiresAt && payment.leaseExpiresAt > clock.now)
      ) return null;

      // Grace cleanup is done with the same shared Order expiration primitive;
      // Payment stays PENDING if the gateway outcome remains uncertain.
      if (clock.now.getTime() >= order.expiresAt.getTime() + PAYMENT_RECONCILIATION_GRACE_MS)
        await expireOrderInTransaction(tx, orderId);

      const nextQueryAt = new Date(Math.min(
        payment.reconcileUntil.getTime(),
        Math.max(
          order.expiresAt.getTime() + PAYMENT_RECONCILIATION_GRACE_MS,
          clock.now.getTime() + cooldownMs,
        ),
      ));
      const requestId = randomUUID().replaceAll('-', '').slice(0, 32);
      const claimToken = randomUUID();
      // Explicit eligibility conditions protect against future caller changes.
      const changed = await tx.payment.updateMany({
        where: {
          id: payment.id, provider: 'VNPAY', status: 'PENDING',
          reconciliationState: 'SCHEDULED',
          nextQueryAt: { not: null, lte: clock.now },
          reconcileUntil: { gt: clock.now },
          claimToken: payment.claimToken,
          leaseExpiresAt: payment.leaseExpiresAt,
        },
        data: {
          claimToken,
          leaseExpiresAt: new Date(clock.now.getTime() + leaseMs),
          lastQueryAt: clock.now,
          lastQueryRequestId: requestId,
          queryAttempts: { increment: 1 },
          nextQueryAt,
          lastQueryError: null,
          updatedAt: clock.now,
        },
      });
      return changed.count === 1 ? { requestId, claimToken } : null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
  }

  /**
   * Stops gateway retries at H=E+5m+60m, but NEVER changes status to FAILED.
   * An active in-flight lease is allowed to complete first. The next tick
   * converts unresolved PENDING to REQUIRES_REVIEW after that lease expires.
   */
  async markExhausted(paymentId: string): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const orderId = await this.lockOrderThenPayment(tx, paymentId);
      if (!orderId) return false;
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Missing reconciliation clock');
      if (!payment || payment.provider !== 'VNPAY' || payment.status !== 'PENDING' ||
          payment.reconciliationState !== 'SCHEDULED' || !payment.reconcileUntil ||
          clock.now < payment.reconcileUntil) return false;
      // Order cleanup must not depend on the independent expiration job running.
      await expireOrderInTransaction(tx, orderId);
      if (payment.leaseExpiresAt && payment.leaseExpiresAt > clock.now)
        return false;
      const updated = await tx.payment.updateMany({
        where: {
          id: paymentId, status: 'PENDING', provider: 'VNPAY',
          reconciliationState: 'SCHEDULED',
          reconcileUntil: { lte: clock.now },
          claimToken: payment.claimToken,
          leaseExpiresAt: payment.leaseExpiresAt,
        },
        data: {
          reconciliationState: 'REQUIRES_REVIEW',
          reviewReason: 'AUTO_RECONCILIATION_EXHAUSTED',
          nextQueryAt: null,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: clock.now,
        },
      });
      return updated.count === 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
  }

  /** Token fence: stale workers cannot clear a newer claim or change its metadata. */
  // The four-argument overload supports older P2-04 integration callers.
  // The caller's nextQueryAt is deliberately ignored: only the atomic claim
  // transaction may set the earliest next gateway request time.
  releaseClaim(paymentId: string, claimToken: string, lastQueryError: string | null): Promise<boolean>;
  releaseClaim(paymentId: string, claimToken: string, legacyNextQueryAt: Date, lastQueryError: string | null): Promise<boolean>;
  async releaseClaim(
    paymentId: string, claimToken: string,
    errorOrLegacyDate: string | Date | null,
    legacyError?: string | null,
  ): Promise<boolean> {
    const lastQueryError = errorOrLegacyDate instanceof Date
      ? (legacyError ?? null)
      : errorOrLegacyDate;
    return this.prisma.$transaction(async tx => {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Missing reconciliation clock');
      const changed = await tx.payment.updateMany({
        where: {
          id: paymentId, provider: 'VNPAY', status: 'PENDING',
          reconciliationState: 'SCHEDULED', claimToken,
          leaseExpiresAt: { gt: clock.now },
        },
        data: {
          claimToken: null, leaseExpiresAt: null,
          lastQueryError, updatedAt: clock.now,
        },
      });
      return changed.count === 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
  }

  private async lockOrderThenPayment(tx: Tx, paymentId: string): Promise<string | null> {
    // Identity lookup does not take Payment row lock; it is re-read below.
    const identity = await tx.payment.findUnique({
      where: { id: paymentId }, select: { orderId: true },
    });
    if (!identity) return null;
    const orderLock = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE id = ${identity.orderId}::uuid FOR UPDATE`;
    if (!orderLock.length) return null;
    const paymentLock = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    return paymentLock.length ? identity.orderId : null;
  }
}
