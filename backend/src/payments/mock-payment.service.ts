import { Injectable } from '@nestjs/common';
import type { CreatePaymentDto } from './dto/create-payment.dto.js';
export type MockPaymentOutcome = {
  paymentStatus: 'SUCCESS' | 'FAILED';
  methodLast4: string;
  failureReason: 'PAYMENT_DECLINED' | null;
};
@Injectable()
export class MockPaymentService {
  evaluate(payment: CreatePaymentDto): MockPaymentOutcome {
    const details = payment.paymentDetails;
    const credential =
      'cardNumber' in details ? details.cardNumber : details.phoneNumber;
    const methodLast4 = credential.slice(-4);
    const declined =
      methodLast4 === (payment.method === 'CARD' ? '0002' : '0000');
    return {
      paymentStatus: declined ? 'FAILED' : 'SUCCESS',
      methodLast4,
      failureReason: declined ? 'PAYMENT_DECLINED' : null,
    };
  }
}
