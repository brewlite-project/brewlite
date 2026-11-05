import {
  Inject, Injectable, Logger,
  type OnApplicationBootstrap, type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VnpayQueryDrService } from './vnpay-querydr.service.js';
import {
  PAYMENT_RECONCILIATION_OPTIONS,
  type PaymentReconciliationOptions,
} from './payment-reconciliation.config.js';

type Candidate = { id: string; horizonReached: boolean };

/**
 * Polls a bounded, stable database snapshot; does not infer Payment FAILED from
 * gateway timeouts, missing IPN, elapsed grace or an exhausted horizon.
 * PostgreSQL claims, not this process-local timer, coordinate multiple workers.
 */
@Injectable()
export class PaymentReconciliationScheduler
  implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconciliationScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly querydr: VnpayQueryDrService,
    @Inject(PAYMENT_RECONCILIATION_OPTIONS)
    private readonly options: PaymentReconciliationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {
        this.logger.error('Reconciliation scan failed; retry on the next tick');
      });
    }, this.options.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Public to integration tests; not exposed by a controller. */
  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.sweep().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async sweep(): Promise<void> {
    const [clock] = await this.prisma.$queryRaw<{ cutoff: string }[]>`
      SELECT clock_timestamp()::text AS cutoff`;
    if (!clock) throw new Error('Missing reconciliation database clock');
    let cursor: string | null = null;
    while (!this.stopping) {
      const candidates: Candidate[] = await this.prisma.$queryRaw<Candidate[]>`
        SELECT id,
               (reconcile_until <= ${clock.cutoff}::timestamptz) AS "horizonReached"
        FROM payments
        WHERE provider = 'VNPAY'
          AND status = 'PENDING'
          AND reconciliation_state = 'SCHEDULED'
          AND (
            (next_query_at IS NOT NULL AND next_query_at <= ${clock.cutoff}::timestamptz)
            OR reconcile_until <= ${clock.cutoff}::timestamptz
          )
          AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
        ORDER BY id
        LIMIT ${this.options.batchSize}`;
      if (!candidates.length) return;
      for (const candidate of candidates) {
        if (this.stopping) return;
        try {
          if (candidate.horizonReached) {
            await this.querydr.markExhausted(candidate.id);
          } else {
            await this.queryCandidate(candidate.id);
          }
        } catch {
          // Never log full gateway responses, secrets, DB connection strings,
          // signed URLs or driver exceptions.
          this.logger.error('Reconciliation candidate failed; retry at next eligible tick');
        }
      }
      cursor = candidates[candidates.length - 1].id;
      if (candidates.length < this.options.batchSize) return;
    }
  }

  private async queryCandidate(paymentId: string): Promise<void> {
    const claim = await this.querydr.claim(
      paymentId, this.options.leaseMs, this.options.cooldownMs,
    );
    if (!claim) return; // Another worker, stale scan or expired horizon.
    let errorCode: string | null = null;
    try {
      await this.querydr.reconcileClaimed(
        paymentId, claim.requestId, claim.claimToken, this.options.ipAddr,
      );
    } catch (error) {
      // HTTP timeout, unverified response or transaction failure is UNKNOWN,
      // never proof that the customer payment FAILED.
      errorCode = 'QUERYDR_UNVERIFIED_OR_TEMPORARY_FAILURE';

      const message =
        error instanceof Error
          ? error.message
          : 'Unknown QueryDR error';

      this.logger.warn(
        `QueryDR attempt inconclusive; retain PENDING and cooldown: ${message}`,
      );
    } finally {
      try {
        await this.querydr.releaseClaim(paymentId, claim.claimToken, errorCode);
      } catch {
        // A previous verified IPN may have finalized the Payment, or the
        // lease may now belong to another worker. No unsafe fallback writes.
        this.logger.error('QueryDR claim cleanup failed; lease recovery will retry');
      }
    }
  }
}
