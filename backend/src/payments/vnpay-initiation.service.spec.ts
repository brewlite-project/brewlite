import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { p2002ConstraintNames } from './vnpay-initiation.service.js';

describe('VNPay P2002 metadata extraction', () => {
  it.each([
    [{ target: ['user_id', 'idempotency_key'] }, ['user_id', 'idempotency_key']],
    [{ driverAdapterError: { cause: { constraint: { index: 'uq_payments_one_pending_vnpay_per_order' } } } }, ['uq_payments_one_pending_vnpay_per_order']],
    [{ driverAdapterError: { cause: { constraint: { index: 'uq_payments_vnp_txn_ref' } } } }, ['uq_payments_vnp_txn_ref']],
  ])('reads safe constraint identifiers from Prisma metadata %#', (meta, expected) => {
    const cause = new Prisma.PrismaClientKnownRequestError('database error', {
      code: 'P2002', clientVersion: 'test', meta,
    });
    expect(p2002ConstraintNames(cause)).toEqual(expected);
  });
});
