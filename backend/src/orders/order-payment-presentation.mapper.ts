import { InternalServerErrorException } from '@nestjs/common';
import { readPaymentSnapshot } from '../payments/payment-snapshot.js';

export type OrderHistoryPaymentProvider = 'MOCK' | 'VNPAY' | 'ZERO_AMOUNT';
export type OrderHistoryPaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type OrderHistoryPaymentResolution =
  | 'PROCESSING'
  | 'RECONCILING'
  | 'PAYMENT_ACCEPTED'
  | 'FAILED'
  | 'FINANCIAL_EXCEPTION'
  | 'REQUIRES_REVIEW';

export type OrderHistoryGatewayEventRow = {
  outcome?: string | null;
  disposition?: string | null;
  responseCode?: string | null;
  transactionStatus?: string | null;
  exceptionReason?: string | null;
  verifiedAt?: Date | null;
  createdAt?: Date | null;
};

export type OrderHistoryPaymentRow = {
  id: string;
  status: OrderHistoryPaymentStatus;
  provider?: OrderHistoryPaymentProvider;
  method: string | null;
  methodLast4: string | null;
  amountVnd: bigint;
  mockReference: string | null;
  responseSnapshot?: unknown;
  finalOutcomeSnapshot?: unknown;
  reconciliationState?: string | null;
  hasFinancialException?: boolean | null;
  createdAt: Date;
  updatedAt?: Date;
  gatewayEvents?: OrderHistoryGatewayEventRow[];
};

export type OrderHistoryOrderRow = {
  id: string;
  status: string;
  expiresAt: Date;
  payments: OrderHistoryPaymentRow[];
};

export type OrderHistoryPaymentSummary = {
  id: string;
  status: OrderHistoryPaymentStatus;
  provider: OrderHistoryPaymentProvider;
  method: string | null;
  methodLast4: string | null;
  amountVnd: number;
  mockReference: string | null;
  failureReason: string | null;
  resolution: OrderHistoryPaymentResolution;
  requiresReview: boolean;
  canRetry: boolean;
  createdAt: string;
};

const ACCEPTED_ORDER_STATUSES = new Set([
  'PAID',
  'PREPARING',
  'READY',
  'COMPLETED',
]);

function safeMoney(value: bigint): number {
  const number = Number(value);
  if (value < 0n || !Number.isSafeInteger(number))
    throw new InternalServerErrorException('Invalid monetary amount');
  return number;
}

function compareDesc(a: OrderHistoryPaymentRow, b: OrderHistoryPaymentRow): number {
  const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return b.id.localeCompare(a.id);
}

function hasPaymentExceptionEvidence(payment: OrderHistoryPaymentRow): boolean {
  if (payment.hasFinancialException) return true;
  const events = Array.isArray(payment.gatewayEvents) ? payment.gatewayEvents : [];
  return events.some(
    (event) =>
      event.disposition === 'FINANCIAL_EXCEPTION' ||
      event.disposition === 'CONFLICT',
  );
}

export function computeOrderHasFinancialException(
  order: OrderHistoryOrderRow,
): boolean {
  const hasPaymentFlagOrEvent = order.payments.some(hasPaymentExceptionEvidence);
  if (hasPaymentFlagOrEvent) return true;
  // Appendix C row 6: CANCELLED order with a recorded financial SUCCESS is a financial exception.
  return (
    order.status === 'CANCELLED' &&
    order.payments.some((payment) => payment.status === 'SUCCESS')
  );
}

export function selectRepresentativePayment(
  payments: readonly OrderHistoryPaymentRow[],
): OrderHistoryPaymentRow | null {
  const sorted = [...payments].sort(compareDesc);
  return (
    sorted.find((candidate) => candidate.status === 'SUCCESS') ??
    sorted.find((candidate) => candidate.status === 'PENDING') ??
    sorted.find((candidate) => candidate.status === 'FAILED') ??
    null
  );
}

function readVnpayFailureReason(payment: OrderHistoryPaymentRow): string | null {
  if (payment.status !== 'FAILED') return null;
  for (const raw of [payment.finalOutcomeSnapshot, payment.responseSnapshot]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.failureReason === 'string' && record.failureReason.trim()) {
      return record.failureReason.trim();
    }
    const responseCode =
      typeof record.responseCode === 'string' && record.responseCode.trim()
        ? record.responseCode.trim()
        : null;
    const transactionStatus =
      typeof record.transactionStatus === 'string' && record.transactionStatus.trim()
        ? record.transactionStatus.trim()
        : null;
    if (responseCode && responseCode !== '00') {
      return `VNPAY_RESPONSE_${responseCode}`;
    }
    if (transactionStatus && transactionStatus !== '00') {
      return `VNPAY_STATUS_${transactionStatus}`;
    }
  }
  const events = Array.isArray(payment.gatewayEvents) ? payment.gatewayEvents : [];
  const failedEvent = events.find((event) => event.outcome === 'FAILED');
  if (failedEvent) {
    if (failedEvent.responseCode && failedEvent.responseCode !== '00') {
      return `VNPAY_RESPONSE_${failedEvent.responseCode}`;
    }
    if (failedEvent.transactionStatus && failedEvent.transactionStatus !== '00') {
      return `VNPAY_STATUS_${failedEvent.transactionStatus}`;
    }
  }
  return 'PAYMENT_DECLINED';
}

function readFailureReason(
  payment: OrderHistoryPaymentRow,
  provider: OrderHistoryPaymentProvider,
  orderId: string,
): string | null {
  if (provider === 'MOCK') {
    try {
      const snapshot = readPaymentSnapshot(
        payment.responseSnapshot,
        payment.id,
        orderId,
      );
      return snapshot.failureReason;
    } catch {
      return payment.status === 'FAILED' ? 'PAYMENT_DECLINED' : null;
    }
  }
  if (provider === 'ZERO_AMOUNT') {
    if (payment.status !== 'SUCCESS') {
      throw new InternalServerErrorException(
        'ZERO_AMOUNT payment must have terminal SUCCESS status',
      );
    }
    return null;
  }
  return readVnpayFailureReason(payment);
}

export function mapOrderPaymentPresentation(
  order: OrderHistoryOrderRow,
  now: Date = new Date(),
): {
  hasFinancialException: boolean;
  payment: OrderHistoryPaymentSummary | null;
} {
  const sortedPayments = [...order.payments].sort(compareDesc);
  const hasFinancialException = computeOrderHasFinancialException(order);
  const payment = selectRepresentativePayment(sortedPayments);

  if (!payment) {
    return {
      hasFinancialException,
      payment: null,
    };
  }

  const provider: OrderHistoryPaymentProvider = payment.provider ?? 'MOCK';
  const failureReason = readFailureReason(payment, provider, order.id);
  const anyRequiresReview =
    hasFinancialException ||
    sortedPayments.some(
      (candidate) => candidate.reconciliationState === 'REQUIRES_REVIEW',
    );
  const anySuccess = sortedPayments.some(
    (candidate) => candidate.status === 'SUCCESS',
  );
  const anyPending = sortedPayments.some(
    (candidate) => candidate.status === 'PENDING',
  );

  let resolution: OrderHistoryPaymentResolution;
  if (hasFinancialException) {
    resolution = 'FINANCIAL_EXCEPTION';
  } else if (anyRequiresReview) {
    resolution = 'REQUIRES_REVIEW';
  } else if (
    payment.status === 'SUCCESS' &&
    ACCEPTED_ORDER_STATUSES.has(order.status)
  ) {
    resolution = 'PAYMENT_ACCEPTED';
  } else if (payment.status === 'SUCCESS') {
    resolution = 'FINANCIAL_EXCEPTION';
  } else if (payment.status === 'FAILED') {
    resolution = 'FAILED';
  } else if (
    order.status === 'CANCELLED' ||
    now.getTime() >= order.expiresAt.getTime()
  ) {
    resolution = 'RECONCILING';
  } else {
    resolution = 'PROCESSING';
  }

  const requiresReview =
    resolution === 'FINANCIAL_EXCEPTION' || resolution === 'REQUIRES_REVIEW';

  const isLatestAttemptFailed = sortedPayments[0]?.id === payment.id;
  const isOrderActiveForRetry =
    order.status === 'PENDING' || order.status === 'PAYMENT_FAILED';
  const isBeforeExpiry = now.getTime() < order.expiresAt.getTime();

  const canRetry =
    provider !== 'ZERO_AMOUNT' &&
    payment.status === 'FAILED' &&
    isLatestAttemptFailed &&
    isOrderActiveForRetry &&
    isBeforeExpiry &&
    !anySuccess &&
    !anyPending &&
    !anyRequiresReview &&
    !hasFinancialException;

  return {
    hasFinancialException:
      hasFinancialException || resolution === 'FINANCIAL_EXCEPTION',
    payment: {
      id: payment.id,
      status: payment.status,
      provider,
      method: provider === 'MOCK' ? payment.method : null,
      methodLast4: provider === 'MOCK' ? payment.methodLast4 : null,
      amountVnd: safeMoney(payment.amountVnd),
      mockReference: provider === 'MOCK' ? payment.mockReference : null,
      failureReason,
      resolution,
      requiresReview,
      canRetry,
      createdAt: payment.createdAt.toISOString(),
    },
  };
}
