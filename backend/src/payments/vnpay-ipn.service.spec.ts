import { createHmac } from 'node:crypto';
import { VnpayIpnService } from './vnpay-ipn.service.js';
import { canonicalizeIpn } from './vnpay-gateway.protocol.js';

const secret = 'test-only-hmac-secret';
function callback(values: Record<string, string>) {
  const canonical = canonicalizeIpn(new Map(Object.entries(values)));
  return `${canonical}&vnp_SecureHash=${createHmac('sha512', secret).update(canonical).digest('hex')}`;
}
function setup(payment: Record<string, unknown> | null, disposition = 'FINALIZED') {
  const finalization = { finalizeInTransaction: vi.fn().mockResolvedValue({ disposition }) };
  const tx = { payment: { findUnique: vi.fn().mockResolvedValue(payment) } };
  const prisma = { $transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)) };
  return { service: new VnpayIpnService(prisma as never, finalization as never), finalization, prisma };
}
describe('VnpayIpnService', () => {
  beforeEach(() => {
    vi.stubEnv('VNPAY_TMN_CODE', 'TMN'); vi.stubEnv('VNPAY_HASH_SECRET', secret);
    vi.stubEnv('VNPAY_PAYMENT_URL', 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'); vi.stubEnv('VNPAY_RETURN_URL', 'https://merchant.example/return');
  });
  afterEach(() => vi.unstubAllEnvs());
  const values = { vnp_TmnCode: 'TMN', vnp_TxnRef: 'REF1', vnp_Amount: '8500000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '123', vnp_PayDate: '20261103100000' };
  const payment = { id: '550e8400-e29b-41d4-a716-446655440000', provider: 'VNPAY', vnpTmnCode: 'TMN', amountVnd: 85000n };
  it('only ACKs 00 after the verified outcome has passed shared finalization', async () => {
    const { service, finalization } = setup(payment);
    await expect(service.handle(callback(values))).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(finalization.finalizeInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'VNPAY', paymentId: payment.id, verifiedOutcome: expect.objectContaining({ outcome: 'SUCCESS' }) }));
  });
  it('maps duplicate, unknown transaction, amount mismatch, malformed and tampered callbacks', async () => {
    await expect(setup(payment, 'DUPLICATE').service.handle(callback(values))).resolves.toEqual({ RspCode: '02', Message: 'Order already confirmed' });
    await expect(setup(null).service.handle(callback(values))).resolves.toEqual({ RspCode: '01', Message: 'Order not found' });
    await expect(setup({ ...payment, amountVnd: 1n }).service.handle(callback(values))).resolves.toEqual({ RspCode: '04', Message: 'Invalid amount' });
    await expect(setup(payment).service.handle('vnp_TmnCode=TMN')).resolves.toEqual({ RspCode: '99', Message: 'Invalid request' });
    await expect(setup(payment).service.handle(`${callback(values)}&vnp_OrderInfo=tampered`)).resolves.toEqual({ RspCode: '97', Message: 'Invalid signature' });
  });
});
