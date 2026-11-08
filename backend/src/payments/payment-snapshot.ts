import { isUUID } from 'class-validator';
import type { PaymentResponseDto } from './dto/payment-response.dto.js';

// Read only the public response shape, never return an arbitrary stored JSON object.
export function readPaymentSnapshot(
  value: unknown,
  paymentId: string,
  orderId: string,
): PaymentResponseDto {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid payment snapshot');
  const v = value as Record<string, unknown>;
  if (
    v.paymentId !== paymentId ||
    v.orderId !== orderId ||
    !isUUID(paymentId) ||
    !isUUID(orderId) ||
    (v.method !== 'CARD' && v.method !== 'WALLET') ||
    typeof v.amountVnd !== 'number' ||
    !Number.isSafeInteger(v.amountVnd) ||
    v.amountVnd < 0 ||
    typeof v.pointsEarned !== 'number' ||
    !Number.isSafeInteger(v.pointsEarned) ||
    v.pointsEarned < 0 ||
    typeof v.methodLast4 !== 'string' ||
    !/^[0-9]{4}$/.test(v.methodLast4) ||
    typeof v.mockReference !== 'string' ||
    !v.mockReference.startsWith('MOCK-') ||
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error('Invalid payment snapshot');
  if (!(
    (v.paymentStatus === 'SUCCESS' &&
      v.orderStatus === 'PAID' &&
      v.failureReason === null) ||
    (v.paymentStatus === 'FAILED' &&
      v.orderStatus === 'PAYMENT_FAILED' &&
      v.failureReason === 'PAYMENT_DECLINED' &&
      v.pointsEarned === 0)
  ))
    throw new Error('Invalid payment snapshot');
  return {
    paymentId,
    orderId,
    method: v.method,
    paymentStatus: v.paymentStatus,
    orderStatus: v.orderStatus,
    amountVnd: v.amountVnd,
    methodLast4: v.methodLast4,
    mockReference: v.mockReference,
    pointsEarned: v.pointsEarned,
    failureReason: v.failureReason,
    createdAt: v.createdAt,
  };
}
