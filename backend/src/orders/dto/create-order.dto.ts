import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderItemDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  productId!: string;

  @ApiProperty({ enum: ['S', 'M', 'L', 'ONE_SIZE'] })
  @IsIn(['S', 'M', 'L', 'ONE_SIZE'])
  size!: 'S' | 'M' | 'L' | 'ONE_SIZE';

  @ApiProperty({ type: [String], maxItems: 3 })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((id: unknown) =>
          typeof id === 'string' ? id.toLowerCase() : id,
        )
      : value,
  )
  @IsArray()
  @IsUUID(undefined, { each: true })
  toppingIds!: string[];

  @ApiProperty({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderItemDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  couponCode?: string;
}
