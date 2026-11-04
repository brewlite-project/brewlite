import 'reflect-metadata';
import {
  InternalServerErrorException,
  type INestApplication,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PaymentProcessor } from '../src/payments/payment-processor.js';
import { VnpayInitiationService } from '../src/payments/vnpay-initiation.service.js';
const userId = '550e8400-e29b-41d4-a716-446655440000';
const orderId = '550e8400-e29b-41d4-a716-446655440010';
const body = {
  orderId,
  method: 'CARD',
  paymentDetails: { cardNumber: '1234567890121234' },
};
const snapshot = {
  paymentId: '550e8400-e29b-41d4-a716-446655440020',
  orderId,
  paymentStatus: 'SUCCESS',
  orderStatus: 'PAID',
  amountVnd: 98000,
  method: 'CARD',
  methodLast4: '1234',
  mockReference: 'MOCK-test',
  pointsEarned: 9,
  failureReason: null,
  createdAt: '2026-10-25T02:00:00.000Z',
};
describe('Payments HTTP/JWT/Swagger with processor double', () => {
  let app: INestApplication<App>;
  let token: string;
  const execute = vi.fn();
  const initiate = vi.fn();
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    initiate.mockReset();
    execute
      .mockReset()
      .mockResolvedValue({ response: snapshot, replayed: false });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(PaymentProcessor)
      .useValue({ execute })
      .overrideProvider(VnpayInitiationService)
      .useValue({ initiate })
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    token = await module.get(JwtService).signAsync({ sub: userId });
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  function post(value: object = body, key = 'payment-key-001') {
    return request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(value);
  }
  it('registers the route in AppModule and uses verified identity and whitelisted request', async () => {
    await post({ ...body, userId: 'attacker', amount: 1, status: 'SUCCESS' })
      .expect(200)
      .expect('Idempotency-Replayed', 'false')
      .expect(snapshot);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      userId,
      'payment-key-001',
      body,
    );
  });
  it('sets replay header from processor', async () => {
    execute.mockResolvedValue({ response: snapshot, replayed: true });
    await post()
      .expect(200)
      .expect('Idempotency-Replayed', 'true')
      .expect(snapshot);
  });
  it('returns mock decline as HTTP 200', async () => {
    const failed = {
      ...snapshot,
      paymentStatus: 'FAILED',
      orderStatus: 'PAYMENT_FAILED',
      pointsEarned: 0,
      failureReason: 'PAYMENT_DECLINED',
    };
    execute.mockResolvedValue({ response: failed, replayed: false });
    await post().expect(200).expect(failed);
  });
  it.each([
    ['test', undefined],
    ['development', 'false'],
    ['test', 'TRUE'],
    ['production', 'true'],
    ['production', 'false'],
  ])(
    'rejects Mock before processing in %s with flag %s',
    async (environment, flag) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('MOCK_PAYMENT_ENABLED', flag);
      // Even a saved receipt must not be exposed while Mock is disabled.
      execute.mockResolvedValue({ response: snapshot, replayed: true });
      const response = await post().expect(403);
      expect(response.body).toEqual({
        statusCode: 403,
        message: 'Mock payment is disabled in this environment',
        error: 'Forbidden',
        code: 'MOCK_PAYMENT_DISABLED',
      });
      expect(response.headers['idempotency-replayed']).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('checks the policy before body/key validation and ignores client opt-in', async () => {
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'false');
    await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .set('MOCK_PAYMENT_ENABLED', 'true')
      .send({ MOCK_PAYMENT_ENABLED: true })
      .expect(403)
      .expect((response) =>
        expect(response.body.code).toBe('MOCK_PAYMENT_DISABLED'),
      );
    expect(execute).not.toHaveBeenCalled();
  });
  it('still authenticates requests while Mock is disabled', async () => {
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'false');
    await request(app.getHttpServer()).post('/payments').send(body).expect(401);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not apply the Mock gate to VNPay initiation', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MOCK_PAYMENT_ENABLED', 'true');
    const response = { provider: 'VNPAY', paymentStatus: 'PENDING', orderId };
    initiate.mockResolvedValue({ response, created: true, replayed: false });
    await request(app.getHttpServer())
      .post('/payments/vnpay/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'vnpay-policy-key')
      .send({ orderId })
      .expect(201)
      .expect(response);
    expect(initiate).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not fall back to Mock when VNPay initiation fails', async () => {
    initiate.mockRejectedValue(new InternalServerErrorException());
    await request(app.getHttpServer())
      .post('/payments/vnpay/initiate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'vnpay-policy-key')
      .send({ orderId })
      .expect(500);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer invalid'])(
    'rejects invalid authentication',
    async (auth) => {
      const call = request(app.getHttpServer()).post('/payments').send(body);
      if (auth) call.set('Authorization', auth);
      const r = await call.expect(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    [],
    {},
    { ...body, paymentDetails: { cardNumber: 'bad' } },
    { ...body, method: 'WALLET' },
  ])('rejects bad HTTP bodies', async (value) => {
    const r = await post(value).expect(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(execute).not.toHaveBeenCalled();
  });
  it('requires the key header', async () => {
    const r = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['1234567', 'x'.repeat(65)])(
    'rejects invalid key lengths',
    async (key) => {
      await post(body, key).expect(400);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('documents authentication, key, DTOs, replay header and all statuses', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const op = doc.paths['/payments'].post!;
    expect(op.security).toEqual([{ bearer: [] }]);
    expect(op.parameters).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
      }),
    );
    expect(Object.keys(op.responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '500',
    ]);
    expect(op.responses['200']).toHaveProperty('headers.Idempotency-Replayed');
    expect(op.responses['403']).toMatchObject({
      description: 'MOCK_PAYMENT_DISABLED',
    });
    for (const schema of [
      'PaymentResponseDto',
      'CardPaymentDetailsDto',
      'WalletPaymentDetailsDto',
    ])
      expect(doc.components?.schemas?.[schema]).toBeDefined();
  });
});
