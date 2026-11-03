import { createHmac } from 'node:crypto';
import { canonicalizeIpn, classifyGatewayOutcome, parseAndVerifyIpn, queryDrSign } from './vnpay-gateway.protocol.js';

const secret = 'test-only-hmac-secret';
function signed(values: Record<string, string>) {
  const canonical = canonicalizeIpn(new Map(Object.entries(values)));
  return `${canonical}&vnp_SecureHash=${createHmac('sha512', secret).update(canonical).digest('hex')}`;
}
describe('VNPay gateway protocol', () => {
  it('verifies a canonical IPN and converts GMT+7 amount/date safely', () => {
    const raw = signed({ vnp_TmnCode: 'TMN', vnp_TxnRef: 'abc_1', vnp_Amount: '8500000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '123456', vnp_PayDate: '20261103103000' });
    const ipn = parseAndVerifyIpn(raw, secret);
    expect(ipn).toMatchObject({ tmnCode: 'TMN', txnRef: 'abc_1', amount: 8500000n, responseCode: '00', transactionStatus: '00' });
    expect(ipn?.payDate?.toISOString()).toBe('2026-11-03T03:30:00.000Z');
  });
  it('accepts a valid GMT+7 pay date in the UTC previous-day window', () => {
    const raw = signed({ vnp_TmnCode: 'TMN', vnp_TxnRef: 'abc_1', vnp_Amount: '8500000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '123456', vnp_PayDate: '20261103010000' });
    expect(parseAndVerifyIpn(raw, secret)?.payDate?.toISOString()).toBe('2026-11-02T18:00:00.000Z');
  });
  it('rejects tampering, duplicate keys, malformed amount and invalid paid date', () => {
    const base = { vnp_TmnCode: 'TMN', vnp_TxnRef: 'abc', vnp_Amount: '10000', vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '1' };
    expect(parseAndVerifyIpn(`${signed(base)}&vnp_Amount=20000`, secret)).toBeNull();
    expect(parseAndVerifyIpn(signed({ ...base, vnp_Amount: '10001' }), secret)).toBeNull();
    expect(parseAndVerifyIpn(signed({ ...base, vnp_PayDate: '20261303103000' }), secret)).toBeNull();
  });
  it('does not equate a request-level response to a financial success', () => {
    expect(classifyGatewayOutcome('00', '00')).toBe('SUCCESS');
    expect(classifyGatewayOutcome('00', '02')).toBe('FAILED');
    expect(classifyGatewayOutcome('00', '01')).toBe('UNKNOWN');
    expect(classifyGatewayOutcome('91', '00')).toBe('UNKNOWN');
  });
  it('uses the documented pipe-delimited QueryDR signing input', () => {
    expect(queryDrSign(['a', '2.1.0', 'querydr'], secret)).toBe(createHmac('sha512', secret).update('a|2.1.0|querydr').digest('hex'));
  });
});
