import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.headers['x-internal-key'];
    const secret = process.env.INTERNAL_SECRET;
    // Fail closed when the internal API has not been configured.
    if (secret && typeof supplied === 'string') {
      const expected = Buffer.from(secret);
      const actual = Buffer.from(supplied);
      if (
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
      )
        return true;
    }
    throw new ForbiddenException({
      statusCode: 403,
      message: 'Invalid internal key',
      error: 'Forbidden',
      code: 'FORBIDDEN',
    });
  }
}
