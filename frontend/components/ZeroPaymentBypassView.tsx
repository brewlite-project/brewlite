"use client";

import React from "react";
import Link from "next/link";
import { formatVnd } from "@/services/api.service";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

export interface ZeroPaymentBypassViewProps {
  order: OrderConfirmationData;
  customerName?: string | null;
  branchName?: string;
}

export function ZeroPaymentBypassView({
  order,
  customerName: rawCustomerName,
  branchName = "BrewLite Saigon Center",
}: ZeroPaymentBypassViewProps) {
  const customerName = rawCustomerName?.trim() || "Quý khách";
  const formattedOrderId = `#ORD-${order.id.slice(0, 8).toUpperCase()}`;

  return (
    <div className="bg-surface font-body-md text-on-surface antialiased min-h-screen flex flex-col justify-between">
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-surface/90 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        <div className="h-20 max-w-[1320px] mx-auto px-6 flex items-center justify-between gap-gutter">
          <Link className="flex items-center gap-space-sm" href="/">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-sm">
              <span className="material-symbols-outlined text-on-primary text-[20px]">coffee</span>
            </div>
            <span className="font-headline-md text-headline-md tracking-tight text-on-surface font-bold">
              Brew<span className="text-primary">Lite</span>
            </span>
          </Link>

          <div className="flex items-center gap-space-md">
            <span className="px-3 py-1 rounded-full bg-secondary text-on-secondary font-label-md text-label-md font-bold shadow-sm flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">verified</span>
              <span>ZERO_AMOUNT</span>
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-20 bg-surface flex-1">
        <div className="flex flex-col w-full">
          <div className="relative overflow-hidden w-full max-w-[1320px] mx-auto px-6 py-space-xl">
            {/* Ambient Background Glows */}
            <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[720px] h-[480px] bg-secondary-fixed/30 rounded-full blur-[110px] pointer-events-none -z-10"></div>
            <div className="absolute top-48 right-12 w-[340px] h-[340px] bg-tertiary-fixed/30 rounded-full blur-[90px] pointer-events-none -z-10"></div>
            <div className="absolute bottom-10 left-10 w-[280px] h-[280px] bg-primary-fixed-dim/20 rounded-full blur-[80px] pointer-events-none -z-10"></div>

            {/* Hero Section */}
            <div className="flex flex-col items-center text-center max-w-[820px] mx-auto mb-space-xl relative">
              <div className="relative mb-space-lg flex items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-secondary-fixed animate-ping opacity-25 scale-125"></div>
                <div className="relative w-28 h-28 rounded-full bg-surface-container-lowest shadow-xl flex items-center justify-center p-3">
                  <div className="w-full h-full rounded-full bg-primary flex items-center justify-center text-on-primary shadow-inner">
                    <span className="material-symbols-outlined text-[54px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                      redeem
                    </span>
                  </div>
                </div>
                <div className="absolute -top-2 -right-2 w-10 h-10 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center shadow-md animate-bounce">
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                    auto_awesome
                  </span>
                </div>
                <div className="absolute -bottom-1 -left-3 px-3 py-1 rounded-full bg-secondary text-on-secondary shadow-md flex items-center gap-1">
                  <span className="material-symbols-outlined text-[14px]">verified</span>
                  <span className="font-label-md text-label-md tracking-wider uppercase font-bold">ZERO_AMOUNT</span>
                </div>
              </div>

              {/* Policy Tag */}
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-surface-container-high text-secondary mb-space-sm shadow-sm">
                <span className="material-symbols-outlined text-[18px]">lock_reset</span>
                <span className="font-label-lg text-label-lg font-semibold tracking-wide">
                  Quyết toán nội bộ 0 ₫ • Không gọi VNPay API theo BR-06
                </span>
              </div>

              <h1 className="font-display-lg text-display-lg text-on-surface tracking-tight mb-space-sm font-bold">
                Đơn hàng hoàn tất (<span className="text-primary">0 ₫</span>)!
              </h1>
              <p className="font-body-lg text-body-lg text-on-surface-variant max-w-[620px] leading-relaxed">
                Cảm ơn <strong className="text-on-surface">{customerName}</strong>! Giao dịch được miễn phí 100% nhờ khuyến mãi đặc biệt. Hệ thống không yêu cầu thanh toán hay chuyển khoản và đã kích hoạt trạng thái pha chế tức thì.
              </p>

              {/* Quick Info Badges */}
              <div className="mt-space-md flex flex-wrap items-center justify-center gap-space-md">
                <div className="px-4 py-2 rounded-xl bg-surface-container-lowest shadow-sm flex items-center gap-2 border border-outline-variant/30">
                  <span className="w-2.5 h-2.5 rounded-full bg-secondary animate-pulse"></span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Mã đơn hàng:</span>
                  <span className="font-label-lg text-label-lg text-on-surface font-bold font-mono">{formattedOrderId}</span>
                </div>

                <div className="px-4 py-2 rounded-xl bg-surface-container-lowest shadow-sm flex items-center gap-2 border border-outline-variant/30">
                  <span className="material-symbols-outlined text-primary text-[18px]">store</span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Chi nhánh:</span>
                  <span className="font-label-lg text-label-lg text-on-surface font-semibold">{branchName}</span>
                </div>

                <div className="px-4 py-2 rounded-xl bg-surface-container-lowest shadow-sm flex items-center gap-2 border border-outline-variant/30">
                  <span className="material-symbols-outlined text-emerald-600 text-[18px]">check_circle</span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant">Trạng thái:</span>
                  <span className="font-label-lg text-label-lg text-emerald-700 font-bold">ĐÃ THANH TOÁN (PAID)</span>
                </div>
              </div>
            </div>

            {/* Zero-Payment Receipt Card */}
            <div className="w-full max-w-[760px] mx-auto bg-surface-container-lowest rounded-2xl shadow-lg border border-outline-variant/30 overflow-hidden">
              <div className="bg-surface-container-low px-6 py-4 flex items-center justify-between border-b border-outline-variant/30">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">local_cafe</span>
                  <span className="font-title-sm text-title-sm font-bold text-on-surface">
                    Quyết toán đơn hàng miễn phí
                  </span>
                </div>
                <span className="text-xs text-on-surface-variant">Phương thức: ZERO_AMOUNT</span>
              </div>

              <div className="p-6 md:p-8 space-y-6">
                {/* ERD Compliance Alert */}
                <div className="p-4 rounded-xl bg-surface-container/60 border border-outline-variant/20 flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">verified</span>
                  <div className="text-xs text-on-surface-variant space-y-1">
                    <p className="font-semibold text-on-surface">Tuân thủ nguyên tắc quyết toán nội bộ BR-06 &amp; ERD Invariants:</p>
                    <p>• Số tiền thanh toán: <strong>0 ₫</strong> (amountVnd = 0).</p>
                    <p>• Không gọi tới cổng thanh toán VNPay hoặc Mock Payment bên ngoài.</p>
                    <p>• Điểm thưởng loyalty tích lũy: <strong>0 điểm</strong> (theo quy tắc nghiệp vụ đơn 0đ không phát sinh điểm).</p>
                    <p>• Giữ chỗ nguyên liệu và ghi nhận mã giảm giá ({order.couponCode || "VOUCHER100"}) thành công một lần duy nhất.</p>
                  </div>
                </div>

                {/* Items List */}
                <div>
                  <h4 className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-3">
                    Món nước pha chế ({order.items.reduce((s, it) => s + it.quantity, 0)} món)
                  </h4>
                  <div className="divide-y divide-outline-variant/20">
                    {order.items.map((it) => (
                      <div key={it.id} className="py-2.5 flex items-center justify-between text-body-sm">
                        <div>
                          <span className="font-semibold text-on-surface">{it.productName}</span>
                          <span className="text-xs text-on-surface-variant ml-2">(Size {it.size}, x{it.quantity})</span>
                        </div>
                        <span className="font-mono text-on-surface line-through text-xs text-on-surface-variant">
                          {formatVnd(it.lineTotalVnd)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Price Breakdown */}
                <div className="pt-4 border-t border-outline-variant/30 space-y-2 text-body-sm">
                  <div className="flex justify-between text-on-surface-variant">
                    <span>Tổng giá niêm yết:</span>
                    <span>{formatVnd(order.subtotalVnd)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700 font-semibold">
                    <span>Khuyến mãi đặc quyền 100% ({order.couponCode || "VOUCHER"}):</span>
                    <span>-{formatVnd(order.discountVnd || order.subtotalVnd)}</span>
                  </div>
                  <div className="pt-3 border-t border-outline-variant/30 flex justify-between items-center text-lg font-bold">
                    <span className="text-on-surface">Tổng số tiền cần trả:</span>
                    <span className="font-price-lg text-price-lg text-emerald-700">0 ₫</span>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="pt-4 flex flex-col sm:flex-row items-center gap-3">
                  <Link
                    href="/orders"
                    className="w-full sm:flex-1 py-3.5 px-6 rounded-xl bg-primary hover:bg-on-secondary-container text-on-primary font-semibold text-center transition-all shadow-md"
                  >
                    Theo dõi đơn hàng tại quầy
                  </Link>
                  <Link
                    href="/"
                    className="w-full sm:w-auto py-3.5 px-6 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface font-semibold text-center transition-colors"
                  >
                    Khám phá thêm thực đơn
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-surface-container-low shadow-[0_-1px_8px_rgba(0,0,0,0.02)] mt-auto py-space-md text-center text-on-surface-variant text-xs">
        <p>© 2026 BrewLite Specialty Coffee Roasters. Quyết toán đơn hàng 0 ₫ thành công.</p>
      </footer>
    </div>
  );
}
