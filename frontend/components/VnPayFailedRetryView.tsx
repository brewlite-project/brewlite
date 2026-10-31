"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatVnd, FALLBACK_DRINK_IMAGE } from "@/services/api.service";
import {
  type OrderConfirmationData,
  computeOrderRemainingSeconds,
  formatRemainingTime,
  isOrderExpired,
} from "@/services/order-confirmation.service";

function useSafeAppRouter() {
  try {
    return useRouter();
  } catch {
    return {
      push: () => {},
      replace: () => {},
      prefetch: () => {},
      back: () => {},
      forward: () => {},
      refresh: () => {},
    };
  }
}

export interface VnPayFailedRetryViewProps {
  order: OrderConfirmationData;
  vnpResponseCode?: string | null;
  vnpTxnRef?: string | null;
  token?: string | null;
  onRetryVnPay?: () => Promise<void> | void;
  onChangePaymentMethod?: () => void;
  router?: { push: (url: string) => void };
}

export function mapVnPayResponseCodeToMessage(code?: string | null): {
  title: string;
  description: string;
} {
  switch (code) {
    case "00":
      return {
        title: "Giao dịch thành công",
        description: "Giao dịch đã được ghi nhận thanh toán thành công trên cổng VNPay.",
      };
    case "07":
      return {
        title: "Giao dịch bị nghi ngờ gian lận",
        description: "Tài khoản đã bị trừ tiền nhưng giao dịch bị tạm giữ do nghi ngờ gian lận để kiểm tra an ninh an toàn. Vui lòng liên hệ BrewLite hoặc ngân hàng phát hành để được hỗ trợ.",
      };
    case "09":
      return {
        title: "Chưa đăng ký Internet Banking",
        description: "Thẻ hoặc tài khoản ngân hàng của bạn chưa đăng ký dịch vụ Internet Banking hoặc chưa kích hoạt thanh toán trực tuyến.",
      };
    case "10":
      return {
        title: "Xác thực thẻ quá số lần cho phép",
        description: "Bạn đã nhập sai thông tin xác thực thẻ quá 3 lần. Giao dịch bị từ chối để bảo vệ an toàn cho chủ tài khoản.",
      };
    case "11":
      return {
        title: "Hết hạn phiên thanh toán",
        description: "Đã quá thời gian quy định chờ nhập thông tin hoặc mã OTP từ ngân hàng phát hành trên cổng VNPay.",
      };
    case "12":
      return {
        title: "Thẻ hoặc tài khoản bị khóa",
        description: "Thẻ hoặc tài khoản ngân hàng của bạn đang bị tạm khóa hoặc chưa kích hoạt tính năng thanh toán trực tuyến.",
      };
    case "13":
      return {
        title: "Sai mã xác thực OTP",
        description: "Mã xác thực OTP bạn nhập không chính xác hoặc đã hết thời gian hiệu lực.",
      };
    case "24":
      return {
        title: "Giao dịch đã bị hủy",
        description: "Bạn đã hủy giao dịch trên cổng thanh toán VNPay hoặc đóng cửa sổ xác thực ngân hàng.",
      };
    case "51":
      return {
        title: "Tài khoản không đủ số dư",
        description: "Tài khoản ngân hàng hoặc ví liên kết của bạn tạm thời không đủ số dư khả dụng để hoàn tất thanh toán.",
      };
    case "65":
      return {
        title: "Vượt quá hạn mức giao dịch",
        description: "Số tiền giao dịch đã vượt quá hạn mức thanh toán trong ngày của thẻ hoặc tài khoản ngân hàng.",
      };
    case "75":
      return {
        title: "Ngân hàng thanh toán đang bảo trì",
        description: "Hệ thống ngân hàng thụ hưởng đang trong thời gian bảo trì định kỳ. Vui lòng thử lại sau ít phút hoặc đổi phương thức khác.",
      };
    case "79":
      return {
        title: "Nhập sai mật khẩu quá số lần",
        description: "Bạn đã nhập sai mật khẩu thanh toán quá số lần cho phép. Giao dịch bị tạm dừng để bảo đảm an toàn.",
      };
    case "97":
      return {
        title: "Chữ ký giao dịch không hợp lệ",
        description: "Mã kiểm tra chữ ký bảo mật (Checksum) không hợp lệ hoặc dữ liệu truyền tải đã bị thay đổi.",
      };
    case "99":
      return {
        title: "Lỗi hệ thống cổng VNPay",
        description: "Cổng thanh toán VNPay gặp sự cố kết nối hoặc lỗi xử lý nội bộ. Vui lòng thử lại sau ít phút.",
      };
    default:
      return {
        title: "Giao dịch VNPay tạm thời gián đoạn",
        description: "Hệ thống chưa nhận được khoản trừ tiền thành công từ cổng VNPay. Giao dịch chưa hoàn tất.",
      };
  }
}

export function VnPayFailedRetryView({
  order,
  vnpResponseCode = "24",
  vnpTxnRef,
  token,
  onRetryVnPay,
  onChangePaymentMethod,
  router: customRouter,
}: VnPayFailedRetryViewProps) {
  const defaultRouter = useSafeAppRouter();
  const router = customRouter || defaultRouter;
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    computeOrderRemainingSeconds(order.expiresAt)
  );
  const [isRetrying, setIsRetrying] = useState<boolean>(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const isExpired = remainingSeconds <= 0 || isOrderExpired(order);
  const errorInfo = mapVnPayResponseCodeToMessage(vnpResponseCode);

  const displayTxnRef = vnpTxnRef || `VNP_TXN_${order.id.slice(0, 8).toUpperCase()}_01`;
  const formattedOrderId = `#ORD-${order.id.slice(0, 8).toUpperCase()}`;

  useEffect(() => {
    const timer = setInterval(() => {
      const rem = computeOrderRemainingSeconds(order.expiresAt);
      setRemainingSeconds(rem);
      if (rem <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [order.expiresAt]);

  const handleRetry = async () => {
    if (isExpired) {
      setRetryError("Đơn hàng đã hết hạn thanh toán 15 phút. Theo quy định BR-03, không thể tạo thêm lượt giao dịch mới.");
      return;
    }

    setIsRetrying(true);
    setRetryError(null);
    try {
      if (onRetryVnPay) {
        await onRetryVnPay();
      } else {
        // Mặc định: điều hướng lại /payment để tạo attempt mới với vnp_TxnRef mới theo BR-05
        router.push(`/payment?orderId=${order.id}&method=VNPAY&retry=true`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRetryError(`Không thể khởi tạo lại giao dịch VNPay: ${msg}`);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleChangeMethod = () => {
    if (onChangePaymentMethod) {
      onChangePaymentMethod();
    } else {
      router.push(`/payment?orderId=${order.id}`);
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

          <div className="flex items-center gap-3">
            <span className="px-3 py-1 rounded-full bg-error-container text-on-error-container font-label-md text-label-md flex items-center gap-1.5 shadow-sm">
              <span className="w-2 h-2 rounded-full bg-error animate-ping"></span>
              <span>Giao dịch chưa hoàn tất</span>
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full pt-20 bg-surface flex-1">
        <div className="flex flex-col w-full">
          <div className="max-w-[1320px] mx-auto px-6 py-space-xl w-full">
            {/* Top Breadcrumb */}
            <div className="flex items-center justify-between pb-8">
              <button
                type="button"
                onClick={handleChangeMethod}
                className="inline-flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors font-label-md text-label-md cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                <span>Quay lại trang giao dịch</span>
              </button>
              <span className="font-body-sm text-body-sm text-on-surface-variant hidden sm:inline">
                vnp_TxnRef: <strong className="text-on-surface font-mono font-semibold">{displayTxnRef}</strong>
              </span>
            </div>

            {/* Grid Workspace */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
              {/* Left Column: Failure Hero & Retry Actions (7 cols) */}
              <section className="lg:col-span-7 flex flex-col gap-space-lg">
                <div className="bg-surface-container-lowest rounded-2xl p-space-xl shadow-md relative overflow-hidden border border-outline-variant/30">
                  <div className="absolute -right-12 -top-12 w-48 h-48 rounded-full bg-secondary-container/20 blur-2xl pointer-events-none"></div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-space-md">
                    <div className="relative w-16 h-16 rounded-xl bg-error-container/60 flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-error text-[36px]">sync_problem</span>
                      <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-error flex items-center justify-center shadow-sm">
                        <span className="material-symbols-outlined text-on-error text-[13px] font-bold">priority_high</span>
                      </span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-label-md text-label-md uppercase tracking-wider text-error font-semibold">
                        Thông báo giao dịch
                      </span>
                      <h1 className="font-headline-lg text-headline-lg text-on-surface mt-0.5 font-bold">
                        Thanh toán không thành công
                      </h1>
                    </div>
                  </div>

                  {/* Empathetic Error Explanation */}
                  <div className="mt-space-lg bg-surface-container-low rounded-xl p-space-md border border-outline-variant/20">
                    <div className="flex items-start gap-space-sm">
                      <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">info</span>
                      <div className="text-on-surface-variant font-body-md text-body-md">
                        <p className="text-on-surface font-title-sm text-title-sm mb-1 font-bold">
                          {errorInfo.title}
                        </p>
                        <p className="leading-relaxed">{errorInfo.description}</p>
                        <div className="mt-space-sm inline-flex items-center gap-2 bg-surface-container-highest px-2.5 py-1 rounded font-body-sm text-body-sm text-on-surface">
                          <span>Mã phản hồi cổng: <strong className="font-mono">vnp_ResponseCode = {vnpResponseCode}</strong></span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Resolution & Retry Card */}
                  <div className="mt-space-lg pt-space-lg border-t border-outline-variant/30 space-y-4">
                    <h2 className="font-title-sm text-title-sm text-on-surface font-bold">
                      Thử lại thanh toán với lượt giao dịch mới
                    </h2>
                    <p className="text-xs text-on-surface-variant leading-relaxed">
                      Theo quy định <strong className="text-on-surface">BR-05 (Controlled Retry)</strong>: Mỗi lần thử lại sẽ khởi tạo một mã giao dịch VNPay (<code className="font-mono text-primary font-semibold">vnp_TxnRef</code>) mới độc lập, đồng thời bảo lưu nguyên vẹn danh sách món và quyền ưu tiên của đơn hàng trong thời hạn 15 phút.
                    </p>

                    {retryError && (
                      <div className="p-3 bg-error-container/40 border border-error rounded-xl text-error text-xs flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px]">error</span>
                        <span>{retryError}</span>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={isRetrying || isExpired}
                        id="vnpay-retry-btn"
                        className="w-full sm:flex-1 flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-primary hover:bg-on-secondary-container text-on-primary font-semibold transition-all shadow-md active:scale-[0.99] disabled:opacity-50 cursor-pointer"
                      >
                        <span className={`material-symbols-outlined text-[18px] ${isRetrying ? "animate-spin" : ""}`}>
                          {isRetrying ? "sync" : "refresh"}
                        </span>
                        <span>{isRetrying ? "Đang tạo phiên giao dịch mới..." : "Thanh toán lại qua VNPay"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleChangeMethod}
                        className="w-full sm:w-auto px-5 py-3.5 rounded-xl border border-outline hover:bg-surface-container text-on-surface font-semibold transition-colors cursor-pointer"
                      >
                        Đổi phương thức thanh toán
                      </button>
                    </div>

                    <div className="pt-2 text-center sm:text-left">
                      <p className="text-xs text-on-surface-variant">
                        Cần trợ giúp tức thì? Liên hệ tổng đài viên:{" "}
                        <a href="tel:19006868" className="text-primary font-bold hover:underline">
                          1900 6868
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* Right Column: Order Context & Expiration Guard (5 cols) */}
              <aside className="lg:col-span-5 flex flex-col gap-space-md">
                {/* Expiration Countdown Card */}
                <div className="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30">
                  <div className="flex items-center justify-between pb-3 border-b border-outline-variant/30">
                    <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant font-semibold">
                      Thời hạn giữ đơn hàng
                    </span>
                    <span
                      id="order-countdown-timer"
                      className={`font-title-sm text-title-sm font-mono font-bold ${
                        isExpired ? "text-error" : remainingSeconds < 180 ? "text-tertiary animate-pulse" : "text-primary"
                      }`}
                    >
                      {formatRemainingTime(remainingSeconds)}
                    </span>
                  </div>

                  <p className="text-xs text-on-surface-variant mt-3 leading-relaxed">
                    {isExpired
                      ? "Đơn hàng đã quá hạn 15 phút. Theo quy định BR-03, nguyên liệu và khuyến mãi đã được giải phóng tự động."
                      : "Nguyên liệu pha chế và khuyến mãi của đơn hàng được giữ tạm thời trong 15 phút. Vui lòng hoàn tất thanh toán trước khi thời gian kết thúc."}
                  </p>
                </div>

                {/* Compact Order Snapshot */}
                <div className="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/30 space-y-4">
                  <div className="flex justify-between items-center pb-3 border-b border-outline-variant/30">
                    <span className="font-title-sm text-title-sm text-on-surface font-bold">
                      Đơn hàng {formattedOrderId}
                    </span>
                    <span className="font-price-lg text-title-sm text-primary font-bold">
                      {formatVnd(order.totalVnd)}
                    </span>
                  </div>

                  <div className="space-y-2 text-body-sm max-h-60 overflow-y-auto">
                    {order.items.map((it) => (
                      <div key={it.id} className="flex justify-between text-on-surface-variant">
                        <span>{it.quantity}x {it.productName} ({it.size})</span>
                        <span className="font-mono text-on-surface">{formatVnd(it.lineTotalVnd)}</span>
                      </div>
                    ))}
                  </div>

                  {order.discountVnd > 0 && (
                    <div className="pt-2 border-t border-outline-variant/30 flex justify-between text-xs text-emerald-700">
                      <span>Voucher ({order.couponCode})</span>
                      <span>-{formatVnd(order.discountVnd)}</span>
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-surface-container-low shadow-[0_-1px_8px_rgba(0,0,0,0.02)] mt-auto py-space-md text-center text-on-surface-variant text-xs">
        <p>© 2026 BrewLite Specialty Coffee Roasters. Xử lý thử lại thanh toán an toàn.</p>
      </footer>
    </div>
  );
}
