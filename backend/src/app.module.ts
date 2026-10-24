import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ProductsModule } from './products/products.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrdersModule } from './orders/orders.module.js';

@Module({
  imports: [ProductsModule, AuthModule, OrdersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
