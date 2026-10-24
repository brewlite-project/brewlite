import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
