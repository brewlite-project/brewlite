import { createHmac } from 'node:crypto';
import { VnpayQueryDrClient } from './vnpay-querydr.client.js';

const secret = 'test-only-hmac-secret';
const config = { tmnCode: 'TMN', hashSecret: secret, queryDrUrl: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction', timeoutMs: 1000 };
const attempt = { id: 'p', vnpTxnRef: 'REF1', vnpTmnCode: 'TMN', vnpCreateDate: '20261103100000', amountVnd: 85000n, initiationSnapshot: { requestParameters: { vnp_OrderInfo: 'Thanh toan don hang REF1' } } };
function response(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { vnp_ResponseId: 'R1', vnp_Command: 'querydr', vnp_ResponseCode: '00', vnp_Message: 'OK', vnp_TmnCode: 'TMN', vnp_TxnRef: 'REF1', vnp_Amount: 8500000, vnp_BankCode: 'NCB', vnp_PayDate: '20261103100100', vnp_TransactionNo: '123', vnp_TransactionType: '01', vnp_TransactionStatus: '00', vnp_OrderInfo: 'Thanh toan don hang REF1', vnp_PromotionCode: '', vnp_PromotionAmount: '', ...overrides };
  const order = ['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo','vnp_PromotionCode','vnp_PromotionAmount'];
  values.vnp_SecureHash = createHmac('sha512', secret).update(order.map(k => values[k] == null ? '' : String(values[k])).join('|')).digest('hex');
  return values;
}
describe('VnpayQueryDrClient', () => {
  it('signs request and accepts only correlated signed response', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const client = new VnpayQueryDrClient(config, transport);
    const result = await client.query(attempt, 'REQUEST1', '127.0.0.1', new Date('2026-11-03T03:05:00Z'));
    const signInput = ['REQUEST1', '2.1.0', 'querydr', 'TMN', 'REF1', '20261103100000', '20261103100500', '127.0.0.1', 'Thanh toan don hang REF1'];
    expect(transport.mock.calls[0]?.[1]).toEqual({
      vnp_RequestId: 'REQUEST1', vnp_Version: '2.1.0', vnp_Command: 'querydr',
      vnp_TmnCode: 'TMN', vnp_TxnRef: 'REF1',
      vnp_TransactionDate: '20261103100000', vnp_CreateDate: '20261103100500',
      vnp_IpAddr: '127.0.0.1', vnp_OrderInfo: 'Thanh toan don hang REF1',
      vnp_SecureHash: createHmac('sha512', secret).update(signInput.join('|'), 'utf8').digest('hex'),
    });
    expect(result).toMatchObject({ source: 'QUERYDR', outcome: 'SUCCESS', responseCode: '00', transactionStatus: '00', amountVnd: 85000n });
  });
  it('accepts the maximum-length alphanumeric RequestId required by QueryDR', async () => {
    const transport = vi.fn().mockResolvedValue(response());
    await new VnpayQueryDrClient(config, transport).query(attempt, 'a'.repeat(32), '127.0.0.1', new Date());
    expect(transport.mock.calls[0]?.[1]?.vnp_RequestId).toHaveLength(32);
  });
  it('reports only allowlisted fields for a VNPay request-level error response', () => {
    expect(() => new VnpayQueryDrClient(config).parseResponse({
      vnp_ResponseCode: '97', vnp_Message: 'Invalid signature\nrequest rejected',
    }, attempt, 'REQUEST1', new Date())).toThrow(
      'VNPay QueryDR request rejected: responseCode=97; message=Invalid signature request rejected',
    );
  });
  it('keeps query success with pending transaction as UNKNOWN', () => {
    const result = new VnpayQueryDrClient(config).parseResponse(response({ vnp_TransactionStatus: '01' }), attempt, 'REQUEST1', new Date());
    expect(result.outcome).toBe('UNKNOWN');
  });
  it('classifies a signed Sandbox-style non-success response with absent transaction details as UNKNOWN', () => {
    const result = new VnpayQueryDrClient(config).parseResponse(response({
      vnp_ResponseCode: '91', vnp_Message: 'Transaction not found',
      vnp_BankCode: null, vnp_PayDate: null, vnp_TransactionNo: null,
      vnp_TransactionType: null, vnp_TransactionStatus: null, vnp_OrderInfo: null,
    }), attempt, 'REQUEST1', new Date());
    expect(result).toMatchObject({ outcome: 'UNKNOWN', responseCode: '91', transactionStatus: null, gatewayTransactionNo: null });
  });
  it('allows omitted optional transaction fields only for a signed non-final outcome', () => {
    const raw = response({
      vnp_ResponseCode: '91', vnp_BankCode: null, vnp_PayDate: null,
      vnp_TransactionNo: null, vnp_TransactionType: null,
      vnp_TransactionStatus: null, vnp_OrderInfo: null,
    });
    delete raw.vnp_BankCode; delete raw.vnp_PayDate; delete raw.vnp_TransactionNo;
    delete raw.vnp_TransactionType; delete raw.vnp_TransactionStatus; delete raw.vnp_OrderInfo;
    expect(new VnpayQueryDrClient(config).parseResponse(raw, attempt, 'REQUEST1', new Date()).outcome).toBe('UNKNOWN');
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
  it.each([
    ['vnp_SecureHash', 'secureHash'], ['vnp_TmnCode', 'tmnCode'],
    ['vnp_TxnRef', 'txnRef'], ['vnp_Amount', 'amount'],
  ])('rejects a response missing required security/correlation field %s', (field) => {
    const raw = response(); delete raw[field];
    expect(() => new VnpayQueryDrClient(config).parseResponse(raw, attempt, 'REQUEST1', new Date())).toThrow();
  });
  it.each([
    ['vnp_Amount', 8400000], ['vnp_TxnRef', 'OTHER'], ['vnp_TmnCode', 'OTHER'],
  ])('rejects a signed response with mismatched %s', (field, value) => {
    expect(() => new VnpayQueryDrClient(config).parseResponse(response({ [field]: value }), attempt, 'REQUEST1', new Date())).toThrow();
  });
  it('never emits SUCCESS from an incomplete signed request-level success', () => {
    expect(() => new VnpayQueryDrClient(config).parseResponse(response({
      vnp_BankCode: null, vnp_TransactionNo: null, vnp_TransactionType: null,
      vnp_OrderInfo: null,
    }), attempt, 'REQUEST1', new Date())).toThrow('Incomplete QueryDR final outcome');
  });
});
