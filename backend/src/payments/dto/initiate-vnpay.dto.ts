import { ApiProperty } from '@nestjs/swagger';

export class InitiateVnpayDto {
  @ApiProperty({ type: String, format: 'uuid' })
  orderId!: string;
}

export class VnpayInitiationResponseDto {
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['VNPAY'] }) provider!: 'VNPAY';
  @ApiProperty({ enum: ['PENDING', 'SUCCESS', 'FAILED'] }) paymentStatus!: 'PENDING' | 'SUCCESS' | 'FAILED';
  @ApiProperty() orderStatus!: string;
  @ApiProperty() amountVnd!: number;
  @ApiProperty() paymentUrl!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
