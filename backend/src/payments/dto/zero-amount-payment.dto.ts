import { ApiProperty } from '@nestjs/swagger';

export class ZeroAmountPaymentDto {
  @ApiProperty({ type: String, format: 'uuid' })
  orderId!: string;
}

export class ZeroAmountPaymentResponseDto {
  @ApiProperty({ type: String, format: 'uuid' }) paymentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['ZERO_AMOUNT'] }) provider!: 'ZERO_AMOUNT';
  @ApiProperty({ enum: ['SUCCESS'] }) paymentStatus!: 'SUCCESS';
  @ApiProperty({ enum: ['PAID'] }) orderStatus!: 'PAID';
  @ApiProperty({ type: Number, enum: [0] }) amountVnd!: 0;
  @ApiProperty({ type: Number, enum: [0] }) pointsEarned!: 0;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
