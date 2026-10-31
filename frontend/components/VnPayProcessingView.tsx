"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { formatVnd } from "@/services/api.service";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

export interface VnPayProcessingViewProps {
  order?: OrderConfirmationData | null;
  orderIdParam?: string | null;
  vnpTxnRef?: string | null;
  amountVnd?: number | null;
  onRefreshStatus?: () => Promise<OrderConfirmationData | null> | void;
  isPolling?: boolean;
}

export function VnPayProcessingView({
  order,
  orderIdParam,
  vnpTxnRef,
  amountVnd,
  onRefreshStatus,
  isPolling = true,
}: VnPayProcessingViewProps) {
  const [pollProgress, setPollProgress] = useState<number>(30);
  const [currentStep, setCurrentStep] = useState<number>(2);
  const [statusMessage, setStatusMessage] = useState<string>("Đang xác thực bảo mật qua VNPay IPN...");
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const displayOrderId = order?.id
    ? `#ORD-${order.id.slice(0, 8).toUpperCase()}`
    : orderIdParam
    ? `#ORD-${orderIdParam.slice(0, 8).toUpperCase()}`
    : "#ORD-CHỜ XÁC THỰC";

  const displayTxnRef = vnpTxnRef || (order?.id ? `VNP_TXN_${order.id.slice(0, 8).toUpperCase()}` : "VNP_PENDING_REF");
  const displayAmount = amountVnd !== undefined && amountVnd !== null
    ? amountVnd
    : order?.totalVnd !== undefined
    ? order.totalVnd
    : 0;

  useEffect(() => {
    if (!isPolling) return;

    const interval = setInterval(() => {
      setPollProgress((prev) => {
        if (prev >= 90) return 90;
        const next = prev + 15;
        if (next >= 50 && next < 80) {
          setCurrentStep(3);
          setStatusMessage("Đang đối soát chữ ký số & tín hiệu máy chủ IPN...");
        } else if (next >= 80) {
          setCurrentStep(3);
          setStatusMessage("Đang đồng bộ trạng thái đơn hàng cuối cùng...");
        }
        return next;
      });
    }, 1200);

    return () => clearInterval(interval);
  }, [isPolling]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    setPollProgress(95);
    setStatusMessage("Đang kiểm tra trạng thái mới nhất từ máy chủ...");
    try {
      if (onRefreshStatus) {
        await onRefreshStatus();
      }
    } finally {
      setIsRefreshing(false);
    }
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

          <div className="flex items-center gap-space-md text-on-surface-variant font-body-sm text-body-sm">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high">
              <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>
              <span className="font-semibold text-on-surface">Đối soát bảo mật BR-04</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-20 bg-surface flex-1">
        <div className="flex flex-col w-full">
          <div className="max-w-[1320px] mx-auto px-6 py-12 w-full flex flex-col items-center justify-center relative">
            {/* Background Glows */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-[620px] h-[360px] bg-secondary-container/20 rounded-full blur-3xl pointer-events-none -z-10"></div>
            <div className="absolute top-48 right-16 w-[320px] h-[320px] bg-primary-fixed/30 rounded-full blur-2xl pointer-events-none -z-10"></div>

            {/* Main Card (680px spec) */}
            <div className="w-full max-w-[680px] bg-surface-container-lowest rounded-2xl shadow-xl p-8 md:p-12 flex flex-col items-center relative overflow-hidden border border-outline-variant/30">
              {/* Top Polling Progress Bar */}
              <div className="absolute top-0 left-0 right-0 h-1.5 bg-surface-container">
                <div
                  className="h-full bg-primary transition-all duration-700 ease-out"
                  id="pollingProgress"
                  style={{ width: `${pollProgress}%` }}
                ></div>
              </div>

              {/* Radar Ring Animation */}
              <div className="relative w-28 h-28 flex items-center justify-center mb-8 mt-2">
                <div className="absolute inset-0 rounded-full bg-primary-fixed/40 animate-ping opacity-60"></div>
                <div className="absolute inset-1 rounded-full bg-primary-fixed/60 animate-pulse"></div>
                <div className="absolute inset-3 rounded-full bg-surface-container flex items-center justify-center">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                    <circle
                      className="text-surface-container-high"
                      cx="50"
                      cy="50"
                      fill="none"
                      r="42"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <circle
                      className="text-primary transition-all duration-1000 ease-linear"
                      cx="50"
                      cy="50"
                      fill="none"
                      id="radarCircle"
                      r="42"
                      stroke="currentColor"
                      strokeDasharray="264"
                      strokeDashoffset={264 - (264 * pollProgress) / 100}
                      strokeLinecap="round"
                      strokeWidth="4"
                    ></circle>
                  </svg>
                </div>
                <div className="relative z-10 w-16 h-16 rounded-full bg-primary flex items-center justify-center shadow-md">
                  <span className="material-symbols-outlined text-on-primary text-[32px] animate-spin" style={{ animationDuration: "3.5s" }}>
                    sync
                  </span>
                </div>
              </div>

              {/* Polling Status Pill */}
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant font-label-md text-label-md mb-4 shadow-sm">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary-container opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-secondary"></span>
                </span>
                <span id="pollingStatusText" className="font-semibold">{statusMessage}</span>
              </div>

              <h1 className="font-headline-lg text-headline-lg text-on-surface text-center mb-3 font-bold tracking-tight">
                Đang kiểm tra kết quả giao dịch...
              </h1>
              <p className="font-body-md text-body-md text-on-surface-variant text-center max-w-[520px] mb-8 leading-relaxed">
                Hệ thống đang xác thực tín hiệu thanh toán từ cổng VNPay và ngân hàng phát hành. Quá trình này thường diễn ra trong vài giây.
              </p>

              {/* Transaction & Audit Details Box */}
              <div className="w-full bg-surface-container-low rounded-xl p-6 mb-6 text-left shadow-sm">
                <div className="flex items-center justify-between pb-4 border-b border-outline-variant/30">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">receipt_long</span>
                    <span className="font-title-sm text-title-sm text-on-surface font-bold">Chi tiết phiên đối soát</span>
                  </div>
                  <span className="font-label-md text-label-md px-2.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface font-mono">
                    {displayOrderId}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4 text-body-sm">
                  <div>
                    <span className="text-on-surface-variant block">Mã giao dịch VNPay (TxnRef):</span>
                    <span className="font-mono font-semibold text-on-surface break-all">{displayTxnRef}</span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant block">Số tiền cần đối soát:</span>
                    <span className="font-price-lg text-title-sm text-primary font-bold">
                      {formatVnd(displayAmount)}
                    </span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant block">Cổng thanh toán:</span>
                    <span className="font-semibold text-on-surface">VNPay Sandbox (HMAC-SHA512)</span>
                  </div>
                  <div>
                    <span className="text-on-surface-variant block">Cơ chế xác thực:</span>
                    <span className="font-semibold text-secondary">Backend Finalization (BR-04)</span>
                  </div>
                </div>

                {/* Security Verification Steps Checklist */}
                <div className="pt-4 border-t border-outline-variant/30 space-y-2.5">
                  <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider font-semibold">
                    Tiến trình kiểm chứng bảo mật
                  </p>

                  <div className="flex items-center gap-2.5 text-body-sm">
                    <span className="material-symbols-outlined text-emerald-600 text-[18px]">check_circle</span>
                    <span className="text-on-surface">1. Tiếp nhận kết quả Return URL từ VNPay</span>
                  </div>

                  <div className="flex items-center gap-2.5 text-body-sm">
                    <span className="material-symbols-outlined text-emerald-600 text-[18px]">check_circle</span>
                    <span className="text-on-surface">2. Kiểm tra chữ ký số bảo mật HMAC-SHA512</span>
                  </div>

                  <div className="flex items-center gap-2.5 text-body-sm">
                    {currentStep >= 3 ? (
                      <span className="material-symbols-outlined text-primary text-[18px] animate-spin">sync</span>
                    ) : (
                      <span className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin inline-block"></span>
                    )}
                    <span className="font-semibold text-primary">
                      3. Chờ tín hiệu xác nhận máy chủ VNPay IPN / QueryDR
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5 text-body-sm text-on-surface-variant">
                    <span className="w-2 h-2 rounded-full bg-outline-variant ml-1 mr-1"></span>
                    <span>4. Cập nhật trạng thái đơn hàng &amp; tích lũy loyalty</span>
                  </div>
                </div>
              </div>

              {/* Rule Note per BR-04 */}
              <div className="w-full p-4 rounded-xl bg-surface-container/70 border border-outline-variant/20 mb-6 text-left">
                <div className="flex items-start gap-2.5">
                  <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">verified_user</span>
                  <p className="text-xs text-on-surface-variant leading-relaxed">
                    <strong className="text-on-surface">Quy tắc bảo mật BR-04:</strong> BrewLite không tin tưởng kết quả từ trình duyệt mà chỉ xác nhận đơn hàng sang <span className="font-semibold text-emerald-700">ĐÃ THANH TOÁN (PAID)</span> sau khi máy chủ nhận và đối soát hợp lệ thông điệp IPN hoặc QueryDR từ VNPay.
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="w-full flex flex-col sm:flex-row items-center gap-3">
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  id="vnpay-check-status-btn"
                  className="w-full flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-primary hover:bg-on-secondary-container text-on-primary font-title-sm text-title-sm font-semibold transition-all shadow-md active:scale-[0.99] disabled:opacity-70 cursor-pointer"
                >
                  <span className={`material-symbols-outlined text-[18px] ${isRefreshing ? "animate-spin" : ""}`}>
                    refresh
                  </span>
                  <span>{isRefreshing ? "Đang tra cứu máy chủ..." : "Làm mới trạng thái ngay"}</span>
                </button>

                <Link
                  href="/orders"
                  className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface font-title-sm text-title-sm font-semibold transition-all text-center"
                >
                  Xem Lịch sử đơn hàng
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-surface-container-low shadow-[0_-1px_8px_rgba(0,0,0,0.02)] mt-auto py-space-md text-center text-on-surface-variant text-xs">
        <p>© 2026 BrewLite Specialty Coffee Roasters. Bảo mật giao dịch VNPay Sandbox.</p>
      </footer>
    </div>
  );
}
