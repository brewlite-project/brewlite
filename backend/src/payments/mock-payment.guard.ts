import { Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { assertMockPaymentEnabled } from './mock-payment.policy.js';

@Injectable()
export class MockPaymentGuard implements CanActivate {
  canActivate(): boolean {
    // Runs before body/key pipes and before any processor (including replay).
    assertMockPaymentEnabled();
    return true;
  }
}
