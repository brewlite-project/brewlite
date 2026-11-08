import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { OrderStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AdvanceOrderResponseDto } from './dto/advance-order.dto.js';

const nextStatus: Partial<Record<OrderStatus, OrderStatus>> = {
  PAID: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COMPLETED',
};

@Injectable()
export class OrderStateService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async advance(
    id: string,
    from: OrderStatus,
  ): Promise<AdvanceOrderResponseDto> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
          if (!locked.length)
            throw new NotFoundException({
              statusCode: 404,
              message: 'Order not found',
              error: 'Not Found',
              code: 'NOT_FOUND',
            });

          // Read after acquiring the lock: a competing request may have advanced it.
          const order = await tx.order.findUniqueOrThrow({
            where: { id },
            select: { id: true, status: true },
          });
          const status = nextStatus[order.status];
          if (order.status !== from || !status)
            throw new ConflictException({
              statusCode: 409,
              message: 'Order cannot advance from the specified status',
              error: 'Conflict',
              code: 'INVALID_TRANSITION',
            });

          await tx.order.update({ where: { id }, data: { status } });
          return { id: order.id, previousStatus: order.status, status };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 8000,
        },
      );
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )
        throw error;
      // Never expose SQL, connection details, or transaction errors to callers.
      throw new InternalServerErrorException({
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
        code: 'INTERNAL_ERROR',
      });
    }
  }
}
