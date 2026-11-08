import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentFinalizationService, type VerifiedGatewayOutcome } from './payment-finalization.service.js';
import { loadVnpayConfig } from './vnpay.config.js';
import { classifyGatewayOutcome, ipnFailureRspCode, parseAndVerifyIpn } from './vnpay-gateway.protocol.js';

export type VnpayAck = { RspCode: '00' | '01' | '02' | '04' | '97' | '99'; Message: string };
const ack = (RspCode: VnpayAck['RspCode'], Message: string): VnpayAck => ({ RspCode, Message });

@Injectable()
export class VnpayIpnService {
  private readonly logger = new Logger(VnpayIpnService.name);
  constructor(private readonly prisma: PrismaService, private readonly finalization: PaymentFinalizationService) {}

  async handle(rawQuery: string): Promise<VnpayAck> {
    let config: ReturnType<typeof loadVnpayConfig>;
    try { config = loadVnpayConfig(); } catch { return ack('99', 'Unknown error'); }
    const ipn = parseAndVerifyIpn(rawQuery, config.hashSecret);
    if (!ipn) return ipnFailureRspCode(rawQuery, config.hashSecret) === '97'
      ? ack('97', 'Invalid signature') : ack('99', 'Invalid request');
    if (ipn.tmnCode !== config.tmnCode) return ack('99', 'Merchant mismatch');
    try {
      const result = await this.prisma.$transaction(async tx => {
        const payment = await tx.payment.findUnique({ where: { vnpTxnRef: ipn.txnRef } });
        if (!payment) return { kind: 'UNKNOWN_TRANSACTION' as const };
        if (payment.provider !== 'VNPAY' || payment.vnpTmnCode !== ipn.tmnCode) return { kind: 'INVALID' as const };
        if (payment.amountVnd * 100n !== ipn.amount) return { kind: 'AMOUNT' as const };
        const outcome: VerifiedGatewayOutcome = {
          source: 'IPN', eventIdentity: ipn.eventIdentity, queryRequestId: null,
          vnpTxnRef: ipn.txnRef, vnpTmnCode: ipn.tmnCode,
          outcome: classifyGatewayOutcome(ipn.responseCode, ipn.transactionStatus),
          responseCode: ipn.responseCode, transactionStatus: ipn.transactionStatus,
          gatewayTransactionNo: ipn.transactionNo, amountVnd: payment.amountVnd,
          gatewayPaidAt: ipn.payDate, receivedAt: new Date(), verifiedAt: new Date(),
        };
        return { kind: 'FINALIZED' as const, value: await this.finalization.finalizeInTransaction(tx, { provider: 'VNPAY', paymentId: payment.id, verifiedOutcome: outcome }) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 8000 });
      if (result.kind === 'UNKNOWN_TRANSACTION') return ack('01', 'Order not found');
      if (result.kind === 'AMOUNT') return ack('04', 'Invalid amount');
      if (result.kind === 'INVALID') return ack('99', 'Invalid request');
      return result.value.disposition === 'DUPLICATE' ? ack('02', 'Order already confirmed') : ack('00', 'Confirm Success');
    } catch {
      // Never log raw callback, signature, or secret.
      this.logger.error('VNPay IPN persistence failed');
      return ack('99', 'Unknown error');
    }
  }
}
