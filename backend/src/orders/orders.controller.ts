import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { CreateOrderResponseDto } from './dto/create-order-response.dto.js';
import { OrdersService } from './orders.service.js';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a PENDING order from the cart' })
  @ApiBody({ type: CreateOrderDto })
  @ApiCreatedResponse({
    type: CreateOrderResponseDto,
    description:
      'Order and price snapshots created (API Contract v2.1 section 8.6)',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR, INVALID_CART or INVALID_COUPON',
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHORIZED' })
  @ApiConflictResponse({
    description: 'INSUFFICIENT_STOCK or PENDING_ORDER_EXISTS',
  })
  create(
    @Req() req: { user: AuthenticatedUser },
    @Body(
      new ValidationPipe({
        expectedType: CreateOrderDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        exceptionFactory: () =>
          new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'VALIDATION_ERROR',
            message: 'Invalid order request',
          }),
      }),
    )
    dto: CreateOrderDto,
  ) {
    return this.orders.create(req.user.userId, dto);
  }
}
