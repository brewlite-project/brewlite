import { ApiProperty } from '@nestjs/swagger';

export class CouponPreviewResponseDto {
  @ApiProperty({ example: 'FREE100', maxLength: 30 })
  couponCode!: string;

  @ApiProperty({ example: 100000, minimum: 0 })
  subtotalVnd!: number;

  @ApiProperty({ example: 100000, minimum: 0 })
  discountVnd!: number;

  @ApiProperty({ example: 0, minimum: 0 })
  totalVnd!: number;

  @ApiProperty({ enum: [true], example: true })
  valid!: true;
}
