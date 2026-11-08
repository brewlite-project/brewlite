import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
export type PaymentMethod = 'CARD' | 'WALLET';
export class CardPaymentDetailsDto {
  @ApiProperty({ type: String, pattern: '^[0-9]{16}$', writeOnly: true })
  cardNumber!: string;
}
export class WalletPaymentDetailsDto {
  @ApiProperty({ type: String, pattern: '^[0-9]{10}$', writeOnly: true })
  phoneNumber!: string;
}
@ApiExtraModels(CardPaymentDetailsDto, WalletPaymentDetailsDto)
export class CreatePaymentDto {
  @ApiProperty({ type: String, format: 'uuid' })
  orderId!: string;
  @ApiProperty({ enum: ['CARD', 'WALLET'] })
  method!: PaymentMethod;
  @ApiProperty({
    description:
      'CARD: cardNumber only; WALLET: phoneNumber only. Test data only.',
    oneOf: [
      { $ref: getSchemaPath(CardPaymentDetailsDto) },
      { $ref: getSchemaPath(WalletPaymentDetailsDto) },
    ],
  })
  paymentDetails!: CardPaymentDetailsDto | WalletPaymentDetailsDto;
}
