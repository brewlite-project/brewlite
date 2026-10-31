"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useCart, clearStoredActiveOrder } from "@/context/CartContext";
import { getStoredToken } from "@/services/auth.service";
import {
  type OrderConfirmationData,
  fetchMyOrdersApi,
  findOrderForConfirmation,
  fetchAuthMeProfile,
} from "@/services/order-confirmation.service";
import { OrderSuccessView } from "@/components/OrderSuccessView";
import { PaymentFailedRetryView } from "@/components/PaymentFailedRetryView";
import { VnPayRedirectingView } from "@/components/VnPayRedirectingView";
import { VnPayProcessingView } from "@/components/VnPayProcessingView";
import { VnPaySuccessView } from "@/components/VnPaySuccessView";
import { VnPayFailedRetryView } from "@/components/VnPayFailedRetryView";
import { ZeroPaymentBypassView } from "@/components/ZeroPaymentBypassView";

function OrderConfirmationContent() {
  const searchParams = useSearchParams();
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

  useEffect(() => {
    let isCancelled = false;

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

  // Preview / Direct View override
  if (viewParam === "redirecting") {
    return (
      <VnPayRedirectingView
        order={order}
        vnpayPaymentUrl={`/order-confirmation?orderId=${order.id}&vnp_ResponseCode=00&view=processing`}
      />
    );
  }

  // VNPay Processing: khi có vnp_ResponseCode hoặc view=processing và đơn hàng chưa PAID
  const isVnPayCallback =
    (vnpResponseCode === "00" || viewParam === "processing") &&
    order.status === "PENDING";
  if (isVnPayCallback && (order.status === "PENDING")) {
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

  // 4. Kiểm tra trạng thái đơn hàng (CHỈ DỰA VÀO DỮ LIỆU SERVER XÁC NHẬN)
  // Tuyệt đối KHÔNG tin URL query param status=PAID khi server chưa xác nhận!
  const isSuccessStatus =
    order.status === "PAID" ||
    order.status === "PREPARING" ||
    order.status === "READY" ||
    order.status === "COMPLETED";

  // Case Zero-Payment Bypass (BR-06)
  if (isSuccessStatus && (order.totalVnd === 0 || order.payment?.method === "ZERO_AMOUNT" || viewParam === "zero")) {
    return (
      <ZeroPaymentBypassView
        order={order}
        customerName={user?.fullName || "Quý khách"}
      />
    );
  }

  // Case VNPay Payment Success
  const isVnPaySuccess =
    order.payment?.method === "VNPAY" ||
    vnpResponseCode === "00" ||
    viewParam === "vnpay_success";

  if (isSuccessStatus) {
    if (isVnPaySuccess) {
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

  // Case VNPay Payment Failed & Retry (BR-05)
  const isVnPayFailed =
    order.payment?.method === "VNPAY" ||
    (Boolean(vnpResponseCode) && vnpResponseCode !== "00") ||
    viewParam === "vnpay_failed";

  if (isVnPayFailed) {
    return (
      <VnPayFailedRetryView
        order={order}
        vnpResponseCode={vnpResponseCode || "24"}
        vnpTxnRef={vnpTxnRef}
        token={token}
        onRetryVnPay={async () => {
          await handleReloadOrder(false);
        }}
      />
    );
  }

  // Mặc định cho PAYMENT_FAILED, CANCELLED, PENDING của Mock Payment
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
