import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MockPaymentService } from './mock-payment.service.js';
import { PaymentProcessor } from './payment-processor.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentFinalizationService } from './payment-finalization.service.js';
import { VnpayInitiationService } from './vnpay-initiation.service.js';
import { VnpayIpnController } from './vnpay-ipn.controller.js';
import { VnpayIpnService } from './vnpay-ipn.service.js';
import { VnpayQueryDrService } from './vnpay-querydr.service.js';
import {
  CreatePaymentPipe,
  IdempotencyKeyPipe,
} from './payment-validation.pipe.js';
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [PaymentsController, VnpayIpnController],
  providers: [
    MockPaymentService,
    PaymentFinalizationService,
    VnpayInitiationService,
    VnpayIpnService,
    VnpayQueryDrService,
    PaymentsService,
    CreatePaymentPipe,
    IdempotencyKeyPipe,
    { provide: PaymentProcessor, useExisting: PaymentsService },
  ],
  exports: [MockPaymentService, PaymentsService, PaymentFinalizationService],
})
export class PaymentsModule {
  // Retained for the foundation HTTP tests; production imports the default module.
  static withProcessor(
    implementation: Type<PaymentProcessor>,
    imports: ModuleMetadata['imports'] = [],
  ): DynamicModule {
    return {
      module: PaymentsModule,
      imports,
      providers: [{ provide: PaymentProcessor, useClass: implementation }],
    };
  }
}
