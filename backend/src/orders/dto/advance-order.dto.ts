import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/enums.js';

export class AdvanceOrderDto {
  @ApiProperty({
    enum: OrderStatus,
    example: 'PAID',
    description: 'Expected current status; the server chooses the next step.',
  })
  @IsEnum(OrderStatus)
  from: OrderStatus;
}

export class AdvanceOrderResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['PAID', 'PREPARING', 'READY'], example: 'PAID' })
  previousStatus: OrderStatus;

  @ApiProperty({
    enum: ['PREPARING', 'READY', 'COMPLETED'],
    example: 'PREPARING',
  })
  status: OrderStatus;
}
