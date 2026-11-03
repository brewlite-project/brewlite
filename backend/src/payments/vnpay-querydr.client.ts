import { createHash, timingSafeEqual } from 'node:crypto';
import { formatVnpayDate } from './vnpay-url.builder.js';
import { classifyGatewayOutcome, queryDrSign } from './vnpay-gateway.protocol.js';
import type { VnpayQueryDrConfig } from './vnpay.config.js';
import type { VerifiedGatewayOutcome } from './payment-finalization.service.js';

export type QueryDrAttempt = Readonly<{
  id: string; vnpTxnRef: string; vnpTmnCode: string; vnpCreateDate: string;
  amountVnd: bigint; initiationSnapshot: unknown;
}>;
export type QueryDrTransport = (url: string, body: Record<string, string>, timeoutMs: number) => Promise<unknown>;

const stringField = (record: Record<string, unknown>, name: string, required = true): string | null => {
  const value = record[name];
  if (value === undefined && !required) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && (!required || value.length > 0) ? value : null;
};
const asGmt7 = (value: string): Date | null => {
  if (!/^\d{14}$/.test(value)) return null;
  const y=+value.slice(0,4), m=+value.slice(4,6), d=+value.slice(6,8), h=+value.slice(8,10), mi=+value.slice(10,12), s=+value.slice(12,14);
  const date = new Date(Date.UTC(y,m-1,d,h-7,mi,s));
  const local = new Date(date.getTime() + 7 * 60 * 60_000);
  return local.getUTCFullYear()===y && local.getUTCMonth()===m-1 && local.getUTCDate()===d && local.getUTCHours()===h && local.getUTCMinutes()===mi && local.getUTCSeconds()===s ? date : null;
};

export class VnpayQueryDrClient {
  constructor(private readonly config: VnpayQueryDrConfig, private readonly transport: QueryDrTransport = VnpayQueryDrClient.fetchTransport) {}

  static async fetchTransport(this: void, url: string, body: Record<string, string>, timeoutMs: number): Promise<unknown> {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('VNPay QueryDR HTTP failure');
    return response.json();
  }

  async query(attempt: QueryDrAttempt, requestId: string, ipAddr: string, now: Date): Promise<VerifiedGatewayOutcome> {
    if (!/^[A-Za-z0-9]{1,32}$/.test(requestId) || !/^[A-Za-z0-9:.]{7,45}$/.test(ipAddr)) throw new Error('Invalid QueryDR request identity');
    if (attempt.vnpTmnCode !== this.config.tmnCode || !/^[A-Za-z0-9_-]{1,100}$/.test(attempt.vnpTxnRef) || !/^\d{14}$/.test(attempt.vnpCreateDate)) throw new Error('Invalid immutable QueryDR correlation');
    const snapshot = attempt.initiationSnapshot as { requestParameters?: Record<string, unknown> } | null;
    const orderInfo = snapshot?.requestParameters?.vnp_OrderInfo;
    if (typeof orderInfo !== 'string' || orderInfo.length === 0 || orderInfo.length > 255) throw new Error('Missing immutable VNPay order info');
    const createDate = formatVnpayDate(now);
    const signValues = [requestId, '2.1.0', 'querydr', this.config.tmnCode, attempt.vnpTxnRef, attempt.vnpCreateDate, createDate, ipAddr, orderInfo];
    const body: Record<string, string> = {
      vnp_RequestId: requestId, vnp_Version: '2.1.0', vnp_Command: 'querydr', vnp_TmnCode: this.config.tmnCode,
      vnp_TxnRef: attempt.vnpTxnRef, vnp_TransactionDate: attempt.vnpCreateDate, vnp_CreateDate: createDate, vnp_IpAddr: ipAddr,
      vnp_OrderInfo: orderInfo, vnp_SecureHash: queryDrSign(signValues, this.config.hashSecret),
    };
    return this.parseResponse(await this.transport(this.config.queryDrUrl, body, this.config.timeoutMs), attempt, requestId, now);
  }

  parseResponse(raw: unknown, attempt: QueryDrAttempt, requestId: string, receivedAt: Date): VerifiedGatewayOutcome {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid QueryDR response');
    const r = raw as Record<string, unknown>;
    const names = ['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo','vnp_SecureHash'];
    // PAY QueryDR signs an empty PayDate slot. A missing/empty field is not a
    // trusted payment time, but its signed evidence must still reach the
    // finalization policy; malformed non-empty values remain invalid below.
    const fields = names.map(name => stringField(r, name, name !== 'vnp_PayDate'));
    if (fields.some(value => value === null)) throw new Error('Malformed QueryDR response');
    const [responseId, command, responseCode, message, tmnCode, txnRef, amount, bankCode, payDate, transactionNo, transactionType, transactionStatus, orderInfo, signature] = fields as string[];
    const promotionCode = stringField(r, 'vnp_PromotionCode', false), promotionAmount = stringField(r, 'vnp_PromotionAmount', false);
    if (promotionCode === null || promotionAmount === null || command !== 'querydr' || tmnCode !== this.config.tmnCode || tmnCode !== attempt.vnpTmnCode || txnRef !== attempt.vnpTxnRef || !/^\d+$/.test(amount) || BigInt(amount) !== attempt.amountVnd * 100n || !/^[a-fA-F0-9]{128}$/.test(signature)) throw new Error('QueryDR correlation failure');
    const signed = [responseId,command,responseCode,message,tmnCode,txnRef,amount,bankCode,payDate,transactionNo,transactionType,transactionStatus,orderInfo,promotionCode,promotionAmount];
    const expected = Buffer.from(queryDrSign(signed, this.config.hashSecret), 'hex'), actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid QueryDR signature');
    const paidAt = payDate ? asGmt7(payDate) : null;
    if (payDate && !paidAt) throw new Error('Invalid QueryDR pay date');
    const outcome = classifyGatewayOutcome(responseCode, transactionStatus);
    const identity = createHash('sha256').update(`QUERYDR\n${requestId}\n${responseId}\n${signature}`).digest('hex');
    return { source: 'QUERYDR', eventIdentity: identity, queryRequestId: requestId, vnpTxnRef: txnRef, vnpTmnCode: tmnCode, outcome, responseCode, transactionStatus, gatewayTransactionNo: transactionNo || null, amountVnd: attempt.amountVnd, gatewayPaidAt: paidAt, receivedAt, verifiedAt: receivedAt };
  }
}
