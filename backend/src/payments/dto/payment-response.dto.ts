import { ApiProperty } from '@nestjs/swagger';
import type { PaymentMethod } from './create-payment.dto.js';
export class PaymentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) paymentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['SUCCESS', 'FAILED'] }) paymentStatus!:
    'SUCCESS' | 'FAILED';
  @ApiProperty({ enum: ['PAID', 'PAYMENT_FAILED'] }) orderStatus!:
    'PAID' | 'PAYMENT_FAILED';
  @ApiProperty({ type: Number, minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  amountVnd!: number;
  @ApiProperty({ enum: ['CARD', 'WALLET'] }) method!: PaymentMethod;
  @ApiProperty({ type: String, pattern: '^[0-9]{4}$' }) methodLast4!: string;
  @ApiProperty({ type: String, example: 'MOCK-0003' }) mockReference!: string;
  @ApiProperty({ type: Number, minimum: 0 }) pointsEarned!: number;
  @ApiProperty({ type: String, nullable: true, enum: ['PAYMENT_DECLINED'] })
  failureReason!: 'PAYMENT_DECLINED' | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
