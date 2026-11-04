import 'dotenv/config';
import { isIP } from 'node:net';
import { loadVnpayQueryDrConfig } from './vnpay.config.js';

export const PAYMENT_RECONCILIATION_OPTIONS = Symbol('PAYMENT_RECONCILIATION_OPTIONS');
export const PAYMENT_RECONCILIATION_GRACE_MS = 5 * 60_000;
export const PAYMENT_RECONCILIATION_COOLDOWN_MS = 10 * 60_000;

export type PaymentReconciliationOptions = Readonly<{
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  leaseMs: number;
  cooldownMs: number;
  ipAddr: string;
}>;

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function getPaymentReconciliationOptions(): PaymentReconciliationOptions {
  // A missing or disabled scheduler must never pass unnoticed in production:
  // otherwise PENDING gateway attempts can remain unreconciled indefinitely.
  const runtime = process.env.NODE_ENV;
  const production = runtime === 'production';
  const enabled = process.env.PAYMENT_RECONCILIATION_ENABLED;
  if (production && enabled !== 'true')
    throw new Error('Production requires PAYMENT_RECONCILIATION_ENABLED=true and valid QueryDR configuration');
  if (enabled === undefined && runtime !== 'test' && runtime !== 'development')
    throw new Error('PAYMENT_RECONCILIATION_ENABLED must be explicit outside development/test');
  if (enabled !== undefined && !['true', 'false'].includes(enabled))
    throw new Error('PAYMENT_RECONCILIATION_ENABLED must be true or false');
  const intervalMs = integerEnv('PAYMENT_RECONCILIATION_INTERVAL_MS', 60_000, 1_000, 300_000);
  const batchSize = integerEnv('PAYMENT_RECONCILIATION_BATCH_SIZE', 50, 1, 500);
  const leaseMs = integerEnv('PAYMENT_RECONCILIATION_LEASE_MS', 60_000, 5_000, 600_000);
  // The BR-05 post-grace cadence is no faster than every ten minutes.
  const cooldownMs = integerEnv('PAYMENT_RECONCILIATION_COOLDOWN_MS', PAYMENT_RECONCILIATION_COOLDOWN_MS, PAYMENT_RECONCILIATION_COOLDOWN_MS, 3_600_000);
  const ipAddr = (process.env.PAYMENT_RECONCILIATION_IP_ADDR ?? '').trim();
  if (enabled === 'true') {
    if (isIP(ipAddr) === 0) throw new Error('PAYMENT_RECONCILIATION_IP_ADDR must be a valid server IP address');
    const { timeoutMs } = loadVnpayQueryDrConfig();
    // Leave headroom for response parsing, finalization and DB claim cleanup.
    if (leaseMs < timeoutMs + 13_000)
      throw new Error('PAYMENT_RECONCILIATION_LEASE_MS must exceed VNPAY_QUERYDR_TIMEOUT_MS by at least 13000ms');
  }
  return { enabled: enabled === 'true', intervalMs, batchSize, leaseMs, cooldownMs, ipAddr };
}
