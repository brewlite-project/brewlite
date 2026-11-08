import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  AdvanceOrderDto,
  AdvanceOrderResponseDto,
} from './dto/advance-order.dto.js';
import { InternalKeyGuard } from './internal-key.guard.js';
import { OrderStateService } from './order-state.service.js';

const validationError = () =>
  new BadRequestException({
    statusCode: 400,
    message: 'Invalid order advance request',
    error: 'Bad Request',
    code: 'VALIDATION_ERROR',
  });

@ApiTags('Internal Orders')
@ApiSecurity('internal-key')
@UseGuards(InternalKeyGuard)
@Controller('internal/orders')
export class InternalOrdersController {
  constructor(
    @Inject(OrderStateService) private readonly states: OrderStateService,
  ) {}

  @Post(':id/advance')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Advance an order by one step: PAID → PREPARING → READY → COMPLETED',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: AdvanceOrderDto })
  @ApiOkResponse({ type: AdvanceOrderResponseDto })
  @ApiBadRequestResponse({ description: 'VALIDATION_ERROR' })
  @ApiForbiddenResponse({
    description: 'FORBIDDEN: missing or invalid internal key',
  })
  @ApiNotFoundResponse({ description: 'NOT_FOUND' })
  @ApiConflictResponse({ description: 'INVALID_TRANSITION' })
  @ApiInternalServerErrorResponse({ description: 'INTERNAL_ERROR' })
  advance(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: validationError }))
    id: string,
    @Body(
      new ValidationPipe({
        expectedType: AdvanceOrderDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        exceptionFactory: validationError,
      }),
    )
    dto: AdvanceOrderDto,
  ) {
    return this.states.advance(id, dto.from);
  }
}
