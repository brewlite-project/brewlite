import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';
import type { PaymentResponseDto } from './dto/payment-response.dto.js';
import { PaymentProcessor } from './payment-processor.js';
import { MockPaymentService } from './mock-payment.service.js';
import { assertMockPaymentEnabled } from './mock-payment.policy.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
import { readPaymentSnapshot } from './payment-snapshot.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';

type Result = { response: PaymentResponseDto; replayed: boolean };
type Tx = Prisma.TransactionClient;
const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, message, error: 'Conflict', code });
const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    message: 'Order not found',
    error: 'Not Found',
    code: 'NOT_FOUND',
  });
const transition = () =>
  conflict('INVALID_TRANSITION', 'Order cannot accept a new payment');
const inProgress = () =>
  conflict(
    'PAYMENT_IN_PROGRESS',
    'Payment is being processed; retry with the same key',
  );

function sqlState(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 5) return undefined;
  const value = error as Record<string, unknown>;
  // Prisma 7 driver adapters can nest PostgreSQL codes inside driverAdapterError.cause.
  for (const code of [value.code, value.originalCode]) {
    if (code === '55P03' || code === '40P01' || code === '40001') return code;
  }
  for (const child of [value.meta, value.driverAdapterError, value.cause]) {
    const state = sqlState(child, depth + 1);
    if (state) return state;
  }
  return undefined;
}

@Injectable()
export class PaymentsService extends PaymentProcessor {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MockPaymentService) private readonly mock: MockPaymentService,
    @Inject(PaymentFinalizationService)
    private readonly finalization: PaymentFinalizationService,
    @Inject(CreatePaymentPipe) private readonly bodyPipe: CreatePaymentPipe,
    @Inject(IdempotencyKeyPipe) private readonly keyPipe: IdempotencyKeyPipe,
  ) {
    super();
  }

  async execute(
    authenticatedUserId: string,
    key: string,
    input: CreatePaymentDto,
  ): Promise<Result> {
    // Enforce the same policy for direct callers before any validation/DB/replay.
    assertMockPaymentEnabled();
    // PostgreSQL UUID equality is case-insensitive; the key lock must use the same identity.
    const userId = authenticatedUserId.toLowerCase();
    const dto = this.bodyPipe.transform(input);
    const idempotencyKey = this.keyPipe.transform(key);
    // Only accepted fields enter the hash; no raw credential is persisted or logged.
    const requestHash = createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // Ownership precedes all key information, including replay/conflict/busy.
            if (
              !(await tx.order.findFirst({
                where: { id: dto.orderId, userId },
                select: { id: true },
              }))
            )
              throw notFound();
            // Completed snapshots are immutable: replay does not need a processing lock.
            // Ownership and validation still run first, including for expired/paid Orders.
            const completed = await this.replay(
              tx,
              userId,
              idempotencyKey,
              requestHash,
            );
            if (completed) return completed;
            const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, idempotencyKey])}, 0)) AS acquired`;
            // Zero wait on a busy key is bounded; callers retry the exact same key.
            if (!lock?.acquired) {
              // A competing writer may have committed between the first read and try-lock.
              const committed = await this.replay(
                tx,
                userId,
                idempotencyKey,
                requestHash,
              );
              if (committed) return committed;
              throw inProgress();
            }
            const replay = await this.replay(
              tx,
              userId,
              idempotencyKey,
              requestHash,
            );
            if (replay) return replay;
            // Bound contention with Scheduler and other keys on the same Order.
            await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
            const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM orders WHERE id = ${dto.orderId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
            if (!locked.length) throw notFound();
            // Required recheck after acquiring the Order lock, before state or expiry rejection.
            const afterLock = await this.replay(
              tx,
              userId,
              idempotencyKey,
              requestHash,
            );
            if (afterLock) return afterLock;
            const outcome = this.mock.evaluate(dto);
            const paymentId = randomUUID();
            const finalized = await this.finalization.finalizeInTransaction(
              tx,
              {
                provider: 'MOCK',
                userId,
                orderId: dto.orderId,
                paymentId,
                idempotencyKey,
                requestHash,
                method: dto.method,
                outcome,
              },
            );
            if (!finalized.mockResponse)
              throw new Error('Mock finalization did not return its snapshot');
            return { response: finalized.mockResponse, replayed: false };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 5000,
            timeout: 8000,
          },
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        const state = sqlState(error);
        if (state === '55P03') throw inProgress();
        if (
          (state === '40P01' ||
            state === '40001' ||
            (error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === 'P2034')) &&
          attempt < 2
        )
          continue;
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // The transaction has rolled back. Reconcile expected uniqueness races, never a fake FAILED attempt.
          try {
            if (
              !(await this.prisma.order.findFirst({
                where: { id: dto.orderId, userId },
                select: { id: true },
              }))
            )
              throw notFound();
            const existing = await this.replay(
              this.prisma,
              userId,
              idempotencyKey,
              requestHash,
            );
            if (existing) return existing;
            if (
              await this.prisma.payment.findFirst({
                where: { orderId: dto.orderId, status: 'SUCCESS' },
                select: { id: true },
              })
            )
              throw transition();
          } catch (recoveryError) {
            if (recoveryError instanceof HttpException) throw recoveryError;
          }
        }
        // Never log raw request, SQL errors, credentials, hashes or snapshots.
        this.logger.error('Failed to process payment');
        throw new InternalServerErrorException({
          statusCode: 500,
          message: 'Internal server error',
          error: 'Internal Server Error',
          code: 'INTERNAL_ERROR',
        });
      }
    }
    throw new Error('Unreachable payment retry state');
  }

  private async replay(
    tx: Tx,
    userId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<Result | null> {
    const existing = await tx.payment.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: {
        id: true,
        orderId: true,
        requestHash: true,
        responseSnapshot: true,
      },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash)
      throw conflict(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was used with a different payment request',
      );
    return {
      response: readPaymentSnapshot(
        existing.responseSnapshot,
        existing.id,
        existing.orderId,
      ),
      replayed: true,
    };
  }

}
