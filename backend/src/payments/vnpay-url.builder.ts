import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type {  VnpayConfig } from './vnpay.config.js';

export type VnpayPaymentUrlInput = {
    txnRef: string;
    amountVnd: bigint;
    orderInfo: string;
    ipAddr: string;
    createDate: string;
    expireDate: string;
};

export type VnpayPaymentUrlResult = {
    paymentUrl: string;
    signedParams: Record<string, string>;
};

function toVnpayAmount(amountVnd: bigint): string {
    if (typeof amountVnd !== 'bigint' || amountVnd <= 0n) {
        throw new Error('VNPay amount must be a positive bigint');
    }
    const scaledAmount = amountVnd * 100n;

    if (scaledAmount > 999_999_999_999n) {
        throw new Error('VNPay amount exceeds 12 digits');
    }

    return scaledAmount.toString();
}

function validateTxnRef(txnRef: string): void {
    if (
        typeof txnRef !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(txnRef)
    ) {
        throw new Error('Invalid VNPay transaction reference');
    }
}

function validateOrderInfo(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9 .,:_-]{1,255}$/.test(value))
    throw new Error('Invalid VNPay order info');
}

function validateIpAddress(value: string): void {
  // Do not accept hostnames, forwarded lists, or syntactically-invalid IPv6.
  if (typeof value !== 'string' || isIP(value) === 0)
    throw new Error('Invalid VNPay IP address');
}

function parseGatewayDate(value: string, field: string): Date {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value))
    throw new Error(`Invalid VNPay ${field}`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 1 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  )
    throw new Error(`Invalid VNPay ${field}`);
  return parsed;
}

/** PHP urlencode-compatible encoding used by the official PAY 2.1.0 examples. */
function vnpEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function canonicalizeVnpayParams(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
    .sort()
    .map((key) => `${vnpEncode(key)}=${vnpEncode(params[key]!)}`)
    .join('&');
}

export function formatVnpayDate(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new Error('Invalid VNPay date');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}${part('hour')}${part('minute')}${part('second')}`;
}


function createPaymentParams(
  input: VnpayPaymentUrlInput,
  config: VnpayConfig,
): Record<string, string> {
  return {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: config.tmnCode,
    vnp_Amount: toVnpayAmount(input.amountVnd),
    vnp_CurrCode: 'VND',
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: input.orderInfo,
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: config.returnUrl,
    vnp_IpAddr: input.ipAddr,
    vnp_CreateDate: input.createDate,
    vnp_ExpireDate: input.expireDate,
  };
}

export function buildVnpayPaymentUrl(
  input: VnpayPaymentUrlInput,
  config: VnpayConfig,
): VnpayPaymentUrlResult {
  validateTxnRef(input.txnRef);
  validateOrderInfo(input.orderInfo);
  validateIpAddress(input.ipAddr);
  const createDate = parseGatewayDate(input.createDate, 'create date');
  const expireDate = parseGatewayDate(input.expireDate, 'expire date');
  if (expireDate.getTime() <= createDate.getTime())
    throw new Error('VNPay expiry must be after create date');
  const signedParams = createPaymentParams(input, config);
  const canonical = canonicalizeVnpayParams(signedParams);
  const secureHash = createHmac('sha512', config.hashSecret)
    .update(canonical, 'utf8')
    .digest('hex');
  const query = `${canonical}&vnp_SecureHash=${secureHash}`;
  return { paymentUrl: `${config.paymentUrl}?${query}`, signedParams };
}
