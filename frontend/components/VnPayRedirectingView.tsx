"use client";

import React, { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { formatVnd } from "@/services/api.service";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

export interface VnPayRedirectingViewProps {
  order: OrderConfirmationData;
  vnpayPaymentUrl?: string;
  autoRedirectSeconds?: number;
  onManualRedirect?: () => void;
  branchName?: string;
}

export function VnPayRedirectingView({
  order,
  vnpayPaymentUrl = "#",
  autoRedirectSeconds = 5,
  onManualRedirect,
  branchName = "Saigon Centre, Q.1",
}: VnPayRedirectingViewProps) {
  const [secondsRemaining, setSecondsRemaining] = useState<number>(autoRedirectSeconds);
  const totalSeconds = autoRedirectSeconds;
  const redirectedRef = useRef(false);

  const formattedOrderId = `#ORD-${order.id.slice(0, 8).toUpperCase()}`;

  useEffect(() => {
    redirectedRef.current = false;
    setSecondsRemaining(totalSeconds);

    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (!redirectedRef.current) {
            redirectedRef.current = true;
            if (onManualRedirect) {
              onManualRedirect();
            } else if (vnpayPaymentUrl && vnpayPaymentUrl !== "#") {
              window.location.href = vnpayPaymentUrl;
            }
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [totalSeconds, onManualRedirect, vnpayPaymentUrl]);

  const progressPercent = Math.max(0, (secondsRemaining / totalSeconds) * 100);

  const handleManualClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onManualRedirect) {
      onManualRedirect();
    } else if (vnpayPaymentUrl && vnpayPaymentUrl !== "#") {
      window.location.href = vnpayPaymentUrl;
    }
  };

  return (
    <div className="bg-surface font-body-md text-on-surface antialiased min-h-screen flex flex-col justify-between">
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-surface/90 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        <div className="h-20 max-w-[1320px] mx-auto px-6 flex items-center justify-between gap-gutter">
          <div className="flex items-center gap-space-lg">
            <Link className="flex items-center gap-space-sm" href="/">
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-sm">
                <span className="material-symbols-outlined text-on-primary text-[20px]">coffee</span>
              </div>
              <span className="font-headline-md text-headline-md tracking-tight text-on-surface font-bold">
                Brew<span className="text-primary">Lite</span>
              </span>
            </Link>
            <div className="h-6 w-px bg-outline-variant/40 hidden md:block"></div>
            <nav className="hidden md:flex items-center gap-space-sm font-label-md text-label-md">
              <Link className="text-on-surface-variant hover:text-on-surface px-space-sm py-1 transition-colors" href="/">
                Thực đơn
              </Link>
              <span className="material-symbols-outlined text-outline text-[16px]">chevron_right</span>
              <span className="text-on-surface-variant px-space-sm py-1">Đặt hàng</span>
              <span className="material-symbols-outlined text-outline text-[16px]">chevron_right</span>
              <span className="px-space-sm py-1 bg-primary-container text-on-primary-container font-semibold rounded-lg">
                Thanh toán VNPay
              </span>
            </nav>
          </div>
          <div className="flex items-center gap-space-lg">
            <div className="hidden sm:flex items-center gap-space-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-secondary text-[18px]">lock</span>
              <span className="font-label-md text-label-md">Bảo mật SSL 256-bit</span>
            </div>
            <div className="hidden lg:flex items-center gap-space-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-primary text-[18px]">support_agent</span>
              <span className="font-body-sm text-body-sm">CSKH:</span>
              <a className="font-label-lg text-label-lg text-on-surface font-semibold hover:text-primary transition-colors" href="tel:19006868">
                1900 6868
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-20 bg-surface flex-1">
        <div className="flex flex-col w-full">
          <div className="relative w-full overflow-hidden py-12 md:py-20 flex items-center justify-center min-h-[calc(100vh-160px)]">
            {/* Ambient Coffee Roast Glows */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-60">
              <div className="w-[620px] h-[620px] rounded-full bg-primary-fixed blur-[140px] -translate-y-12"></div>
              <div className="w-[420px] h-[420px] rounded-full bg-secondary-fixed blur-[100px] translate-x-32 translate-y-24 opacity-70"></div>
            </div>

            {/* Centered Card Container */}
            <div className="relative z-10 w-full max-w-[680px] px-4 md:px-6">
              {/* Stepper Tag */}
              <div className="flex justify-center mb-6">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-surface-container-high shadow-sm">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                  </span>
                  <span className="font-label-md text-label-md tracking-wider uppercase text-on-surface-variant font-semibold">
                    Cổng kết nối thanh toán trực tuyến
                  </span>
                </div>
              </div>

              {/* Main Surface Card */}
              <div className="bg-surface-container-lowest rounded-3xl p-8 md:p-12 shadow-[0_16px_48px_-8px_rgba(44,32,24,0.08),0_4px_16px_-2px_rgba(44,32,24,0.04)] flex flex-col items-center text-center relative overflow-hidden">
                {/* Top Accent Strip */}
                <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-primary via-secondary-container to-primary"></div>

                {/* Partnership Bridge */}
                <div className="w-full flex items-center justify-center gap-4 sm:gap-6 my-2">
                  <div className="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-surface-container-low shadow-sm">
                    <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center shadow-sm">
                      <span className="material-symbols-outlined text-on-primary text-[22px]">coffee</span>
                    </div>
                    <div className="text-left hidden xs:block">
                      <p className="font-title-sm text-title-sm text-on-surface font-bold leading-none">BrewLite</p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant text-[11px] mt-0.5">Roastery &amp; Bar</p>
                    </div>
                  </div>

                  <div className="relative flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-primary">
                      <span className="material-symbols-outlined text-[18px]">lock</span>
                    </div>
                    <div className="absolute -right-3 sm:-right-4 w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse"></div>
                    <div className="absolute -left-3 sm:-left-4 w-1.5 h-1.5 rounded-full bg-primary/40 animate-pulse delay-150"></div>
                  </div>

                  <div className="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-surface-container-low shadow-sm">
                    <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shadow-sm p-1.5">
                      <svg className="w-full h-full" fill="none" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
                        <rect fill="#005BAA" height="120" rx="20" width="120"></rect>
                        <path d="M22 36L44 84H58L36 36H22Z" fill="#ED1C24"></path>
                        <path d="M52 36L74 84H88L66 36H52Z" fill="#FFFFFF"></path>
                        <path d="M82 36L94 62L106 36H96L88 54L80 36H82Z" fill="#FFFFFF"></path>
                      </svg>
                    </div>
                    <div className="text-left hidden xs:block">
                      <p className="font-title-sm text-title-sm text-[#005baa] font-bold leading-none">
                        VNPAY<span className="text-[#ed1c24] text-[10px] ml-0.5">QR</span>
                      </p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant text-[11px] mt-0.5">Cổng Thanh Toán</p>
                    </div>
                  </div>
                </div>

                {/* Radar / Spinner */}
                <div className="relative my-8 flex items-center justify-center">
                  <div className="absolute w-24 h-24 rounded-full bg-primary/10 animate-ping opacity-75"></div>
                  <div className="absolute w-20 h-20 rounded-full bg-primary-fixed/40"></div>
                  <svg className="animate-spin w-16 h-16 text-primary" fill="none" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="32" cy="32" r="28" stroke="currentColor" strokeLinecap="round" strokeOpacity="0.15" strokeWidth="4"></circle>
                    <path d="M32 4C47.464 4 60 16.536 60 32" stroke="currentColor" strokeLinecap="round" strokeWidth="4"></path>
                  </svg>
                  <div className="absolute inset-0 m-auto w-8 h-8 rounded-full bg-surface-container-lowest flex items-center justify-center shadow-sm">
                    <span className="material-symbols-outlined text-primary text-[18px]">cached</span>
                  </div>
                </div>

                <h1 className="font-headline-md text-headline-md font-bold text-on-surface tracking-tight mb-2">
                  Đang chuyển hướng đến VNPay...
                </h1>
                <p className="font-body-md text-body-md text-on-surface-variant max-w-[500px] mb-8 leading-relaxed">
                  Vui lòng không tắt hoặc làm mới trang trình duyệt. Phiên giao dịch được mã hóa và chứng thực với giao thức SSL 256-bit chuẩn PCI-DSS Quốc tế.
                </p>

                {/* Order Summary Card */}
                <div className="w-full bg-surface-container-low rounded-2xl p-5 mb-6 text-left shadow-sm">
                  <div className="flex items-center justify-between pb-3.5 mb-3.5 bg-surface-container/60 rounded-xl px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-primary text-[20px]">receipt_long</span>
                      <span className="font-label-md text-label-md uppercase text-on-surface-variant">Mã giao dịch</span>
                    </div>
                    <span className="font-title-sm text-title-sm font-semibold tracking-wide text-on-surface font-mono">
                      {formattedOrderId}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 px-2">
                    <div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">Chi nhánh pha chế</p>
                      <p className="font-label-lg text-label-lg text-on-surface mt-0.5 flex items-center gap-1 font-semibold">
                        <span className="material-symbols-outlined text-primary text-[16px]">store</span>
                        {branchName} ({order.items.reduce((s, it) => s + it.quantity, 0)} món)
                      </p>
                    </div>
                    <div className="sm:text-right">
                      <p className="font-body-sm text-body-sm text-on-surface-variant">Tổng tiền cần thanh toán</p>
                      <p className="font-price-lg text-price-lg text-primary font-bold mt-0.5">
                        {formatVnd(order.totalVnd)}
                      </p>
                    </div>
                  </div>

                  {/* Micro Item Chips */}
                  <div className="mt-4 pt-3 flex flex-wrap gap-2 px-2 border-t border-outline-variant/30">
                    {order.items.slice(0, 3).map((it) => (
                      <span
                        key={it.id}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-surface-container-lowest text-on-surface font-body-sm text-body-sm shadow-xs"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                        {it.quantity}x {it.productName} (Size {it.size})
                      </span>
                    ))}
                    {order.items.length > 3 && (
                      <span className="inline-flex items-center px-2 py-1 rounded-full bg-surface-container-lowest text-on-surface-variant font-body-sm text-body-sm">
                        +{order.items.length - 3} món khác
                      </span>
                    )}
                  </div>
                </div>

                {/* Countdown Progress Bar */}
                <div className="w-full mb-6">
                  <div className="flex items-center justify-between text-on-surface-variant font-body-sm text-body-sm mb-2">
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-primary text-[16px]">hourglass_top</span>
                      Tự động khởi động sau
                    </span>
                    <span className="font-label-lg text-label-lg text-primary font-bold font-mono" id="vnpay-countdown-timer">
                      {secondsRemaining > 0 ? `${secondsRemaining} giây` : "Đang chuyển trang..."}
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-surface-container-high overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all ease-linear duration-1000 rounded-full"
                      id="vnpay-progress-fill"
                      style={{ width: `${progressPercent}%` }}
                    ></div>
                  </div>
                </div>

                {/* Primary Action Button */}
                <button
                  type="button"
                  onClick={handleManualClick}
                  id="vnpay-manual-btn"
                  className="w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-xl bg-primary hover:bg-on-secondary-container text-on-primary font-title-sm text-title-sm font-semibold transition-all duration-200 shadow-md hover:shadow-lg active:scale-[0.99] group cursor-pointer"
                >
                  <span>Tiếp tục mở cổng VNPay ngay</span>
                  <span className="material-symbols-outlined text-[20px] transition-transform group-hover:translate-x-1">
                    open_in_new
                  </span>
                </button>
                <p className="font-body-sm text-body-sm text-on-surface-variant/80 mt-3">
                  Nếu thiết bị không mở cổng sau {totalSeconds} giây, vui lòng bấm vào nút bên trên.
                </p>

                {/* Trust Badges */}
                <div className="mt-8 pt-6 w-full flex flex-wrap items-center justify-center gap-4 text-on-surface-variant border-t border-outline-variant/30">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-[16px]">verified_user</span>
                    <span className="font-label-md text-label-md tracking-wider uppercase font-semibold">PCI-DSS LEVEL 1</span>
                  </div>
                  <span className="w-1 h-1 rounded-full bg-outline-variant"></span>
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-[16px]">account_balance</span>
                    <span className="font-label-md text-label-md tracking-wider uppercase font-semibold">NAPAS SWITCH</span>
                  </div>
                  <span className="w-1 h-1 rounded-full bg-outline-variant"></span>
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-primary text-[16px]">shield</span>
                    <span className="font-label-md text-label-md tracking-wider uppercase font-semibold">VNPAY PARTNER</span>
                  </div>
                </div>
              </div>

              {/* Assistance Note */}
              <div className="text-center mt-6">
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Gặp trở ngại với đơn hàng? Gọi ngay tổng đài hỗ trợ{" "}
                  <a className="font-label-md text-label-md text-primary font-semibold hover:underline" href="tel:19006868">
                    1900 6868
                  </a>{" "}
                  (Miễn phí 24/7)
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-surface-container-low shadow-[0_-1px_8px_rgba(0,0,0,0.02)] mt-auto">
        <div className="max-w-[1320px] mx-auto px-6 py-space-xl">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-space-sm text-on-surface-variant font-body-sm text-body-sm">
            <p>© 2026 BrewLite Specialty Coffee Roasters. All rights reserved.</p>
            <div className="flex items-center gap-space-lg">
              <Link className="hover:text-primary transition-colors" href="#">Chính sách bảo mật</Link>
              <Link className="hover:text-primary transition-colors" href="#">Điều khoản giao dịch</Link>
              <Link className="hover:text-primary transition-colors" href="/orders">Tra cứu đơn hàng</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
