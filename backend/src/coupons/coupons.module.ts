import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CouponsController } from './coupons.controller.js';
import { CouponsService } from './coupons.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [CouponsController],
  providers: [CouponsService],
})
export class CouponsModule {}
