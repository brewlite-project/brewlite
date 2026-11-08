import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
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
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { CreateOrderResponseDto } from './dto/create-order-response.dto.js';
import { GetMyOrdersQueryDto } from './dto/get-my-orders-query.dto.js';
import { GetMyOrdersResponseDto } from './dto/get-my-orders-response.dto.js';
import { OrdersService } from './orders.service.js';

const validationError = () =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'VALIDATION_ERROR',
    message: 'Invalid order history query',
  });

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user order history' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    minimum: 1,
    description: 'Positive integer; must be sent together with limit.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
    description: 'Integer 1..100; must be sent together with page.',
  })
  @ApiOkResponse({ type: GetMyOrdersResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHORIZED' })
  @ApiInternalServerErrorResponse({ description: 'INTERNAL_ERROR' })
  getMine(
    @Req() req: { user: AuthenticatedUser },
    @Query(
      new ValidationPipe({
        expectedType: GetMyOrdersQueryDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        exceptionFactory: validationError,
      }),
    )
    query: GetMyOrdersQueryDto,
  ) {
    if ((query.page === undefined) !== (query.limit === undefined))
      throw validationError();
    return this.orders.getMine(req.user.userId, query);
  }

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
    description: 'INSUFFICIENT_STOCK, PENDING_ORDER_EXISTS or COUPON_UNAVAILABLE',
  })
  @ApiInternalServerErrorResponse({
    description: 'Unexpected server error',
    schema: {
      example: {
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
      },
    },
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
