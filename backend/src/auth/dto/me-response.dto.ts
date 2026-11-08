import { ApiProperty } from '@nestjs/swagger';

export class MeResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'customer@example.com' })
  email!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Nguyen Van A',
  })
  fullName!: string | null;

  @ApiProperty({ example: 125, minimum: 0 })
  loyaltyPoints!: number;
}