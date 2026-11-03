import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VnpayIpnService, type VnpayAck } from './vnpay-ipn.service.js';

@ApiTags('Payments')
@Controller('payments/vnpay')
export class VnpayIpnController {
  constructor(private readonly ipn: VnpayIpnService) {}
  @Get('ipn')
  @ApiOperation({ summary: 'VNPay server-to-server IPN callback (no Customer JWT)' })
  @ApiResponse({ status: 200, description: 'VNPay acknowledgement JSON' })
  handle(@Req() request: Request): Promise<VnpayAck> {
    const delimiter = request.originalUrl.indexOf('?');
    return this.ipn.handle(delimiter < 0 ? '' : request.originalUrl.slice(delimiter + 1));
  }
}
