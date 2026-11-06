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
  if ((value === undefined || value === null) && !required) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && (!required || value.length > 0) ? value : null;
};
const describeInvalidFields = (names: readonly string[], values: readonly (string | null)[]) =>
  names.filter((_, index) => values[index] === null).join(',');
const requestErrorDiagnostic = (record: Record<string, unknown>): string | null => {
  const responseCode = stringField(record, 'vnp_ResponseCode');
  const message = stringField(record, 'vnp_Message');
  if (!responseCode || !/^\d{2}$/.test(responseCode) || !message) return null;
  // The gateway's documented request-error message is safe to surface only as
  // a bounded, single-line diagnostic. Never include raw response data.
  const safeMessage = message.replace(/[\r\n\t]/g, ' ').slice(0, 255);
  return `VNPay QueryDR request rejected: responseCode=${responseCode}; message=${safeMessage}`;
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
    const coreNames = ['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_SecureHash'] as const;
    const coreFields = coreNames.map(name => stringField(r, name));
    if (coreFields.some(value => value === null)) {
      const requestError = requestErrorDiagnostic(r);
      if (requestError) throw new Error(requestError);
      throw new Error(`Malformed QueryDR response: missing/invalid core fields (${describeInvalidFields(coreNames, coreFields)})`);
    }
    const [responseId, command, responseCode, message, tmnCode, txnRef, amount, signature] = coreFields as string[];

    // Sandbox can return a signed, non-final response before it has transaction
    // details. Those fields still occupy empty slots in the documented signing
    // order, but never provide enough evidence to finalize a payment.
    const transactionNames = ['vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo'] as const;
    const transactionFields = transactionNames.map(name => stringField(r, name, false));
    if (transactionFields.some(value => value === null))
      throw new Error(`Malformed QueryDR response: invalid transaction fields (${describeInvalidFields(transactionNames, transactionFields)})`);
    const [bankCode, payDate, transactionNo, transactionType, transactionStatus, orderInfo] = transactionFields as string[];
    const promotionCode = stringField(r, 'vnp_PromotionCode', false), promotionAmount = stringField(r, 'vnp_PromotionAmount', false);
    if (promotionCode === null || promotionAmount === null)
      throw new Error('Malformed QueryDR response: invalid promotion fields');
    if (command !== 'querydr') throw new Error('QueryDR correlation failure: command');
    if (tmnCode !== this.config.tmnCode || tmnCode !== attempt.vnpTmnCode) throw new Error('QueryDR correlation failure: tmnCode');
    if (txnRef !== attempt.vnpTxnRef) throw new Error('QueryDR correlation failure: txnRef');
    if (!/^\d+$/.test(amount) || BigInt(amount) !== attempt.amountVnd * 100n) throw new Error('QueryDR correlation failure: amount');
    if (!/^[a-fA-F0-9]{128}$/.test(signature)) throw new Error('Malformed QueryDR response: secureHash');
    const signed = [responseId,command,responseCode,message,tmnCode,txnRef,amount,bankCode,payDate,transactionNo,transactionType,transactionStatus,orderInfo,promotionCode,promotionAmount];
    const expected = Buffer.from(queryDrSign(signed, this.config.hashSecret), 'hex'), actual = Buffer.from(signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid QueryDR signature');
    const paidAt = payDate ? asGmt7(payDate) : null;
    if (payDate && !paidAt) throw new Error('Invalid QueryDR pay date');
    const outcome = classifyGatewayOutcome(responseCode, transactionStatus);
    // Finalizing outcomes retain the complete legacy transaction shape. A
    // signed request-level success therefore cannot become financial truth.
    if (outcome !== 'UNKNOWN') {
      const finalNames = ['vnp_BankCode','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo'] as const;
      const finalFields = [bankCode, transactionNo, transactionType, transactionStatus, orderInfo];
      const missing = finalNames.filter((_, index) => !finalFields[index]);
      if (missing.length)
        throw new Error(`Incomplete QueryDR final outcome: missing transaction fields (${missing.join(',')})`);
    }
    const identity = createHash('sha256').update(`QUERYDR\n${requestId}\n${responseId}\n${signature}`).digest('hex');
    return { source: 'QUERYDR', eventIdentity: identity, queryRequestId: requestId, vnpTxnRef: txnRef, vnpTmnCode: tmnCode, outcome, responseCode, transactionStatus: transactionStatus || null, gatewayTransactionNo: transactionNo || null, amountVnd: attempt.amountVnd, gatewayPaidAt: paidAt, receivedAt, verifiedAt: receivedAt };
  }
}
