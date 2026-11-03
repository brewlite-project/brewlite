import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type VnpayIpn = Readonly<{
  tmnCode: string; txnRef: string; amount: bigint; responseCode: string;
  transactionStatus: string; transactionNo: string; payDate: Date | null;
  eventIdentity: string; canonical: string;
}>;

const ipnFields = new Set([
  'vnp_Amount', 'vnp_BankCode', 'vnp_BankTranNo', 'vnp_CardType',
  'vnp_OrderInfo', 'vnp_PayDate', 'vnp_ResponseCode', 'vnp_TmnCode',
  'vnp_TransactionNo', 'vnp_TransactionStatus', 'vnp_TxnRef',
  'vnp_SecureHash', 'vnp_SecureHashType',
]);
const required = ['vnp_TmnCode', 'vnp_TxnRef', 'vnp_Amount', 'vnp_ResponseCode', 'vnp_TransactionStatus', 'vnp_TransactionNo', 'vnp_SecureHash'];

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
}

export function canonicalizeIpn(values: ReadonlyMap<string, string>): string {
  return [...values.entries()].filter(([key]) => key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}

function parseGmt7(value: string): Date | null {
  if (!/^\d{14}$/.test(value)) return null;
  const y = Number(value.slice(0, 4)), mo = Number(value.slice(4, 6)), d = Number(value.slice(6, 8));
  const h = Number(value.slice(8, 10)), mi = Number(value.slice(10, 12)), s = Number(value.slice(12, 14));
  const result = new Date(Date.UTC(y, mo - 1, d, h - 7, mi, s));
  // Reconstruct the supplied wall-clock fields in GMT+7. Comparing UTC fields
  // directly is wrong between 00:00 and 06:59 because their UTC date is prior.
  const local = new Date(result.getTime() + 7 * 60 * 60_000);
  return y >= 1 && local.getUTCFullYear() === y && local.getUTCMonth() === mo - 1 && local.getUTCDate() === d && local.getUTCHours() === h && local.getUTCMinutes() === mi && local.getUTCSeconds() === s ? result : null;
}

export function parseAndVerifyIpn(rawQuery: string, hashSecret: string): VnpayIpn | null {
  const query = new URLSearchParams(rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery);
  const values = new Map<string, string>();
  for (const [key, value] of query) {
    if (!ipnFields.has(key) || values.has(key)) return null;
    values.set(key, value);
  }
  if (required.some(key => !values.get(key))) return null;
  const signature = values.get('vnp_SecureHash')!;
  if (!/^[a-fA-F0-9]{128}$/.test(signature)) return null;
  const canonical = canonicalizeIpn(values);
  const expected = createHmac('sha512', hashSecret).update(canonical, 'utf8').digest();
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  const amount = values.get('vnp_Amount')!;
  const txnRef = values.get('vnp_TxnRef')!;
  const responseCode = values.get('vnp_ResponseCode')!;
  const transactionStatus = values.get('vnp_TransactionStatus')!;
  const transactionNo = values.get('vnp_TransactionNo')!;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(txnRef) || !/^[1-9]\d*00$/.test(amount) || !/^\d{2}$/.test(responseCode) || !/^\d{2}$/.test(transactionStatus) || !/^\d{1,15}$/.test(transactionNo)) return null;
  const payDateValue = values.get('vnp_PayDate');
  const payDate = payDateValue ? parseGmt7(payDateValue) : null;
  if (payDateValue && !payDate) return null;
  return { tmnCode: values.get('vnp_TmnCode')!, txnRef, amount: BigInt(amount), responseCode, transactionStatus, transactionNo, payDate, canonical, eventIdentity: createHash('sha256').update(`IPN\n${canonical}`).digest('hex') };
}

/** Distinguish protocol-invalid (99) from an otherwise valid request with bad HMAC (97). */
export function ipnFailureRspCode(rawQuery: string, hashSecret: string): '97' | '99' {
  const query = new URLSearchParams(rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery);
  const values = new Map<string, string>();
  for (const [key, value] of query) {
    if (!ipnFields.has(key) || values.has(key)) return '99';
    values.set(key, value);
  }
  if (required.some(key => !values.get(key))) return '99';
  const signature = values.get('vnp_SecureHash')!;
  if (!/^[a-fA-F0-9]{128}$/.test(signature)) return '97';
  const txnRef = values.get('vnp_TxnRef')!, amount = values.get('vnp_Amount')!, responseCode = values.get('vnp_ResponseCode')!, transactionStatus = values.get('vnp_TransactionStatus')!, transactionNo = values.get('vnp_TransactionNo')!;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(txnRef) || !/^[1-9]\d*00$/.test(amount) || !/^\d{2}$/.test(responseCode) || !/^\d{2}$/.test(transactionStatus) || !/^\d{1,15}$/.test(transactionNo)) return '99';
  if (values.has('vnp_PayDate') && !parseGmt7(values.get('vnp_PayDate')!)) return '99';
  const expected = createHmac('sha512', hashSecret).update(canonicalizeIpn(values), 'utf8').digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? '99' : '97';
}

export function classifyGatewayOutcome(responseCode: string, transactionStatus: string): 'SUCCESS' | 'FAILED' | 'UNKNOWN' {
  if (responseCode !== '00') return 'UNKNOWN';
  if (transactionStatus === '00') return 'SUCCESS';
  if (transactionStatus === '02') return 'FAILED';
  return 'UNKNOWN';
}

export function queryDrSign(values: readonly string[], hashSecret: string): string {
  return createHmac('sha512', hashSecret).update(values.join('|'), 'utf8').digest('hex');
}
