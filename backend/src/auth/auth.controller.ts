
import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { RegisterResponseDto } from './dto/register-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { MeResponseDto } from './dto/me-response.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthenticatedUser } from './jwt.strategy.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService)
    private readonly authService: AuthService,
  ) {}

  // --------------------------------------------------
  // POST /auth/login
  // --------------------------------------------------
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Đăng nhập và cấp JWT có hiệu lực 1 giờ',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR',
    schema: {
      example: {
        statusCode: 400,
        message: ['password should not be empty'],
        error: 'Bad Request',
        code: 'VALIDATION_ERROR',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'INVALID_CREDENTIALS',
    schema: {
      example: {
        statusCode: 401,
        message: 'Invalid email or password',
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
      },
    },
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
  login(
    @Body(
      new ValidationPipe({
        expectedType: LoginDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        validationError: {
          target: false,
          value: false,
        },
        exceptionFactory: (errors) =>
          new BadRequestException({
            statusCode: 400,
            message: errors.flatMap((error) =>
              Object.values(error.constraints ?? {}),
            ),
            error: 'Bad Request',
            code: 'VALIDATION_ERROR',
          }),
      }),
    )
    dto: LoginDto,
  ): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  // --------------------------------------------------
  // POST /auth/register
  // --------------------------------------------------
  @Post('register')
  @ApiOperation({
    summary: 'Đăng ký Customer; không tự động đăng nhập',
  })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiBadRequestResponse({
    description: 'VALIDATION_ERROR',
    schema: {
      example: {
        statusCode: 400,
        message: [
          'password must be longer than or equal to 8 characters',
        ],
        error: 'Bad Request',
        code: 'VALIDATION_ERROR',
      },
    },
  })
  @ApiConflictResponse({
    description: 'EMAIL_ALREADY_EXISTS',
    schema: {
      example: {
        statusCode: 409,
        message: 'Email already exists',
        error: 'Conflict',
        code: 'EMAIL_ALREADY_EXISTS',
      },
    },
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
  register(
    @Body(
      new ValidationPipe({
        expectedType: RegisterDto,
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        validationError: {
          target: false,
          value: false,
        },
        exceptionFactory: (errors) =>
          new BadRequestException({
            statusCode: 400,
            message: errors.flatMap((error) =>
              Object.values(error.constraints ?? {}),
            ),
            error: 'Bad Request',
            code: 'VALIDATION_ERROR',
          }),
      }),
    )
    dto: RegisterDto,
  ): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  // --------------------------------------------------
  // GET /auth/me – SCRUM-71
  // --------------------------------------------------
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Lấy thông tin Customer và điểm Loyalty hiện tại',
    description:
      'Xác thực Bearer JWT và lấy thông tin Customer từ PostgreSQL. ' +
      'User ID được lấy từ JWT.sub, không nhận từ client. ' +
      'Không trả passwordHash hoặc dữ liệu nhạy cảm.',
  })
  @ApiOkResponse({
    description: 'Customer profile retrieved successfully',
    type: MeResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'UNAUTHORIZED – JWT thiếu/sai/hết hạn hoặc User không còn tồn tại',
    schema: {
      example: {
        statusCode: 401,
        message: 'Unauthorized',
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      },
    },
  })
  @ApiInternalServerErrorResponse({
    description: 'INTERNAL_ERROR – Unexpected server error',
    schema: {
      example: {
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      },
    },
  })
  getMe(
    @Req() request: { user: AuthenticatedUser },
  ): Promise<MeResponseDto> {
    return this.authService.getMe(request.user.userId);
  }
}
