import { ApiProperty } from '@nestjs/swagger';

class OrderToppingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() priceVnd!: number;
}

class OrderItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty({ enum: ['S', 'M', 'L', 'ONE_SIZE'] }) size!: string;
  @ApiProperty() sizeMultiplierPercent!: number;
  @ApiProperty() basePriceVnd!: number;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPriceVnd!: number;
  @ApiProperty() lineTotalVnd!: number;
  @ApiProperty({ type: [OrderToppingResponseDto] })
  toppings!: OrderToppingResponseDto[];
}

export class CreateOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['PENDING'] }) status!: string;
  @ApiProperty({ type: [OrderItemResponseDto] }) items!: OrderItemResponseDto[];
  @ApiProperty({ type: String, nullable: true }) couponCode!: string | null;
  @ApiProperty() subtotalVnd!: number;
  @ApiProperty() discountVnd!: number;
  @ApiProperty() totalVnd!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
