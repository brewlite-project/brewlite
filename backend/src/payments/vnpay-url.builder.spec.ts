import { describe, expect, it } from 'vitest';
import { buildVnpayPaymentUrl, canonicalizeVnpayParams, formatVnpayDate } from './vnpay-url.builder.js';

const config = { tmnCode: 'TEST', hashSecret: 'test-secret', paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html', returnUrl: 'https://merchant.example/return' };

describe('VNPay PAY 2.1.0 URL builder', () => {
  const input = { txnRef: 'abc-123', amountVnd: 85000n, orderInfo: 'Thanh toan don hang abc', ipAddr: '127.0.0.1', createDate: '20261102090000', expireDate: '20261102091500' };
  it('sorts, PHP-urlencodes and signs the fixed HMAC-SHA512 vector', () => {
    const result = buildVnpayPaymentUrl(input, config);
    expect(canonicalizeVnpayParams(result.signedParams)).toBe('vnp_Amount=8500000&vnp_Command=pay&vnp_CreateDate=20261102090000&vnp_CurrCode=VND&vnp_ExpireDate=20261102091500&vnp_IpAddr=127.0.0.1&vnp_Locale=vn&vnp_OrderInfo=Thanh+toan+don+hang+abc&vnp_OrderType=other&vnp_ReturnUrl=https%3A%2F%2Fmerchant.example%2Freturn&vnp_TmnCode=TEST&vnp_TxnRef=abc-123&vnp_Version=2.1.0');
    expect(result.paymentUrl).toContain('vnp_SecureHash=11b8c26374191ce4ddfc4b6d5c1ca0214aa1b16f95c8209779a1db379d98efcce5e31ce20644b497ab4d2b1882a5a910cbab7c8eb93c25fad758c798e1fe7fa2');
  });
  it('uses the merchant GMT+7 clock', () => expect(formatVnpayDate(new Date('2026-11-02T02:00:00.000Z'))).toBe('20261102090000'));
  it.each([
    [{ ...input, amountVnd: 0n }], [{ ...input, txnRef: 'bad space' }], [{ ...input, orderInfo: 'Tiếng Việt có dấu' }], [{ ...input, ipAddr: 'example.com' }], [{ ...input, ipAddr: '::::' }], [{ ...input, createDate: '20260230090000' }], [{ ...input, expireDate: '20261102096000' }], [{ ...input, expireDate: input.createDate }], [{ ...input, expireDate: '20261102085959' }],
  ])('rejects invalid gateway input', (invalid) => expect(() => buildVnpayPaymentUrl(invalid, config)).toThrow());
});
