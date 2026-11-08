import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { OrderStatus } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const id = '550e8400-e29b-41d4-a716-446655440010';
const key = 'internal-orders-test-only-key';
const transitions: Partial<Record<OrderStatus, OrderStatus>> = {
  PAID: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COMPLETED',
};

describe('POST /internal/orders/:id/advance', () => {
  let app: INestApplication<App>;
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    order: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  };
  const prisma = { $transaction: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('INTERNAL_SECRET', key);
    tx.$queryRaw.mockResolvedValue([{ id }]);
    tx.order.findUniqueOrThrow.mockResolvedValue({ id, status: 'PAID' });
    prisma.$transaction.mockImplementation(
      (run: (client: typeof tx) => unknown) => run(tx),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const post = (body: object = { from: 'PAID' }, orderId = id) =>
    request(app.getHttpServer())
      .post(`/internal/orders/${orderId}/advance`)
      .set('X-Internal-Key', key)
      .send(body);

  it.each([undefined, '', 'wrong', 'x'.repeat(key.length)])(
    'rejects key %s before validation or database access',
    async (supplied) => {
      const req = request(app.getHttpServer()).post(
        '/internal/orders/invalid/advance',
      );
      if (supplied !== undefined) req.set('X-Internal-Key', supplied);
      const { body } = await req.send({ from: 'INVALID' }).expect(403);
      expect(body.code).toBe('FORBIDDEN');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('does not accept a customer JWT as internal authorization', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const token = new JwtService({ secret: process.env.JWT_SECRET }).sign({
      sub: id,
    });
    await request(app.getHttpServer())
      .post(`/internal/orders/${id}/advance`)
      .auth(token, { type: 'bearer' })
      .send({ from: 'PAID' })
      .expect(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])(
    'fails closed when server secret is %s',
    async (secret) => {
      vi.stubEnv('INTERNAL_SECRET', secret);
      await post().expect(403);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { from: null },
    { from: 'paid' },
    { from: 'UNKNOWN' },
    { from: 1 },
    { from: ['PAID'] },
    [],
  ])('rejects invalid body %j without querying', async (body) => {
    const response = await post(body).expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid UUID without querying', async () => {
    const { body } = await post({ from: 'PAID' }, 'invalid').expect(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  for (const current of Object.values(OrderStatus)) {
    it.each(Object.values(OrderStatus))(
      `validates ${current} with expected from=%s`,
      async (from) => {
        tx.order.findUniqueOrThrow.mockResolvedValue({ id, status: current });
        const next = transitions[current];
        const accepted = current === from && next !== undefined;
        const { body } = await post({ from }).expect(accepted ? 200 : 409);
        if (accepted) {
          expect(body).toEqual({ id, previousStatus: current, status: next });
          expect(tx.order.update).toHaveBeenCalledExactlyOnceWith({
            where: { id },
            data: { status: next },
          });
        } else {
          expect(body.code).toBe('INVALID_TRANSITION');
          expect(tx.order.update).not.toHaveBeenCalled();
        }
      },
    );
  }

  it('ignores client-selected target and identity fields', async () => {
    const { body } = await post({
      from: 'PAID',
      to: 'COMPLETED',
      status: 'COMPLETED',
      userId: id,
    }).expect(200);
    expect(body).toEqual({ id, previousStatus: 'PAID', status: 'PREPARING' });
  });

  it('returns 404 for a missing Order', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const { body } = await post().expect(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('rechecks the state after the lock before updating', async () => {
    tx.$queryRaw.mockImplementation(async () => {
      tx.order.findUniqueOrThrow.mockResolvedValue({ id, status: 'PREPARING' });
      return [{ id }];
    });
    const { body } = await post().expect(409);
    expect(body.code).toBe('INVALID_TRANSITION');
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it.each(['lock', 'read', 'update', 'commit'])(
    'masks unexpected %s errors',
    async (stage) => {
      const error = new Error('private SQL and connection information');
      if (stage === 'lock') tx.$queryRaw.mockRejectedValue(error);
      if (stage === 'read') tx.order.findUniqueOrThrow.mockRejectedValue(error);
      if (stage === 'update') tx.order.update.mockRejectedValue(error);
      if (stage === 'commit') prisma.$transaction.mockRejectedValue(error);
      const { body } = await post().expect(500);
      expect(body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    },
  );

  it('documents the API key, DTOs, and all contract status codes', () => {
    const config = new DocumentBuilder()
      .addBearerAuth()
      .addApiKey(
        { type: 'apiKey', in: 'header', name: 'X-Internal-Key' },
        'internal-key',
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    const operation = document.paths['/internal/orders/{id}/advance'].post!;
    expect(operation.security).toEqual([{ 'internal-key': [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '400',
      '403',
      '404',
      '409',
      '500',
    ]);
    expect(document.components?.schemas?.AdvanceOrderDto).toMatchObject({
      required: ['from'],
    });
    expect(document.components?.schemas?.AdvanceOrderResponseDto).toMatchObject(
      { required: ['id', 'previousStatus', 'status'] },
    );
    expect(JSON.stringify(document)).not.toContain(key);
  });
});
