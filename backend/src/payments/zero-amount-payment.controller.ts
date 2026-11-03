import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import {
  ZeroAmountPaymentDto,
  ZeroAmountPaymentResponseDto,
} from './dto/zero-amount-payment.dto.js';
import { ZeroAmountPaymentPipe } from './payment-validation.pipe.js';
import { ZeroAmountPaymentService } from './zero-amount-payment.service.js';

const replayHeaders = {
  'Idempotency-Replayed': {
    description: 'false on first completion; true for replay',
    schema: { type: 'string' as const, enum: ['false', 'true'] },
  },
};

@ApiTags('Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments/zero-amount')
export class ZeroAmountPaymentController {
  constructor(
    @Inject(ZeroAmountPaymentService)
    private readonly payment: ZeroAmountPaymentService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Complete an owned zero-VND Order without a gateway or Mock payment',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 64 },
  })
  @ApiBody({ type: ZeroAmountPaymentDto })
  @ApiResponse({
    status: 201,
    type: ZeroAmountPaymentResponseDto,
    headers: replayHeaders,
  })
  @ApiResponse({
    status: 200,
    type: ZeroAmountPaymentResponseDto,
    headers: replayHeaders,
    description: 'Immutable response replay',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({
    status: 404,
    description: 'NOT_FOUND: missing Order or another owner',
  })
  @ApiResponse({
    status: 409,
    description:
      'ORDER_NOT_ZERO_AMOUNT | ORDER_EXPIRED | INVALID_TRANSITION | IDEMPOTENCY_KEY_CONFLICT | PAYMENT_IN_PROGRESS | FINANCIAL_EXCEPTION_REQUIRES_REVIEW',
  })
  @ApiResponse({ status: 500, description: 'INTERNAL_ERROR' })
  async complete(
    @Req() req: Request & { user: AuthenticatedUser },
    @Headers('idempotency-key') key: unknown,
    @Body(ZeroAmountPaymentPipe) dto: ZeroAmountPaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ZeroAmountPaymentResponseDto> {
    const result = await this.payment.execute(req.user.userId, key, dto);
    res.status(result.replayed ? 200 : 201);
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.response;
  }
}
