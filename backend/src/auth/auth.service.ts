
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hashPassword, verifyPassword } from './password-hash.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { RegisterResponseDto } from './dto/register-response.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { LoginResponseDto } from './dto/login-response.dto.js';
import type { MeResponseDto } from './dto/me-response.dto.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './jwt.config.js';

// Public dummy hash, not an account credential.
// Keep the Argon2id work factors equal to registration
// so an unknown email still performs a password comparison.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$mG7PSvxFcBnes/A6uf4Bxg$jN4wfxF0HsF54rHgyOd7a8Jce4+8xpTe/FuALxO+iJ4';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  // --------------------------------------------------
  // POST /auth/login
  // --------------------------------------------------
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email.trim().toLowerCase() },
        select: { id: true, passwordHash: true },
      });

      const matches = await verifyPassword(
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        dto.password,
      );

      if (!user || !matches) {
        throw new UnauthorizedException({
          statusCode: 401,
          message: 'Invalid email or password',
          error: 'Unauthorized',
          code: 'INVALID_CREDENTIALS',
        });
      }

      const accessToken = await this.jwt.signAsync({ sub: user.id });

      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;

      this.logger.error('Failed to log in customer');

      throw new InternalServerErrorException('Internal server error');
    }
  }

  // --------------------------------------------------
  // POST /auth/register
  // --------------------------------------------------
  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    try {
      const passwordHash = await hashPassword(dto.password);

      // The database unique constraint is authoritative,
      // including concurrent requests.
      const user = await this.prisma.user.create({
        data: {
          email: dto.email.trim().toLowerCase(),
          passwordHash,
          fullName: dto.fullName,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
        },
      });

      return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Email already exists',
          error: 'Conflict',
          code: 'EMAIL_ALREADY_EXISTS',
        });
      }

      // Do not log request, password, hash or raw database errors.
      this.logger.error('Failed to register customer');

      throw new InternalServerErrorException('Internal server error');
    }
  }

  // --------------------------------------------------
  // GET /auth/me – SCRUM-71
  // --------------------------------------------------
  async getMe(userId: string): Promise<MeResponseDto> {
    try {
      // userId must come from the verified JWT.sub,
      // never from client-supplied body or query parameters.
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          loyaltyPoints: true,
        },
      });

      // A valid token referencing a deleted user
      // no longer represents a valid authenticated principal.
      if (!user) {
        throw new UnauthorizedException({
          statusCode: 401,
          message: 'Unauthorized',
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
        });
      }

      // Return only the four fields approved by API Contract v3.0.
      // Never expose passwordHash, role or other internal data.
      return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        loyaltyPoints: user.loyaltyPoints,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      // Avoid logging sensitive user or database information.
      this.logger.error('Failed to retrieve customer profile');

      throw new InternalServerErrorException({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    }
  }
}
