import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import { loadVnpayQueryDrConfig } from './vnpay.config.js';
import { VnpayQueryDrClient, type QueryDrTransport } from './vnpay-querydr.client.js';

/** The scheduler owns policy values. This service owns only safe claim/network/finalization boundaries. */
@Injectable()
export class VnpayQueryDrService {
  constructor(private readonly prisma: PrismaService, private readonly finalization: PaymentFinalizationService) {}

  async reconcileClaimed(paymentId: string, requestId: string, claimToken: string, ipAddr: string, transport?: QueryDrTransport) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.provider !== 'VNPAY' || payment.status !== 'PENDING' || payment.claimToken !== claimToken || !payment.leaseExpiresAt || payment.leaseExpiresAt <= new Date() || payment.lastQueryRequestId !== requestId || !payment.vnpTxnRef || !payment.vnpTmnCode || !payment.vnpCreateDate) throw new Error('QueryDR claim is not valid');
    // No interactive transaction is open while the network client runs.
    const outcome = await new VnpayQueryDrClient(loadVnpayQueryDrConfig(), transport).query({
      id: payment.id, vnpTxnRef: payment.vnpTxnRef, vnpTmnCode: payment.vnpTmnCode,
      vnpCreateDate: payment.vnpCreateDate, amountVnd: payment.amountVnd,
      initiationSnapshot: payment.initiationSnapshot,
    }, requestId, ipAddr, new Date());
    return this.prisma.$transaction(tx => this.finalization.finalizeInTransaction(tx, { provider: 'VNPAY', paymentId, verifiedOutcome: outcome }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
  }

  async claim(paymentId: string, leaseMs: number): Promise<{ requestId: string; claimToken: string } | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('QueryDR lease policy is required');
    return this.prisma.$transaction(async tx => {
      const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!row) throw new Error('Missing database clock');
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.provider !== 'VNPAY' || payment.status !== 'PENDING' || payment.reconciliationState !== 'SCHEDULED' || !payment.nextQueryAt || payment.nextQueryAt > row.now || !payment.reconcileUntil || row.now > payment.reconcileUntil || (payment.leaseExpiresAt && payment.leaseExpiresAt > row.now)) return null;
      const requestId = randomUUID().replaceAll('-', '').slice(0, 32);
      const claimToken = randomUUID();
      // The preliminary read is advisory only. Recheck every eligibility
      // condition at the write so an IPN/finalizer commit between read/update
      // becomes a harmless lost claim rather than an invalid lease update.
      const changed = await tx.payment.updateMany({ where: {
        id: payment.id,
        provider: 'VNPAY',
        status: 'PENDING',
        reconciliationState: 'SCHEDULED',
        nextQueryAt: { not: null, lte: row.now },
        reconcileUntil: { gte: row.now },
        claimToken: payment.claimToken,
        leaseExpiresAt: payment.leaseExpiresAt,
      }, data: { claimToken, leaseExpiresAt: new Date(row.now.getTime() + leaseMs), lastQueryAt: row.now, lastQueryRequestId: requestId, queryAttempts: { increment: 1 }, updatedAt: row.now } });
      return changed.count === 1 ? { requestId, claimToken } : null;
    });
  }

  /** Scheduler supplies the next eligible instant; a stale worker cannot clear a newer claim. */
  async releaseClaim(paymentId: string, claimToken: string, nextQueryAt: Date, lastQueryError: string | null): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Missing database clock');
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, provider: 'VNPAY', status: 'PENDING', reconciliationState: 'SCHEDULED', claimToken, leaseExpiresAt: { not: null } },
        data: { claimToken: null, leaseExpiresAt: null, nextQueryAt, lastQueryError, updatedAt: clock.now },
      });
      return changed.count === 1;
    });
  }
}
