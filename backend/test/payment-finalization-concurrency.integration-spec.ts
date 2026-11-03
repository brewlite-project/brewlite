import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Prisma } from '../src/generated/prisma/client.js';
import { expireOrderInTransaction } from '../src/orders/inventory-policy.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PaymentFinalizationService,
  type FinalizationResult,
  type VerifiedGatewayOutcome,
} from '../src/payments/payment-finalization.service.js';

type Fixture = {
  userId: string;
  orderId: string;
  productId: string;
  couponId: string;
  totalVnd: bigint;
  expiresAt: Date;
};

type VnpayPayment = {
  id: string;
  vnpTxnRef: string;
  vnpTmnCode: string;
};

type OutcomeOptions = {
  source?: VerifiedGatewayOutcome['source'];
  outcome?: VerifiedGatewayOutcome['outcome'];
  eventIdentity?: string;
  queryRequestId?: string | null;
  responseCode?: string | null;
  transactionStatus?: string | null;
  gatewayTransactionNo?: string | null;
  amountVnd?: bigint | null;
  gatewayPaidAt?: Date | null;
};

type TxWork<T> = (tx: Prisma.TransactionClient) => Promise<T>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const runId = randomUUID();
const finalizer = new PaymentFinalizationService();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requirePrisma(prisma: PrismaService | undefined): PrismaService {
  if (!prisma) throw new Error('PostgreSQL test client is not initialized');
  return prisma;
}

function assertDedicatedTestUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('AUTH_TEST_DATABASE_URL is not a valid PostgreSQL URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== 'localhost' ||
    parsed.port !== '5433' ||
    databaseName !== 'brewlite_test'
  )
    throw new Error(
      'AUTH_TEST_DATABASE_URL must target only localhost:5433/brewlite_test; no other database was used.',
    );
}

describe.skipIf(process.env.PAYMENT_CONCURRENCY_TESTS !== '1')(
  'Payment finalization concurrency on PostgreSQL',
  () => {
    let prisma: PrismaService | undefined;
    const userIds: string[] = [];
    const orderIds: string[] = [];
    const productIds: string[] = [];
    const couponIds: string[] = [];
    const paymentIds: string[] = [];
    const categoryId = randomUUID();
    let observedLockWaits = 0;

    beforeAll(async () => {
      const url = process.env.AUTH_TEST_DATABASE_URL;
      if (!url)
        throw new Error(
          'Set AUTH_TEST_DATABASE_URL to the dedicated localhost:5433/brewlite_test database before enabling PAYMENT_CONCURRENCY_TESTS.',
        );
      assertDedicatedTestUrl(url);
      vi.stubEnv('DATABASE_URL', url);

      prisma = new PrismaService();
      await prisma.$connect();
      const [identity] = await prisma.$queryRaw<
        { database: string }[]
      >`SELECT current_database() AS database`;
      if (identity?.database !== 'brewlite_test')
        throw new Error(
          'Connected PostgreSQL database did not match brewlite_test; no fixtures were created.',
        );

      const migrationDirectory = fileURLToPath(
        new URL('../prisma/migrations/', import.meta.url),
      );
      const expectedMigrations = (
        await readdir(migrationDirectory, {
          withFileTypes: true,
        })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      let migrationRows: {
        migrationName: string;
        finishedAt: Date | null;
        rolledBackAt: Date | null;
      }[];
      try {
        migrationRows = await prisma.$queryRaw<
          {
            migrationName: string;
            finishedAt: Date | null;
            rolledBackAt: Date | null;
          }[]
        >`
          SELECT migration_name AS "migrationName",
                 finished_at AS "finishedAt",
                 rolled_back_at AS "rolledBackAt"
          FROM "_prisma_migrations"`;
      } catch {
        throw new Error(
          'Could not read the migration ledger in brewlite_test; verify migration status before running this suite.',
        );
      }
      const applied = new Set(
        migrationRows
          .filter((row) => row.finishedAt && !row.rolledBackAt)
          .map((row) => row.migrationName),
      );
      const missing = expectedMigrations.filter((name) => !applied.has(name));
      const unfinished = migrationRows
        .filter((row) => !row.finishedAt && !row.rolledBackAt)
        .map((row) => row.migrationName);
      if (missing.length || unfinished.length)
        throw new Error(
          `brewlite_test is not fully migrated; missing local migrations: ${missing.join(', ') || 'none'}; unfinished migrations: ${unfinished.join(', ') || 'none'}.`,
        );

      await prisma.category.create({
        data: {
          id: categoryId,
          code: `tc-${runId.replaceAll('-', '').slice(0, 24)}`,
          name: `Concurrency test category ${runId.slice(0, 8)}`,
        },
      });
    });

    afterAll(async () => {
      try {
        if (prisma) {
          if (paymentIds.length)
            await prisma.paymentGatewayEvent.deleteMany({
              where: { paymentId: { in: paymentIds } },
            });
          if (paymentIds.length)
            await prisma.payment.deleteMany({
              where: { id: { in: paymentIds } },
            });
          if (orderIds.length)
            await prisma.couponRedemption.deleteMany({
              where: { orderId: { in: orderIds } },
            });
          if (orderIds.length)
            await prisma.orderItem.deleteMany({
              where: { orderId: { in: orderIds } },
            });
          if (orderIds.length)
            await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
          if (couponIds.length)
            await prisma.coupon.deleteMany({
              where: { id: { in: couponIds } },
            });
          if (productIds.length)
            await prisma.product.deleteMany({
              where: { id: { in: productIds } },
            });
          await prisma.category.deleteMany({ where: { id: categoryId } });
          if (userIds.length)
            await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        }
      } finally {
        await prisma?.$disconnect();
        vi.unstubAllEnvs();
      }
    });

    async function databaseNow(): Promise<Date> {
      const [row] = await requirePrisma(prisma).$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      if (!row) throw new Error('PostgreSQL did not return its clock.');
      return row.now;
    }

    async function fixture(
      options: { coupon?: boolean } = {},
    ): Promise<Fixture> {
      const dbNow = await databaseNow();
      const userId = randomUUID();
      userIds.push(userId);
      await requirePrisma(prisma).user.create({
        data: {
          id: userId,
          email: `concurrency-${runId.slice(0, 8)}-${userId}@example.com`,
          passwordHash: 'test-only-no-login',
          loyaltyPoints: 0,
        },
      });

      const productId = randomUUID();
      productIds.push(productId);
      await requirePrisma(prisma).product.create({
        data: {
          id: productId,
          categoryId,
          name: `Concurrency test product ${productId.slice(0, 8)}`,
          basePriceVnd: 49000n,
          imageUrl: '/test.svg',
          // The Order already holds two units. Cancellation must add them back.
          stock: 8,
        },
      });

      let couponId: string = randomUUID();
      let discountVnd = 0n;
      let totalVnd = 98000n;
      if (options.coupon) {
        couponIds.push(couponId);
        discountVnd = 1000n;
        totalVnd -= discountVnd;
        await requirePrisma(prisma).coupon.create({
          data: {
            id: couponId,
            code: `cc-${couponId.replaceAll('-', '').slice(0, 24)}`,
            type: 'FIXED',
            value: 1000,
            startsAt: new Date(dbNow.getTime() - 60_000),
            expiresAt: new Date(dbNow.getTime() + 86_400_000),
            usageLimit: 10,
            activeUsageCount: 1,
          },
        });
      } else {
        couponId = '';
      }

      const orderId = randomUUID();
      orderIds.push(orderId);
      const order = await requirePrisma(prisma).order.create({
        data: {
          id: orderId,
          userId,
          couponId: options.coupon ? couponId : null,
          subtotalVnd: 98000n,
          discountVnd,
          totalVnd,
          expiresAt: new Date(dbNow.getTime() + 900_000),
          items: {
            create: {
              productId,
              productNameSnapshot: 'Concurrency test product',
              size: 'S',
              sizePercentSnapshot: 100,
              basePriceSnapshotVnd: 49000n,
              unitPriceVnd: 49000n,
              quantity: 2,
              lineTotalVnd: 98000n,
            },
          },
        },
      });
      if (options.coupon)
        await requirePrisma(prisma).couponRedemption.create({
          data: { couponId, orderId, userId },
        });
      return {
        userId,
        orderId,
        productId,
        couponId,
        totalVnd,
        expiresAt: order.expiresAt,
      };
    }

    async function setExpiryFromDatabase(
      f: Fixture,
      offsetMs: number,
    ): Promise<Date> {
      if (!Number.isInteger(offsetMs))
        throw new Error(
          'Order expiry offset must be an integer millisecond value.',
        );
      const [row] = await requirePrisma(prisma).$queryRaw<
        { expiresAt: Date }[]
      >`
        UPDATE orders
        SET expires_at = date_trunc('milliseconds', clock_timestamp())
          + (${offsetMs} * INTERVAL '1 millisecond')
        WHERE id = ${f.orderId}::uuid
        RETURNING expires_at AS "expiresAt"`;
      if (!row) throw new Error('Could not set the fixture Order expiry.');
      f.expiresAt = row.expiresAt;
      return row.expiresAt;
    }

    async function addPendingVnpay(f: Fixture): Promise<VnpayPayment> {
      const now = await databaseNow();
      const id = randomUUID();
      const vnpTxnRef = `T-${randomUUID()}`;
      const vnpTmnCode = 'TEST-TMN';
      paymentIds.push(id);
      await requirePrisma(prisma).payment.create({
        data: {
          id,
          orderId: f.orderId,
          userId: f.userId,
          idempotencyKey: randomUUID(),
          requestHash: sha256(`${runId}:${randomUUID()}`),
          amountVnd: f.totalVnd,
          provider: 'VNPAY',
          method: null,
          status: 'PENDING',
          mockReference: null,
          methodLast4: null,
          responseSnapshot: Prisma.DbNull,
          createdAt: now,
          updatedAt: now,
          vnpTxnRef,
          vnpTmnCode,
          vnpCreateDate: now.toISOString().replace(/\D/g, '').slice(0, 14),
          gatewayExpiresAt: new Date(now.getTime() + 900_000),
          initiationSnapshot: {
            provider: 'VNPAY',
            vnpTxnRef,
            vnpTmnCode,
            amountVnd: Number(f.totalVnd),
          },
          finalOutcomeSnapshot: Prisma.DbNull,
          verifiedPaidAt: null,
          verifiedAt: null,
          finalizedAt: null,
          reconciliationState: 'SCHEDULED',
          nextQueryAt: new Date(now.getTime() + 60_000),
          lastQueryAt: null,
          queryAttempts: 0,
          reconcileUntil: new Date(now.getTime() + 3_900_000),
          claimToken: null,
          leaseExpiresAt: null,
          lastQueryRequestId: null,
          lastQueryError: null,
          reviewReason: null,
          hasFinancialException: false,
        },
      });
      return { id, vnpTxnRef, vnpTmnCode };
    }

    async function outcome(
      f: Fixture,
      payment: VnpayPayment,
      options: OutcomeOptions = {},
    ): Promise<VerifiedGatewayOutcome> {
      const now = await databaseNow();
      const source = options.source ?? 'IPN';
      const result = options.outcome ?? 'SUCCESS';
      return {
        source,
        eventIdentity:
          options.eventIdentity ?? sha256(`${runId}:${randomUUID()}`),
        queryRequestId:
          source === 'IPN' ? null : (options.queryRequestId ?? randomUUID()),
        vnpTxnRef: payment.vnpTxnRef,
        vnpTmnCode: payment.vnpTmnCode,
        outcome: result,
        responseCode:
          options.responseCode ?? (result === 'FAILED' ? '24' : '00'),
        transactionStatus:
          options.transactionStatus ?? (result === 'FAILED' ? '02' : '00'),
        gatewayTransactionNo:
          options.gatewayTransactionNo ?? `GW-${randomUUID()}`,
        amountVnd:
          options.amountVnd === undefined ? f.totalVnd : options.amountVnd,
        gatewayPaidAt:
          options.gatewayPaidAt === undefined
            ? result === 'SUCCESS'
              ? now
              : null
            : options.gatewayPaidAt,
        verifiedAt: now,
        receivedAt: now,
      };
    }

    function finalizationWork(
      payment: VnpayPayment,
      evidence: VerifiedGatewayOutcome,
    ): TxWork<FinalizationResult> {
      return (tx) =>
        finalizer.finalizeInTransaction(tx, {
          provider: 'VNPAY',
          paymentId: payment.id,
          verifiedOutcome: evidence,
        });
    }

    function startTransaction<T>(
      work: TxWork<T>,
      options: { lockTimeout?: string } = {},
    ) {
      const backendPid = deferred<number>();
      const result = requirePrisma(prisma)
        .$transaction(
          async (tx) => {
            try {
              const [row] = await tx.$queryRaw<{ pid: number }[]>`
                SELECT pg_backend_pid() AS pid`;
              if (!row)
                throw new Error('PostgreSQL did not return a backend PID.');
              backendPid.resolve(Number(row.pid));
              if (options.lockTimeout)
                await tx.$queryRaw`
                  SELECT set_config('lock_timeout', ${options.lockTimeout}, true)`;
              return await work(tx);
            } catch (error) {
              backendPid.reject(error);
              throw error;
            }
          },
          { maxWait: 5_000, timeout: 20_000 },
        )
        .catch((error: unknown) => {
          backendPid.reject(error);
          throw error;
        });
      void result.catch(() => undefined);
      return { backendPid: backendPid.promise, result };
    }

    function startHeldOrderTransaction<T>(orderId: string, work: TxWork<T>) {
      const ready = deferred<{ backendPid: number; result: T }>();
      const releaseGate = deferred<void>();
      const result = requirePrisma(prisma)
        .$transaction(
          async (tx) => {
            try {
              const [backend] = await tx.$queryRaw<{ pid: number }[]>`
                SELECT pg_backend_pid() AS pid`;
              if (!backend)
                throw new Error('PostgreSQL did not return a backend PID.');
              await tx.$queryRaw`
                SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
              const value = await work(tx);
              ready.resolve({ backendPid: Number(backend.pid), result: value });
              await releaseGate.promise;
              return value;
            } catch (error) {
              ready.reject(error);
              throw error;
            }
          },
          { maxWait: 5_000, timeout: 20_000 },
        )
        .catch((error: unknown) => {
          ready.reject(error);
          throw error;
        });
      void result.catch(() => undefined);
      return {
        ready: ready.promise,
        result,
        release: () => releaseGate.resolve(undefined),
      };
    }

    async function waitForLockWait(backendPid: number, timeoutMs = 7_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [activity] = await requirePrisma(prisma).$queryRaw<
          {
            waitEventType: string | null;
            waitEvent: string | null;
            state: string | null;
            query: string | null;
          }[]
        >`
          SELECT wait_event_type AS "waitEventType",
                 wait_event AS "waitEvent",
                 state,
                 query
          FROM pg_stat_activity
          WHERE pid = ${backendPid}`;
        if (activity?.waitEventType === 'Lock') return activity;
        await delay(20);
      }
      throw new Error(
        `PostgreSQL backend ${backendPid} did not enter a real Lock wait.`,
      );
    }

    async function contendInOrder<TFirst, TSecond>(
      orderId: string,
      firstWork: TxWork<TFirst>,
      secondWork: TxWork<TSecond>,
    ) {
      const first = startHeldOrderTransaction(orderId, firstWork);
      let second:
        { backendPid: Promise<number>; result: Promise<TSecond> } | undefined;
      try {
        const firstReady = await first.ready;
        second = startTransaction(secondWork);
        const secondPid = await second.backendPid;
        const lockWait = await waitForLockWait(secondPid);
        expect(lockWait.waitEventType).toBe('Lock');
        expect(lockWait.state).toBe('active');
        observedLockWaits += 1;
        first.release();
        const [firstResult, secondResult] = await Promise.all([
          first.result,
          second.result,
        ]);
        expect(firstReady.result).toEqual(firstResult);
        return { firstResult, secondResult, lockWait, secondPid };
      } finally {
        first.release();
        if (second) await Promise.allSettled([first.result, second.result]);
        else await Promise.allSettled([first.result]);
      }
    }

    async function finalize(
      payment: VnpayPayment,
      evidence: VerifiedGatewayOutcome,
    ): Promise<FinalizationResult> {
      return requirePrisma(prisma).$transaction(
        finalizationWork(payment, evidence),
        { maxWait: 5_000, timeout: 15_000 },
      );
    }

    async function persistedState(f: Fixture, paymentId: string) {
      const client = requirePrisma(prisma);
      const [order, payment, user, product, redemption, coupon, events] =
        await Promise.all([
          client.order.findUniqueOrThrow({ where: { id: f.orderId } }),
          client.payment.findUniqueOrThrow({ where: { id: paymentId } }),
          client.user.findUniqueOrThrow({ where: { id: f.userId } }),
          client.product.findUniqueOrThrow({ where: { id: f.productId } }),
          client.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          }),
          client.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
          client.paymentGatewayEvent.findMany({
            where: { paymentId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        ]);
      return {
        order: {
          status: order.status,
          pointsEarned: order.pointsEarned,
          paidAt: order.paidAt,
          cancelledAt: order.cancelledAt,
          updatedAt: order.updatedAt,
        },
        payment: {
          status: payment.status,
          finalOutcomeSnapshot: payment.finalOutcomeSnapshot,
          verifiedAt: payment.verifiedAt,
          verifiedPaidAt: payment.verifiedPaidAt,
          finalizedAt: payment.finalizedAt,
          hasFinancialException: payment.hasFinancialException,
          reconciliationState: payment.reconciliationState,
          reviewReason: payment.reviewReason,
          updatedAt: payment.updatedAt,
        },
        userPoints: user.loyaltyPoints,
        productStock: product.stock,
        redemption: {
          status: redemption.status,
          consumedAt: redemption.consumedAt,
          releasedAt: redemption.releasedAt,
        },
        couponActiveUsageCount: coupon.activeUsageCount,
        events,
      };
    }

    async function assertAcceptedSideEffects(f: Fixture, paymentId: string) {
      const client = requirePrisma(prisma);
      const [order, payment, user, product, redemption, coupon, events] =
        await Promise.all([
          client.order.findUniqueOrThrow({ where: { id: f.orderId } }),
          client.payment.findUniqueOrThrow({ where: { id: paymentId } }),
          client.user.findUniqueOrThrow({ where: { id: f.userId } }),
          client.product.findUniqueOrThrow({ where: { id: f.productId } }),
          client.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          }),
          client.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
          client.paymentGatewayEvent.findMany({
            where: { paymentId },
            orderBy: { createdAt: 'asc' },
          }),
        ]);
      expect(order.status).toBe('PAID');
      expect(order.pointsEarned).toBe(9);
      expect(payment.status).toBe('SUCCESS');
      expect(payment.verifiedPaidAt).not.toBeNull();
      expect(user.loyaltyPoints).toBe(9);
      expect(product.stock).toBe(8);
      expect(redemption.status).toBe('CONSUMED');
      expect(coupon.activeUsageCount).toBe(1);
      expect(
        events.filter((event) => event.disposition === 'FINALIZED'),
      ).toHaveLength(1);
      expect(
        await client.payment.count({
          where: { orderId: f.orderId, status: 'SUCCESS' },
        }),
      ).toBe(1);
    }

    it('deduplicates the same event sequentially without repeating writes', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const evidence = await outcome(f, payment);

      const first = await finalize(payment, evidence);
      const replay = await finalize(payment, evidence);

      expect(first.disposition).toBe('FINALIZED');
      expect(replay.disposition).toBe('DUPLICATE');
      expect(
        await requirePrisma(prisma).payment.count({
          where: { orderId: f.orderId },
        }),
      ).toBe(1);
      expect(
        await requirePrisma(prisma).paymentGatewayEvent.count({
          where: { paymentId: payment.id },
        }),
      ).toBe(1);
      await assertAcceptedSideEffects(f, payment.id);
    });

    it('deduplicates the same event concurrently after observing a PostgreSQL Order lock wait', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const evidence = await outcome(f, payment);
      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, evidence),
        finalizationWork(payment, evidence),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult.disposition).toBe('DUPLICATE');
      expect(
        await requirePrisma(prisma).paymentGatewayEvent.count({
          where: { paymentId: payment.id },
        }),
      ).toBe(1);
      await assertAcceptedSideEffects(f, payment.id);
    }, 30_000);

    it('serializes IPN and QueryDR SUCCESS as separate valid evidence with one accepted success', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const ipn = await outcome(f, payment, { source: 'IPN' });
      const query = await outcome(f, payment, { source: 'QUERYDR' });
      expect(query.eventIdentity).not.toBe(ipn.eventIdentity);
      expect(query.queryRequestId).toBeTruthy();

      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, ipn),
        finalizationWork(payment, query),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult.disposition).toBe('DUPLICATE');
      const events = await requirePrisma(prisma).paymentGatewayEvent.findMany({
        where: { paymentId: payment.id },
        orderBy: { source: 'asc' },
      });
      expect(events).toHaveLength(2);
      expect(events.map((event) => [event.source, event.disposition])).toEqual([
        ['IPN', 'FINALIZED'],
        ['QUERYDR', 'DUPLICATE'],
      ]);
      expect(events.every((event) => event.outcome === 'SUCCESS')).toBe(true);
      expect(events.every((event) => event.evidence)).toBe(true);
      await assertAcceptedSideEffects(f, payment.id);
    }, 30_000);

    it('records two distinct SUCCESS events but accepts only one and runs effects once', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const first = await outcome(f, payment, { source: 'IPN' });
      const second = await outcome(f, payment, { source: 'IPN' });
      expect(second.eventIdentity).not.toBe(first.eventIdentity);

      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, first),
        finalizationWork(payment, second),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult.disposition).toBe('DUPLICATE');
      const events = await requirePrisma(prisma).paymentGatewayEvent.findMany({
        where: { paymentId: payment.id },
      });
      expect(events).toHaveLength(2);
      expect(
        events.filter((event) => event.disposition === 'FINALIZED'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.disposition === 'DUPLICATE'),
      ).toHaveLength(1);
      await assertAcceptedSideEffects(f, payment.id);
    }, 30_000);

    it('preserves SUCCESS when FAILED arrives second and records review evidence', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const success = await outcome(f, payment, { outcome: 'SUCCESS' });
      const failed = await outcome(f, payment, { outcome: 'FAILED' });

      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, success),
        finalizationWork(payment, failed),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult.disposition).toBe('CONFLICT');
      const row = await requirePrisma(prisma).payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(row.status).toBe('SUCCESS');
      expect(row.reconciliationState).toBe('REQUIRES_REVIEW');
      expect(row.reviewReason).toBeTruthy();
      expect(
        await requirePrisma(prisma).order.count({
          where: { id: f.orderId, status: 'PAID' },
        }),
      ).toBe(1);
      await assertAcceptedSideEffects(f, payment.id);
    }, 30_000);

    it('preserves terminal FAILED when SUCCESS arrives second; FAILED does not lose by default', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const failed = await outcome(f, payment, { outcome: 'FAILED' });
      const success = await outcome(f, payment, { outcome: 'SUCCESS' });

      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, failed),
        finalizationWork(payment, success),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult.disposition).toBe('FINANCIAL_EXCEPTION');
      const client = requirePrisma(prisma);
      const [row, order, user, product, redemption, coupon, events] =
        await Promise.all([
          client.payment.findUniqueOrThrow({ where: { id: payment.id } }),
          client.order.findUniqueOrThrow({ where: { id: f.orderId } }),
          client.user.findUniqueOrThrow({ where: { id: f.userId } }),
          client.product.findUniqueOrThrow({ where: { id: f.productId } }),
          client.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          }),
          client.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
          client.paymentGatewayEvent.findMany({
            where: { paymentId: payment.id },
          }),
        ]);
      expect(row.status).toBe('FAILED');
      expect(row.hasFinancialException).toBe(true);
      expect(row.reconciliationState).toBe('REQUIRES_REVIEW');
      expect(row.verifiedPaidAt).toBeNull();
      expect(order.status).toBe('PAYMENT_FAILED');
      expect(order.pointsEarned).toBe(0);
      expect(user.loyaltyPoints).toBe(0);
      expect(product.stock).toBe(8);
      expect(redemption.status).toBe('HELD');
      expect(coupon.activeUsageCount).toBe(1);
      expect(events.map((event) => event.disposition).sort()).toEqual([
        'FINALIZED',
        'FINANCIAL_EXCEPTION',
      ]);
    }, 30_000);

    it('records a second payment SUCCESS as a financial exception without violating the one-success index', async () => {
      const f = await fixture({ coupon: true });
      const acceptedPayment = await addPendingVnpay(f);
      const accepted = await finalize(
        acceptedPayment,
        await outcome(f, acceptedPayment),
      );
      expect(accepted.disposition).toBe('FINALIZED');

      // The first VNPay attempt is terminal now, so the fixture adds exactly one
      // pending attempt; it never creates two VNPay PENDING rows for this Order.
      const secondPayment = await addPendingVnpay(f);
      expect(
        await requirePrisma(prisma).payment.count({
          where: { orderId: f.orderId, provider: 'VNPAY', status: 'PENDING' },
        }),
      ).toBe(1);
      const second = await finalize(
        secondPayment,
        await outcome(f, secondPayment),
      );

      expect(second.disposition).toBe('FINANCIAL_EXCEPTION');
      expect(
        await requirePrisma(prisma).payment.count({
          where: { orderId: f.orderId, status: 'SUCCESS' },
        }),
      ).toBe(1);
      const exceptionPayment = await requirePrisma(
        prisma,
      ).payment.findUniqueOrThrow({
        where: { id: secondPayment.id },
      });
      expect(exceptionPayment.status).toBe('PENDING');
      expect(exceptionPayment.hasFinancialException).toBe(true);
      expect(exceptionPayment.reconciliationState).toBe('REQUIRES_REVIEW');
      await assertAcceptedSideEffects(f, acceptedPayment.id);
      expect(
        await requirePrisma(prisma).paymentGatewayEvent.count({
          where: {
            paymentId: secondPayment.id,
            disposition: 'FINANCIAL_EXCEPTION',
          },
        }),
      ).toBe(1);
    });

    it('keeps a cancelled Order cancelled when SUCCESS arrives and replay does not release resources again', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const expiresAt = await setExpiryFromDatabase(f, -6 * 60_000);
      const cancelled = await requirePrisma(prisma).$transaction((tx) =>
        expireOrderInTransaction(tx, f.orderId),
      );
      expect(cancelled).toBe('CANCELLED');

      const evidence = await outcome(f, payment, { gatewayPaidAt: expiresAt });
      const first = await finalize(payment, evidence);
      const replay = await finalize(payment, evidence);
      expect(first.disposition).toBe('FINANCIAL_EXCEPTION');
      expect(replay.disposition).toBe('DUPLICATE');

      const client = requirePrisma(prisma);
      const [order, row, user, product, redemption, coupon, events] =
        await Promise.all([
          client.order.findUniqueOrThrow({ where: { id: f.orderId } }),
          client.payment.findUniqueOrThrow({ where: { id: payment.id } }),
          client.user.findUniqueOrThrow({ where: { id: f.userId } }),
          client.product.findUniqueOrThrow({ where: { id: f.productId } }),
          client.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          }),
          client.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
          client.paymentGatewayEvent.findMany({
            where: { paymentId: payment.id },
          }),
        ]);
      expect(order.status).toBe('CANCELLED');
      expect(row.status).toBe('PENDING');
      expect(row.hasFinancialException).toBe(true);
      expect(row.reconciliationState).toBe('REQUIRES_REVIEW');
      expect(row.reviewReason).toBe('ORDER_CANCELLED');
      expect(user.loyaltyPoints).toBe(0);
      expect(product.stock).toBe(10);
      expect(redemption.status).toBe('RELEASED');
      expect(coupon.activeUsageCount).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0].disposition).toBe('FINANCIAL_EXCEPTION');
      expect(events[0].exceptionReason).toBe('ORDER_CANCELLED');
    });

    it('lets timely SUCCESS win the Order lock in Grace and expiration observes PAID without releasing twice', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const expiresAt = await setExpiryFromDatabase(f, -60_000);
      const [clock] = await requirePrisma(prisma).$queryRaw<
        { now: Date; beforeGraceEnd: boolean }[]
      >`
        SELECT clock_timestamp() AS now,
               clock_timestamp() < ${expiresAt}::timestamptz + INTERVAL '5 minutes' AS "beforeGraceEnd"`;
      expect(clock.beforeGraceEnd).toBe(true);
      const success = await outcome(f, payment, { gatewayPaidAt: expiresAt });

      const race = await contendInOrder(
        f.orderId,
        finalizationWork(payment, success),
        (tx) => expireOrderInTransaction(tx, f.orderId),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult.disposition).toBe('FINALIZED');
      expect(race.secondResult).toBe('PAID');
      await assertAcceptedSideEffects(f, payment.id);
    }, 30_000);

    it('lets expiration win after Grace and records waiting SUCCESS as an exception', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const expiresAt = await setExpiryFromDatabase(f, -6 * 60_000);
      const [clock] = await requirePrisma(prisma).$queryRaw<
        { now: Date; graceEnded: boolean }[]
      >`
        SELECT clock_timestamp() AS now,
               clock_timestamp() >= ${expiresAt}::timestamptz + INTERVAL '5 minutes' AS "graceEnded"`;
      expect(clock.graceEnded).toBe(true);
      const success = await outcome(f, payment, { gatewayPaidAt: expiresAt });

      const race = await contendInOrder(
        f.orderId,
        (tx) => expireOrderInTransaction(tx, f.orderId),
        finalizationWork(payment, success),
      );

      expect(race.lockWait.waitEventType).toBe('Lock');
      expect(race.firstResult).toBe('CANCELLED');
      expect(race.secondResult.disposition).toBe('FINANCIAL_EXCEPTION');
      const order = await requirePrisma(prisma).order.findUniqueOrThrow({
        where: { id: f.orderId },
      });
      const row = await requirePrisma(prisma).payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(order.status).toBe('CANCELLED');
      expect(row.status).toBe('PENDING');
      expect(row.hasFinancialException).toBe(true);
      expect(row.reconciliationState).toBe('REQUIRES_REVIEW');
      expect(
        await requirePrisma(prisma)
          .product.findUniqueOrThrow({ where: { id: f.productId } })
          .then((p) => p.stock),
      ).toBe(10);
      expect(
        await requirePrisma(prisma)
          .couponRedemption.findUniqueOrThrow({ where: { orderId: f.orderId } })
          .then((r) => r.status),
      ).toBe('RELEASED');
      expect(
        await requirePrisma(prisma)
          .user.findUniqueOrThrow({ where: { id: f.userId } })
          .then((u) => u.loyaltyPoints),
      ).toBe(0);
    }, 30_000);

    it('accepts paidAt exactly at expiresAt when DB clock is still inside Grace', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const expiresAt = await setExpiryFromDatabase(f, -30_000);
      const [clock] = await requirePrisma(prisma).$queryRaw<
        { now: Date; beforeGraceEnd: boolean; exactExpiry: boolean }[]
      >`
        SELECT clock_timestamp() AS now,
               clock_timestamp() < ${expiresAt}::timestamptz + INTERVAL '5 minutes' AS "beforeGraceEnd",
               ${expiresAt}::timestamptz = expires_at AS "exactExpiry"
        FROM orders WHERE id = ${f.orderId}::uuid`;
      expect(clock.beforeGraceEnd).toBe(true);
      expect(clock.exactExpiry).toBe(true);
      const evidence = await outcome(f, payment, { gatewayPaidAt: expiresAt });

      const result = await finalize(payment, evidence);

      expect(result.disposition).toBe('FINALIZED');
      expect(result.orderStatus).toBe('PAID');
      const row = await requirePrisma(prisma).payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(row.verifiedPaidAt?.getTime()).toBe(expiresAt.getTime());
      await assertAcceptedSideEffects(f, payment.id);
    });

    it('does not accept PAID at or after Grace even when verified paidAt equals expiresAt', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const expiresAt = await setExpiryFromDatabase(f, -6 * 60_000);
      const [clock] = await requirePrisma(prisma).$queryRaw<
        { graceEnded: boolean }[]
      >`
        SELECT clock_timestamp() >= ${expiresAt}::timestamptz + INTERVAL '5 minutes' AS "graceEnded"`;
      expect(clock.graceEnded).toBe(true);
      const evidence = await outcome(f, payment, { gatewayPaidAt: expiresAt });

      const result = await finalize(payment, evidence);

      expect(result.disposition).toBe('FINANCIAL_EXCEPTION');
      expect(result.paymentStatus).toBe('PENDING');
      expect(result.orderStatus).toBe('CANCELLED');
      const client = requirePrisma(prisma);
      const [order, row, event, product, redemption, coupon, user] =
        await Promise.all([
          client.order.findUniqueOrThrow({ where: { id: f.orderId } }),
          client.payment.findUniqueOrThrow({ where: { id: payment.id } }),
          client.paymentGatewayEvent.findFirstOrThrow({
            where: { paymentId: payment.id },
          }),
          client.product.findUniqueOrThrow({ where: { id: f.productId } }),
          client.couponRedemption.findUniqueOrThrow({
            where: { orderId: f.orderId },
          }),
          client.coupon.findUniqueOrThrow({ where: { id: f.couponId } }),
          client.user.findUniqueOrThrow({ where: { id: f.userId } }),
        ]);
      expect(order.status).toBe('CANCELLED');
      expect(row.status).toBe('PENDING');
      expect(row.verifiedPaidAt).toBeNull();
      expect(row.hasFinancialException).toBe(true);
      expect(row.reviewReason).toBe('GRACE_ENDED');
      expect(event.disposition).toBe('FINANCIAL_EXCEPTION');
      expect(event.exceptionReason).toBe('GRACE_ENDED');
      expect(product.stock).toBe(10);
      expect(redemption.status).toBe('RELEASED');
      expect(coupon.activeUsageCount).toBe(0);
      expect(user.loyaltyPoints).toBe(0);
    });

    it('rolls back coupon changes after a real user-row lock timeout, then retry applies effects once', async () => {
      const f = await fixture({ coupon: true });
      const payment = await addPendingVnpay(f);
      const evidence = await outcome(f, payment);
      const baseline = await persistedState(f, payment.id);
      expect(baseline).toMatchObject({
        order: { status: 'PENDING', pointsEarned: 0 },
        payment: {
          status: 'PENDING',
          finalOutcomeSnapshot: null,
          verifiedPaidAt: null,
        },
        userPoints: 0,
        productStock: 8,
        redemption: { status: 'HELD' },
        couponActiveUsageCount: 1,
        events: [],
      });
      const lockReady = deferred<void>();
      const releaseGate = deferred<void>();
      const blocker = requirePrisma(prisma)
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT id FROM users WHERE id = ${f.userId}::uuid FOR UPDATE`;
            lockReady.resolve(undefined);
            await releaseGate.promise;
          },
          { maxWait: 5_000, timeout: 20_000 },
        )
        .catch((error: unknown) => {
          lockReady.reject(error);
          throw error;
        });
      void blocker.catch(() => undefined);
      let attempt:
        | { backendPid: Promise<number>; result: Promise<FinalizationResult> }
        | undefined;

      try {
        await lockReady.promise;
        attempt = startTransaction(finalizationWork(payment, evidence), {
          lockTimeout: '1200ms',
        });
        const backendPid = await attempt.backendPid;
        const lockWait = await waitForLockWait(backendPid);
        expect(lockWait.waitEventType).toBe('Lock');
        expect(lockWait.query?.toLowerCase()).toContain('users');
        await expect(attempt.result).rejects.toBeDefined();

        expect(await persistedState(f, payment.id)).toEqual(baseline);
      } finally {
        releaseGate.resolve(undefined);
        await Promise.allSettled([
          blocker,
          ...(attempt ? [attempt.result] : []),
        ]);
      }

      const retry = await finalize(payment, evidence);
      expect(retry.disposition).toBe('FINALIZED');
      expect(
        await requirePrisma(prisma).paymentGatewayEvent.count({
          where: { paymentId: payment.id },
        }),
      ).toBe(1);
      await assertAcceptedSideEffects(f, payment.id);
      expect(observedLockWaits).toBeGreaterThanOrEqual(6);
    }, 30_000);
  },
);
