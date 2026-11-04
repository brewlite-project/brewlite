import { ForbiddenException } from '@nestjs/common';

export function assertMockPaymentEnabled(): void {
  // Explicit opt-in only; production can never enable Mock, including replays.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.MOCK_PAYMENT_ENABLED !== 'true'
  )
    throw new ForbiddenException({
      statusCode: 403,
      message: 'Mock payment is disabled in this environment',
      error: 'Forbidden',
      code: 'MOCK_PAYMENT_DISABLED',
    });
}
