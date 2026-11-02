import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Prisma, type OrderStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadVnpayConfig } from './vnpay.config.js';
import { buildVnpayPaymentUrl, formatVnpayDate } from './vnpay-url.builder.js';
import type { InitiateVnpayDto, VnpayInitiationResponseDto } from './dto/initiate-vnpay.dto.js';

type Tx = Prisma.TransactionClient;
type Result = { response: VnpayInitiationResponseDto; replayed: boolean; created: boolean };
const error = (code: string, message: string) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message });
const notFound = () => new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'NOT_FOUND', message: 'Order not found' });
const active = (status: OrderStatus) => status === 'PENDING' || status === 'PAYMENT_FAILED';
const clientIp = (value: string | undefined) => {
  const normalized = value?.replace(/^::ffff:/, '');
  return normalized && isIP(normalized) !== 0 ? normalized : '127.0.0.1';
};
export const p2002ConstraintNames = (cause: Prisma.PrismaClientKnownRequestError): string[] => {
  const names = new Set<string>();
  const seen = new Set<object>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) names.add(value);
    else if (Array.isArray(value)) value.forEach(add);
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    add(record.target);
    add(record.index);
    if (record.constraint && typeof record.constraint === 'object')
      add((record.constraint as Record<string, unknown>).index);
    // Prisma 7 adapter errors preserve PostgreSQL's constraint index under this chain.
    visit(record.meta);
    visit(record.driverAdapterError);
    visit(record.cause);
  };
  visit(cause);
  return [...names];
};
const p2002Kind = (cause: Prisma.PrismaClientKnownRequestError): 'idempotency' | 'pending-vnpay' | null => {
  const text = p2002ConstraintNames(cause).join(',');
  if (/idempotency|uq_payments_user_idempotency/i.test(text)) return 'idempotency';
  // PostgreSQL/Prisma may report this partial unique index either by index name
  // or by its sole indexed column. At this create site, only a pending-VNPay row
  // can violate the order_id partial index (a SUCCESS row cannot).
  if (/uq_payments_one_pending_vnpay_per_order/i.test(text) || text === 'order_id') return 'pending-vnpay';
  return null;
};

@Injectable()
export class VnpayInitiationService {
  constructor(private readonly prisma: PrismaService) {}

  async initiate(userIdInput: string, key: string, dto: InitiateVnpayDto, ipAddress: string | undefined): Promise<Result> {
    const userId = userIdInput.toLowerCase();
    const orderId = dto.orderId.toLowerCase();
    const requestHash = createHash('sha256').update('VNPAY_INITIATE\n' + JSON.stringify({ orderId })).digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const owned = await tx.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
        if (!owned) throw notFound();
        const existing = await this.replay(tx, userId, key, requestHash);
        if (existing) return existing;
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, key])}, 0)) AS acquired`;
        if (!lock?.acquired) throw error('PAYMENT_IN_PROGRESS', 'Payment is being processed; retry with the same key');
        const replay = await this.replay(tx, userId, key, requestHash);
        if (replay) return replay;
        await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order || order.userId !== userId) throw notFound();
        const afterLock = await this.replay(tx, userId, key, requestHash);
        if (afterLock) return afterLock;
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock) throw new Error('Missing database clock');
        if (!active(order.status)) throw error('INVALID_TRANSITION', 'Order cannot accept a new payment');
        if (clock.now >= order.expiresAt) throw error('ORDER_EXPIRED', 'Order has expired');
        if (order.totalVnd === 0n) throw error('ZERO_AMOUNT_REQUIRED', 'Order total must be settled using ZERO_AMOUNT');
        if (order.totalVnd < 0n || !Number.isSafeInteger(Number(order.totalVnd))) throw new Error('Unsafe payment amount');
        const prior = await tx.payment.findMany({ where: { orderId }, select: { status: true, provider: true, hasFinancialException: true, reconciliationState: true } });
        if (prior.some((p) => p.hasFinancialException || p.reconciliationState === 'REQUIRES_REVIEW')) throw error('FINANCIAL_EXCEPTION_REQUIRES_REVIEW', 'Payment requires financial review');
        if (prior.some((p) => p.status === 'SUCCESS')) throw error('INVALID_TRANSITION', 'Order cannot accept a new payment');
        if (prior.some((p) => p.status === 'PENDING')) throw error('PAYMENT_IN_PROGRESS', 'A payment attempt is still being processed');
        // A replay only reads its immutable snapshot; a new attempt alone needs gateway configuration.
        // The outer catch remains the public error boundary for configuration failures.
        const config = loadVnpayConfig();
        const paymentId = randomUUID();
        const txnRef = paymentId.replace(/-/g, '');
        // Gateway expiry is exactly Order expiry; it never grants extra payment time.
        const built = buildVnpayPaymentUrl({ txnRef, amountVnd: order.totalVnd, orderInfo: `Thanh toan don hang ${order.id}`, ipAddr: clientIp(ipAddress), createDate: formatVnpayDate(clock.now), expireDate: formatVnpayDate(order.expiresAt) }, config);
        const response: VnpayInitiationResponseDto = { paymentId, orderId, provider: 'VNPAY', paymentStatus: 'PENDING', orderStatus: order.status, amountVnd: Number(order.totalVnd), paymentUrl: built.paymentUrl, expiresAt: order.expiresAt.toISOString() };
        await tx.payment.create({ data: { id: paymentId, orderId, userId, idempotencyKey: key, requestHash, amountVnd: order.totalVnd, provider: 'VNPAY', status: 'PENDING', vnpTxnRef: txnRef, vnpTmnCode: config.tmnCode, vnpCreateDate: formatVnpayDate(clock.now), gatewayExpiresAt: order.expiresAt, initiationSnapshot: { schemaVersion: 1, paymentUrl: built.paymentUrl, requestParameters: built.signedParams }, reconciliationState: 'SCHEDULED', nextQueryAt: order.expiresAt, reconcileUntil: new Date(order.expiresAt.getTime() + 65 * 60_000), updatedAt: clock.now } });
        return { response, replayed: false, created: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
    } catch (cause) {
      if (cause instanceof ConflictException || cause instanceof NotFoundException) throw cause;
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        try {
          const recovered = await this.recoverP2002(cause, userId, key, requestHash, orderId);
          if (recovered) return recovered;
        } catch (recoveryCause) {
          if (recoveryCause instanceof ConflictException || recoveryCause instanceof NotFoundException) throw recoveryCause;
        }
      }
      throw new InternalServerErrorException({ statusCode: 500, error: 'Internal Server Error', code: 'INTERNAL_ERROR', message: 'Internal server error' });
    }
  }

  /** A failed transaction cannot read its winner; resolve known unique races in a fresh transaction. */
  private async recoverP2002(cause: Prisma.PrismaClientKnownRequestError, userId: string, key: string, hash: string, orderId: string): Promise<Result | null> {
    const kind = p2002Kind(cause);
    if (!kind) return null;
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
      if (!owned) throw notFound();
      const replay = await this.replay(tx, userId, key, hash);
      if (replay) return replay;
      if (kind === 'pending-vnpay') {
        const pending = await tx.payment.findFirst({ where: { orderId, provider: 'VNPAY', status: 'PENDING' }, select: { id: true } });
        if (pending) throw error('PAYMENT_IN_PROGRESS', 'A payment attempt is still being processed');
      }
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
  }

  private async replay(tx: Tx, userId: string, key: string, hash: string): Promise<Result | null> {
    const payment = await tx.payment.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } }, include: { order: { select: { status: true } } } });
    if (!payment) return null;
    if (payment.requestHash !== hash) throw error('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency key was used with a different payment request');
    if (payment.provider !== 'VNPAY' || !payment.initiationSnapshot || typeof payment.initiationSnapshot !== 'object') throw error('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency key was used with a different payment request');
    const snap = payment.initiationSnapshot as { paymentUrl?: unknown };
    if (typeof snap.paymentUrl !== 'string') throw new Error('Invalid VNPay initiation snapshot');
    return { response: { paymentId: payment.id, orderId: payment.orderId, provider: 'VNPAY', paymentStatus: payment.status, orderStatus: payment.order.status, amountVnd: Number(payment.amountVnd), paymentUrl: snap.paymentUrl, expiresAt: payment.gatewayExpiresAt!.toISOString() }, replayed: true, created: false };
  }
}
