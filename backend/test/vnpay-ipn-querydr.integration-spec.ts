import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { canonicalizeIpn } from '../src/payments/vnpay-gateway.protocol.js';
import { VnpayQueryDrService } from '../src/payments/vnpay-querydr.service.js';
import { formatVnpayDate } from '../src/payments/vnpay-url.builder.js';
import { expireOrderInTransaction } from '../src/orders/inventory-policy.js';

const secret = 'scrum81-integration-secret';
const run = randomUUID();
const users: string[] = [];
let app: INestApplication<App>;
let db: PrismaService;
let jwt: JwtService;

function signedIpn(values: Record<string, string>) {
  const canonical = canonicalizeIpn(new Map(Object.entries(values)));
  return `${canonical}&vnp_SecureHash=${createHmac('sha512', secret).update(canonical).digest('hex')}`;
}

type Fixture = { userId: string; orderId: string; token: string; paymentId: string; txnRef: string; onTimePayDate: string };
async function fixture(): Promise<Fixture> {
  const userId = randomUUID(); users.push(userId);
  await db.user.create({ data: { id: userId, email: `ipn-${run}-${userId}@test.local`, passwordHash: 'x' } });
  const order = await db.order.create({ data: { userId, subtotalVnd: 85000n, totalVnd: 85000n, expiresAt: new Date(Date.now() + 15 * 60_000) } });
  const token = await jwt.signAsync({ sub: userId });
  const initiated = await request(app.getHttpServer()).post('/payments/vnpay/initiate')
    .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send({ orderId: order.id }).expect(201);
  const payment = await db.payment.findUniqueOrThrow({ where: { id: initiated.body.paymentId } });
  // A successful test callback must carry a trusted gateway time that is not
  // later than this freshly-created Order's persisted expiry.
  return { userId, orderId: order.id, token, paymentId: payment.id, txnRef: payment.vnpTxnRef!, onTimePayDate: formatVnpayDate(payment.createdAt) };
}
function callback(f: Fixture, overrides: Record<string, string> = {}) {
  return signedIpn({ vnp_TmnCode: 'TESTMERCHANT', vnp_TxnRef: f.txnRef, vnp_Amount: '8500000', vnp_OrderInfo: `Order ${f.orderId}`, vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: `9${Date.now()}`.slice(0, 15), vnp_PayDate: f.onTimePayDate, ...overrides });
}
function queryResponse(f: Fixture, requestId: string, responseCode: string, transactionStatus: string, payDate = f.onTimePayDate) {
  const fields: Record<string, string> = { vnp_ResponseId: `R${requestId}`, vnp_Command: 'querydr', vnp_ResponseCode: responseCode, vnp_Message: 'OK', vnp_TmnCode: 'TESTMERCHANT', vnp_TxnRef: f.txnRef, vnp_Amount: '8500000', vnp_BankCode: 'NCB', vnp_PayDate: payDate, vnp_TransactionNo: `8${Date.now()}`.slice(0, 15), vnp_TransactionType: '01', vnp_TransactionStatus: transactionStatus, vnp_OrderInfo: `Thanh toan don hang ${f.orderId}`, vnp_PromotionCode: '', vnp_PromotionAmount: '' };
  const ordered = ['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo','vnp_PromotionCode','vnp_PromotionAmount'];
  fields.vnp_SecureHash = createHmac('sha512', secret).update(ordered.map(key => fields[key]).join('|')).digest('hex');
  return fields;
}

describe('VNPay IPN and QueryDR on PostgreSQL', () => {
  beforeAll(async () => {
    const url = process.env.AUTH_TEST_DATABASE_URL;
    if (!url) throw new Error('Set AUTH_TEST_DATABASE_URL to localhost:5433/brewlite_test');
    const parsed = new URL(url);
    if (parsed.hostname !== 'localhost' || parsed.port !== '5433' || parsed.pathname !== '/brewlite_test') throw new Error('Refusing non-allowlisted integration database');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('VNPAY_TMN_CODE', 'TESTMERCHANT'); vi.stubEnv('VNPAY_HASH_SECRET', secret);
    vi.stubEnv('VNPAY_PAYMENT_URL', 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'); vi.stubEnv('VNPAY_RETURN_URL', 'https://merchant.example/return');
    vi.stubEnv('VNPAY_QUERYDR_URL', 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'); vi.stubEnv('VNPAY_QUERYDR_TIMEOUT_MS', '15000');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile(); db = module.get(PrismaService); jwt = module.get(JwtService); app = module.createNestApplication({ logger: false }); await app.init();
  });
  afterAll(async () => { try { await db.paymentGatewayEvent.deleteMany({ where: { payment: { userId: { in: users } } } }); await db.payment.deleteMany({ where: { userId: { in: users } } }); await db.order.deleteMany({ where: { userId: { in: users } } }); await db.user.deleteMany({ where: { id: { in: users } } }); } finally { await app.close(); vi.unstubAllEnvs(); } });

  it('accepts verified IPN only once and commits Order/Payment before ACK', async () => {
    const f = await fixture(); const raw = callback(f);
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${raw}`).expect(200).expect({ RspCode: '00', Message: 'Confirm Success' });
    await expect(db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).resolves.toMatchObject({ status: 'SUCCESS', reconciliationState: 'RESOLVED' });
    await expect(db.order.findUniqueOrThrow({ where: { id: f.orderId } })).resolves.toMatchObject({ status: 'PAID' });
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${raw}`).expect(200).expect({ RspCode: '02', Message: 'Order already confirmed' });
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(1);
  });

  it('rejects a tampered signed value without mutation', async () => {
    const f = await fixture();
    const tampered = callback(f).replace(`vnp_Amount=8500000`, `vnp_Amount=8400000`);
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${tampered}`).expect(200).expect({ RspCode: '97', Message: 'Invalid signature' });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).toMatchObject({ status: 'PENDING' });
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(0);
  });

  it('rejects a duplicate raw query key before signature evaluation', async () => {
    const f = await fixture();
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f)}&vnp_OrderInfo=tampered`).expect(200).expect({ RspCode: '99', Message: 'Invalid request' });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).toMatchObject({ status: 'PENDING' });
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(0);
  });

  it('rejects unknown transaction, merchant mismatch and amount mismatch without mutation', async () => {
    const f = await fixture();
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f, { vnp_TxnRef: 'UNKNOWN' })}`).expect(200).expect({ RspCode: '01', Message: 'Order not found' });
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f, { vnp_TmnCode: 'OTHER' })}`).expect(200).expect({ RspCode: '99', Message: 'Merchant mismatch' });
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f, { vnp_Amount: '10000' })}`).expect(200).expect({ RspCode: '04', Message: 'Invalid amount' });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).toMatchObject({ status: 'PENDING' });
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(0);
  });

  it('persists QueryDR UNKNOWN then only releases the matching lease token', async () => {
    const f = await fixture(); await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const service = app.get(VnpayQueryDrService); const claim = await service.claim(f.paymentId, 30_000); expect(claim).toBeTruthy();
    const transport = vi.fn().mockResolvedValue({});
    await expect(service.reconcileClaimed(f.paymentId, claim!.requestId, claim!.claimToken, '127.0.0.1', transport)).rejects.toThrow('Malformed QueryDR response');
    expect(await service.releaseClaim(f.paymentId, randomUUID(), new Date(Date.now() + 1000), 'QUERYDR_INVALID_RESPONSE')).toBe(false);
    expect(await service.releaseClaim(f.paymentId, claim!.claimToken, new Date(Date.now() + 1000), 'QUERYDR_INVALID_RESPONSE')).toBe(true);
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).toMatchObject({ status: 'PENDING', claimToken: null, lastQueryError: 'QUERYDR_INVALID_RESPONSE' });
  });

  it('keeps a verified late IPN success as financial exception without reviving the cancelled Order', async () => {
    const f = await fixture();
    await db.order.update({ where: { id: f.orderId }, data: { expiresAt: new Date(Date.now() - 6 * 60_000) } });
    await db.$transaction(tx => expireOrderInTransaction(tx, f.orderId));
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f)}`).expect(200).expect({ RspCode: '00', Message: 'Confirm Success' });
    await expect(db.order.findUniqueOrThrow({ where: { id: f.orderId } })).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).resolves.toMatchObject({ status: 'PENDING', hasFinancialException: true, reconciliationState: 'REQUIRES_REVIEW' });
  });

  it.each([
    ['00', '00', 'ON_TIME', 'SUCCESS', 'RESOLVED'],
    ['00', '02', 'ON_TIME', 'FAILED', 'RESOLVED'],
    ['00', '01', 'ON_TIME', 'PENDING', 'SCHEDULED'],
    ['91', '00', 'ON_TIME', 'PENDING', 'SCHEDULED'],
    ['00', '00', '', 'PENDING', 'SCHEDULED'],
  ] as const)('handles signed QueryDR response code %s and transaction status %s independently', async (responseCode, transactionStatus, payDate, expectedStatus, expectedReconciliation) => {
    const f = await fixture(); await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const service = app.get(VnpayQueryDrService); const claim = await service.claim(f.paymentId, 30_000); expect(claim).toBeTruthy();
    const result = await service.reconcileClaimed(f.paymentId, claim!.requestId, claim!.claimToken, '127.0.0.1', async () => queryResponse(f, claim!.requestId, responseCode, transactionStatus, payDate === 'ON_TIME' ? f.onTimePayDate : payDate));
    expect(result.paymentStatus).toBe(expectedStatus);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.paymentId } });
    expect(payment.status).toBe(expectedStatus); expect(payment.reconciliationState).toBe(expectedReconciliation);
    if (expectedStatus === 'PENDING') await service.releaseClaim(f.paymentId, claim!.claimToken, new Date(Date.now() + 1000), null);
  });

  it('returns IPN 99 and rolls back all evidence when finalization persistence fails', async () => {
    const f = await fixture(); const suffix = randomUUID().replaceAll('-', ''); const fn = `ipn_rollback_${suffix}`; const trigger = `ipn_rollback_trigger_${suffix}`;
    try {
      await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23505', CONSTRAINT='test_ipn_rollback'; END; $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON payment_gateway_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f)}`).expect(200).expect({ RspCode: '99', Message: 'Unknown error' });
      await expect(db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).resolves.toMatchObject({ status: 'PENDING', finalOutcomeSnapshot: null });
      expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON payment_gateway_events`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  it('keeps a claimed QueryDR attempt unchanged on transport timeout until its owner releases it', async () => {
    const f = await fixture(); await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const service = app.get(VnpayQueryDrService); const claim = await service.claim(f.paymentId, 30_000); expect(claim).toBeTruthy();
    await expect(service.reconcileClaimed(f.paymentId, claim!.requestId, claim!.claimToken, '127.0.0.1', async () => { throw new Error('transport timeout'); })).rejects.toThrow('transport timeout');
    await expect(db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).resolves.toMatchObject({ status: 'PENDING', claimToken: claim!.claimToken, finalOutcomeSnapshot: null });
    expect(await service.releaseClaim(f.paymentId, claim!.claimToken, new Date(Date.now() + 1000), 'QUERYDR_TIMEOUT')).toBe(true);
  });

  it('serializes concurrent IPN and QueryDR success through one financial finalization', async () => {
    const f = await fixture(); await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    const service = app.get(VnpayQueryDrService); const claim = await service.claim(f.paymentId, 30_000); expect(claim).toBeTruthy();
    const [ipn, query] = await Promise.all([
      request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f)}`),
      service.reconcileClaimed(f.paymentId, claim!.requestId, claim!.claimToken, '127.0.0.1', async () => queryResponse(f, claim!.requestId, '00', '00')),
    ]);
    expect(ipn.status).toBe(200); expect(['00', '02']).toContain(ipn.body.RspCode); expect(['FINALIZED', 'DUPLICATE']).toContain(query.disposition);
    expect(await db.payment.count({ where: { orderId: f.orderId, status: 'SUCCESS' } })).toBe(1);
    expect(await db.paymentGatewayEvent.count({ where: { paymentId: f.paymentId } })).toBe(2);
    await expect(db.order.findUniqueOrThrow({ where: { id: f.orderId } })).resolves.toMatchObject({ status: 'PAID' });
  });

  it('returns null instead of leasing a Payment finalized by IPN before a claim write', async () => {
    const f = await fixture(); await db.payment.update({ where: { id: f.paymentId }, data: { nextQueryAt: new Date(Date.now() - 1000) } });
    await request(app.getHttpServer()).get(`/payments/vnpay/ipn?${callback(f)}`).expect(200).expect({ RspCode: '00', Message: 'Confirm Success' });
    const claim = await app.get(VnpayQueryDrService).claim(f.paymentId, 30_000);
    expect(claim).toBeNull();
    await expect(db.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).resolves.toMatchObject({ status: 'SUCCESS', reconciliationState: 'RESOLVED', claimToken: null });
  });
});
