import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { OrderStatus } from '../src/generated/prisma/enums.js';
import { OrderStateService } from '../src/orders/order-state.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Internal order advance PostgreSQL transactions', () => {
  let app: INestApplication<App> | undefined;
  let prisma: PrismaService | undefined;
  const userId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const couponId = randomUUID();
  const key = 'internal-order-integration-test-only';

  beforeAll(async () => {
    const url = process.env.ORDERS_TEST_DATABASE_URL;
    if (!url)
      throw new Error(
        'Set ORDERS_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.',
      );
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('INTERNAL_SECRET', key);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    prisma = module.get<PrismaService>(PrismaService);
    app = module.createNestApplication({ logger: false });
    await app.init();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@advance.test`,
        passwordHash: 'test-only-unused',
        loyaltyPoints: 9,
      },
    });
    await prisma.category.create({
      data: { id: categoryId, code: categoryId, name: 'Advance test' },
    });
    await prisma.product.create({
      data: {
        id: productId,
        categoryId,
        name: 'Advance test',
        imageUrl: '/test',
        basePriceVnd: 100000n,
        stock: 3,
      },
    });
    await prisma.coupon.create({
      data: {
        id: couponId,
        code: couponId.replaceAll('-', '').slice(0, 20),
        type: 'FIXED',
        value: 10000,
        startsAt: new Date(0),
        expiresAt: new Date('2099-01-01'),
        usageLimit: 100,
        activeUsageCount: 1,
      },
    });
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.payment.deleteMany({ where: { userId } });
        await prisma.couponRedemption.deleteMany({ where: { userId } });
        await prisma.orderItem.deleteMany({ where: { order: { userId } } });
        await prisma.order.deleteMany({ where: { userId } });
        await prisma.product.deleteMany({ where: { id: productId } });
        await prisma.category.deleteMany({ where: { id: categoryId } });
        await prisma.coupon.deleteMany({ where: { id: couponId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
    }
  });

  async function createOrder(status: OrderStatus = 'PAID') {
    return prisma!.order.create({
      data: {
        userId,
        status,
        subtotalVnd: 100000n,
        discountVnd: 10000n,
        totalVnd: 90000n,
        pointsEarned: 9,
        couponId,
        couponCodeSnapshot: 'TEST',
        paidAt: new Date(),
        // Expiry applies to unpaid orders only; paid fulfillment must still work.
        expiresAt: new Date(0),
        items: {
          create: {
            productId,
            productNameSnapshot: 'Advance test',
            size: 'M',
            sizePercentSnapshot: 120,
            basePriceSnapshotVnd: 83333n,
            unitPriceVnd: 100000n,
            quantity: 1,
            lineTotalVnd: 100000n,
          },
        },
        couponRedemption: {
          create: {
            userId,
            couponId,
            status: 'CONSUMED',
            consumedAt: new Date(),
          },
        },
      },
    });
  }

  const advance = (id: string, from: OrderStatus) =>
    request(app!.getHttpServer())
      .post(`/internal/orders/${id}/advance`)
      .set('X-Internal-Key', key)
      .send({ from });

  async function snapshot(id: string) {
    return {
      order: await prisma!.order.findUniqueOrThrow({
        where: { id },
        include: { items: true, couponRedemption: true, payments: true },
      }),
      product: await prisma!.product.findUniqueOrThrow({
        where: { id: productId },
      }),
      coupon: await prisma!.coupon.findUniqueOrThrow({
        where: { id: couponId },
      }),
      user: await prisma!.user.findUniqueOrThrow({ where: { id: userId } }),
    };
  }

  it('persists the full fulfillment flow and preserves inventory, coupon, loyalty and snapshots', async () => {
    const order = await createOrder();
    const before = await snapshot(order.id);
    for (const [from, status] of [
      ['PAID', 'PREPARING'],
      ['PREPARING', 'READY'],
      ['READY', 'COMPLETED'],
    ] as const) {
      const response = await advance(order.id, from).expect(200);
      expect(response.body).toEqual({
        id: order.id,
        previousStatus: from,
        status,
      });
    }
    const after = await snapshot(order.id);
    expect(after).toEqual({
      ...before,
      order: {
        ...before.order,
        status: 'COMPLETED',
        updatedAt: expect.any(Date),
      },
    });
    await advance(order.id, 'COMPLETED').expect(409);
    expect(await snapshot(order.id)).toEqual(after);
  });

  it.each(['PAID', 'PREPARING', 'READY'] as const)(
    'allows exactly one concurrent request from %s',
    async (from) => {
      const order = await createOrder(from);
      const responses = await Promise.all([
        advance(order.id, from),
        advance(order.id, from),
      ]);
      expect(
        responses.map((response) => response.status).sort((a, b) => a - b),
      ).toEqual([200, 409]);
      expect(
        responses.find((response) => response.status === 409)!.body.code,
      ).toBe('INVALID_TRANSITION');
      const expected = {
        PAID: 'PREPARING',
        PREPARING: 'READY',
        READY: 'COMPLETED',
      }[from];
      expect(
        (await prisma!.order.findUniqueOrThrow({ where: { id: order.id } }))
          .status,
      ).toBe(expected);
    },
  );

  it('rechecks a state committed by a competing transaction after acquiring the lock', async () => {
    const order = await createOrder();
    let started!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = prisma!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      started();
      await released;
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'PREPARING' },
      });
    });
    // Surface writer failures immediately instead of leaving the barrier pending.
    await Promise.race([locked, writer]);
    const response = advance(order.id, 'PAID').then((result) => result);
    try {
      // Observe the actual PostgreSQL lock wait before allowing the writer to commit.
      await expect
        .poll(
          async () => {
            const [activity] = await prisma!.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%SELECT id FROM orders%'
          ) AS waiting`;
            return activity.waiting;
          },
          { timeout: 1000, interval: 10 },
        )
        .toBe(true);
    } finally {
      release();
      await writer;
      await response;
    }
    expect((await response).status).toBe(409);
    expect(
      (await prisma!.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('PREPARING');
  });

  it('rolls back a real update when the transaction fails before commit', async () => {
    const order = await createOrder();
    const before = await snapshot(order.id);
    const failingPrisma = {
      $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma!.$transaction(async (tx) => {
          await run(tx);
          throw new Error('Injected failure after update');
        }),
    } as unknown as PrismaService;
    await expect(
      new OrderStateService(failingPrisma).advance(order.id, 'PAID'),
    ).rejects.toMatchObject({
      response: { statusCode: 500, code: 'INTERNAL_ERROR' },
    });
    expect(await snapshot(order.id)).toEqual(before);
    await advance(order.id, 'PAID').expect(200);
  });
});
