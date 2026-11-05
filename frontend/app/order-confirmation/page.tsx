"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useCart, clearStoredActiveOrder } from "@/context/CartContext";
import { getStoredToken } from "@/services/auth.service";
import {
  type OrderConfirmationData,
  fetchMyOrdersApi,
  findOrderForConfirmation,
  fetchAuthMeProfile,
  getOrderConfirmationPollingConfig,
  shouldPollOrderConfirmation,
} from "@/services/order-confirmation.service";
import { OrderSuccessView } from "@/components/OrderSuccessView";
import { PaymentFailedRetryView } from "@/components/PaymentFailedRetryView";
import { VnPayProcessingView } from "@/components/VnPayProcessingView";
import { VnPaySuccessView } from "@/components/VnPaySuccessView";
import { VnPayFailedRetryView } from "@/components/VnPayFailedRetryView";
import { VnPayRedirectingView } from "@/components/VnPayRedirectingView";
import { ZeroPaymentBypassView } from "@/components/ZeroPaymentBypassView";

function useSafeAppRouter() {
  try {
    return useRouter();
  } catch {
    return {
      push: (url: string) => {
        if (typeof window !== "undefined") window.location.href = url;
      },
      replace: (url: string) => {
        if (typeof window !== "undefined") window.location.replace(url);
      },
    };
  }
}

function useSafeSearchParams(): { get: (key: string) => string | null } {
  const nextParams = useSearchParams();
  return {
    get: (key: string) => {
      const fromNext = nextParams?.get?.(key) ?? null;
      if (fromNext !== null) return fromNext;
      if (typeof window !== "undefined" && window.location?.search) {
        return new URLSearchParams(window.location.search).get(key);
      }
      return null;
    },
  };
}

function OrderConfirmationContent() {
  const router = useSafeAppRouter();
  const searchParams = useSafeSearchParams();
  const orderIdParam = searchParams.get("orderId");
  const vnpResponseCode = searchParams.get("vnp_ResponseCode");
  const vnpTxnRef = searchParams.get("vnp_TxnRef");
  const vnpBankCode = searchParams.get("vnp_BankCode");
  const vnpPayDate = searchParams.get("vnp_PayDate");
  const vnpTransactionNo = searchParams.get("vnp_TransactionNo");
  const viewParam = searchParams.get("view");

  const { accessToken, user, isAuthenticated } = useAuth();
  const { clearCart } = useCart();
  const token = accessToken || (typeof window !== "undefined" ? getStoredToken() : null);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderConfirmationData | null>(null);
  const [userLoyaltyPoints, setUserLoyaltyPoints] = useState<number>(0);
  const clearedPaidOrderIdRef = useRef<string | null>(null);
  const pollAttemptsRef = useRef<number>(0);

  // BR-04: Tự động xóa giỏ hàng và active order đúng 1 lần khi máy chủ xác nhận đơn đã PAID
  useEffect(() => {
    if (!order) return;
    const isConfirmedPaid =
      order.status === "PAID" ||
      order.status === "PREPARING" ||
      order.status === "READY" ||
      order.status === "COMPLETED";
    if (isConfirmedPaid && clearedPaidOrderIdRef.current !== order.id) {
      clearedPaidOrderIdRef.current = order.id;
      clearCart();
      clearStoredActiveOrder();
    }
  }, [order, clearCart]);

  useEffect(() => {
    let isCancelled = false;
    pollAttemptsRef.current = 0;

    async function loadConfirmationOrder() {
      if (!token) {
        setLoading(false);
        return;
      }

      // Khi URL thiếu orderId: TUYỆT ĐỐI KHÔNG tự ý chọn order mới nhất!
      // Báo lỗi rõ ràng để yêu cầu người dùng cung cấp orderId.
      if (!orderIdParam || typeof orderIdParam !== "string" || orderIdParam.trim() === "") {
        setError("Vui lòng cung cấp mã đơn hàng (orderId) trên đường dẫn URL.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const [orders, profile] = await Promise.all([
          fetchMyOrdersApi(token),
          fetchAuthMeProfile(token),
        ]);

        if (isCancelled) return;

        if (profile?.loyaltyPoints !== undefined) {
          setUserLoyaltyPoints(profile.loyaltyPoints);
        }

        const target = findOrderForConfirmation(orders, orderIdParam);
        if (!target) {
          setError("Không tìm thấy thông tin đơn hàng này trong lịch sử của bạn.");
        } else {
          setOrder(target);
        }
      } catch (err: unknown) {
        if (isCancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "UNAUTHORIZED") {
          setError("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại để xem đơn hàng.");
        } else {
          setError(`Không thể tải thông tin đơn hàng: ${msg}`);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    loadConfirmationOrder();

    return () => {
      isCancelled = true;
    };
  }, [token, orderIdParam]);

  // Bounded Polling: Tự động refetch Server Truth khi trạng thái đang PENDING / PROCESSING / RECONCILING.
  // Dừng ngay khi gặp terminal state (SUCCESS/PAID, FAILED terminal, CANCELLED, financial exception),
  // giới hạn số lần tối đa (maxAttempts) và cleanup khi unmount.
  useEffect(() => {
    if (loading || !token || !orderIdParam || !order) {
      return;
    }

    if (!shouldPollOrderConfirmation(order)) {
      return;
    }

    const { intervalMs, maxAttempts } = getOrderConfirmationPollingConfig();
    if (maxAttempts <= 0 || pollAttemptsRef.current >= maxAttempts) {
      return;
    }

    let isDisposed = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextPoll = () => {
      if (isDisposed || pollAttemptsRef.current >= maxAttempts) {
        return;
      }

      timerId = setTimeout(async () => {
        if (isDisposed || pollAttemptsRef.current >= maxAttempts) {
          return;
        }
        pollAttemptsRef.current += 1;

        try {
          const [orders, profile] = await Promise.all([
            fetchMyOrdersApi(token),
            fetchAuthMeProfile(token),
          ]);
          if (isDisposed) return;

          if (profile?.loyaltyPoints !== undefined) {
            setUserLoyaltyPoints(profile.loyaltyPoints);
          }

          const updatedOrder = findOrderForConfirmation(orders, orderIdParam);
          if (updatedOrder) {
            setOrder(updatedOrder);
            if (!shouldPollOrderConfirmation(updatedOrder)) {
              return;
            }
          }
        } catch {
          if (isDisposed) return;
        }

        if (!isDisposed && pollAttemptsRef.current < maxAttempts) {
          scheduleNextPoll();
        }
      }, intervalMs);
    };

    scheduleNextPoll();

    return () => {
      isDisposed = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [
    loading,
    token,
    orderIdParam,
    order,
  ]);

  // Handler khi retry payment hoàn thành (dù SUCCESS hay FAILED):
  // Luôn reload server truth từ GET /orders/me và GET /auth/me để cập nhật trạng thái đơn hàng chính xác từ máy chủ.
  const handleReloadOrder = async (showFullLoading = true) => {
    if (!token || !orderIdParam) return null;
    try {
      if (showFullLoading) {
        setLoading(true);
      }
      const [orders, profile] = await Promise.all([
        fetchMyOrdersApi(token),
        fetchAuthMeProfile(token),
      ]);
      if (profile?.loyaltyPoints !== undefined) {
        setUserLoyaltyPoints(profile.loyaltyPoints);
      }
      const updatedOrder = findOrderForConfirmation(orders, orderIdParam);
      if (updatedOrder) {
        setOrder(updatedOrder);
        return updatedOrder;
      } else {
        if (showFullLoading) {
          setError("Không tìm thấy thông tin đơn hàng sau khi cập nhật từ máy chủ.");
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (showFullLoading) {
        setError(`Không thể làm mới trạng thái đơn hàng sau thanh toán: ${msg}`);
      }
    } finally {
      if (showFullLoading) {
        setLoading(false);
      }
    }
    return null;
  };

  const handleRetrySuccess = async () => {
    // API Contract v3.0 §3.2 & §9: Clear Cart đúng một lần khi Payment SUCCESS được xác nhận
    clearCart();
    clearStoredActiveOrder();
    await handleReloadOrder(true);
  };

  const handleRetryFailure = async () => {
    // Khi retry FAILED, reload server truth ngầm mà không làm mất thông báo lỗi trong Retry form
    return await handleReloadOrder(false);
  };

  // 1. Chưa đăng nhập
  if (!isAuthenticated && !loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-surface p-8 rounded-2xl shadow-sm border border-[#EFECE6] text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-surface-container-high text-primary flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-[32px]">lock</span>
          </div>
          <h2 className="text-xl font-bold text-on-surface">Cần đăng nhập</h2>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Vui lòng đăng nhập tài khoản để tra cứu và xem trạng thái xác nhận đơn hàng của bạn.
          </p>
          <div className="pt-2">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary text-sm font-semibold transition-colors"
            >
              <span>Về Trang chủ để đăng nhập</span>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 2. Đang tải
  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-sm font-medium text-on-surface-variant">
            Đang xác thực thông tin đơn hàng từ máy chủ...
          </p>
        </div>
      </div>
    );
  }

  // 3. Có lỗi hoặc không tìm thấy đơn
  if (error || !order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-surface p-8 rounded-2xl shadow-sm border border-[#EFECE6] text-center space-y-4">
          <div className="w-14 h-14 rounded-full bg-[#FEF2F2] text-[#DC2626] flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-[32px]">error</span>
          </div>
          <h2 className="text-xl font-bold text-on-surface">Không tìm thấy đơn hàng</h2>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            {error || "Hệ thống chưa tìm thấy thông tin đơn hàng này trong tài khoản của bạn."}
          </p>
          <div className="pt-2">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary text-sm font-semibold transition-colors"
            >
              <span>Quay lại Thực đơn</span>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 4. Phân loại trạng thái và provider dựa trên SERVER TRUTH tuyệt đối (BR-04)
  // Các query params (view=redirecting, view=zero, view=vnpay_success, vnp_ResponseCode=00)
  // TUYỆT ĐỐI KHÔNG được phép ghi đè trạng thái đơn hàng hoặc provider thực tế từ máy chủ!
  const isSuccessStatus =
    order.status === "PAID" ||
    order.status === "PREPARING" ||
    order.status === "READY" ||
    order.status === "COMPLETED";

  const isZeroAmountOrder =
    order.totalVnd === 0 ||
    order.payment?.provider === "ZERO_AMOUNT" ||
    order.payment?.method === "ZERO_AMOUNT";

  const isMockOrder =
    !isZeroAmountOrder &&
    (order.payment?.provider === "MOCK" ||
      order.payment?.method === "CARD" ||
      order.payment?.method === "WALLET");

  const isExplicitVnPayOrder =
    !isZeroAmountOrder &&
    !isMockOrder &&
    (order.payment?.provider === "VNPAY" || order.payment?.method === "VNPAY");

  // Ưu tiên #1: Đơn hàng đã được máy chủ xác nhận PAID (PAID / PREPARING / READY / COMPLETED)
  if (isSuccessStatus) {
    if (isZeroAmountOrder) {
      return (
        <ZeroPaymentBypassView
          order={order}
          customerName={user?.fullName || "Quý khách"}
        />
      );
    }

    if (isExplicitVnPayOrder) {
      return (
        <VnPaySuccessView
          order={order}
          customerName={user?.fullName || "Quý khách"}
          userPoints={userLoyaltyPoints || order.pointsEarned}
          vnpayDetails={{
            vnp_TxnRef: vnpTxnRef || undefined,
            vnp_TransactionNo: vnpTransactionNo || undefined,
            vnp_BankCode: vnpBankCode || undefined,
            vnp_PayDate: vnpPayDate || undefined,
          }}
        />
      );
    }

    return (
      <OrderSuccessView
        order={order}
        customerName={user?.fullName || "Quý khách"}
        userPoints={userLoyaltyPoints || order.pointsEarned}
      />
    );
  }

  // Ưu tiên #2: Chỉ cho phép vào luồng giao diện VNPay khi máy chủ xác nhận rõ payment.provider === "VNPAY".
  // Khi payment === null (hoặc thuộc provider MOCK / ZERO_AMOUNT), TUYỆT ĐỐI KHÔNG cho phép URL query params
  // (view=redirecting, vnp_ResponseCode=00, vnp_ResponseCode!=00, view=vnpay_failed) tự suy diễn ra provider VNPay.
  if (!isExplicitVnPayOrder) {
    return (
      <PaymentFailedRetryView
        order={order}
        token={token}
        onRetrySuccess={handleRetrySuccess}
        onRetryFailure={handleRetryFailure}
      />
    );
  }

  // Ưu tiên #3: Đơn hàng có payment.provider === "VNPAY" được máy chủ xác nhận
  const hasFinancialOrReviewLock =
    order.hasFinancialException === true ||
    order.payment?.requiresReview === true ||
    order.payment?.resolution === "FINANCIAL_EXCEPTION" ||
    order.payment?.resolution === "REQUIRES_REVIEW";

  if (hasFinancialOrReviewLock) {
    return (
      <PaymentFailedRetryView
        order={order}
        token={token}
        onRetrySuccess={handleRetrySuccess}
        onRetryFailure={handleRetryFailure}
      />
    );
  }

  if (order.status === "CANCELLED") {
    if (order.payment?.resolution === "RECONCILING" && viewParam === "processing") {
      return (
        <VnPayProcessingView
          order={order}
          orderIdParam={orderIdParam}
          vnpTxnRef={vnpTxnRef}
          amountVnd={order.totalVnd}
          onRefreshStatus={() => handleReloadOrder(false)}
        />
      );
    }
    return (
      <PaymentFailedRetryView
        order={order}
        token={token}
        onRetrySuccess={handleRetrySuccess}
        onRetryFailure={handleRetryFailure}
      />
    );
  }

  const isServerVnPayFailed =
    order.status === "PAYMENT_FAILED" ||
    order.payment?.status === "FAILED" ||
    order.payment?.resolution === "FAILED";

  // Case VNPay Payment Failed & Retry (BR-05):
  // Khi máy chủ đã xác nhận giao dịch VNPay FAILED, luôn giữ trạng thái FAILED/retry theo máy chủ,
  // TUYỆT ĐỐI KHÔNG cho phép view=redirecting, view=processing hay vnp_ResponseCode=00 ghi đè về màn hình redirect/processing.
  if (isServerVnPayFailed) {
    const failureReason = order.payment?.failureReason;
    const derivedResponseCode =
      (vnpResponseCode && vnpResponseCode !== "00" ? vnpResponseCode : null) ||
      (failureReason?.startsWith("VNPAY_RESPONSE_")
        ? failureReason.replace("VNPAY_RESPONSE_", "")
        : failureReason?.startsWith("VNPAY_STATUS_")
        ? failureReason.replace("VNPAY_STATUS_", "")
        : "24");
    return (
      <VnPayFailedRetryView
        order={order}
        vnpResponseCode={derivedResponseCode}
        vnpTxnRef={vnpTxnRef}
        token={token}
        onRetryVnPay={async () => {
          if (order.payment?.status === "PENDING") {
            await handleReloadOrder(false);
            return;
          }
          router.push(`/payment?orderId=${encodeURIComponent(order.id)}&method=VNPAY`);
        }}
      />
    );
  }

  // Khi giao dịch VNPay trên máy chủ đang ở trạng thái PENDING (PROCESSING / RECONCILING):
  if (
    viewParam === "redirecting" &&
    order.status === "PENDING" &&
    order.payment?.status === "PENDING" &&
    order.payment?.resolution !== "RECONCILING" &&
    !vnpResponseCode
  ) {
    return (
      <VnPayRedirectingView
        order={order}
        vnpayPaymentUrl={`/order-confirmation?orderId=${order.id}&vnp_ResponseCode=00&view=processing`}
      />
    );
  }

  if (
    order.status === "PENDING" &&
    (order.payment?.status === "PENDING" ||
      order.payment?.resolution === "PROCESSING" ||
      order.payment?.resolution === "RECONCILING")
  ) {
    return (
      <VnPayProcessingView
        order={order}
        orderIdParam={orderIdParam}
        vnpTxnRef={vnpTxnRef}
        amountVnd={order.totalVnd}
        onRefreshStatus={() => handleReloadOrder(false)}
      />
    );
  }

  // Mặc định cho các trạng thái còn lại
  return (
    <PaymentFailedRetryView
      order={order}
      token={token}
      onRetrySuccess={handleRetrySuccess}
      onRetryFailure={handleRetryFailure}
    />
  );
}

export default function OrderConfirmationPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="text-center space-y-3">
            <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
            <p className="text-sm font-medium text-on-surface-variant">
              Đang khởi tạo trang xác nhận đơn hàng...
            </p>
          </div>
        </div>
      }
    >
      <OrderConfirmationContent />
    </Suspense>
  );
}
