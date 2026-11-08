import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { InternalOrdersController } from './internal-orders.controller.js';
import { InternalKeyGuard } from './internal-key.guard.js';
import { OrderStateService } from './order-state.service.js';
import { OrderExpirationService } from './order-expiration.service.js';
import {
  getOrderExpirationOptions,
  ORDER_EXPIRATION_OPTIONS,
} from './order-expiration.config.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OrdersController, InternalOrdersController],
  providers: [
    OrdersService,
    OrderStateService,
    InternalKeyGuard,
    OrderExpirationService,
    {
      provide: ORDER_EXPIRATION_OPTIONS,
      useFactory: getOrderExpirationOptions,
    },
  ],
})
export class OrdersModule {}
