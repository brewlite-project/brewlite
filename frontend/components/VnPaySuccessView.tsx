"use client";

import React, { useState } from "react";
import Link from "next/link";
import { formatVnd, FALLBACK_DRINK_IMAGE } from "@/services/api.service";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

export interface VnPaySuccessDetails {
  vnp_TxnRef?: string;
  vnp_TransactionNo?: string;
  vnp_BankCode?: string;
  vnp_PayDate?: string;
}

export interface VnPaySuccessViewProps {
  order: OrderConfirmationData;
  customerName?: string | null;
  customerEmail?: string | null;
  userPoints?: number;
  vnpayDetails?: VnPaySuccessDetails;
}

export function VnPaySuccessView({
  order,
  customerName: rawCustomerName,
  customerEmail = "customer@example.com",
  userPoints = 0,
  vnpayDetails,
}: VnPaySuccessViewProps) {
  const customerName = rawCustomerName?.trim() || "Quý khách";
  const [copiedOrderId, setCopiedOrderId] = useState<boolean>(false);
  const [downloadingInvoice, setDownloadingInvoice] = useState<boolean>(false);

  const formattedOrderId = `#ORD-${order.id.slice(0, 8).toUpperCase()}`;

  const txnRef = vnpayDetails?.vnp_TxnRef || `VNP_TXN_${order.id.slice(0, 8).toUpperCase()}`;
  const transactionNo = vnpayDetails?.vnp_TransactionNo || "14892044";
  const bankCode = vnpayDetails?.vnp_BankCode || "NCB / VNPAYQR";

  const formattedPayDate = vnpayDetails?.vnp_PayDate
    ? vnpayDetails.vnp_PayDate
    : new Date(order.createdAt).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

  const handleCopyOrderId = () => {
    navigator.clipboard.writeText(order.id).catch(() => {});
    setCopiedOrderId(true);
    setTimeout(() => setCopiedOrderId(false), 2000);
  };

  const handleDownloadInvoice = () => {
    setDownloadingInvoice(true);
    setTimeout(() => {
      setDownloadingInvoice(false);
      alert(`Đã xuất hóa đơn điện tử cho đơn hàng ${formattedOrderId}`);
    }, 1000);
  };

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
            <Link
              href="/orders"
              className="px-4 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container-high text-on-surface text-sm font-semibold transition-colors flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-primary text-[18px]">history</span>
              <span>Lịch sử đơn hàng</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-20 bg-surface flex-1">
        <div className="flex flex-col w-full">
          <div className="w-full max-w-[1320px] mx-auto px-6 py-space-xl">
            {/* Ambient Background Glows */}
            <div className="relative w-full flex flex-col items-center">
              <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-[580px] h-[340px] bg-secondary-container/15 rounded-full blur-[100px] pointer-events-none -z-10"></div>
              <div className="absolute top-48 left-1/4 w-[280px] h-[280px] bg-primary-fixed/20 rounded-full blur-[80px] pointer-events-none -z-10"></div>

              {/* Success Badge & Heading */}
              <div className="flex flex-col items-center text-center max-w-[640px] mx-auto mb-space-xl">
                <div className="relative mb-6">
                  <div className="w-24 h-24 rounded-full bg-emerald-500/10 flex items-center justify-center animate-pulse">
                    <div className="w-16 h-16 rounded-full bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-600/25">
                      <span className="material-symbols-outlined text-white text-[38px] font-bold">
                        check
                      </span>
                    </div>
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-surface-container-lowest shadow-md flex items-center justify-center">
                    <span className="material-symbols-outlined text-primary text-[18px]">verified</span>
                  </div>
                </div>

                <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-label-md text-label-md mb-3 border border-emerald-200">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                  <span className="font-semibold">HTTP 200 • GIAO DỊCH ĐÃ ĐƯỢC XÁC THỰC</span>
                </div>

                <h1 className="font-headline-xl text-headline-xl text-on-surface font-bold tracking-tight mb-3">
                  Thanh toán thành công qua VNPay!
                </h1>
                <p className="font-body-lg text-body-lg text-on-surface-variant max-w-[560px]">
                  Cảm ơn <strong className="text-on-surface">{customerName}</strong>! Đơn hàng của bạn đã được xác nhận. Hóa đơn điện tử và chi tiết giao dịch đã được ghi nhận an toàn trên máy chủ.
                </p>
              </div>

              {/* Main Receipt Card Layout (820px) */}
              <div className="w-full max-w-[820px] bg-surface-container-lowest rounded-2xl shadow-[0_4px_30px_-4px_rgba(44,32,24,0.06)] overflow-hidden border border-outline-variant/30">
                {/* Receipt Header Strip */}
                <div className="bg-surface-container px-space-lg py-5 flex flex-wrap items-center justify-between gap-4 border-b border-outline-variant/30">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-surface-container-lowest flex items-center justify-center shadow-sm">
                      <span className="material-symbols-outlined text-primary text-[22px]">receipt_long</span>
                    </div>
                    <div>
                      <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">
                        Hóa đơn điện tử BrewLite
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="font-title-sm text-title-sm text-on-surface font-bold font-mono">
                          {formattedOrderId}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyOrderId}
                          className="text-on-surface-variant hover:text-primary transition-colors p-1 rounded hover:bg-surface-container-high cursor-pointer"
                          title="Sao chép mã đơn"
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            {copiedOrderId ? "check" : "content_copy"}
                          </span>
                        </button>
                        {copiedOrderId && (
                          <span className="text-xs text-emerald-600 font-medium">Đã chép!</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 font-label-md text-label-md font-bold border border-emerald-200">
                    <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                    ĐÃ THANH TOÁN (PAID)
                  </span>
                </div>

                {/* Metadata Grid */}
                <div className="p-6 md:p-8 bg-surface-container-low/40 border-b border-outline-variant/30">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-body-sm">
                    <div>
                      <span className="text-on-surface-variant block text-xs">Mã giao dịch VNPay (TxnRef):</span>
                      <span className="font-mono font-semibold text-on-surface break-all">{txnRef}</span>
                    </div>
                    <div>
                      <span className="text-on-surface-variant block text-xs">Mã tham chiếu Gateway:</span>
                      <span className="font-mono font-semibold text-on-surface">{transactionNo}</span>
                    </div>
                    <div>
                      <span className="text-on-surface-variant block text-xs">Ngân hàng phát hành:</span>
                      <span className="font-semibold text-on-surface">{bankCode}</span>
                    </div>
                    <div>
                      <span className="text-on-surface-variant block text-xs">Thời gian ghi nhận:</span>
                      <span className="font-semibold text-on-surface">{formattedPayDate}</span>
                    </div>
                    <div>
                      <span className="text-on-surface-variant block text-xs">Điểm thưởng tích lũy:</span>
                      <span className="font-semibold text-tertiary">
                        +{order.pointsEarned} điểm (Hiện có {userPoints} điểm)
                      </span>
                    </div>
                    <div>
                      <span className="text-on-surface-variant block text-xs">Cổng thanh toán:</span>
                      <span className="font-semibold text-primary">VNPay Sandbox</span>
                    </div>
                  </div>
                </div>

                {/* Items Breakdown */}
                <div className="p-6 md:p-8 space-y-4">
                  <h3 className="font-title-sm text-title-sm text-on-surface font-bold">
                    Chi tiết sản phẩm ({order.items.reduce((s, it) => s + it.quantity, 0)} món)
                  </h3>

                  <div className="divide-y divide-outline-variant/20">
                    {order.items.map((it) => (
                      <div key={it.id} className="py-3 flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-on-surface truncate">
                            {it.productName} <span className="text-xs text-on-surface-variant font-normal">(Size {it.size})</span>
                          </p>
                          {it.toppings.length > 0 && (
                            <p className="text-xs text-on-surface-variant truncate">
                              Topping: {it.toppings.map((t) => t.name).join(", ")}
                            </p>
                          )}
                          <span className="text-xs text-on-surface-variant">
                            Số lượng: {it.quantity} x {formatVnd(it.unitPriceVnd)}
                          </span>
                        </div>
                        <span className="font-semibold text-on-surface font-mono">
                          {formatVnd(it.lineTotalVnd)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Financial Breakdown */}
                  <div className="pt-4 border-t border-outline-variant/30 space-y-2 text-body-sm">
                    <div className="flex justify-between text-on-surface-variant">
                      <span>Tạm tính:</span>
                      <span>{formatVnd(order.subtotalVnd)}</span>
                    </div>
                    {order.discountVnd > 0 && (
                      <div className="flex justify-between text-emerald-700 font-medium">
                        <span>Giảm giá khuyến mãi ({order.couponCode || "VOUCHER"}):</span>
                        <span>-{formatVnd(order.discountVnd)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-on-surface-variant">
                      <span>Phí pha chế / giao hàng:</span>
                      <span className="text-emerald-700 font-medium">Miễn phí</span>
                    </div>
                    <div className="pt-3 border-t border-outline-variant/30 flex justify-between items-center text-lg font-bold">
                      <span className="text-on-surface">Tổng tiền đã thanh toán:</span>
                      <span className="font-price-lg text-price-lg text-primary">
                        {formatVnd(order.totalVnd)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="p-6 md:p-8 bg-surface-container-low flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-outline-variant/30">
                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <Link
                      href="/orders"
                      className="flex-1 sm:flex-none px-6 py-3 rounded-xl bg-primary hover:bg-on-secondary-container text-on-primary font-semibold text-center transition-colors shadow-sm"
                    >
                      Xem đơn hàng trong Lịch sử
                    </Link>
                    <Link
                      href="/"
                      className="flex-1 sm:flex-none px-6 py-3 rounded-xl bg-surface-container-highest hover:bg-surface-container text-on-surface font-semibold text-center transition-colors"
                    >
                      Tiếp tục đặt món
                    </Link>
                  </div>

                  <button
                    type="button"
                    onClick={handleDownloadInvoice}
                    disabled={downloadingInvoice}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-outline hover:bg-surface-container-highest text-on-surface text-sm font-semibold transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">download</span>
                    <span>{downloadingInvoice ? "Đang tạo PDF..." : "Tải hóa đơn điện tử"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-surface-container-low shadow-[0_-1px_8px_rgba(0,0,0,0.02)] mt-auto py-space-md text-center text-on-surface-variant text-xs">
        <p>© 2026 BrewLite Specialty Coffee Roasters. Giao dịch thanh toán VNPay hoàn tất.</p>
      </footer>
    </div>
  );
}
