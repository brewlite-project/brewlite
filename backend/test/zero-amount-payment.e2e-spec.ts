import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ZeroAmountPaymentService } from '../src/payments/zero-amount-payment.service.js';

const userId = 'abcdef00-0000-4000-8000-000000000001';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const response = {
  paymentId: '550e8400-e29b-41d4-a716-446655440020',
  orderId,
  provider: 'ZERO_AMOUNT',
  paymentStatus: 'SUCCESS',
  orderStatus: 'PAID',
  amountVnd: 0,
  pointsEarned: 0,
  createdAt: '2026-11-03T00:00:00.000Z',
};

describe('ZERO_AMOUNT HTTP/JWT/Swagger', () => {
  let app: INestApplication<App>;
  let token: string;
  const execute = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(ZeroAmountPaymentService)
      .useValue({ execute })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    token = module.get(JwtService).sign({ sub: userId });
  });
  beforeEach(() =>
    execute.mockReset().mockResolvedValue({ response, replayed: false }),
  );
  afterAll(async () => {
    await app?.close();
  });
  const post = (body: unknown = { orderId }) =>
    request(app.getHttpServer())
      .post('/payments/zero-amount')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', 'zero-key-001')
      .send(body as object);

  it('returns 201 without a redirect and passes verified identity with only accepted fields', async () => {
    const result = await post({
      orderId: orderId.toUpperCase(),
      userId: 'attacker',
      amountVnd: 0,
      provider: 'MOCK',
    })
      .expect(201)
      .expect('Idempotency-Replayed', 'false')
      .expect(response);
    expect(result.headers.location).toBeUndefined();
    expect(result.body).not.toHaveProperty('paymentUrl');
    expect(execute).toHaveBeenCalledExactlyOnceWith(userId, 'zero-key-001', {
      orderId,
    });
  });
  it('returns 200 and the immutable response for replay', async () => {
    execute.mockResolvedValue({ response, replayed: true });
    await post()
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(response);
  });
  it.each([undefined, 'Bearer invalid'])(
    'rejects missing/invalid JWT (%s)',
    async (auth) => {
      const call = request(app.getHttpServer())
        .post('/payments/zero-amount')
        .send({ orderId });
      if (auth) call.set('Authorization', auth);
      const result = await call.expect(401);
      expect(result.body.code).toBe('UNAUTHORIZED');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each([[], {}, { orderId: 0 }, { orderId: 'invalid' }])(
    'rejects malformed request bodies (%j)',
    async (body) => {
      const result = await post(body).expect(400);
      expect(result.body.code).toBe('VALIDATION_ERROR');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('documents request, fixed zero response, JWT, replay header and all HTTP statuses', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const operation = document.paths['/payments/zero-amount'].post!;
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
      }),
    );
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '201',
      '400',
      '401',
      '404',
      '409',
      '500',
    ]);
    for (const status of ['200', '201'])
      expect(operation.responses[status]).toHaveProperty(
        'headers.Idempotency-Replayed',
      );
    expect(document.components?.schemas?.ZeroAmountPaymentDto).toMatchObject({
      required: ['orderId'],
      properties: { orderId: { type: 'string', format: 'uuid' } },
    });
    expect(
      document.components?.schemas?.ZeroAmountPaymentResponseDto,
    ).toMatchObject({
      properties: {
        provider: { enum: ['ZERO_AMOUNT'] },
        paymentStatus: { enum: ['SUCCESS'] },
        orderStatus: { enum: ['PAID'] },
        amountVnd: { enum: [0] },
        pointsEarned: { enum: [0] },
      },
    });
  });
});
