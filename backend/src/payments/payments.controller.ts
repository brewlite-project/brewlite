import {
  Body,
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
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
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { PaymentResponseDto } from './dto/payment-response.dto.js';
import { InitiateVnpayDto, VnpayInitiationResponseDto } from './dto/initiate-vnpay.dto.js';
import { VnpayInitiationService } from './vnpay-initiation.service.js';
import { PaymentProcessor } from './payment-processor.js';
import { MockPaymentGuard } from './mock-payment.guard.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';

@ApiTags('Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(PaymentProcessor) private readonly processor: PaymentProcessor,
    @Inject(IdempotencyKeyPipe) private readonly keyPipe: IdempotencyKeyPipe,
    private readonly vnpay: VnpayInitiationService,
  ) {}
  @Post()
  @UseGuards(MockPaymentGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mock payment for an owned Order',
    description:
      'Requires MOCK_PAYMENT_ENABLED=true and NODE_ENV other than production; otherwise returns 403 MOCK_PAYMENT_DISABLED, including replays. CARD ending 0002 or WALLET ending 0000 declines; other valid test details succeed. Both return HTTP 200. Retry a timed-out request with the same key. Never falls back from an unresolved VNPay payment.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 8, maxLength: 64 },
  })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({
    status: 200,
    type: PaymentResponseDto,
    description: 'SUCCESS or FAILED; immutable stored response on replay',
    headers: {
      'Idempotency-Replayed': {
        description: 'false on first attempt; true for replay',
        schema: { type: 'string', enum: ['false', 'true'] },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'MOCK_PAYMENT_DISABLED' })
  @ApiResponse({
    status: 404,
    description: 'NOT_FOUND: missing Order or another owner',
  })
  @ApiResponse({
    status: 409,
    description:
      'INVALID_TRANSITION | IDEMPOTENCY_KEY_CONFLICT | PAYMENT_IN_PROGRESS | FINANCIAL_EXCEPTION_REQUIRES_REVIEW',
  })
  @ApiResponse({ status: 500, description: 'INTERNAL_ERROR' })
  async create(
    @Req() req: Request & { user: AuthenticatedUser },
    @Headers('idempotency-key') key: unknown,
    @Body(CreatePaymentPipe) dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentResponseDto> {
    const result = await this.processor.execute(
      req.user.userId,
      this.keyPipe.transform(key),
      dto,
    );
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.response;
  }

  @Post('vnpay/initiate')
  @ApiOperation({ summary: 'Create a signed VNPay Sandbox payment attempt' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 64 } })
  @ApiBody({ type: InitiateVnpayDto })
  @ApiResponse({ status: 201, type: VnpayInitiationResponseDto })
  @ApiResponse({ status: 200, type: VnpayInitiationResponseDto, description: 'Idempotency replay' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ORDER_EXPIRED | ZERO_AMOUNT_REQUIRED | INVALID_TRANSITION | PAYMENT_IN_PROGRESS | IDEMPOTENCY_KEY_CONFLICT | FINANCIAL_EXCEPTION_REQUIRES_REVIEW' })
  @ApiResponse({ status: 500, description: 'INTERNAL_ERROR' })
  async initiateVnpay(
    @Req() req: Request & { user: AuthenticatedUser },
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VnpayInitiationResponseDto> {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof (body as Record<string, unknown>).orderId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((body as Record<string, unknown>).orderId as string))
      throw new BadRequestException({ statusCode: 400, message: ['orderId must be a UUID'], error: 'Bad Request', code: 'VALIDATION_ERROR' });
    const dto = { orderId: ((body as Record<string, unknown>).orderId as string).toLowerCase() };
    const result = await this.vnpay.initiate(req.user.userId, this.keyPipe.transform(key), dto, req.ip);
    res.status(result.created ? 201 : 200);
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.response;
  }
}
