"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatVnd, FALLBACK_DRINK_IMAGE } from "@/services/api.service";
import {
  type OrderConfirmationData,
  type PaymentMethodType,
  type PaymentApiResponse,
  computeOrderRemainingSeconds,
  formatRemainingTime,
  generateIdempotencyKey,
  isOrderExpired,
  submitRetryPaymentApi,
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

interface PaymentFailedRetryViewProps {
  order: OrderConfirmationData;
  token?: string | null;
  onRetrySuccess?: (result: PaymentApiResponse) => void | Promise<void>;
  onRetryFailure?: (result: PaymentApiResponse) => void | Promise<OrderConfirmationData | null>;
  router?: { push: (url: string) => void };
}

export function PaymentFailedRetryView({
  order,
  token,
  onRetrySuccess,
  onRetryFailure,
  router: customRouter,
}: PaymentFailedRetryViewProps) {
  const defaultRouter = useSafeAppRouter();
  const router = customRouter || defaultRouter;

  // State lưu trữ dữ liệu order thực tế trên UI (cập nhật ngay khi prop đổi hoặc khi refetch server truth)
  const [currentOrder, setCurrentOrder] = useState<OrderConfirmationData>(order);
  const [prevOrderProp, setPrevOrderProp] = useState<OrderConfirmationData>(order);
  if (order !== prevOrderProp) {
    setPrevOrderProp(order);
    setCurrentOrder(order);
  }

  const activeOrder = currentOrder || order;
  const isCancelled = activeOrder.status === "CANCELLED";

  // Trạng thái đếm ngược 15 phút
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    computeOrderRemainingSeconds(activeOrder.expiresAt)
  );
  const [isExpiredState, setIsExpiredState] = useState<boolean>(() =>
    isOrderExpired(activeOrder)
  );

  // Đồng bộ đếm ngược khi activeOrder thay đổi id hoặc expiresAt
  const [prevOrderId, setPrevOrderId] = useState<string>(activeOrder.id);
  const [prevExpiresAt, setPrevExpiresAt] = useState<string>(activeOrder.expiresAt);
  if (activeOrder.id !== prevOrderId || activeOrder.expiresAt !== prevExpiresAt) {
    setPrevOrderId(activeOrder.id);
    setPrevExpiresAt(activeOrder.expiresAt);
    setRemainingSeconds(computeOrderRemainingSeconds(activeOrder.expiresAt));
    setIsExpiredState(isOrderExpired(activeOrder));
  }

  // Terminal state: Quá hạn 15 phút, đơn hàng đã bị CANCELLED từ máy chủ, hoặc có ngoại lệ tài chính / đang đối soát
  const isReviewOrException =
    activeOrder.hasFinancialException === true ||
    activeOrder.payment?.requiresReview === true ||
    activeOrder.payment?.resolution === "FINANCIAL_EXCEPTION" ||
    activeOrder.payment?.resolution === "REQUIRES_REVIEW";
  const isReconcilingOrBlocked =
    activeOrder.payment?.status === "PENDING" ||
    activeOrder.payment?.resolution === "RECONCILING" ||
    activeOrder.payment?.resolution === "PROCESSING" ||
    activeOrder.payment?.canRetry === false;
  const isTerminal =
    isExpiredState || isCancelled || isReviewOrException || isReconcilingOrBlocked;

  // Trạng thái mất đồng bộ Server Truth: Khóa retry form khi refetch GET /orders/me thất bại
  const [isServerSyncFailed, setIsServerSyncFailed] = useState<boolean>(false);
  const [isSyncingServerTruth, setIsSyncingServerTruth] = useState<boolean>(false);

  // Form thử lại
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>("CARD");
  const [cardIdentifier, setCardIdentifier] = useState<string>("1234567890121234");
  const [walletIdentifier, setWalletIdentifier] = useState<string>("0912345678");

  // Idempotency-Key & Network Uncertain State
  const [currentIdempotencyKey, setCurrentIdempotencyKey] = useState<string>(() => generateIdempotencyKey());
  const [isNetworkUncertain, setIsNetworkUncertain] = useState<boolean>(false);

  // Loading & error
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef<boolean>(false);

  // Cập nhật countdown mỗi giây
  useEffect(() => {
    if (isExpiredState) return;

    const interval = setInterval(() => {
      const remaining = computeOrderRemainingSeconds(activeOrder.expiresAt);
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        setIsExpiredState(true);
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [activeOrder.expiresAt, isExpiredState]);

  const formattedOrderId = `#BL-${activeOrder.id.slice(0, 8).toUpperCase()}`;

  // Tỷ lệ % thời gian còn lại (trên tổng 15 phút = 900s)
  const percentLeft = Math.max(0, Math.min(100, Math.round((remainingSeconds / 900) * 100)));

  // Thử đồng bộ lại Server Truth khi đang ở blocking error state
  const handleManualSyncServerTruth = async () => {
    if (isSyncingServerTruth || !onRetryFailure) return;
    setIsSyncingServerTruth(true);
    setSubmitError(null);
    try {
      const reloaded = await onRetryFailure({} as PaymentApiResponse);
      if (reloaded) {
        setCurrentOrder(reloaded);
        setIsServerSyncFailed(false);
        const isSuccess =
          reloaded.status === "PAID" ||
          reloaded.status === "PREPARING" ||
          reloaded.status === "READY" ||
          reloaded.status === "COMPLETED";
        if (isSuccess && onRetrySuccess) {
          await onRetrySuccess({} as PaymentApiResponse);
        }
      } else {
        setSubmitError("Máy chủ vẫn chưa phản hồi trạng thái đơn hàng. Vui lòng thử lại sau giây lát.");
      }
    } catch {
      setSubmitError("Lỗi kết nối khi cố gắng đồng bộ từ máy chủ. Vui lòng kiểm tra lại mạng.");
    } finally {
      setIsSyncingServerTruth(false);
    }
  };

  // Xử lý submit thanh toán lại
  const handleRetrySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || isSubmitting || isTerminal || isServerSyncFailed) return;

    if (!token) {
      setSubmitError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.");
      return;
    }

    const currentIdentifier = selectedMethod === "CARD" ? cardIdentifier : walletIdentifier;
    const cleanNumber = currentIdentifier.replace(/\s+/g, "");

    if (selectedMethod === "CARD" && cleanNumber.length !== 16) {
      setSubmitError("Vui lòng nhập số thẻ đúng 16 chữ số.");
      return;
    }
    if (selectedMethod === "WALLET" && cleanNumber.length !== 10) {
      setSubmitError("Vui lòng nhập số điện thoại ví đúng 10 chữ số.");
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const result = await submitRetryPaymentApi({
        orderId: activeOrder.id,
        method: selectedMethod,
        identifier: cleanNumber,
        token,
        idempotencyKey: currentIdempotencyKey,
        expectedAmountVnd: activeOrder.totalVnd,
      });

      if (result.paymentStatus === "SUCCESS") {
        setIsNetworkUncertain(false);
        setIsServerSyncFailed(false);
        if (onRetrySuccess) {
          await onRetrySuccess(result);
        } else {
          // Chuyển hướng sang OrderSuccessView
          router.push(`/order-confirmation?orderId=${activeOrder.id}`);
        }
      } else {
        // Giao dịch FAILED dứt khoát từ server (PAYMENT_DECLINED)
        setIsNetworkUncertain(false);
        // Mỗi lần backend reject dứt khoát thì tạo key mới cho lần thử kế tiếp
        setCurrentIdempotencyKey(generateIdempotencyKey());

        // Tải lại server truth từ GET /orders/me trước khi quyết định trạng thái tiếp theo
        let latestOrder = activeOrder;
        let refetchSucceeded = false;
        if (onRetryFailure) {
          try {
            const reloaded = await onRetryFailure(result);
            if (reloaded) {
              setCurrentOrder(reloaded);
              latestOrder = reloaded;
              refetchSucceeded = true;
              setIsServerSyncFailed(false);
            }
          } catch {
            refetchSucceeded = false;
          }
        }

        // Invariant: Nếu refetch server truth fail -> chuyển sang blocking error state, khóa retry
        if (!refetchSucceeded && onRetryFailure) {
          setIsServerSyncFailed(true);
          setSubmitError(
            "Không thể đồng bộ trạng thái mới nhất từ máy chủ sau khi giao dịch bị từ chối. Biểu mẫu thử lại đã được khóa để bảo vệ tính nhất quán dữ liệu. Vui lòng bấm thử đồng bộ lại."
          );
          return;
        }

        setSubmitError(
          latestOrder.status === "CANCELLED"
            ? "Đơn hàng đã bị hủy trên hệ thống. Không thể tiếp tục thanh toán."
            : `Giao dịch vẫn bị từ chối (${result.failureReason || latestOrder.payment?.failureReason || "PAYMENT_DECLINED"}). Vui lòng thử phương thức khác.`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
      const errCode = (errObj.code || "") as string;
      const statusCode = (errObj.statusCode || 0) as number;

      // 1. Phân loại IDEMPOTENCY_KEY_CONFLICT trước tiên (kể cả khi HTTP 409):
      // Tuyệt đối không coi là INVALID_TRANSITION. Phải xoay (rotate) Idempotency-Key mới ngay lập tức
      // để tránh việc người dùng bị kẹt retry mãi với key cũ bị xung đột. Giữ form mở để tiếp tục thử lại.
      const isIdempotencyConflict =
        errCode === "IDEMPOTENCY_KEY_CONFLICT" ||
        msg.includes("IDEMPOTENCY_KEY_CONFLICT");

      // 2. Lỗi mạng hoặc 409 PAYMENT_IN_PROGRESS: Bảo lưu Idempotency-Key để retry an toàn
      const isNetworkErr =
        err instanceof TypeError ||
        msg.includes("fetch") ||
        msg.includes("Network") ||
        msg.includes("Failed to fetch") ||
        errCode === "PAYMENT_IN_PROGRESS" ||
        msg.includes("PAYMENT_IN_PROGRESS");

      if (isIdempotencyConflict) {
        setIsNetworkUncertain(false);
        setIsServerSyncFailed(false);
        const nextKey = generateIdempotencyKey();
        setCurrentIdempotencyKey(nextKey);
        setSubmitError(
          "Xung đột khóa giao dịch (IDEMPOTENCY_KEY_CONFLICT). Hệ thống đã tự động tạo mã giao dịch mới, vui lòng bấm thử lại."
        );
      } else if (isNetworkErr) {
        setIsNetworkUncertain(true);
        setIsServerSyncFailed(false);
        setSubmitError(
          "Không thể kết nối đến máy chủ hoặc giao dịch đang xử lý. Idempotency-Key đã được giữ nguyên để bạn có thể thử lại an toàn."
        );
      } else if (msg === "UNAUTHORIZED" || statusCode === 401) {
        setIsNetworkUncertain(false);
        setIsServerSyncFailed(false);
        setSubmitError("Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.");
      } else if (
        errCode === "INVALID_TRANSITION" ||
        msg.includes("INVALID_TRANSITION") ||
        (statusCode === 409 && !isIdempotencyConflict && !msg.includes("PAYMENT_IN_PROGRESS"))
      ) {
        setIsNetworkUncertain(false);
        // Khi backend trả 409 INVALID_TRANSITION do order đã đổi state (PAID, CANCELLED,...):
        // Lập tức refetch GET /orders/me từ server truth và khóa/chuyển UI theo state server mới
        let refetchSucceeded = false;
        let newStatus: string | undefined;
        if (onRetryFailure) {
          try {
            const reloaded = await onRetryFailure({} as PaymentApiResponse);
            if (reloaded) {
              setCurrentOrder(reloaded);
              newStatus = reloaded.status;
              refetchSucceeded = true;
              setIsServerSyncFailed(false);
              const isSuccess =
                reloaded.status === "PAID" ||
                reloaded.status === "PREPARING" ||
                reloaded.status === "READY" ||
                reloaded.status === "COMPLETED";
              if (isSuccess && onRetrySuccess) {
                await onRetrySuccess({} as PaymentApiResponse);
              }
            }
          } catch {
            refetchSucceeded = false;
          }
        }

        // Invariant: Nếu refetch server truth fail sau 409 -> chuyển sang blocking error state, khóa retry
        if (!refetchSucceeded && onRetryFailure) {
          setIsServerSyncFailed(true);
          setSubmitError(
            "Không thể đồng bộ trạng thái đơn hàng từ máy chủ sau lỗi INVALID_TRANSITION. Biểu mẫu thử lại đã được khóa để ngăn thao tác trên dữ liệu cũ (stale order). Vui lòng thử đồng bộ lại."
          );
          return;
        }

        setSubmitError(
          newStatus === "CANCELLED"
            ? "Đơn hàng đã bị hủy trên hệ thống (INVALID_TRANSITION). Không thể tiếp tục thanh toán."
            : newStatus === "PAID" || newStatus === "PREPARING" || newStatus === "READY" || newStatus === "COMPLETED"
            ? "Đơn hàng đã được thanh toán thành công trước đó (INVALID_TRANSITION). Đang chuyển hướng..."
            : "Trạng thái đơn hàng đã thay đổi trên máy chủ (INVALID_TRANSITION). Đã đồng bộ lại dữ liệu mới nhất."
        );
      } else {
        setIsNetworkUncertain(false);
        setSubmitError(`Lỗi thanh toán: ${msg}`);
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full bg-background min-h-screen text-on-surface">
      {/* Header Bar */}
      <header className="sticky top-0 left-0 right-0 w-full z-40 bg-surface/90 backdrop-blur-xl border-b border-[#EFECE6]">
        <div className="h-16 max-w-[1320px] mx-auto px-4 md:px-8 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="font-headline-md text-[22px] text-primary font-bold tracking-tight">
              BrewLite
            </span>
            <span className="hidden sm:inline-block px-2.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant text-[11px] font-medium">
              Specialty Coffee
            </span>
          </Link>
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span className="material-symbols-outlined text-primary text-[18px]">
              location_on
            </span>
            <span>Chi nhánh: Saigon Center</span>
          </div>
        </div>
      </header>

      {/* Hero Notification Banner */}
      <section
        className={`w-full border-b border-[#EFECE6] py-8 ${
          isTerminal || isServerSyncFailed
            ? "bg-surface-container"
            : activeOrder.status === "PENDING"
            ? "bg-[#FFFBEB]"
            : "bg-[#FEF2F2]"
        }`}
      >
        <div className="max-w-[1320px] mx-auto px-4 md:px-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <div
                className={`w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm border ${
                  isTerminal || isServerSyncFailed
                    ? "bg-surface-container-highest text-on-surface-variant border-outline-variant"
                    : activeOrder.status === "PENDING"
                    ? "bg-[#FEF3C7] text-[#D97706] border-[#FDE68A]"
                    : "bg-[#FEE2E2] text-[#DC2626] border-[#FECACA]"
                }`}
              >
                <span className="material-symbols-outlined text-[32px]">
                  {isCancelled
                    ? "cancel"
                    : isExpiredState
                    ? "schedule"
                    : isServerSyncFailed
                    ? "sync_problem"
                    : activeOrder.status === "PENDING"
                    ? "hourglass_top"
                    : "error"}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="font-headline-md text-2xl md:text-3xl font-bold text-on-surface">
                    {isCancelled
                      ? "Đơn hàng đã bị hủy"
                      : isExpiredState
                      ? "Đơn hàng đã hết hạn thanh toán"
                      : isServerSyncFailed
                      ? "Trạng thái máy chủ chưa xác định"
                      : activeOrder.status === "PENDING"
                      ? "Đơn hàng đang chờ thanh toán"
                      : "Thanh toán thất bại & Thử lại"}
                  </h1>
                  <span
                    id="orderStatusBadge"
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                      isTerminal || isServerSyncFailed
                        ? "bg-surface-container-highest text-on-surface-variant border-outline-variant"
                        : activeOrder.status === "PENDING"
                        ? "bg-[#FEF3C7] text-[#D97706] border-[#FDE68A]"
                        : "bg-[#FEE2E2] text-[#DC2626] border-[#FECACA]"
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isTerminal || isServerSyncFailed
                          ? "bg-on-surface-variant"
                          : activeOrder.status === "PENDING"
                          ? "bg-[#D97706]"
                          : "bg-[#DC2626]"
                      }`}
                    ></span>
                    {/* Hiển thị chính xác trạng thái từ server, không tự ý gán ép CANCELLED/EXPIRED */}
                    {isReviewOrException
                      ? "FINANCIAL_EXCEPTION / REQUIRES_REVIEW"
                      : isCancelled && activeOrder.payment?.resolution === "RECONCILING"
                      ? "CANCELLED • RECONCILING (ĐANG ĐỐI SOÁT)"
                      : isCancelled
                      ? "CANCELLED (ĐÃ HỦY)"
                      : isExpiredState
                      ? `${activeOrder.status} (QUÁ HẠN 15 PHÚT)`
                      : isServerSyncFailed
                      ? "SERVER_SYNC_REQUIRED"
                      : activeOrder.status === "PENDING"
                      ? "PENDING (CHỜ THANH TOÁN)"
                      : "PAYMENT_FAILED (BỊ TỪ CHỐI)"}
                  </span>
                </div>
                <p className="text-sm text-on-surface-variant max-w-2xl leading-relaxed">
                  {isCancelled
                    ? "Đơn hàng này đã bị hủy trên hệ thống và tồn kho đã được hoàn trả."
                    : isExpiredState
                    ? "Thời gian giữ chỗ tồn kho (15 phút) đã kết thúc. Bạn không thể tiếp tục thực hiện thanh toán cho đơn hàng này."
                    : isServerSyncFailed
                    ? "Hệ thống chưa thể lấy lại trạng thái đơn hàng chính xác từ máy chủ. Biểu mẫu thanh toán đã tạm khóa để đảm bảo an toàn."
                    : activeOrder.status === "PENDING"
                    ? "Đơn hàng của bạn đang ở trạng thái chờ thanh toán. Vui lòng chọn phương thức Thẻ hoặc Ví để hoàn tất trong thời hạn 15 phút."
                    : "Giao dịch thanh toán chưa thể hoàn tất. Đơn hàng của bạn đang được bảo lưu tạm thời, bạn có thể đổi phương thức và thử lại ngay."}
                </p>
              </div>
            </div>

            {/* Quick Metadata Box */}
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 bg-surface-container-lowest p-3.5 rounded-xl shadow-sm border border-[#EFECE6] flex-shrink-0">
              <div className="px-3 border-r border-[#EFECE6]/80 last:border-0">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Mã đơn hàng
                </span>
                <span
                  id="orderCodeText"
                  className="font-mono text-sm font-bold text-primary tracking-tight"
                >
                  {formattedOrderId}
                </span>
              </div>
              <div className="px-3 border-r border-[#EFECE6]/80 last:border-0">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Thời hạn giữ đơn
                </span>
                <span
                  id="countdown-timer"
                  className={`font-mono text-sm font-bold ${
                    isTerminal ? "text-error" : "text-primary"
                  }`}
                >
                  {isCancelled ? "00:00" : formatRemainingTime(remainingSeconds)}
                </span>
              </div>
              <div className="px-3">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Tổng tiền
                </span>
                <span className="text-sm font-bold text-primary">
                  {formatVnd(activeOrder.totalVnd)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Container */}
      <main className="max-w-[1320px] mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* Countdown & Expiration Notice Bar */}
        <div
          id="countdownNoticeBox"
          className="w-full bg-surface-container-lowest rounded-xl p-5 shadow-sm border border-[#EFECE6] flex flex-col sm:flex-row items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3.5 w-full sm:w-auto">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                isTerminal
                  ? "bg-error-container text-on-error-container"
                  : "bg-tertiary-fixed text-tertiary"
              }`}
            >
              <span className="material-symbols-outlined text-[24px]">
                {isCancelled ? "cancel" : "timer"}
              </span>
            </div>
            <div>
              <span className="text-xs text-on-surface-variant uppercase tracking-wider font-semibold block">
                {isCancelled
                  ? "Đơn hàng đã kết thúc"
                  : isExpiredState
                  ? "Đơn hàng đã hết hiệu lực"
                  : "Thời gian giữ chỗ còn lại"}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-on-surface">
                  {isCancelled
                    ? "Đã bị hủy từ máy chủ"
                    : isExpiredState
                    ? "Đã quá hạn 15 phút"
                    : `Còn ${formatRemainingTime(remainingSeconds)}`}
                </span>
                {!isTerminal && (
                  <span className="text-xs text-tertiary font-medium">
                    (Coupon &amp; tồn kho đang được giữ)
                  </span>
                )}
              </div>
            </div>
          </div>

          {!isTerminal && (
            <div className="w-full sm:w-64 space-y-1">
              <div className="flex justify-between text-[11px] text-on-surface-variant">
                <span>Tiến trình giữ đơn</span>
                <span className="font-semibold">{percentLeft}%</span>
              </div>
              <div className="w-full h-2 bg-surface-container-high rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-1000"
                  style={{ width: `${percentLeft}%` }}
                ></div>
              </div>
            </div>
          )}
        </div>

        {/* Notice/Reason banner */}
        <div
          id="orderNoticeBanner"
          className={`p-4 rounded-xl border flex items-start gap-3 ${
            isTerminal || isServerSyncFailed
              ? "bg-surface-container-high border-outline-variant/40 text-on-surface"
              : activeOrder.status === "PENDING"
              ? "bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]"
              : "bg-[#FEF2F2] border-[#FECACA] text-[#991B1B]"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[22px] flex-shrink-0 mt-0.5 ${
              isTerminal || isServerSyncFailed
                ? "text-on-surface-variant"
                : activeOrder.status === "PENDING"
                ? "text-[#D97706]"
                : "text-[#DC2626]"
            }`}
          >
            {isCancelled
              ? "block"
              : isExpiredState
              ? "timer_off"
              : isServerSyncFailed
              ? "sync_problem"
              : activeOrder.status === "PENDING"
              ? "info"
              : "warning"}
          </span>
          <div className="space-y-0.5 text-xs">
            {isCancelled ? (
              <>
                <p className="font-bold">
                  Đơn hàng đã bị hủy (CANCELLED)
                </p>
                <p className="leading-relaxed text-on-surface-variant">
                  Đơn hàng này hiện ở trạng thái đã hủy từ hệ thống. Không thể thực hiện thanh toán tiếp.
                </p>
              </>
            ) : isExpiredState ? (
              <>
                <p className="font-bold">
                  Thời hạn giữ chỗ đơn hàng đã kết thúc (15 phút)
                </p>
                <p className="leading-relaxed text-on-surface-variant">
                  Theo quy định của hệ thống, đơn hàng chỉ được giữ tối đa 15 phút kể từ lúc tạo. Vui lòng quay về thực đơn để tạo đơn hàng mới.
                </p>
              </>
            ) : isServerSyncFailed ? (
              <>
                <p className="font-bold">
                  Chưa thể xác định trạng thái đơn hàng từ máy chủ
                </p>
                <p className="leading-relaxed text-on-surface-variant">
                  Để đảm bảo tính nhất quán (Server Truth), form thử lại đã tạm khóa. Vui lòng bấm &quot;Thử đồng bộ lại từ máy chủ&quot;.
                </p>
              </>
            ) : activeOrder.status === "PENDING" ? (
              <>
                <p className="font-bold">
                  Đơn hàng đang chờ thanh toán (PENDING)
                </p>
                <p className="leading-relaxed">
                  Đơn hàng của bạn đã được ghi nhận vào hệ thống. Vui lòng hoàn tất thanh toán trước khi thời gian giữ chỗ kết thúc.
                </p>
              </>
            ) : (
              <>
                <p className="font-bold">
                  Lý do thanh toán thất bại:{" "}
                  <span className="font-mono">
                    {activeOrder.payment?.failureReason || "PAYMENT_DECLINED (Thẻ bị từ chối)"}
                  </span>
                </p>
                <p className="leading-relaxed">
                  Hệ thống ghi nhận giao dịch không thành công. Bạn có thể kiểm tra lại thông tin thanh toán hoặc chọn phương thức khác để thử lại.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Main Grid: Left (7 cols - Retry Form hoặc Terminal/Blocked State View), Right (5 cols - Summary) */}
        <div className="grid grid-cols-12 gap-8 items-start">
          {/* Left: Retry Form hoặc Khối thông báo kết thúc / Blocking Error State */}
          <section className="col-span-12 lg:col-span-7 space-y-6">
            <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-[#EFECE6] space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-[#EFECE6]">
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-primary text-[24px]">
                    {isTerminal ? "info" : isServerSyncFailed ? "sync_problem" : "payments"}
                  </span>
                  <h2 className="text-lg font-bold text-on-surface">
                    {isCancelled
                      ? "Đơn hàng đã kết thúc"
                      : isExpiredState
                      ? "Đơn hàng đã hết hiệu lực"
                      : isServerSyncFailed
                      ? "Đồng bộ trạng thái máy chủ"
                      : activeOrder.status === "PENDING"
                      ? "Chọn phương thức thanh toán"
                      : "Chọn phương thức thanh toán thử lại"}
                  </h2>
                </div>
                <span
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                    isTerminal
                      ? "bg-surface-container-high text-on-surface-variant"
                      : isServerSyncFailed
                      ? "bg-[#FEE2E2] text-[#DC2626]"
                      : "text-tertiary bg-tertiary-fixed/60"
                  }`}
                >
                  {isTerminal ? "TRẠNG THÁI CUỐI" : isServerSyncFailed ? "ĐỒNG BỘ THẤT BẠI" : "POST /payments"}
                </span>
              </div>

              {/* Nhánh 1: Đơn hàng đã CANCELLED hoặc EXPIRED (Terminal State): form và nút retry biến mất hoàn toàn */}
              {isTerminal ? (
                <div id="orderTerminalStateNotice" className="text-center py-8 space-y-3">
                  <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center mx-auto text-on-surface-variant">
                    <span className="material-symbols-outlined text-[32px]">
                      {isCancelled ? "cancel" : "block"}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-on-surface">
                    {isReviewOrException
                      ? "Đơn hàng cần đối soát tài chính (REQUIRES_REVIEW)"
                      : isCancelled && activeOrder.payment?.resolution === "RECONCILING"
                      ? "Đơn hàng đã hủy — Đang đối soát giao dịch VNPay"
                      : isCancelled
                      ? "Đơn hàng đã bị hủy"
                      : "Không thể thử lại cho đơn hàng này"}
                  </h3>
                  <p className="text-xs text-on-surface-variant max-w-md mx-auto leading-relaxed">
                    {isReviewOrException
                      ? "Hệ thống ghi nhận dấu hiệu bất thường hoặc giao dịch thành công trễ hạn cần bộ phận vận hành kiểm tra thủ công. Đã khóa tạo giao dịch mới để bảo vệ quyền lợi của bạn."
                      : isCancelled && activeOrder.payment?.resolution === "RECONCILING"
                      ? "Đơn hàng đã quá thời gian giữ chỗ và bị hủy tự động, tuy nhiên giao dịch VNPay của bạn vẫn đang được hệ thống đối soát với ngân hàng."
                      : isCancelled
                      ? "Đơn hàng này đã bị hủy trên hệ thống. Tồn kho và ưu đãi đã được hoàn trả để đảm bảo công bằng cho các khách hàng khác."
                      : "Thời gian giữ chỗ đơn hàng đã kết thúc (15 phút). Bạn không thể tiếp tục thử lại thanh toán cho đơn hàng này nữa."}
                  </p>
                  <div className="pt-2">
                    <Link
                      href="/"
                      className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary text-sm font-semibold shadow transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                      <span>Quay lại Thực đơn để đặt món mới</span>
                    </Link>
                  </div>
                </div>
              ) : isServerSyncFailed ? (
                /* Nhánh 2: Refetch server truth fail (Blocking error / Unknown state): Khóa form, không cho phép gửi request stale */
                <div id="serverSyncFailedNotice" className="text-center py-8 space-y-4">
                  <div className="w-16 h-16 rounded-full bg-[#FEE2E2] text-[#DC2626] flex items-center justify-center mx-auto">
                    <span className="material-symbols-outlined text-[32px]">sync_problem</span>
                  </div>
                  <h3 className="text-base font-bold text-on-surface">
                    Chưa thể xác định trạng thái đơn hàng từ máy chủ
                  </h3>
                  <p className="text-xs text-on-surface-variant max-w-md mx-auto leading-relaxed">
                    Hệ thống không thể tải dữ liệu mới nhất của đơn hàng từ máy chủ sau giao dịch.
                    Để đảm bảo an toàn và tuân thủ quy tắc Server Truth, biểu mẫu thanh toán đã tạm khóa để tránh gửi trùng yêu cầu trên dữ liệu cũ.
                  </p>
                  {submitError && (
                    <div className="p-3 rounded-lg bg-error-container/20 text-error text-xs max-w-md mx-auto border border-error/20">
                      {submitError}
                    </div>
                  )}
                  <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      id="btnRetrySyncServerTruth"
                      onClick={handleManualSyncServerTruth}
                      disabled={isSyncingServerTruth}
                      className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary text-xs font-bold shadow transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {isSyncingServerTruth ? "sync" : "refresh"}
                      </span>
                      <span>{isSyncingServerTruth ? "Đang đồng bộ lại..." : "Thử đồng bộ lại từ máy chủ"}</span>
                    </button>
                    <Link
                      href="/orders"
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-[#EFECE6] bg-surface hover:bg-surface-container text-xs font-semibold text-on-surface transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">history</span>
                      <span>Kiểm tra trong Lịch sử đơn</span>
                    </Link>
                  </div>
                </div>
              ) : (
                /* Nhánh 3: Form thử lại bình thường */
                <form onSubmit={handleRetrySubmit} className="space-y-5">
                  {/* Option 1: Card */}
                  <label
                    className={`block cursor-pointer rounded-xl p-4 transition-all border ${
                      selectedMethod === "CARD"
                        ? "bg-secondary-fixed/20 border-primary shadow-sm"
                        : "bg-surface-container-low border-outline-variant/30 hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="payment_method"
                          value="CARD"
                          checked={selectedMethod === "CARD"}
                          onChange={() => setSelectedMethod("CARD")}
                          className="w-4 h-4 text-primary accent-primary"
                        />
                        <span className="material-symbols-outlined text-[22px] text-primary">
                          credit_card
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-on-surface">
                              Thẻ thanh toán (CARD - 16 chữ số)
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-primary text-on-primary text-[10px] font-bold">
                              Khuyên dùng
                            </span>
                          </div>
                          <span className="text-xs text-on-surface-variant">
                            Hỗ trợ thẻ Visa, Mastercard, JCB mô phỏng
                          </span>
                        </div>
                      </div>
                    </div>

                    {selectedMethod === "CARD" && (
                      <div className="mt-4 pt-3 border-t border-primary/20 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-on-surface-variant font-medium">
                            Số thẻ thanh toán (16 chữ số)
                          </span>
                          <button
                            type="button"
                            onClick={() => setCardIdentifier("1234567890121234")}
                            className="text-primary hover:underline font-bold"
                          >
                            Điền thẻ hợp lệ mẫu (..1234)
                          </button>
                        </div>
                        <input
                          id="card-input-field"
                          type="text"
                          maxLength={16}
                          value={cardIdentifier}
                          onChange={(e) => setCardIdentifier(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-lowest font-mono text-sm border border-outline-variant focus:outline-none focus:ring-1 focus:ring-primary"
                          placeholder="1234 5678 9012 1234"
                        />
                        <p className="text-[11px] text-on-surface-variant">
                          💡 Gợi ý: Thẻ kết thúc bằng <strong className="text-error">0002</strong> sẽ
                          bị từ chối (PAYMENT_DECLINED); kết thúc khác 0002 sẽ THÀNH CÔNG.
                        </p>
                      </div>
                    )}
                  </label>

                  {/* Option 2: Wallet */}
                  <label
                    className={`block cursor-pointer rounded-xl p-4 transition-all border ${
                      selectedMethod === "WALLET"
                        ? "bg-secondary-fixed/20 border-primary shadow-sm"
                        : "bg-surface-container-low border-outline-variant/30 hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="payment_method"
                          value="WALLET"
                          checked={selectedMethod === "WALLET"}
                          onChange={() => setSelectedMethod("WALLET")}
                          className="w-4 h-4 text-primary accent-primary"
                        />
                        <span className="material-symbols-outlined text-[22px] text-secondary">
                          account_balance_wallet
                        </span>
                        <div>
                          <span className="text-sm font-bold text-on-surface block">
                            Ví điện tử (WALLET - 10 chữ số)
                          </span>
                          <span className="text-xs text-on-surface-variant">
                            Mô phỏng thanh toán ví MoMo, VNPay qua số điện thoại
                          </span>
                        </div>
                      </div>
                    </div>

                    {selectedMethod === "WALLET" && (
                      <div className="mt-4 pt-3 border-t border-primary/20 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-on-surface-variant font-medium">
                            Số điện thoại ví (10 chữ số)
                          </span>
                          <button
                            type="button"
                            onClick={() => setWalletIdentifier("0912345678")}
                            className="text-primary hover:underline font-bold"
                          >
                            Điền SĐT ví hợp lệ (..5678)
                          </button>
                        </div>
                        <input
                          id="wallet-input-field"
                          type="text"
                          maxLength={10}
                          value={walletIdentifier}
                          onChange={(e) => setWalletIdentifier(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-lowest font-mono text-sm border border-outline-variant focus:outline-none focus:ring-1 focus:ring-primary"
                          placeholder="0912345678"
                        />
                        <p className="text-[11px] text-on-surface-variant">
                          💡 Gợi ý: Ví kết thúc bằng <strong className="text-error">0000</strong> sẽ
                          bị từ chối; kết thúc khác 0000 sẽ THÀNH CÔNG.
                        </p>
                      </div>
                    )}
                  </label>

                  {/* Error display */}
                  {submitError && (
                    <div
                      id="retryErrorBanner"
                      className={`p-4 rounded-xl border text-xs flex flex-col gap-2.5 ${
                        isNetworkUncertain
                          ? "bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]"
                          : "bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-bold text-sm">
                        <span className="material-symbols-outlined text-[20px]">
                          {isNetworkUncertain ? "wifi_off" : "error"}
                        </span>
                        <span>
                          {isNetworkUncertain
                            ? "Trạng thái giao dịch chưa xác định (Network Uncertain)"
                            : "Lỗi thanh toán"}
                        </span>
                      </div>
                      <span id="retryErrorMessage">{submitError}</span>
                      {isNetworkUncertain && (
                        <div className="pt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[#FDE68A]">
                          <span className="font-mono text-[11px] text-[#B45309]">
                            Idempotency-Key: {currentIdempotencyKey.slice(0, 8)}...
                          </span>
                          <button
                            type="button"
                            id="btnRetrySameKey"
                            onClick={handleRetrySubmit}
                            disabled={isSubmitting}
                            className="px-3 py-1.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary font-bold text-xs transition-colors cursor-pointer"
                          >
                            {isSubmitting ? "Đang gửi lại..." : "Thử lại cùng Idempotency-Key"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Submit Button */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      id="btnSubmitRetryPayment"
                      disabled={isSubmitting}
                      className="w-full py-3.5 px-4 rounded-xl bg-primary hover:bg-[#70370e] text-on-primary font-bold text-sm shadow transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        {isSubmitting ? "sync" : activeOrder.status === "PENDING" ? "lock" : "refresh"}
                      </span>
                      <span>
                        {isSubmitting
                          ? activeOrder.status === "PENDING"
                            ? "Đang xử lý thanh toán..."
                            : "Đang xử lý thanh toán lại..."
                          : activeOrder.status === "PENDING"
                          ? `Thanh toán ngay (${formatVnd(activeOrder.totalVnd)})`
                          : `Thanh toán lại ngay (${formatVnd(activeOrder.totalVnd)})`}
                      </span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>

          {/* Right: Order Summary Sidebar */}
          <aside className="col-span-12 lg:col-span-5 space-y-6">
            <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-[#EFECE6] space-y-5">
              <div className="flex items-center justify-between pb-4 border-b border-[#EFECE6]">
                <h3 className="text-base font-bold text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">
                    receipt_long
                  </span>
                  Tóm tắt đơn hàng ({activeOrder.items.length} món)
                </h3>
                <span className="text-xs text-on-surface-variant">Bao gồm VAT</span>
              </div>

              {/* Items List */}
              <div className="divide-y divide-[#EFECE6]/80 max-h-72 overflow-y-auto pr-1">
                {activeOrder.items.map((item) => (
                  <div key={item.id} className="py-3 flex gap-3 items-start">
                    <div className="w-12 h-12 rounded-lg bg-surface-container overflow-hidden flex-shrink-0 flex items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={FALLBACK_DRINK_IMAGE}
                        alt={item.productName}
                        className="w-full h-full object-contain p-1"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="text-sm font-bold text-on-surface truncate">
                          {item.quantity}x {item.productName}
                        </h4>
                        <span className="text-sm font-bold text-on-surface flex-shrink-0">
                          {formatVnd(item.lineTotalVnd)}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        Size {item.size} ({item.sizeMultiplierPercent}%)
                        {item.toppings?.length > 0 &&
                          ` • +${item.toppings.map((t) => t.name).join(", ")}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Price Calculation */}
              <div className="pt-3 border-t border-[#EFECE6] space-y-2 text-xs">
                <div className="flex justify-between text-on-surface-variant">
                  <span>Tạm tính (subtotalVnd)</span>
                  <span className="font-semibold text-on-surface">
                    {formatVnd(activeOrder.subtotalVnd)}
                  </span>
                </div>
                {activeOrder.discountVnd > 0 && (
                  <div className="flex justify-between text-tertiary font-semibold">
                    <span>
                      Giảm giá ({activeOrder.couponCode} -{" "}
                      <span className="px-1 py-0.2 rounded bg-tertiary-fixed text-on-tertiary-fixed text-[10px]">
                        HELD
                      </span>
                      )
                    </span>
                    <span>-{formatVnd(activeOrder.discountVnd)}</span>
                  </div>
                )}
                <div className="pt-3 border-t border-[#EFECE6] flex justify-between items-baseline">
                  <span className="text-sm font-bold text-on-surface">Tổng thanh toán</span>
                  <div className="text-right">
                    <span className="text-lg font-bold text-primary">
                      {formatVnd(activeOrder.totalVnd)}
                    </span>
                    <span className="block text-[11px] text-tertiary font-medium">
                      Điểm nhận: 0 (sẽ +{Math.floor(activeOrder.totalVnd / 10000)} điểm khi SUCCESS)
                    </span>
                  </div>
                </div>
              </div>

              {/* Coupon Held Notice */}
              {activeOrder.couponCode && !isTerminal && (
                <div className="p-3 rounded-lg bg-surface-container flex items-start gap-2 text-xs text-on-surface-variant leading-relaxed">
                  <span className="material-symbols-outlined text-secondary text-[18px] flex-shrink-0">
                    info
                  </span>
                  <span>
                    Mã ưu đãi <strong className="font-mono text-on-surface">{activeOrder.couponCode}</strong>{" "}
                    đang ở trạng thái <strong className="text-tertiary">HELD</strong> bảo lưu cho đơn hàng.
                    Nếu quá 15 phút chưa thanh toán, mã sẽ tự động nhả lại vào tài khoản.
                  </span>
                </div>
              )}
            </div>

            {/* Links */}
            <div className="flex items-center justify-between px-2 text-xs">
              <Link
                href="/"
                className="text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1 font-medium"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                <span>Quay lại Thực đơn</span>
              </Link>
              <Link
                href="/orders"
                className="text-primary hover:underline transition-all flex items-center gap-1 font-semibold"
              >
                <span>Xem Lịch sử Đơn hàng</span>
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </Link>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default PaymentFailedRetryView;
