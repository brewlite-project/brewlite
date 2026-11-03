import { createHmac } from 'node:crypto';
import { VnpayQueryDrClient } from './vnpay-querydr.client.js';

const secret = 'test-only-hmac-secret';
const config = { tmnCode: 'TMN', hashSecret: secret, queryDrUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction', timeoutMs: 1000 };
const attempt = { id: 'p', vnpTxnRef: 'REF1', vnpTmnCode: 'TMN', vnpCreateDate: '20261103100000', amountVnd: 85000n, initiationSnapshot: { requestParameters: { vnp_OrderInfo: 'Thanh toan don hang REF1' } } };
function response(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { vnp_ResponseId: 'R1', vnp_Command: 'querydr', vnp_ResponseCode: '00', vnp_Message: 'OK', vnp_TmnCode: 'TMN', vnp_TxnRef: 'REF1', vnp_Amount: 8500000, vnp_BankCode: 'NCB', vnp_PayDate: '20261103100100', vnp_TransactionNo: '123', vnp_TransactionType: '01', vnp_TransactionStatus: '00', vnp_OrderInfo: 'Thanh toan don hang REF1', vnp_PromotionCode: '', vnp_PromotionAmount: '', ...overrides };
  const order = ['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo','vnp_PromotionCode','vnp_PromotionAmount'];
  values.vnp_SecureHash = createHmac('sha512', secret).update(order.map(k => String(values[k])).join('|')).digest('hex');
  return values;
}
describe('VnpayQueryDrClient', () => {
  it('signs request and accepts only correlated signed response', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const client = new VnpayQueryDrClient(config, transport);
    const result = await client.query(attempt, 'REQUEST1', '127.0.0.1', new Date('2026-11-03T03:05:00Z'));
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ vnp_Command: 'querydr', vnp_TransactionDate: '20261103100000', vnp_RequestId: 'REQUEST1' });
    expect(result).toMatchObject({ source: 'QUERYDR', outcome: 'SUCCESS', responseCode: '00', transactionStatus: '00', amountVnd: 85000n });
  });
  it('keeps query success with pending transaction as UNKNOWN', () => {
    const result = new VnpayQueryDrClient(config).parseResponse(response({ vnp_TransactionStatus: '01' }), attempt, 'REQUEST1', new Date());
    expect(result.outcome).toBe('UNKNOWN');
  });
  it('preserves signed success evidence with an empty PayDate without promoting it', () => {
    const result = new VnpayQueryDrClient(config).parseResponse(response({ vnp_PayDate: '' }), attempt, 'REQUEST1', new Date());
    expect(result).toMatchObject({ outcome: 'SUCCESS', gatewayPaidAt: null });
  });
  it('treats an omitted signed PayDate as the same empty signature slot', () => {
    const raw = response({ vnp_PayDate: '' }); delete raw.vnp_PayDate;
    expect(new VnpayQueryDrClient(config).parseResponse(raw, attempt, 'REQUEST1', new Date()).gatewayPaidAt).toBeNull();
  });
  it('rejects a non-empty malformed PayDate even when the response is signed', () => {
    expect(() => new VnpayQueryDrClient(config).parseResponse(response({ vnp_PayDate: 'not-a-date' }), attempt, 'REQUEST1', new Date())).toThrow('Invalid QueryDR pay date');
  });
  it('rejects unsigned or mismatched responses', () => {
    const client = new VnpayQueryDrClient(config);
    expect(() => client.parseResponse({ ...response(), vnp_TxnRef: 'OTHER' }, attempt, 'REQUEST1', new Date())).toThrow();
    expect(() => client.parseResponse({ ...response(), vnp_SecureHash: '0'.repeat(128) }, attempt, 'REQUEST1', new Date())).toThrow();
  });
});
