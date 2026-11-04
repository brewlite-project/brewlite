import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ZeroAmountPaymentResponseDto } from './dto/zero-amount-payment.dto.js';
import {
  PaymentFinalizationService,
  type FinalizationCommand,
} from './payment-finalization.service.js';
import {
  IdempotencyKeyPipe,
  ZeroAmountPaymentPipe,
} from './payment-validation.pipe.js';

type Command = Extract<FinalizationCommand, { provider: 'ZERO_AMOUNT' }>;
type Result = { response: ZeroAmountPaymentResponseDto; replayed: boolean };
const inProgress = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'PAYMENT_IN_PROGRESS',
    message: 'Payment is being processed; retry with the same key',
  });

function isContention(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const value = error as Record<string, unknown>;
  if (
    [value.code, value.originalCode].some((code) =>
      ['55P03', '40P01', '40001', 'P2034'].includes(String(code)),
    )
  )
    return true;
  return [value.meta, value.driverAdapterError, value.cause].some((child) =>
    isContention(child, depth + 1),
  );
}

@Injectable()
export class ZeroAmountPaymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentFinalizationService)
    private readonly finalization: PaymentFinalizationService,
    @Inject(ZeroAmountPaymentPipe)
    private readonly bodyPipe: ZeroAmountPaymentPipe,
    @Inject(IdempotencyKeyPipe) private readonly keyPipe: IdempotencyKeyPipe,
  ) {}

  async execute(
    authenticatedUserId: string,
    key: unknown,
    input: unknown,
  ): Promise<Result> {
    const userId = authenticatedUserId.toLowerCase();
    const dto = this.bodyPipe.transform(input);
    const idempotencyKey = this.keyPipe.transform(key);
    // Separate this operation from Mock and VNPay within the shared key namespace.
    const requestHash = createHash('sha256')
      .update('ZERO_AMOUNT\n' + JSON.stringify(dto))
      .digest('hex');
    const command: Command = {
      provider: 'ZERO_AMOUNT',
      userId,
      orderId: dto.orderId,
      paymentId: randomUUID(),
      idempotencyKey,
      requestHash,
    };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
          // Do not expose replay, key conflict or processing state before ownership.
          const owned = await tx.order.findFirst({
            where: { id: dto.orderId, userId },
            select: { id: true },
          });
          if (!owned)
            throw new NotFoundException({
              statusCode: 404,
              error: 'Not Found',
              code: 'NOT_FOUND',
              message: 'Order not found',
            });
          const completed = await this.replay(tx, command);
          if (completed) return completed;
          // Same lock identity/order as Mock and VNPay: user/key, then Order.
          const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, idempotencyKey])}, 0)) AS acquired`;
          if (!lock?.acquired) {
            const committed = await this.replay(tx, command);
            if (committed) return committed;
            throw inProgress();
          }
          // Shared Finalization locks/rechecks Order, then checks replay before
          // state/expiry. It owns every Payment/Order/Coupon/Loyalty mutation.
          return this.finalize(tx, command);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5000,
          timeout: 8000,
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isContention(error)) throw inProgress();
      // Never expose SQL, connection details or stored payment snapshots.
      throw new InternalServerErrorException({
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    }
  }

  private async replay(
    tx: Prisma.TransactionClient,
    command: Command,
  ): Promise<Result | null> {
    const existing = await tx.payment.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: command.userId,
          idempotencyKey: command.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (!existing) return null;
    // Reuse the provider-aware snapshot parser and key-conflict checks.
    const result = await this.finalize(tx, command);
    if (!result.replayed)
      throw new Error('Expected a committed ZERO_AMOUNT replay');
    return result;
  }

  private async finalize(
    tx: Prisma.TransactionClient,
    command: Command,
  ): Promise<Result> {
    const result = await this.finalization.finalizeInTransaction(tx, command);
    if (
      !result.zeroAmountResponse ||
      !['FINALIZED', 'DUPLICATE'].includes(result.disposition)
    )
      throw new Error('Missing ZERO_AMOUNT finalization snapshot');
    return {
      response: result.zeroAmountResponse,
      replayed: result.disposition === 'DUPLICATE',
    };
  }
}
