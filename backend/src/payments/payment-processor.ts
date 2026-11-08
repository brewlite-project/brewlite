import type { CreatePaymentDto } from './dto/create-payment.dto.js';
import type { PaymentResponseDto } from './dto/payment-response.dto.js';
export abstract class PaymentProcessor {
  abstract execute(
    userId: string,
    idempotencyKey: string,
    payment: CreatePaymentDto,
  ): Promise<{ response: PaymentResponseDto; replayed: boolean }>;
}
