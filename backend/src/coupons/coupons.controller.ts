import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/jwt.strategy.js';
import { CouponPreviewDto } from './dto/coupon-preview.dto.js';
import { CouponPreviewResponseDto } from './dto/coupon-preview-response.dto.js';
import { CouponsService } from './coupons.service.js';

const validationError = () =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'VALIDATION_ERROR',
    message: 'Invalid coupon preview request',
  });

@ApiTags('Coupons')
@ApiBearerAuth()
@Controller('coupons')
@UseGuards(JwtAuthGuard)
export class CouponsController {
  constructor(@Inject(CouponsService) private readonly coupons: CouponsService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a coupon against the authenticated customer cart',
    description:
      'Read-only. Rechecks coupon validity and quota when Create Order is submitted.',
  })
  @ApiBody({ type: CouponPreviewDto })
  @ApiOkResponse({ type: CouponPreviewResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR, INVALID_CART or INVALID_COUPON',
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHORIZED' })
  @ApiConflictResponse({ description: 'COUPON_UNAVAILABLE' })
  @ApiInternalServerErrorResponse({ description: 'INTERNAL_ERROR' })
  preview(
    @Req() req: { user: AuthenticatedUser },
    @Body(
      new ValidationPipe({
        expectedType: CouponPreviewDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        exceptionFactory: validationError,
      }),
    )
    dto: CouponPreviewDto,
  ) {
    return this.coupons.preview(req.user.userId, dto);
  }
}
