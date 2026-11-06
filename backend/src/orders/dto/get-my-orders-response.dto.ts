import { ApiProperty } from '@nestjs/swagger';

class OrderToppingSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 0 })
  priceVnd!: number;
}

class OrderItemSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ enum: ['S', 'M', 'L', 'ONE_SIZE'] })
  size!: string;

  @ApiProperty()
  sizeMultiplierPercent!: number;

  @ApiProperty({ minimum: 0 })
  basePriceVnd!: number;

  @ApiProperty({ minimum: 1 })
  quantity!: number;

  @ApiProperty({ minimum: 0 })
  unitPriceVnd!: number;

  @ApiProperty({ minimum: 0 })
  lineTotalVnd!: number;

  @ApiProperty({ type: [OrderToppingSummaryDto] })
  toppings!: OrderToppingSummaryDto[];
}

class PaymentSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['PENDING', 'SUCCESS', 'FAILED'] })
  status!: string;

  @ApiProperty({ enum: ['MOCK', 'VNPAY', 'ZERO_AMOUNT'] })
  provider!: string;

  @ApiProperty({ type: String, nullable: true, enum: ['CARD', 'WALLET'] })
  method!: string | null;

  @ApiProperty({ type: String, nullable: true, pattern: '^[0-9]{4}$' })
  methodLast4!: string | null;

  @ApiProperty({ minimum: 0 })
  amountVnd!: number;

  @ApiProperty({ type: String, nullable: true })
  mockReference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({
    enum: [
      'PROCESSING',
      'RECONCILING',
      'PAYMENT_ACCEPTED',
      'FAILED',
      'FINANCIAL_EXCEPTION',
      'REQUIRES_REVIEW',
    ],
  })
  resolution!: string;

  @ApiProperty()
  requiresReview!: boolean;

  @ApiProperty()
  canRetry!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

class MyOrderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: [
      'PENDING',
      'PAYMENT_FAILED',
      'PAID',
      'PREPARING',
      'READY',
      'COMPLETED',
      'CANCELLED',
    ],
  })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ minimum: 0 })
  subtotalVnd!: number;

  @ApiProperty({ minimum: 0 })
  discountVnd!: number;

  @ApiProperty({ minimum: 0 })
  totalVnd!: number;

  @ApiProperty({ type: String, nullable: true })
  couponCode!: string | null;

  @ApiProperty({ minimum: 0 })
  pointsEarned!: number;

  @ApiProperty({ type: [OrderItemSummaryDto] })
  items!: OrderItemSummaryDto[];

  @ApiProperty()
  hasFinancialException!: boolean;

  @ApiProperty({ type: PaymentSummaryDto, nullable: true })
  payment!: PaymentSummaryDto | null;
}

class MyOrdersMetaDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 1 })
  page!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 100 })
  limit!: number | null;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  totalPages!: number | null;
}

export class GetMyOrdersResponseDto {
  @ApiProperty({ type: [MyOrderDto] })
  items!: MyOrderDto[];

  @ApiProperty({ type: MyOrdersMetaDto })
  meta!: MyOrdersMetaDto;
}
