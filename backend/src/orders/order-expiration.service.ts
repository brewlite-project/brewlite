import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { expireOrderInTransaction } from './inventory-policy.js';
import { runInventoryTransaction } from './inventory-transaction.js';
import {
  ORDER_EXPIRATION_INTERVAL_MS,
  ORDER_EXPIRATION_OPTIONS,
  ORDER_GRACE_MS,
  type OrderExpirationOptions,
} from './order-expiration.config.js';

@Injectable()
export class OrderExpirationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OrderExpirationService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ORDER_EXPIRATION_OPTIONS)
    private readonly options: OrderExpirationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.timer || this.stopping) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, ORDER_EXPIRATION_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // OrdersModule is destroyed before its PrismaModule dependency in Nest.
    await this.running;
  }

  /** Internal runner, also used by integration tests; not exposed as an HTTP API. */
  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.sweep()
      .catch(() => {
        this.logger.error(
          'Order expiration scan failed; will retry on the next tick',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sweep(): Promise<void> {
    // Preserve DB timestamp precision as text. New expirations are picked up on
    // the next tick so a continuously changing table cannot extend this sweep.
    const [clock] = await this.prisma.$queryRaw<{ cutoff: string }[]>`
      SELECT clock_timestamp()::text AS cutoff`;
    if (!clock) throw new Error('Missing database clock');
    let cursor: string | null = null;
    while (!this.stopping) {
      const candidates: { id: string }[] = await this.prisma.$queryRaw<
        { id: string }[]
      >`
        SELECT id FROM orders
        WHERE status IN ('PENDING', 'PAYMENT_FAILED')
          AND expires_at <= ${clock.cutoff}::timestamptz
          AND (
            expires_at + (${ORDER_GRACE_MS} * INTERVAL '1 millisecond') <= ${clock.cutoff}::timestamptz
            OR NOT EXISTS (
              SELECT 1 FROM payments
              WHERE payments.order_id = orders.id
                AND payments.provider = 'VNPAY'
                AND payments.status = 'PENDING'
            )
          )
          AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
        ORDER BY id
        LIMIT ${this.options.batchSize}`;
      if (!candidates.length) return;
      for (const candidate of candidates) {
        if (this.stopping) return;
        try {
          // The scan only finds candidates. Recheck Grace, attempts and DB time
          // after the Order lock, shared with POST /orders lazy cleanup.
          await runInventoryTransaction(this.prisma, (tx) =>
            expireOrderInTransaction(tx, candidate.id),
          );
        } catch {
          // Do not log raw driver errors, SQL, connection details or payment data.
          this.logger.error(
            `Order expiration failed for ${candidate.id}; will retry on the next tick`,
          );
        }
      }
      // Advance past failures too; one bad Order must not starve later batches.
      cursor = candidates[candidates.length - 1].id;
      if (candidates.length < this.options.batchSize) return;
    }
  }
}
