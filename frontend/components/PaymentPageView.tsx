"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  clearStoredActiveOrder,
  restoreActiveOrderForUser,
  useCart,
} from "@/context/CartContext";
import type {
  CreateOrderResponseDto,
  CreatePaymentRequestDto,
  MyOrderDto,
  OrderStatus,
  PaymentMethod,
  PaymentResponseDto,
  PaymentSubmissionErrorState,
} from "@/mock-data";
import {
  FALLBACK_DRINK_IMAGE,
  fetchCatalogData,
  formatVnd,
} from "@/services/api.service";
import {
  clearStoredSession,
  getDisplayCustomerName,
  getStoredToken,
  isTokenExpired,
} from "@/services/auth.service";
import {
  buildCreatePaymentPayload,
  buildVnPayOrderConfirmationUrl,
  extractVnPayReturnContext,
  fetchAuthMeProfile,
  fetchMyOrdersApi,
  generateIdempotencyKey,
  isOrderExpired,
  isOrderPayable,
  selectTargetOrderFromMyOrders,
  submitPaymentApi,
  toPaymentSubmissionErrorState,
  validateCreatePaymentPayload,
  validatePaymentResponseData,
  initiateVnPayPaymentApi,
  submitZeroAmountPaymentApi,
  validateZeroAmountPaymentResponse,
  type SubmitPaymentApiResult,
} from "@/services/payment.service";
import {
  getOrderConfirmationPollingConfig,
  shouldPollOrderConfirmation,
  type OrderConfirmationData,
} from "@/services/order-confirmation.service";
import { OrderSuccessView } from "@/components/OrderSuccessView";
import { PaymentFailedRetryView } from "@/components/PaymentFailedRetryView";
import { VnPayProcessingView } from "@/components/VnPayProcessingView";
import { VnPaySuccessView } from "@/components/VnPaySuccessView";
import { VnPayFailedRetryView } from "@/components/VnPayFailedRetryView";
import { ZeroPaymentBypassView } from "@/components/ZeroPaymentBypassView";

export type PaymentSubmissionOutcome =
  | {
      type: "success";
      response: PaymentResponseDto;
      replayed: boolean;
      idempotencyKey: string;
    }
  | {
      type: "failed";
      response: PaymentResponseDto;
      replayed: boolean;
      idempotencyKey: string;
      nextIdempotencyKey: string;
    }
  | {
      type: "error";
      error: PaymentSubmissionErrorState;
    };

export interface ExecutePaymentSubmissionDeps {
  activeOrder: CreateOrderResponseDto | MyOrderDto | null;
  orderStatus?: OrderStatus | string | null;
  payload: CreatePaymentRequestDto;
  idempotencyKey: string;
  reuseExistingKey?: boolean;
  accessToken: string | null;
  isAuthenticated: boolean;
  verifySession: () => boolean;
  openAuthModal: (
    mode?: "login" | "register",
    options?: { resumeCheckout?: boolean; reasonMessage?: string }
  ) => void;
  submittingRef: { current: boolean };
  isSubmitting: boolean;
  setIsSubmitting: (submitting: boolean) => void;
  setIdempotencyKey: (key: string) => void;
  setLastSubmittedPayloadJson?: (json: string) => void;
  setPaymentResult: (result: PaymentResponseDto | null) => void;
  setIsReplayedResult?: (replayed: boolean) => void;
  setOrderStatus: (status: OrderStatus) => void;
  setIsResultModalOpen?: (open: boolean) => void;
  setPaymentError: (error: PaymentSubmissionErrorState | null) => void;
  clearCart: () => void;
  setContextActiveOrder?: (order: CreateOrderResponseDto | null) => void;
  onPointsEarned?: (points: number) => void;
  submitPaymentFn?: typeof submitPaymentApi;
}

/**
 * Hàm điều phối thực thi gửi `POST /payments` (tách biệt để dễ kiểm thử đầy đủ mọi nhánh):
 * 1. Chặn double-submit (`submittingRef.current || isSubmitting`).
 * 2. Chặn thanh toán nếu Order không còn ở trạng thái `PENDING` hoặc `PAYMENT_FAILED`.
 * 3. Kiểm tra `Idempotency-Key` và `CreatePaymentRequestDto`.
 * 4. Kiểm tra phiên đăng nhập JWT (401 -> xóa session, mở Login modal, giữ nguyên Cart).
 * 5. Gọi `POST /payments` và kiểm tra toàn vẹn response khớp với `activeOrder.id` & `activeOrder.totalVnd`.
 * 6. Chỉ xóa Cart khi response hợp lệ 100% và `paymentStatus === "SUCCESS"` (`orderStatus === "PAID"`).
 */
export async function executePaymentSubmission(
  deps: ExecutePaymentSubmissionDeps
): Promise<{ skipped: boolean; outcome: PaymentSubmissionOutcome | null }> {
  if (deps.submittingRef.current || deps.isSubmitting || !deps.activeOrder) {
    return { skipped: true, outcome: null };
  }

  const effectiveStatus = deps.orderStatus ?? deps.activeOrder.status;
  const keyToUse = deps.reuseExistingKey
    ? deps.idempotencyKey
    : deps.idempotencyKey || generateIdempotencyKey("idem");

  if ((deps.payload as unknown as Record<string, unknown>).method === "VNPAY") {
    const vnpayBlockedErr = toPaymentSubmissionErrorState(
      {
        statusCode: 400,
        code: "INVALID_METHOD",
        message: "Flow VNPay không được gửi qua endpoint POST /payments. Tuyệt đối không fallback sang Mock.",
        canRetrySameKey: false,
        shouldGenerateNewKey: false,
        idempotencyKey: keyToUse,
      },
      keyToUse
    );
    deps.setPaymentError(vnpayBlockedErr);
    return {
      skipped: false,
      outcome: { type: "error", error: vnpayBlockedErr },
    };
  }

  if (!isOrderPayable(deps.activeOrder, effectiveStatus)) {
    const isExpired =
      effectiveStatus !== "CANCELLED" &&
      effectiveStatus !== "PAID" &&
      isOrderExpired(deps.activeOrder);
    const nonPayableError = toPaymentSubmissionErrorState(
      {
        statusCode: 409,
        code: "INVALID_TRANSITION",
        message: isExpired
          ? "Đơn hàng đã hết hạn thanh toán (expiresAt). Form và nút thanh toán đã bị khóa; không thể gửi POST /payments."
          : `Đơn hàng đang ở trạng thái ${String(
              effectiveStatus
            )} (không còn ở PENDING hoặc PAYMENT_FAILED) nên không thể thực hiện thanh toán.`,
        canRetrySameKey: false,
        shouldGenerateNewKey: false,
        idempotencyKey: keyToUse,
      },
      keyToUse
    );
    deps.setPaymentError(nonPayableError);
    return {
      skipped: false,
      outcome: { type: "error", error: nonPayableError },
    };
  }

  const validation = validateCreatePaymentPayload(deps.payload, keyToUse);
  if (!validation.isValid || !validation.payload) {
    const validationErr = toPaymentSubmissionErrorState(
      validation.error,
      keyToUse
    );
    deps.setPaymentError(validationErr);
    return {
      skipped: false,
      outcome: { type: "error", error: validationErr },
    };
  }

  if (
    validation.payload.orderId !== deps.activeOrder.id.trim().toLowerCase()
  ) {
    const mismatchOrderErr = toPaymentSubmissionErrorState(
      {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message:
          "orderId trong yêu cầu thanh toán không khớp với đơn hàng hiện tại.",
        canRetrySameKey: false,
        shouldGenerateNewKey: false,
        idempotencyKey: keyToUse,
      },
      keyToUse
    );
    deps.setPaymentError(mismatchOrderErr);
    return {
      skipped: false,
      outcome: { type: "error", error: mismatchOrderErr },
    };
  }

  if (
    !deps.verifySession() ||
    !deps.isAuthenticated ||
    !deps.accessToken ||
    isTokenExpired(deps.accessToken)
  ) {
    clearStoredSession();
    const unauthError = toPaymentSubmissionErrorState(
      {
        statusCode: 401,
        code: "UNAUTHORIZED",
        message:
          "Phiên đăng nhập thiếu hoặc đã hết hạn (401 UNAUTHORIZED). Vui lòng đăng nhập lại để thanh toán.",
        canRetrySameKey: false,
        shouldGenerateNewKey: false,
        idempotencyKey: keyToUse,
      },
      keyToUse
    );
    deps.setPaymentError(unauthError);
    deps.openAuthModal("login", {
      reasonMessage: unauthError.message,
    });
    return {
      skipped: false,
      outcome: { type: "error", error: unauthError },
    };
  }

  const callSubmitPayment = deps.submitPaymentFn || submitPaymentApi;
  const expectedMethodLast4 =
    "cardNumber" in validation.payload.paymentDetails
      ? validation.payload.paymentDetails.cardNumber.slice(-4)
      : validation.payload.paymentDetails.phoneNumber.slice(-4);

  deps.submittingRef.current = true;
  deps.setIsSubmitting(true);
  deps.setPaymentError(null);
  deps.setIdempotencyKey(keyToUse);
  deps.setLastSubmittedPayloadJson?.(JSON.stringify(validation.payload));

  try {
    const result: SubmitPaymentApiResult = await callSubmitPayment(
      validation.payload,
      keyToUse,
      {
        accessToken: deps.accessToken,
        expectedOrderId: deps.activeOrder.id,
        expectedAmountVnd: deps.activeOrder.totalVnd,
      }
    );

    // Kiểm tra chéo lần 2 tại tầng UI để đảm bảo tuyệt đối không xóa Cart hay hiển thị SUCCESS khi response sai/lệch Order
    const verifiedResponse = validatePaymentResponseData(
      result.response,
      keyToUse,
      {
        expectedOrderId: deps.activeOrder.id,
        expectedMethod: validation.payload.method,
        expectedMethodLast4,
        expectedAmountVnd: deps.activeOrder.totalVnd,
      }
    );

    deps.setPaymentResult(verifiedResponse);
    deps.setIsReplayedResult?.(Boolean(result.replayed));
    deps.setOrderStatus(verifiedResponse.orderStatus);
    deps.setIsResultModalOpen?.(true);

    if (
      verifiedResponse.paymentStatus === "SUCCESS" &&
      verifiedResponse.orderStatus === "PAID" &&
      verifiedResponse.failureReason === null
    ) {
      // API Contract v3.0 §3.2 & §9: Chỉ xóa Cart sau khi Payment SUCCESS (Order -> PAID)
      deps.clearCart();
      clearStoredActiveOrder();
      deps.setContextActiveOrder?.(null);
      if (!result.replayed) {
        deps.onPointsEarned?.(verifiedResponse.pointsEarned);
      }
      return {
        skipped: false,
        outcome: {
          type: "success",
          response: verifiedResponse,
          replayed: Boolean(result.replayed),
          idempotencyKey: keyToUse,
        },
      };
    }

    // API Contract v3.0 §3.2 & §9: FAILED không xóa Cart; tạo Idempotency-Key mới cho lần thử tiếp theo
    const nextKey = generateIdempotencyKey("idem");
    deps.setIdempotencyKey(nextKey);
    deps.setLastSubmittedPayloadJson?.("");
    return {
      skipped: false,
      outcome: {
        type: "failed",
        response: verifiedResponse,
        replayed: Boolean(result.replayed),
        idempotencyKey: keyToUse,
        nextIdempotencyKey: nextKey,
      },
    };
  } catch (err: unknown) {
    const errorState = toPaymentSubmissionErrorState(err, keyToUse);
    deps.setPaymentError(errorState);

    if (errorState.statusCode === 401 || errorState.code === "UNAUTHORIZED") {
      clearStoredSession();
      deps.openAuthModal("login", {
        reasonMessage:
          "Phiên đăng nhập đã hết hạn (401 UNAUTHORIZED). Vui lòng đăng nhập lại để tiếp tục thanh toán.",
      });
    } else if (errorState.shouldGenerateNewKey) {
      const freshKey = generateIdempotencyKey("idem");
      deps.setIdempotencyKey(freshKey);
      deps.setLastSubmittedPayloadJson?.("");
    }
    return {
      skipped: false,
      outcome: { type: "error", error: errorState },
    };
  } finally {
    deps.submittingRef.current = false;
    deps.setIsSubmitting(false);
  }
}

const FALLBACK_SAFE_ROUTER = {
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
};

function useSafeAppRouter() {
  try {
    return useRouter() ?? FALLBACK_SAFE_ROUTER;
  } catch {
    return FALLBACK_SAFE_ROUTER;
  }
}

export type VnPayFlowState =
  | "idle"
  | "initiating"
  | "redirecting"
  | "verifying"
  | "success"
  | "failed"
  | "expired"
  | "unknown";

export interface PaymentPageViewProps {
  initialOrder?: CreateOrderResponseDto | MyOrderDto | null;
  initialMethod?: PaymentMethod;
  initialCardNumber?: string;
  initialPhoneNumber?: string;
  initialIdempotencyKey?: string;
  initialIsSubmitting?: boolean;
  initialPaymentResult?: PaymentResponseDto | null;
  initialPaymentError?: PaymentSubmissionErrorState | null;
  initialVnPayFlowState?: VnPayFlowState;
  initiateVnPayFn?: typeof initiateVnPayPaymentApi;
  submitZeroAmountFn?: typeof submitZeroAmountPaymentApi;
  submitPaymentFn?: typeof submitPaymentApi;
  onRedirectToVnPay?: (paymentUrl: string) => void;
  onNavigateSuccess?: (url: string) => void;
}

export default function PaymentPageView({
  initialOrder = null,
  initialMethod = "VNPAY",
  initialCardNumber = "1234567890121234",
  initialPhoneNumber = "0912345678",
  initialIdempotencyKey,
  initialIsSubmitting = false,
  initialPaymentResult = null,
  initialPaymentError = null,
  initialVnPayFlowState = "idle",
  initiateVnPayFn,
  submitZeroAmountFn,
  submitPaymentFn,
  onRedirectToVnPay,
  onNavigateSuccess,
}: PaymentPageViewProps) {
  const router = useSafeAppRouter();
  const {
    openCart,
    clearCart,
    activeOrder: contextActiveOrder,
    setActiveOrder: setContextActiveOrder,
  } = useCart();

  const {
    user,
    accessToken,
    isAuthenticated,
    isLoading: isAuthLoading,
    openAuthModal,
    verifySession,
  } = useAuth();

  const currentUserId =
    isAuthenticated && user?.id ? user.id.trim().toLowerCase() : null;

  const initialSearchParams =
    typeof window !== "undefined" && window.location?.search
      ? new URLSearchParams(window.location.search)
      : null;
  const initialVnPayReturnCtx = extractVnPayReturnContext(initialSearchParams);

  // Khôi phục đơn hàng PENDING từ Checkout Flow Sprint 2 (nếu vừa chuyển từ CartDrawer sang)
  const sessionCheckoutOrder = useMemo<CreateOrderResponseDto | null>(() => {
    if (initialOrder) return initialOrder;
    if (contextActiveOrder) return contextActiveOrder;
    if (currentUserId) {
      return restoreActiveOrderForUser(currentUserId);
    }
    return null;
  }, [initialOrder, contextActiveOrder, currentUserId]);

  const [serverOrder, setServerOrder] = useState<
    CreateOrderResponseDto | MyOrderDto | null
  >(
    initialOrder ??
      (initialVnPayReturnCtx.hasVnPayReturnParams ? null : sessionCheckoutOrder)
  );
  const [isLoadingOrder, setIsLoadingOrder] = useState<boolean>(
    (!initialOrder && !sessionCheckoutOrder) ||
      (!initialOrder && initialVnPayReturnCtx.hasVnPayReturnParams)
  );
  const [hasLoadedServerTruth, setHasLoadedServerTruth] = useState<boolean>(
    Boolean(initialOrder && !initialVnPayReturnCtx.hasVnPayReturnParams)
  );
  const [dismissedVnPayReturnView, setDismissedVnPayReturnView] =
    useState<boolean>(false);
  const [loadOrderError, setLoadOrderError] = useState<string | null>(null);

  const sessionCheckoutOrderRef = useRef<CreateOrderResponseDto | null>(
    sessionCheckoutOrder
  );
  const resolvedOrderIdRef = useRef<string | null>(
    initialOrder?.id ?? sessionCheckoutOrder?.id ?? null
  );
  const clearedPaidOrderIdRef = useRef<string | null>(null);
  const notifiedSuccessOrderIdRef = useRef<string | null>(null);
  const redirectedConfirmUrlRef = useRef<string | null>(null);
  const pollAttemptsRef = useRef<number>(0);
  const routerRef = useRef(router);
  const onNavigateSuccessRef = useRef(onNavigateSuccess);
  const clearCartRef = useRef(clearCart);
  const setContextActiveOrderRef = useRef(setContextActiveOrder);

  useEffect(() => {
    routerRef.current = router;
    onNavigateSuccessRef.current = onNavigateSuccess;
    clearCartRef.current = clearCart;
    setContextActiveOrderRef.current = setContextActiveOrder;
  }, [router, onNavigateSuccess, clearCart, setContextActiveOrder]);

  useEffect(() => {
    if (sessionCheckoutOrder) {
      sessionCheckoutOrderRef.current = sessionCheckoutOrder;
      if (!resolvedOrderIdRef.current) {
        resolvedOrderIdRef.current = sessionCheckoutOrder.id;
      }
    }
  }, [sessionCheckoutOrder]);

  // Map hình ảnh sản phẩm thật từ GET /products
  const [productImagesById, setProductImagesById] = useState<
    Record<string, string>
  >({});

  // Điểm tích lũy thật từ GET /auth/me hoặc tổng pointsEarned trên GET /orders/me
  const [loyaltyPoints, setLoyaltyPoints] = useState<number>(0);

  // State chọn phương thức thanh toán & thông tin CARD / WALLET
  const [method, setMethod] = useState<PaymentMethod>(
    initialMethod === "CARD" || initialMethod === "WALLET" ? "VNPAY" : initialMethod
  );
  const [devNotice, setDevNotice] = useState<string | null>(null);
  const [cardNumber, setCardNumber] = useState<string>(initialCardNumber);
  const [phoneNumber, setPhoneNumber] = useState<string>(initialPhoneNumber);

  // Quản lý Idempotency-Key (8..64 ký tự) theo API Contract v3.0 §3.2 & §9
  const [idempotencyKey, setIdempotencyKey] = useState<string>(
    () => initialIdempotencyKey || generateIdempotencyKey("idem")
  );
  const [lastSubmittedPayloadJson, setLastSubmittedPayloadJson] =
    useState<string>("");

  // State Loading / Result / Error của POST /payments
  const [isSubmitting, setIsSubmitting] = useState<boolean>(
    initialIsSubmitting
  );
  const [vnPayFlowState, setVnPayFlowState] = useState<VnPayFlowState>(
    initialVnPayFlowState
  );
  const [activePaymentId, setActivePaymentId] = useState<string | null>(null);
  const [isVnPayTabOpened, setIsVnPayTabOpened] = useState<boolean>(false);
  const submittingRef = useRef<boolean>(initialIsSubmitting);
  const [paymentResult, setPaymentResult] =
    useState<PaymentResponseDto | null>(initialPaymentResult);
  const [isReplayedResult, setIsReplayedResult] = useState<boolean>(false);
  const [isResultModalOpen, setIsResultModalOpen] = useState<boolean>(
    Boolean(initialPaymentResult)
  );
  const [paymentError, setPaymentError] =
    useState<PaymentSubmissionErrorState | null>(initialPaymentError);

  const currentSearchParams =
    typeof window !== "undefined" && window.location?.search
      ? new URLSearchParams(window.location.search)
      : null;
  const vnpReturnCtx = extractVnPayReturnContext(currentSearchParams);

  const activeOrder =
    vnpReturnCtx.hasVnPayReturnParams && !hasLoadedServerTruth && !initialOrder
      ? null
      : serverOrder ?? sessionCheckoutOrder;

  const [submittedOrderStatus, setSubmittedOrderStatus] =
    useState<OrderStatus | null>(null);

  const orderStatus: OrderStatus =
    submittedOrderStatus ??
    paymentResult?.orderStatus ??
    activeOrder?.status ??
    "PENDING";



  // Tải danh sách ảnh sản phẩm thật từ GET /products
  useEffect(() => {
    let cancelled = false;
    fetchCatalogData()
      .then((catalog) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const p of catalog.products) {
          if (p.id && p.imageUrl) {
            map[p.id.trim().toLowerCase()] = p.imageUrl;
          }
        }
        setProductImagesById(map);
      })
      .catch(() => {
        // Giữ ảnh fallback nếu không tải được catalog
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tải đơn hàng thật từ GET /orders/me và hồ sơ khách hàng từ GET /auth/me
  const loadRealOrderAndProfile = useCallback(
    async (options?: {
      silent?: boolean;
      fromPoll?: boolean;
    }): Promise<OrderConfirmationData | null> => {
      if (isAuthLoading) return null;

      const effectiveToken =
        accessToken ||
        (isAuthenticated && typeof window !== "undefined"
          ? getStoredToken()
          : null);

      if (!isAuthenticated || !effectiveToken) {
        if (!options?.silent) {
          setIsLoadingOrder(false);
          setHasLoadedServerTruth(true);
        }
        return null;
      }

      if (!options?.silent) {
        setIsLoadingOrder(true);
        setLoadOrderError(null);
      }

      try {
        const searchParams =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search)
            : null;
        const returnCtx = extractVnPayReturnContext(searchParams);
        const explicitOrderId = returnCtx.orderIdFromParams;
        const fallbackOrderId =
          resolvedOrderIdRef.current ||
          sessionCheckoutOrderRef.current?.id ||
          null;

        const [myOrdersRes, authMeProfile] = await Promise.all([
          fetchMyOrdersApi(effectiveToken),
          fetchAuthMeProfile(effectiveToken),
        ]);

        // Tính tổng điểm tích lũy thật từ GET /auth/me (hoặc cộng từ các đơn hàng đã ghi nhận trong GET /orders/me)
        if (authMeProfile && typeof authMeProfile.loyaltyPoints === "number") {
          setLoyaltyPoints(authMeProfile.loyaltyPoints);
        } else {
          const totalEarnedFromOrders = myOrdersRes.items.reduce(
            (sum, o) =>
              sum + (typeof o.pointsEarned === "number" ? o.pointsEarned : 0),
            0
          );
          setLoyaltyPoints(totalEarnedFromOrders);
        }

        // Ưu tiên khớp theo explicitOrderId (orderId hoặc vnp_OrderInfo) -> vnp_TxnRef -> fallbackOrderId (từ checkout session)
        let targetOrder = selectTargetOrderFromMyOrders(
          myOrdersRes.items,
          explicitOrderId,
          returnCtx.vnpTxnRef
        );
        if (
          !targetOrder &&
          !explicitOrderId &&
          !returnCtx.vnpTxnRef &&
          fallbackOrderId
        ) {
          targetOrder = selectTargetOrderFromMyOrders(
            myOrdersRes.items,
            fallbackOrderId,
            null
          );
        } else if (
          targetOrder &&
          !explicitOrderId &&
          !returnCtx.vnpTxnRef &&
          fallbackOrderId &&
          targetOrder.id.trim().toLowerCase() !==
            fallbackOrderId.trim().toLowerCase()
        ) {
          const matchedFallback = myOrdersRes.items.find(
            (o) =>
              o.id.trim().toLowerCase() === fallbackOrderId.trim().toLowerCase()
          );
          if (matchedFallback) {
            targetOrder = matchedFallback;
          }
        }

        if (targetOrder) {
          resolvedOrderIdRef.current = targetOrder.id;
          setServerOrder(targetOrder);
          setSubmittedOrderStatus(targetOrder.status);
          setHasLoadedServerTruth(true);

          const hasFinancialLock =
            targetOrder.hasFinancialException === true ||
            targetOrder.payment?.requiresReview === true ||
            targetOrder.payment?.resolution === "FINANCIAL_EXCEPTION" ||
            targetOrder.payment?.resolution === "REQUIRES_REVIEW";

          const isConfirmedPaid =
            !hasFinancialLock &&
            (targetOrder.status === "PAID" ||
              targetOrder.status === "PREPARING" ||
              targetOrder.status === "READY" ||
              targetOrder.status === "COMPLETED");

          if (isConfirmedPaid) {
            if (clearedPaidOrderIdRef.current !== targetOrder.id) {
              clearedPaidOrderIdRef.current = targetOrder.id;
              clearCartRef.current();
              clearStoredActiveOrder();
              setContextActiveOrderRef.current?.(null);
            }
          } else if (!isOrderPayable(targetOrder)) {
            clearStoredActiveOrder();
            setContextActiveOrderRef.current?.(null);
          }

          // Điều hướng sang /order-confirmation khi:
          // 1. Có tham số VNPay Return URL (vnp_*) trên /payment, HOẶC
          // 2. Đơn hàng VNPay đã được máy chủ xác nhận PAID + payment.status === "SUCCESS"
          const isVnPayTarget =
            targetOrder.payment?.provider === "VNPAY" ||
            targetOrder.payment?.method === "VNPAY";
          const isVnPayConfirmedSuccess =
            isConfirmedPaid && targetOrder.payment?.status === "SUCCESS";

          if (
            returnCtx.hasVnPayReturnParams ||
            (isVnPayTarget && isVnPayConfirmedSuccess)
          ) {
            const confirmUrl = buildVnPayOrderConfirmationUrl(
              targetOrder.id,
              searchParams
            );
            if (redirectedConfirmUrlRef.current !== confirmUrl) {
              redirectedConfirmUrlRef.current = confirmUrl;
              routerRef.current.replace(confirmUrl);
            }
            if (
              isVnPayConfirmedSuccess &&
              notifiedSuccessOrderIdRef.current !== targetOrder.id
            ) {
              notifiedSuccessOrderIdRef.current = targetOrder.id;
              setVnPayFlowState("success");
              onNavigateSuccessRef.current?.(confirmUrl);
            }
          }

          // Nếu đơn hàng trên Server đã có Payment snapshot (ví dụ reload sau khi đã thanh toán Mock):
          // khôi phục kết quả đã kiểm duyệt từ GET /orders/me mà KHÔNG gọi POST /payments lại (API Contract v3.0 §4.2 & §9)
          if (
            targetOrder.payment &&
            !returnCtx.hasVnPayReturnParams &&
            !isVnPayTarget
          ) {
            try {
              const candidatePayment: PaymentResponseDto = {
                paymentId: targetOrder.payment.id,
                orderId: targetOrder.id,
                paymentStatus: targetOrder.payment.status,
                orderStatus:
                  targetOrder.payment.status === "SUCCESS"
                    ? "PAID"
                    : "PAYMENT_FAILED",
                amountVnd: targetOrder.payment.amountVnd,
                method: targetOrder.payment.method,
                methodLast4: targetOrder.payment.methodLast4 || "0000",
                mockReference: targetOrder.payment.mockReference || "MOCK-0000",
                pointsEarned: targetOrder.pointsEarned,
                failureReason:
                  targetOrder.payment.failureReason === "PAYMENT_DECLINED"
                    ? "PAYMENT_DECLINED"
                    : null,
                createdAt: targetOrder.payment.createdAt,
              };
              const verifiedSnapshot = validatePaymentResponseData(
                candidatePayment,
                "",
                {
                  expectedOrderId: targetOrder.id,
                  expectedAmountVnd: targetOrder.totalVnd,
                }
              );
              setPaymentResult(verifiedSnapshot);
            } catch {
              // Bỏ qua nếu snapshot payment không hợp lệ
            }
          }

          return targetOrder as unknown as OrderConfirmationData;
        } else if (
          !returnCtx.hasVnPayReturnParams &&
          sessionCheckoutOrderRef.current
        ) {
          setServerOrder(sessionCheckoutOrderRef.current);
          setSubmittedOrderStatus(sessionCheckoutOrderRef.current.status);
          setHasLoadedServerTruth(true);
        } else {
          setServerOrder(null);
          setHasLoadedServerTruth(true);
        }
      } catch (err: unknown) {
        if (!options?.silent) {
          const msg =
            err instanceof Error && err.message
              ? err.message
              : "Không thể tải thông tin đơn hàng từ máy chủ (GET /orders/me).";
          setLoadOrderError(msg);
          setHasLoadedServerTruth(true);
        }
      } finally {
        if (!options?.silent) {
          setIsLoadingOrder(false);
        }
      }
      return null;
    },
    [isAuthLoading, isAuthenticated, accessToken]
  );

  useEffect(() => {
    const hasVnPayQuery =
      typeof window !== "undefined" &&
      extractVnPayReturnContext(new URLSearchParams(window.location.search))
        .hasVnPayReturnParams;
    if (initialOrder && !hasVnPayQuery) return;
    pollAttemptsRef.current = 0;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void loadRealOrderAndProfile();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialOrder, loadRealOrderAndProfile]);

  // Bounded Polling trên /payment (dành cho luồng VNPay Return URL hoặc đơn VNPay đang PENDING / PROCESSING / RECONCILING):
  // Tự động refetch GET /orders/me và chuyển sang trạng thái xác nhận thành công ngay khi máy chủ báo Payment SUCCESS + Order PAID mà không cần F5.
  useEffect(() => {
    const searchParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const returnCtx = extractVnPayReturnContext(searchParams);
    const effectiveToken =
      accessToken ||
      (isAuthenticated && typeof window !== "undefined"
        ? getStoredToken()
        : null);

    if (
      isLoadingOrder ||
      !isAuthenticated ||
      !effectiveToken ||
      !serverOrder ||
      (initialOrder && !returnCtx.hasVnPayReturnParams)
    ) {
      return;
    }

    const orderAsConfirmation = serverOrder as unknown as OrderConfirmationData;
    const isVnPayInFlight =
      returnCtx.hasVnPayReturnParams ||
      orderAsConfirmation.payment?.provider === "VNPAY" ||
      orderAsConfirmation.payment?.method === "VNPAY" ||
      vnPayFlowState === "verifying" ||
      vnPayFlowState === "redirecting" ||
      isVnPayTabOpened;

    if (!isVnPayInFlight || !shouldPollOrderConfirmation(orderAsConfirmation)) {
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

        const updated = await loadRealOrderAndProfile({
          silent: true,
          fromPoll: true,
        });
        if (isDisposed) return;

        if (updated && !shouldPollOrderConfirmation(updated)) {
          return;
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
    isLoadingOrder,
    isAuthenticated,
    accessToken,
    serverOrder,
    initialOrder,
    vnPayFlowState,
    isVnPayTabOpened,
    loadRealOrderAndProfile,
  ]);

  const customerFullName = useMemo(() => {
    if (user) {
      return getDisplayCustomerName(user);
    }
    return "Khách hàng";
  }, [user]);

  const customerEmail = user?.email || "Chưa đăng nhập";

  // Đồng hồ đếm ngược 15 phút từ `expiresAt` thật của Server (hoặc `createdAt + 15 phút`)
  const expiresAtDate = useMemo<Date | null>(() => {
    const myOrderWithExpiry = activeOrder as Partial<MyOrderDto> | null;
    if (
      myOrderWithExpiry?.expiresAt &&
      Number.isFinite(Date.parse(myOrderWithExpiry.expiresAt))
    ) {
      return new Date(Date.parse(myOrderWithExpiry.expiresAt));
    }
    const createdMs = activeOrder?.createdAt
      ? Date.parse(activeOrder.createdAt)
      : NaN;
    if (Number.isFinite(createdMs)) {
      return new Date(createdMs + 15 * 60 * 1000);
    }
    return null;
  }, [activeOrder]);

  const [remainingSeconds, setRemainingSeconds] = useState<number>(15 * 60);

  useEffect(() => {
    const updateRemaining = () => {
      if (!expiresAtDate) {
        setRemainingSeconds(0);
        return;
      }
      const diff = Math.floor((expiresAtDate.getTime() - Date.now()) / 1000);
      setRemainingSeconds(diff > 0 ? diff : 0);
    };
    const initialTimer = setTimeout(updateRemaining, 0);
    const interval = setInterval(updateRemaining, 1000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [expiresAtDate]);

  const formattedCountdown = useMemo(() => {
    const mins = Math.floor(remainingSeconds / 60);
    const secs = remainingSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }, [remainingSeconds]);

  const formattedExpireClock = useMemo(() => {
    if (!expiresAtDate) return "--:--";
    return expiresAtDate.toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [expiresAtDate]);

  const isExpiredOrder = useMemo<boolean>(() => {
    if (!activeOrder) return false;
    if (orderStatus === "CANCELLED" || orderStatus === "PAID") return false;
    if (isOrderExpired(activeOrder)) return true;
    if (remainingSeconds <= 0 && Boolean(expiresAtDate)) return true;
    return false;
  }, [activeOrder, orderStatus, remainingSeconds, expiresAtDate]);

  const isPayableOrder = useMemo<boolean>(() => {
    if (!activeOrder) return false;
    if (paymentResult?.paymentStatus === "SUCCESS") return false;
    if (isExpiredOrder) return false;
    return isOrderPayable(activeOrder, orderStatus);
  }, [activeOrder, orderStatus, paymentResult?.paymentStatus, isExpiredOrder]);

  // Payload chuẩn API Contract v3.0 §3.1 được tạo từ form hiện tại
  const currentPaymentPayload = useMemo<CreatePaymentRequestDto>(() => {
    return buildCreatePaymentPayload({
      orderId: activeOrder?.id || "",
      method,
      cardNumber,
      phoneNumber,
    });
  }, [activeOrder?.id, method, cardNumber, phoneNumber]);

  const expectedPointsEarned = useMemo(() => {
    if (!activeOrder) return 0;
    return Math.floor(activeOrder.totalVnd / 10000);
  }, [activeOrder]);

  const totalItemsQuantity = useMemo(() => {
    if (!activeOrder) return 0;
    return activeOrder.items.reduce((sum, item) => sum + item.quantity, 0);
  }, [activeOrder]);

  const maskedCardDisplay = useMemo(() => {
    const clean = cardNumber.replace(/\D/g, "").slice(0, 16);
    const last4 = clean.length >= 4 ? clean.slice(-4) : clean.padEnd(4, "•");
    return `**** **** **** ${last4}`;
  }, [cardNumber]);

  const refreshKeyIfChangedAfterSubmit = (
    nextMethod: PaymentMethod,
    nextCard: string,
    nextPhone: string
  ) => {
    if (!lastSubmittedPayloadJson || !activeOrder) return;
    const nextPayload = buildCreatePaymentPayload({
      orderId: activeOrder.id,
      method: nextMethod,
      cardNumber: nextCard,
      phoneNumber: nextPhone,
    });
    if (JSON.stringify(nextPayload) !== lastSubmittedPayloadJson) {
      setIdempotencyKey(generateIdempotencyKey("idem"));
      setLastSubmittedPayloadJson("");
    }
  };

  const handleSelectMethod = (nextMethod: PaymentMethod) => {
    if (isSubmitting || !isPayableOrder) return;
    if (nextMethod !== "VNPAY") {
      setDevNotice(
        `Phương thức ${
          nextMethod === "CARD" ? "Thẻ thanh toán (CARD)" : "Ví điện tử (WALLET)"
        } hiện đang được phát triển. Vui lòng chọn Cổng thanh toán VNPay Sandbox.`
      );
      return;
    }
    setDevNotice(null);
    setMethod("VNPAY");
    setPaymentError(null);
    refreshKeyIfChangedAfterSubmit(nextMethod, cardNumber, phoneNumber);
  };

  const handleCardInputChange = (_rawVal: string) => {
    if (isSubmitting || !isPayableOrder) return;
    setDevNotice("Phương thức Thẻ thanh toán (CARD) hiện đang được phát triển. Vui lòng chọn VNPay Sandbox.");
  };

  const handleWalletInputChange = (_rawVal: string) => {
    if (isSubmitting || !isPayableOrder) return;
    setDevNotice("Phương thức Ví điện tử (WALLET) hiện đang được phát triển. Vui lòng chọn VNPay Sandbox.");
  };

  const handleSetCardScenario = (_scenario: "success" | "fail") => {
    if (isSubmitting || !isPayableOrder) return;
    setDevNotice("Phương thức Thẻ thanh toán (CARD) hiện đang được phát triển. Vui lòng chọn VNPay Sandbox.");
  };

  const handleSetWalletScenario = (_scenario: "success" | "fail") => {
    if (isSubmitting || !isPayableOrder) return;
    setDevNotice("Phương thức Ví điện tử (WALLET) hiện đang được phát triển. Vui lòng chọn VNPay Sandbox.");
  };

  /**
   * Quyết toán đơn hàng 0 ₫ (BR-06)
   */
  const handleZeroAmountSubmit = async () => {
    if (isSubmitting || submittingRef.current || !activeOrder || activeOrder.totalVnd !== 0) return;
    setIsSubmitting(true);
    submittingRef.current = true;
    setPaymentError(null);
    try {
      const zeroApi = submitZeroAmountFn ?? submitZeroAmountPaymentApi;
      const res = await zeroApi(
        { orderId: activeOrder.id },
        idempotencyKey,
        { accessToken }
      );
      // Kiểm tra nghiêm ngặt toàn bộ DTO (bao gồm UUID và calendar date của createdAt) trước khi xóa Cart hoặc navigate
      const verifiedZero = validateZeroAmountPaymentResponse(
        res?.response,
        activeOrder.id,
        idempotencyKey
      );
      if (
        verifiedZero.paymentStatus === "SUCCESS" &&
        verifiedZero.orderStatus === "PAID"
      ) {
        setVnPayFlowState("success");
        clearCart();
        if (setContextActiveOrder) setContextActiveOrder(null);
        clearStoredActiveOrder();
        const confirmUrl = `/order-confirmation?orderId=${encodeURIComponent(activeOrder.id)}&view=zero`;
        onNavigateSuccess?.(confirmUrl);
        router.push(confirmUrl);
      } else {
        throw new Error("Phản hồi quyết toán 0đ không hợp lệ từ máy chủ.");
      }
    } catch (err: unknown) {
      setVnPayFlowState("failed");
      const submissionErr = toPaymentSubmissionErrorState(err, idempotencyKey);
      setPaymentError(submissionErr);
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  };

  /**
   * Khởi tạo giao dịch thanh toán VNPay Sandbox (API Contract v4.0 §3 / BR-05).
   * Tuyệt đối không bao giờ fallback sang Mock Payment (POST /payments).
   */
  const handleVnPayInitiate = async (options?: {
    reuseExistingKey?: boolean;
  }) => {
    // Chặn double-initiation
    if (submittingRef.current || isSubmitting || !activeOrder) return;

    // Chặn khi đơn hàng đã hết hạn
    if (isOrderExpired(activeOrder) || orderStatus === "CANCELLED") {
      setVnPayFlowState("expired");
      setPaymentError({
        statusCode: 409,
        message: "Đơn hàng đã hết hạn thanh toán (15 phút). Không thể tạo giao dịch mới.",
        code: "ORDER_EXPIRED",
        idempotencyKey,
        canRetrySameKey: false,
        shouldGenerateNewKey: false,
      });
      return;
    }

    // Chặn retry khi VNPay còn PENDING / PAYMENT_IN_PROGRESS (BR-05)
    const isPendingPayment =
      Boolean(
        "payment" in activeOrder &&
          (activeOrder as MyOrderDto).payment?.status === "PENDING"
      ) ||
      (orderStatus === "PENDING" && vnPayFlowState === "verifying") ||
      paymentError?.code === "PAYMENT_IN_PROGRESS" ||
      vnPayFlowState === "verifying";

    if (isPendingPayment) {
      setVnPayFlowState("verifying");
      setPaymentError({
        statusCode: 409,
        message:
          "Giao dịch trước đó đang được xử lý. Vui lòng không thực hiện lại để tránh thanh toán hai lần.",
        code: "PAYMENT_IN_PROGRESS",
        idempotencyKey,
        canRetrySameKey: false, // Block retry vì vẫn đang PENDING
        shouldGenerateNewKey: false,
      });
      return;
    }

    // BR-06: Đơn hàng 0đ quyết toán nội bộ không cần redirect
    if (activeOrder.totalVnd === 0) {
      await handleZeroAmountSubmit();
      return;
    }

    // Khởi tạo thanh toán VNPay Sandbox (> 0 VND)
    setIsSubmitting(true);
    submittingRef.current = true;
    setVnPayFlowState("initiating");
    setPaymentError(null);

    const keyToUse = options?.reuseExistingKey
      ? idempotencyKey
      : idempotencyKey || generateIdempotencyKey();

    try {
      const initApi = initiateVnPayFn ?? initiateVnPayPaymentApi;
      const result = await initApi(
        { orderId: activeOrder.id },
        keyToUse,
        { accessToken }
      );

      // Validate response & paymentUrl từ Backend
      const paymentUrl = result?.response?.paymentUrl;
      if (
        !paymentUrl ||
        typeof paymentUrl !== "string" ||
        !/^https?:\/\//i.test(paymentUrl)
      ) {
        throw new Error(
          "Cổng thanh toán không trả về đường dẫn thanh toán hợp lệ."
        );
      }

      if (result.response.paymentId) {
        setActivePaymentId(result.response.paymentId);
        if (typeof window !== "undefined") {
          try {
            sessionStorage.setItem(
              `vnpay_payment_id_${activeOrder.id}`,
              result.response.paymentId
            );
          } catch {}
        }
      }

      setVnPayFlowState("redirecting");

      // Chỉ redirect bằng chính paymentUrl do backend trả về
      if (onRedirectToVnPay) {
        onRedirectToVnPay(paymentUrl);
      } else if (typeof window !== "undefined") {
        window.location.href = paymentUrl;
      }
    } catch (err: unknown) {
      submittingRef.current = false;
      setIsSubmitting(false);

      const submissionErr = toPaymentSubmissionErrorState(err, keyToUse);
      const errCode = submissionErr.code;

      if (errCode === "PAYMENT_IN_PROGRESS") {
        setVnPayFlowState("verifying");
        submissionErr.canRetrySameKey = false; // Block retry vì vẫn đang PENDING
      } else if (errCode === "ORDER_EXPIRED") {
        setVnPayFlowState("expired");
        submissionErr.canRetrySameKey = false;
      } else if (errCode === "IDEMPOTENCY_KEY_CONFLICT") {
        setVnPayFlowState("failed");
        setIdempotencyKey(generateIdempotencyKey());
      } else if (errCode === "NETWORK_ERROR") {
        setVnPayFlowState("unknown");
      } else {
        setVnPayFlowState("failed");
      }

      setPaymentError(submissionErr);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  /**
   * Thực thi gửi `POST /payments` thật lên Backend (hoặc retry với cùng `Idempotency-Key` khi timeout / `PAYMENT_IN_PROGRESS`)
   */
  const handleSubmitPayment = async (options?: {
    reuseExistingKey?: boolean;
  }) => {
    // BR-06 / P2-22: Đơn hàng 0đ quyết toán qua ZERO_AMOUNT, tuyệt đối không gọi VNPay hay Mock Payment (POST /payments)
    if (activeOrder && activeOrder.totalVnd === 0) {
      await handleZeroAmountSubmit();
      return;
    }
    // Tuyệt đối không fallback VNPay sang Mock Payment (POST /payments)
    if (method === "VNPAY") {
      await handleVnPayInitiate(options);
      return;
    }
    await executePaymentSubmission({
      activeOrder,
      orderStatus,
      payload: currentPaymentPayload,
      idempotencyKey,
      reuseExistingKey: options?.reuseExistingKey,
      accessToken,
      isAuthenticated,
      verifySession,
      openAuthModal,
      submittingRef,
      isSubmitting,
      setIsSubmitting,
      setIdempotencyKey,
      setLastSubmittedPayloadJson,
      setPaymentResult,
      setIsReplayedResult,
      setOrderStatus: setSubmittedOrderStatus,
      setIsResultModalOpen,
      setPaymentError,
      clearCart,
      setContextActiveOrder,
      onPointsEarned: (pts) => setLoyaltyPoints((prev) => prev + pts),
    });
  };

  const effectiveAccessToken =
    accessToken ||
    (isAuthenticated && typeof window !== "undefined"
      ? getStoredToken()
      : null);

  const confirmationOrder = serverOrder as unknown as OrderConfirmationData | null;
  const hasFinancialOrReviewLock = Boolean(
    confirmationOrder &&
      (confirmationOrder.hasFinancialException === true ||
        confirmationOrder.payment?.requiresReview === true ||
        confirmationOrder.payment?.resolution === "FINANCIAL_EXCEPTION" ||
        confirmationOrder.payment?.resolution === "REQUIRES_REVIEW")
  );
  const isConfirmedSuccessStatus = Boolean(
    confirmationOrder &&
      !hasFinancialOrReviewLock &&
      (confirmationOrder.status === "PAID" ||
        confirmationOrder.status === "PREPARING" ||
        confirmationOrder.status === "READY" ||
        confirmationOrder.status === "COMPLETED")
  );
  const isZeroAmountOrder = Boolean(
    confirmationOrder &&
      (confirmationOrder.totalVnd === 0 ||
        confirmationOrder.payment?.provider === "ZERO_AMOUNT" ||
        confirmationOrder.payment?.method === "ZERO_AMOUNT")
  );
  const isMockOrder = Boolean(
    confirmationOrder &&
      !isZeroAmountOrder &&
      (confirmationOrder.payment?.provider === "MOCK" ||
        confirmationOrder.payment?.method === "CARD" ||
        confirmationOrder.payment?.method === "WALLET")
  );
  const isExplicitVnPayOrder = Boolean(
    confirmationOrder &&
      !isZeroAmountOrder &&
      !isMockOrder &&
      (confirmationOrder.payment?.provider === "VNPAY" ||
        confirmationOrder.payment?.method === "VNPAY")
  );

  const shouldRenderAuthoritativeConfirmationView = Boolean(
    hasLoadedServerTruth &&
      !isLoadingOrder &&
      confirmationOrder &&
      ((vnpReturnCtx.hasVnPayReturnParams && !dismissedVnPayReturnView) ||
        (!initialOrder &&
          isExplicitVnPayOrder &&
          isConfirmedSuccessStatus &&
          confirmationOrder.payment?.status === "SUCCESS"))
  );

  if (shouldRenderAuthoritativeConfirmationView && confirmationOrder) {
    const handleConfirmationRetrySuccess = async () => {
      clearCart();
      clearStoredActiveOrder();
      setContextActiveOrder?.(null);
      await loadRealOrderAndProfile({ silent: false });
    };

    const handleConfirmationRetryFailure = async () => {
      return await loadRealOrderAndProfile({ silent: true });
    };

    // Ưu tiên #1: Khóa đối soát tài chính / cần rà soát thủ công (REQUIRES_REVIEW / FINANCIAL_EXCEPTION)
    if (hasFinancialOrReviewLock) {
      return (
        <PaymentFailedRetryView
          order={confirmationOrder}
          token={effectiveAccessToken}
          onRetrySuccess={handleConfirmationRetrySuccess}
          onRetryFailure={handleConfirmationRetryFailure}
        />
      );
    }

    // Ưu tiên #2: Máy chủ đã xác nhận đơn hàng PAID (PAID / PREPARING / READY / COMPLETED)
    if (isConfirmedSuccessStatus) {
      if (isZeroAmountOrder) {
        return (
          <ZeroPaymentBypassView
            order={confirmationOrder}
            customerName={customerFullName}
          />
        );
      }

      if (isExplicitVnPayOrder) {
        return (
          <VnPaySuccessView
            order={confirmationOrder}
            customerName={customerFullName}
            userPoints={loyaltyPoints || confirmationOrder.pointsEarned}
            vnpayDetails={{
              vnp_TxnRef: vnpReturnCtx.vnpTxnRef || undefined,
              vnp_TransactionNo: vnpReturnCtx.vnpTransactionNo || undefined,
              vnp_BankCode: vnpReturnCtx.vnpBankCode || undefined,
              vnp_PayDate: vnpReturnCtx.vnpPayDate || undefined,
            }}
          />
        );
      }

      return (
        <OrderSuccessView
          order={confirmationOrder}
          customerName={customerFullName}
          userPoints={loyaltyPoints || confirmationOrder.pointsEarned}
        />
      );
    }

    // Ưu tiên #3: Không phải giao dịch VNPay trên máy chủ (VD: payment === null hoặc MOCK) -> giữ chuẩn Server Truth
    if (!isExplicitVnPayOrder) {
      return (
        <PaymentFailedRetryView
          order={confirmationOrder}
          token={effectiveAccessToken}
          onRetrySuccess={handleConfirmationRetrySuccess}
          onRetryFailure={handleConfirmationRetryFailure}
        />
      );
    }

    // Ưu tiên #4: Đơn hàng đã CANCELLED trên máy chủ
    if (confirmationOrder.status === "CANCELLED") {
      return (
        <PaymentFailedRetryView
          order={confirmationOrder}
          token={effectiveAccessToken}
          onRetrySuccess={handleConfirmationRetrySuccess}
          onRetryFailure={handleConfirmationRetryFailure}
        />
      );
    }

    // Ưu tiên #5: Giao dịch VNPay đã FAILED trên máy chủ (BR-05)
    const isServerVnPayFailed =
      confirmationOrder.status === "PAYMENT_FAILED" ||
      confirmationOrder.payment?.status === "FAILED" ||
      confirmationOrder.payment?.resolution === "FAILED";

    if (isServerVnPayFailed) {
      const failureReason = confirmationOrder.payment?.failureReason;
      const derivedResponseCode =
        (vnpReturnCtx.vnpResponseCode && vnpReturnCtx.vnpResponseCode !== "00"
          ? vnpReturnCtx.vnpResponseCode
          : null) ||
        (failureReason?.startsWith("VNPAY_RESPONSE_")
          ? failureReason.replace("VNPAY_RESPONSE_", "")
          : failureReason?.startsWith("VNPAY_STATUS_")
          ? failureReason.replace("VNPAY_STATUS_", "")
          : "24");

      return (
        <VnPayFailedRetryView
          order={confirmationOrder}
          vnpResponseCode={derivedResponseCode}
          vnpTxnRef={vnpReturnCtx.vnpTxnRef}
          token={effectiveAccessToken}
          onRetryVnPay={async () => {
            if (confirmationOrder.payment?.status === "PENDING") {
              await loadRealOrderAndProfile({ silent: true });
              return;
            }
            setDismissedVnPayReturnView(true);
            router.replace(
              `/payment?orderId=${encodeURIComponent(confirmationOrder.id)}&method=VNPAY`
            );
          }}
        />
      );
    }

    // Ưu tiên #6: Giao dịch VNPay đang PENDING / PROCESSING / RECONCILING (đang chờ IPN / QueryDR)
    if (
      confirmationOrder.status === "PENDING" &&
      (confirmationOrder.payment?.status === "PENDING" ||
        confirmationOrder.payment?.resolution === "PROCESSING" ||
        confirmationOrder.payment?.resolution === "RECONCILING")
    ) {
      return (
        <VnPayProcessingView
          order={confirmationOrder}
          orderIdParam={confirmationOrder.id}
          vnpTxnRef={vnpReturnCtx.vnpTxnRef}
          amountVnd={confirmationOrder.totalVnd}
          onRefreshStatus={() => loadRealOrderAndProfile({ silent: true })}
        />
      );
    }

    return (
      <PaymentFailedRetryView
        order={confirmationOrder}
        token={effectiveAccessToken}
        onRetrySuccess={handleConfirmationRetrySuccess}
        onRetryFailure={handleConfirmationRetryFailure}
      />
    );
  }


  return (
    <div className="min-h-screen flex flex-col bg-[#FDFBF7] font-body-md text-[#1E1510] antialiased">
      <Header onCartClick={openCart} activeNav="thuc-don" />

      <main className="w-full pt-20 bg-[#FDFBF7] min-h-screen flex-1">
        <div className="flex flex-col w-full">
          {/* Top Breadcrumb Bar */}
          <div className="w-full bg-[#FAF6EE] border-b border-[#EFECE6]">
            <div className="max-w-[1320px] mx-auto px-margin py-space-sm flex items-center justify-between gap-4 flex-wrap">
              <nav
                aria-label="Breadcrumb"
                className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md"
              >
                <Link
                  href="/"
                  className="hover:text-[#C67C4E] transition-colors flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    restaurant_menu
                  </span>
                  Thực đơn
                </Link>
                <span className="material-symbols-outlined text-[14px] text-outline">
                  chevron_right
                </span>
                <button
                  type="button"
                  onClick={openCart}
                  className="hover:text-[#C67C4E] transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    shopping_bag
                  </span>
                  Giỏ hàng
                </button>
                <span className="material-symbols-outlined text-[14px] text-outline">
                  chevron_right
                </span>
                <span className="text-[#C67C4E] font-semibold flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">
                    payment
                  </span>
                  Thanh toán đơn hàng
                </span>
              </nav>
            </div>
          </div>

          {/* TRẠNG THÁI 1: ĐANG TẢI DỮ LIỆU ĐƠN HÀNG TỪ GET /orders/me */}
          {isLoadingOrder && !activeOrder && (
            <div className="max-w-[1320px] mx-auto px-margin py-space-xl w-full flex flex-col items-center justify-center text-center gap-3">
              <span className="material-symbols-outlined text-[40px] text-[#C67C4E] animate-spin">
                progress_activity
              </span>
              <h2 className="font-headline-md text-headline-md text-[#1E1510] font-bold">
                Đang tải thông tin đơn hàng từ máy chủ...
              </h2>
              <p className="font-body-md text-body-md text-on-surface-variant">
                Đang đồng bộ dữ liệu thực tế từ API <code>GET /orders/me</code>
              </p>
            </div>
          )}

          {/* TRẠNG THÁI 2: CHƯA ĐĂNG NHẬP */}
          {!isLoadingOrder && !isAuthenticated && !activeOrder && (
            <div className="max-w-[1320px] mx-auto px-margin py-space-xl w-full">
              <div className="bg-white rounded-2xl p-space-xl border border-[#EFECE6] shadow-sm max-w-lg mx-auto text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-[#FAF6EE] text-[#C67C4E] flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-[32px]">
                    lock_person
                  </span>
                </div>
                <h2 className="font-headline-md text-headline-md text-[#1E1510] font-bold">
                  Vui lòng đăng nhập để thanh toán
                </h2>
                <p className="font-body-md text-body-md text-on-surface-variant">
                  Vui lòng đăng nhập để xem thông tin đơn hàng và tiến hành thanh toán.
                </p>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => openAuthModal("login")}
                    className="px-6 py-3 rounded-xl bg-[#C67C4E] hover:bg-[#b56e40] text-white font-title-sm text-title-sm font-bold transition-colors cursor-pointer"
                  >
                    Đăng nhập ngay
                  </button>
                  <Link
                    href="/"
                    className="px-5 py-3 rounded-xl border border-[#EFECE6] bg-[#FAF6EE] hover:bg-[#EFECE6] text-[#1E1510] font-title-sm text-title-sm font-semibold transition-colors"
                  >
                    Về Thực đơn
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* TRẠNG THÁI 3: ĐÃ ĐĂNG NHẬP NHƯNG CHƯA CÓ ĐƠN HÀNG PENDING / CẦN THANH TOÁN */}
          {!isLoadingOrder && isAuthenticated && !activeOrder && (
            <div className="max-w-[1320px] mx-auto px-margin py-space-xl w-full">
              <div className="bg-white rounded-2xl p-space-xl border border-[#EFECE6] shadow-sm max-w-lg mx-auto text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-[#FAF6EE] text-[#C67C4E] flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-[32px]">
                    receipt_long
                  </span>
                </div>
                <h2 className="font-headline-md text-headline-md text-[#1E1510] font-bold">
                  Chưa có đơn hàng nào chờ thanh toán
                </h2>
                <p className="font-body-md text-body-md text-on-surface-variant">
                  {loadOrderError
                    ? loadOrderError
                    : "Hãy chọn món vào Giỏ hàng và bấm Đặt hàng để tạo đơn trước khi tiến hành thanh toán."}
                </p>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={openCart}
                    className="px-6 py-3 rounded-xl bg-[#C67C4E] hover:bg-[#b56e40] text-white font-title-sm text-title-sm font-bold transition-colors cursor-pointer"
                  >
                    Mở Giỏ hàng &amp; Đặt đơn
                  </button>
                  <Link
                    href="/"
                    className="px-5 py-3 rounded-xl border border-[#EFECE6] bg-[#FAF6EE] hover:bg-[#EFECE6] text-[#1E1510] font-title-sm text-title-sm font-semibold transition-colors"
                  >
                    Khám phá Thực đơn
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* TRẠNG THÁI 4: HIỂN THỊ GIAO DIỆN THANH TOÁN VỚI ĐƠN HÀNG THẬT */}
          {activeOrder && (
            <>
              {/* Header & Order Status Section */}
              <div className="max-w-[1320px] mx-auto px-margin pt-space-lg pb-space-sm w-full">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-space-sm">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center flex-wrap gap-2.5">
                      <h1 className="font-headline-lg text-headline-lg text-[#1E1510] font-bold">
                        Thanh toán Đơn hàng
                      </h1>
                      {/* Order UUID Badge */}
                      <span
                        id="paymentOrderIdBadge"
                        className="font-mono text-label-md px-2.5 py-1 rounded bg-[#EFECE6] text-[#53443b] font-medium select-all"
                      >
                        #{activeOrder.id}
                      </span>
                      {/* Status Badge */}
                      {orderStatus === "PAID" ? (
                        <span
                          id="paymentOrderStatusBadge"
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-full font-label-md text-[12px] bg-[#E6F4EA] text-[#137333] border border-[#A8DAB5] font-bold"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#137333]" />
                          ĐÃ THANH TOÁN
                        </span>
                      ) : orderStatus === "PAYMENT_FAILED" ? (
                        <span
                          id="paymentOrderStatusBadge"
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-full font-label-md text-[12px] bg-[#FCE8E6] text-[#C5221F] border border-[#F5C2C7] font-bold"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#C5221F] animate-pulse" />
                          THANH TOÁN THẤT BẠI
                        </span>
                      ) : orderStatus === "PENDING" ? (
                        <span
                          id="paymentOrderStatusBadge"
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-full font-label-md text-[12px] bg-[#FEFCE8] text-[#D97706] border border-[#FDE047] font-bold"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#D97706] animate-pulse" />
                          CHỜ THANH TOÁN
                        </span>
                      ) : (
                        <span
                          id="paymentOrderStatusBadge"
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-full font-label-md text-[12px] bg-[#EFECE6] text-[#53443b] border border-[#D7CCC8] font-bold"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#53443b]" />
                          KHÔNG THỂ THANH TOÁN
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* ExpiresAt Countdown Notice Box */}
                <div className="mt-4 p-space-md rounded-xl bg-[#FEFCE8] border border-[#FDE047] text-[#1E1510] flex items-start gap-space-sm shadow-sm">
                  <span className="material-symbols-outlined text-[#D97706] text-[24px] flex-shrink-0 mt-0.5">
                    timer
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-title-sm text-title-sm text-[#D97706] font-bold">
                        Thời gian hoàn tất thanh toán còn lại:{" "}
                        <span
                          className="font-mono text-[17px] text-[#C67C4E]"
                          id="countdownTimer"
                        >
                          {formattedCountdown}
                        </span>{" "}
                        (Hết hạn lúc {formattedExpireClock})
                      </span>
                    </div>
                    <p className="font-body-sm text-body-sm text-[#53443b]">
                      Vui lòng hoàn tất thanh toán trước thời gian hết hạn. Quá 15 phút, đơn hàng sẽ tự động bị hủy.
                    </p>
                  </div>
                </div>
              </div>

              {/* Main Content Layout (12 cols: 7 Left, 5 Right) */}
              <div className="max-w-[1320px] mx-auto px-margin py-space-md pb-space-xl w-full">
                <div className="grid grid-cols-12 gap-gutter items-start">
                  {/* LEFT COLUMN: Payment Form conforming to ERD & POST /payments (7 cols) */}
                  <div className="col-span-12 lg:col-span-7 flex flex-col gap-space-lg">
                    {/* MỤC 1: Thông tin tài khoản đặt hàng (từ JWT / GET /auth/me & GET /orders/me) */}
                    <div className="bg-white rounded-xl p-space-lg shadow-sm border border-[#EFECE6] flex flex-col gap-space-md">
                      <div className="flex items-center justify-between border-b border-[#EFECE6] pb-3">
                        <div className="flex items-center gap-space-sm">
                          <div className="w-7 h-7 rounded-full bg-[#C67C4E]/10 text-[#C67C4E] flex items-center justify-center font-bold text-sm">
                            1
                          </div>
                          <h2 className="font-title-md text-title-md text-[#1E1510] font-bold">
                            Thông tin tài khoản đặt hàng
                          </h2>
                        </div>
                        <span className="material-symbols-outlined text-[#C67C4E] text-[20px]">
                          account_circle
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md text-body-sm">
                        <div className="flex flex-col gap-1 p-3 rounded-lg bg-[#FAF6EE] border border-[#EFECE6]">
                          <span className="font-label-md text-[11px] text-on-surface-variant uppercase tracking-wider">
                            Họ và tên
                          </span>
                          <span className="font-title-sm text-title-sm text-[#1E1510] font-semibold">
                            {customerFullName}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1 p-3 rounded-lg bg-[#FAF6EE] border border-[#EFECE6]">
                          <span className="font-label-md text-[11px] text-on-surface-variant uppercase tracking-wider">
                            Email tài khoản
                          </span>
                          <span
                            className="font-title-sm text-[14px] text-[#1E1510] font-semibold truncate"
                            title={customerEmail}
                          >
                            {customerEmail}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1 p-3 rounded-lg bg-[#FAF6EE] border border-[#EFECE6]">
                          <span className="font-label-md text-[11px] text-on-surface-variant uppercase tracking-wider">
                            Điểm tích lũy hiện tại
                          </span>
                          <span className="font-title-sm text-title-sm text-[#C67C4E] font-bold flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px]">
                              stars
                            </span>{" "}
                            {loyaltyPoints} điểm
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* MỤC 2: Chọn phương thức thanh toán */}
                    <div className="bg-white rounded-xl p-space-lg shadow-sm border border-[#EFECE6] flex flex-col gap-space-md">
                      <div className="flex items-center justify-between border-b border-[#EFECE6] pb-3">
                        <div className="flex items-center gap-space-sm">
                          <div className="w-7 h-7 rounded-full bg-[#C67C4E]/10 text-[#C67C4E] flex items-center justify-center font-bold text-sm">
                            2
                          </div>
                          <h2 className="font-title-md text-title-md text-[#1E1510] font-bold">
                            Chọn phương thức thanh toán
                          </h2>
                        </div>
                      </div>

                      {/* Payment Method Tabs / Accordion (Chỉ mở cho Order ở trạng thái PENDING hoặc PAYMENT_FAILED) */}
                      {!isPayableOrder ? (
                        <div
                          id="nonPayableOrderBanner"
                          role="alert"
                          aria-live="polite"
                          className={`rounded-xl p-space-md border flex flex-col gap-2 ${
                            orderStatus === "PAID"
                              ? "bg-[#E6F4EA] border-[#A8DAB5] text-[#137333]"
                              : "bg-[#FCE8E6] border-[#F5C2C7] text-[#C5221F]"
                          }`}
                        >
                          <div className="flex items-center gap-2 font-title-sm text-title-sm font-bold">
                            <span className="material-symbols-outlined text-[20px]">
                              {orderStatus === "PAID" ? "verified" : isExpiredOrder ? "schedule" : "block"}
                            </span>
                            <span id="nonPayableOrderTitle">
                              {orderStatus === "PAID"
                                ? "Đơn hàng đã hoàn tất thanh toán"
                                : isExpiredOrder
                                ? (
                                    <>
                                      Đơn hàng đã hết hạn thanh toán
                                      <span className="sr-only"> (EXPIRED)</span>
                                    </>
                                  )
                                : "Không thể thanh toán đơn hàng này"}
                            </span>
                          </div>
                          <p id="nonPayableOrderMessage" className="font-body-sm text-body-sm text-[#1E1510] leading-relaxed">
                            {orderStatus === "PAID"
                              ? "Đơn hàng này đã được thanh toán thành công. Biểu mẫu thanh toán đã được khóa."
                              : isExpiredOrder
                              ? "Đơn hàng chỉ được giữ tối đa 15 phút từ lúc tạo. Đơn hàng này đã quá hạn thanh toán nên không thể thực hiện giao dịch."
                              : "Chỉ các đơn hàng đang chờ thanh toán hoặc chưa thanh toán thành công mới được phép thực hiện giao dịch."}
                          </p>
                          <div className="pt-2">
                            <Link
                              href={`/order-confirmation?orderId=${activeOrder.id}&status=${orderStatus}`}
                              id="btnNonPayableOrderConfirmation"
                              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white hover:bg-[#F5F2EA] text-on-surface text-xs font-semibold border border-[#EFECE6] shadow-xs transition-colors"
                            >
                              <span className="material-symbols-outlined text-[16px]">receipt_long</span>
                              <span>
                                {orderStatus === "PAID"
                                  ? "Xem xác nhận đơn hàng đã thanh toán"
                                  : "Xem trạng thái xác nhận đơn hàng"}
                              </span>
                            </Link>
                          </div>
                        </div>
                      ) : (
                        <div
                          id="paymentMethodFormSection"
                          className="flex flex-col gap-space-md"
                        >
                          {/* ĐƠN HÀNG 0Đ - ZERO_AMOUNT BYPASS (BR-06) */}
                          {activeOrder && activeOrder.totalVnd === 0 && (
                            <div className="p-5 rounded-xl bg-[#F0FDF4] border-2 border-[#16A34A] flex flex-col gap-3 shadow-xs">
                              <div className="flex items-center gap-2">
                                <span className="material-symbols-outlined text-[#16A34A] text-[24px]">verified</span>
                                <h3 className="font-title-sm text-[#15803D] font-bold">
                                  Đơn hàng 0 ₫ — Miễn phí 100%
                                </h3>
                              </div>
                              <p className="text-xs text-[#166534] leading-relaxed">
                                Đơn hàng được miễn phí 100% nhờ áp dụng khuyến mãi. Hệ thống tự động xác nhận đơn hàng mà không cần chuyển tiếp sang cổng thanh toán.
                              </p>
                              <button
                                type="button"
                                id="btnZeroPaymentBypass"
                                disabled={isSubmitting}
                                onClick={handleZeroAmountSubmit}
                                className="w-full py-3 px-6 rounded-xl bg-[#16A34A] hover:bg-[#15803D] text-white font-title-sm text-title-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-colors text-center disabled:opacity-50 cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[18px]">check_circle</span>
                                <span>{isSubmitting ? "Đang xác nhận đơn hàng..." : "Xác nhận đơn hàng 0 ₫ ngay"}</span>
                              </button>
                            </div>
                          )}

                          {/* Thông báo phương thức đang phát triển */}
                          {devNotice && (
                            <div
                              id="devPaymentNotice"
                              role="alert"
                              className="p-3.5 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] flex items-start gap-2.5 text-xs animate-fadeIn shadow-xs"
                            >
                              <span className="material-symbols-outlined text-[20px] text-[#D97706] shrink-0 mt-0.5">
                                engineering
                              </span>
                              <div className="flex items-center justify-between w-full gap-2">
                                <p className="leading-relaxed font-medium">
                                  {devNotice}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => setDevNotice(null)}
                                  className="text-[#92400E] hover:text-[#78350F] p-1 font-bold text-sm cursor-pointer shrink-0"
                                  aria-label="Đóng thông báo"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          )}

                          {/* PHƯƠNG THỨC 0: Cổng thanh toán VNPay */}
                          <div
                            className={`rounded-xl p-space-md flex flex-col gap-space-md transition-all ${
                              method === "VNPAY"
                                ? "border-2 border-[#005baa] bg-[#f0f7fc]"
                                : "border border-[#EFECE6] bg-white hover:border-[#005baa]/50"
                            }`}
                          >
                            <label
                              className="flex items-center justify-between cursor-pointer"
                              onClick={() => handleSelectMethod("VNPAY")}
                            >
                              <div className="flex items-center gap-space-sm">
                                <input
                                  id="radioVnpay"
                                  type="radio"
                                  name="payment_method_enum"
                                  value="VNPAY"
                                  checked={method === "VNPAY"}
                                  disabled={isSubmitting}
                                  onChange={() => handleSelectMethod("VNPAY")}
                                  className="w-4 h-4 text-[#005baa] focus:ring-[#005baa] border-[#EFECE6]"
                                />
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-title-sm text-title-sm text-[#1E1510] font-bold">
                                      Cổng thanh toán VNPay
                                      <span className="sr-only"> Sandbox</span>
                                    </span>
                                  </div>
                                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                                    Quét mã VNPAY-QR, Thẻ ATM Nội địa &amp; Thẻ Quốc tế Visa/Mastercard
                                  </p>
                                </div>
                              </div>
                              <div className="w-12 h-8 rounded bg-white border border-[#EFECE6] flex items-center justify-center p-1 shadow-xs">
                                <svg className="w-full h-full" fill="none" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
                                  <rect fill="#005BAA" height="120" rx="20" width="120"></rect>
                                  <path d="M22 36L44 84H58L36 36H22Z" fill="#ED1C24"></path>
                                  <path d="M52 36L74 84H88L66 36H52Z" fill="#FFFFFF"></path>
                                  <path d="M82 36L94 62L106 36H96L88 54L80 36H82Z" fill="#FFFFFF"></path>
                                </svg>
                              </div>
                            </label>

                            {method === "VNPAY" && (
                            <div className="pt-2 border-t border-[#005baa]/20 space-y-2.5">
                              <div className="p-3 bg-white rounded-lg border border-[#005baa]/20 text-xs text-on-surface-variant flex items-start gap-2">
                                <span className="material-symbols-outlined text-[#005baa] text-[18px] shrink-0 mt-0.5">verified_user</span>
                                <p className="leading-relaxed">
                                  Bạn sẽ được chuyển hướng an toàn đến cổng thanh toán <span className="font-semibold text-[#005baa]">VNPay</span> trong tab mới để xác thực giao dịch qua môi trường bảo mật SSL 256-bit chuẩn PCI-DSS khi bấm nút <strong>Xác nhận thanh toán</strong> bên dưới. Tab hiện tại sẽ được giữ nguyên.
                                </p>
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-[#005baa] font-medium px-1">
                                <span className="material-symbols-outlined text-[16px]">info</span>
                                <span>Hỗ trợ thẻ ATM nội địa (NAPAS), VNPAY-QR và thẻ quốc tế Visa / Mastercard / JCB</span>
                              </div>
                            </div>
                          )}

                          </div>

                          {/* PHƯƠNG THỨC 1: Thẻ thanh toán (CARD) - ĐANG PHÁT TRIỂN */}
                          <div
                            className="rounded-xl p-space-md flex flex-col gap-space-md transition-all opacity-70 bg-[#FAF9F5] border border-dashed border-[#D1CCC4] hover:border-[#C67C4E]/60 cursor-pointer"
                            onClick={() => handleSelectMethod("CARD")}
                          >
                            <label
                              className="flex items-center justify-between cursor-pointer"
                              onClick={() => handleSelectMethod("CARD")}
                            >
                            <div className="flex items-center gap-space-sm">
                              <input
                                id="radioCard"
                                type="radio"
                                name="payment_method_enum"
                                value="CARD"
                                checked={false}
                                disabled={true}
                                readOnly
                                className="w-4 h-4 text-[#C67C4E] focus:ring-[#C67C4E] border-[#EFECE6] cursor-not-allowed"
                              />
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-title-sm text-title-sm text-[#7D7571] font-bold">
                                    Thẻ thanh toán (ATM / Visa / Mastercard)
                                  </span>
                                  <span className="px-2 py-0.5 rounded-full bg-[#E5E0D8] text-[#6E645E] font-label-md text-[11px] font-bold">
                                    ĐANG PHÁT TRIỂN
                                  </span>
                                </div>
                                <span className="font-body-sm text-body-sm text-on-surface-variant/80">
                                  Thanh toán bằng thẻ ATM / Thẻ quốc tế (Tính năng đang phát triển - Chưa hỗ trợ)
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 opacity-60">
                              <span className="px-2 py-0.5 rounded bg-white border border-[#EFECE6] font-bold text-[11px] text-[#C67C4E]">
                                VISA
                              </span>
                              <span className="px-2 py-0.5 rounded bg-white border border-[#EFECE6] font-bold text-[11px] text-[#944925]">
                                MC
                              </span>
                            </div>
                          </label>

                          {/* Card Visual Box & Inputs */}
                          <div
                            className="pt-space-xs flex flex-col gap-space-md border-t border-[#EFECE6]"
                            id="cardDetailsPanel"
                          >
                            {/* Minh họa thẻ BrewLite Reserve Card sang trọng */}
                            <div className="relative w-full h-44 rounded-xl p-5 text-white overflow-hidden shadow-md flex flex-col justify-between bg-gradient-to-br from-[#1E1510] via-[#31231B] to-[#8d4e24]">
                              <div className="absolute -right-8 -bottom-8 w-44 h-44 rounded-full bg-white/5 blur-xl pointer-events-none" />
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="material-symbols-outlined text-[#C67C4E] text-[24px]">
                                    coffee
                                  </span>
                                  <span className="font-title-md text-title-md tracking-wider font-semibold">
                                    BrewLite Reserve Card
                                  </span>
                                </div>
                                <span className="material-symbols-outlined text-[24px] opacity-75">
                                  contactless
                                </span>
                              </div>
                              {/* methodLast4 display */}
                              <div
                                className="font-mono text-headline-md tracking-widest text-white/95"
                                id="mockCardDisplayMasked"
                              >
                                {maskedCardDisplay}
                              </div>
                              <div className="flex items-end justify-between font-label-md text-white/80">
                                <div>
                                  <span className="block text-[10px] uppercase tracking-wider text-white/60">
                                    Chủ tài khoản
                                  </span>
                                  <span className="font-mono uppercase font-semibold text-title-sm text-white">
                                    {customerFullName.toUpperCase()}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-[10px] uppercase tracking-wider text-white/60">
                                    Phương thức
                                  </span>
                                  <span className="font-mono font-semibold text-title-sm text-[#ffb68c]">
                                    CARD
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* Ô input DUY NHẤT: cardNumber */}
                            <div className="flex flex-col gap-1.5">
                              <label
                                htmlFor="cardInputNumber"
                                className="font-label-lg text-label-lg text-[#1E1510] flex items-center justify-between"
                              >
                                <span>
                                  Số thẻ thanh toán{" "}
                                  <span className="font-mono font-normal text-on-surface-variant">
                                    (16 chữ số)
                                  </span>{" "}
                                  <span className="text-error">*</span>
                                </span>
                                <span
                                  className="font-mono text-[11px] text-on-surface-variant"
                                  id="cardLenCounter"
                                >
                                  {cardNumber.length}/16 ký tự
                                </span>
                              </label>
                              <div className="relative">
                                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-outline">
                                  <span className="material-symbols-outlined text-[18px]">
                                    credit_card
                                  </span>
                                </span>
                                <input
                                  id="cardInputNumber"
                                  type="text"
                                  inputMode="numeric"
                                  maxLength={16}
                                  disabled={isSubmitting}
                                  value={cardNumber}
                                  onFocus={() => handleSelectMethod("CARD")}
                                  onChange={(e) =>
                                    handleCardInputChange(e.target.value)
                                  }
                                  placeholder="Nhập 16 chữ số thẻ (VD: 1234567890121234)"
                                  className="w-full pl-10 pr-10 py-2.5 bg-white border border-[#EFECE6] rounded-lg text-[#1E1510] font-mono text-body-md focus:outline-none focus:ring-2 focus:ring-[#C67C4E] shadow-sm disabled:opacity-60"
                                />
                                <span className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-[#C67C4E]">
                                  <span className="material-symbols-outlined text-[18px]">
                                    verified
                                  </span>
                                </span>
                              </div>
                            </div>

                            {/* 2 Nút chọn nhanh kịch bản kiểm thử CARD */}
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <span className="font-label-md text-[12px] text-on-surface-variant font-medium">
                                Kịch bản thử nghiệm CARD:
                              </span>
                              <button
                                id="btnScenarioCardSuccess"
                                type="button"
                                disabled={isSubmitting}
                                onClick={() => handleSetCardScenario("success")}
                                className="px-3 py-1.5 rounded-lg bg-[#E6F4EA] hover:bg-[#CEEAD6] text-[#137333] border border-[#A8DAB5] font-label-md text-[12px] transition-colors flex items-center gap-1.5 font-semibold cursor-pointer disabled:opacity-50"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  check_circle
                                </span>
                                Kịch bản Thành công (đuôi ≠ 0002, VD: ...1234 →
                                SUCCESS)
                              </button>
                              <button
                                id="btnScenarioCardFail"
                                type="button"
                                disabled={isSubmitting}
                                onClick={() => handleSetCardScenario("fail")}
                                className="px-3 py-1.5 rounded-lg bg-[#FCE8E6] hover:bg-[#FAD2CF] text-[#C5221F] border border-[#F5C2C7] font-label-md text-[12px] transition-colors flex items-center gap-1.5 font-semibold cursor-pointer disabled:opacity-50"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  cancel
                                </span>
                                Kịch bản Thất bại (đuôi 0002, VD: ...0002 →
                                FAILED)
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* PHƯƠNG THỨC 2: Ví điện tử (WALLET) - ĐANG PHÁT TRIỂN */}
                        <div
                          className="rounded-xl p-space-md flex flex-col gap-space-md transition-all opacity-70 bg-[#FAF9F5] border border-dashed border-[#D1CCC4] hover:border-[#C67C4E]/60 cursor-pointer"
                          onClick={() => handleSelectMethod("WALLET")}
                        >
                          <label
                            className="flex items-center justify-between cursor-pointer"
                            onClick={() => handleSelectMethod("WALLET")}
                          >
                            <div className="flex items-center gap-space-sm">
                              <input
                                id="radioWallet"
                                type="radio"
                                name="payment_method_enum"
                                value="WALLET"
                                checked={false}
                                disabled={true}
                                readOnly
                                className="w-4 h-4 text-[#C67C4E] focus:ring-[#C67C4E] border-[#EFECE6] cursor-not-allowed"
                              />
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-title-sm text-title-sm text-[#7D7571] font-bold">
                                    Ví điện tử (WALLET)
                                  </span>
                                  <span className="px-2 py-0.5 rounded-full bg-[#E5E0D8] text-[#6E645E] font-label-md text-[11px] font-bold">
                                    ĐANG PHÁT TRIỂN
                                  </span>
                                </div>
                                <span className="font-body-sm text-body-sm text-on-surface-variant/80">
                                  Thanh toán qua ví điện tử liên kết số điện thoại (Tính năng đang phát triển - Chưa hỗ trợ)
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 opacity-60">
                              <span className="w-7 h-7 rounded-lg bg-[#a50064] text-white flex items-center justify-center font-bold text-[10px]">
                                MoMo
                              </span>
                              <span className="w-7 h-7 rounded-lg bg-[#0068ff] text-white flex items-center justify-center font-bold text-[10px]">
                                VNPay
                              </span>
                            </div>
                          </label>

                          {/* Wallet Inputs & Guidance */}
                          <div
                            className="pt-space-xs flex flex-col gap-space-md border-t border-[#EFECE6]"
                            id="walletDetailsPanel"
                          >
                            <div className="flex flex-col gap-1.5">
                              <label
                                htmlFor="walletInputPhone"
                                className="font-label-lg text-label-lg text-[#1E1510] flex items-center justify-between"
                              >
                                <span>
                                  Số điện thoại ví điện tử{" "}
                                  <span className="font-mono font-normal text-on-surface-variant">
                                    (phoneNumber - bắt buộc đúng 10 chữ số)
                                  </span>{" "}
                                  <span className="text-error">*</span>
                                </span>
                                <span
                                  className="font-mono text-[11px] text-on-surface-variant"
                                  id="walletLenCounter"
                                >
                                  {phoneNumber.length}/10 ký tự
                                </span>
                              </label>
                              <div className="relative">
                                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-outline">
                                  <span className="material-symbols-outlined text-[18px]">
                                    phone_android
                                  </span>
                                </span>
                                <input
                                  id="walletInputPhone"
                                  type="tel"
                                  inputMode="numeric"
                                  maxLength={10}
                                  disabled={isSubmitting}
                                  value={phoneNumber}
                                  onFocus={() => handleSelectMethod("WALLET")}
                                  onChange={(e) =>
                                    handleWalletInputChange(e.target.value)
                                  }
                                  placeholder="Nhập 10 chữ số điện thoại (VD: 0912345678)"
                                  className="w-full pl-10 pr-10 py-2.5 bg-[#FAF6EE] border border-[#EFECE6] rounded-lg text-[#1E1510] font-mono text-body-md focus:outline-none focus:ring-2 focus:ring-[#C67C4E] disabled:opacity-60"
                                />
                                <span className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-[#C67C4E]">
                                  <span className="material-symbols-outlined text-[18px]">
                                    account_balance_wallet
                                  </span>
                                </span>
                              </div>
                            </div>

                            {/* Hướng dẫn kịch bản WALLET */}
                            <div className="p-3 rounded-lg bg-[#FAF6EE] border border-[#EFECE6] flex items-start gap-2.5">
                              <span className="material-symbols-outlined text-[#C67C4E] text-[18px] flex-shrink-0 mt-0.5">
                                info
                              </span>
                              <div className="flex flex-col gap-1">
                                <p className="font-body-sm text-[12px] text-[#53443b] leading-relaxed">
                                  <span className="font-semibold text-[#1E1510]">
                                    Hướng dẫn kịch bản WALLET:
                                  </span>{" "}
                                  Số điện thoại kết thúc bằng{" "}
                                  <span className="px-1 py-0.5 rounded bg-white font-mono font-bold text-error border border-[#EFECE6]">
                                    0000
                                  </span>{" "}
                                  (VD: 0912340000) →{" "}
                                  <span className="font-bold text-error">
                                    FAILED (PAYMENT_DECLINED)
                                  </span>
                                  ; các số khác →{" "}
                                  <span className="font-bold text-[#137333]">
                                    SUCCESS
                                  </span>
                                  .
                                </p>
                                <div className="flex items-center gap-2 pt-1 flex-wrap">
                                  <button
                                    id="btnScenarioWalletSuccess"
                                    type="button"
                                    disabled={isSubmitting}
                                    onClick={() =>
                                      handleSetWalletScenario("success")
                                    }
                                    className="px-2 py-0.5 rounded bg-white border border-[#A8DAB5] text-[#137333] font-label-md text-[11px] hover:bg-[#E6F4EA] cursor-pointer disabled:opacity-50"
                                  >
                                    Đặt số thành công (...5678)
                                  </button>
                                  <button
                                    id="btnScenarioWalletFail"
                                    type="button"
                                    disabled={isSubmitting}
                                    onClick={() =>
                                      handleSetWalletScenario("fail")
                                    }
                                    className="px-2 py-0.5 rounded bg-white border border-[#F5C2C7] text-[#C5221F] font-label-md text-[11px] hover:bg-[#FCE8E6] cursor-pointer disabled:opacity-50"
                                  >
                                    Đặt số thất bại (...0000)
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      )}
                    </div>

                      <span id="activeIdempotencyKeyBadge" className="sr-only">Key: {idempotencyKey}</span>
                    </div>

                  {/* RIGHT COLUMN: Order Summary Sticky Card (5 cols) */}
                  <div className="col-span-12 lg:col-span-5 sticky top-24 flex flex-col gap-space-md">
                    <div className="bg-white rounded-xl p-space-lg shadow-sm border border-[#EFECE6] flex flex-col gap-space-md">
                      {/* Summary Header */}
                      <div className="flex items-center justify-between pb-3 border-b border-[#EFECE6]">
                        <div>
                          <h2 className="font-headline-md text-headline-md text-[#1E1510] font-bold">
                            Tóm tắt đơn hàng
                          </h2>
                        </div>
                        <span className="px-2.5 py-1 rounded-full bg-[#FAF6EE] text-[#C67C4E] border border-[#EFECE6] font-label-md text-[12px] font-bold">
                          {totalItemsQuantity} món
                        </span>
                      </div>

                      {/* Items List */}
                      <div
                        className="flex flex-col gap-3"
                        id="paymentOrderItemsList"
                      >
                        {activeOrder.items.map((item) => {
                          const sizeDisplay =
                            item.size === "ONE_SIZE"
                              ? "Tiêu chuẩn"
                              : `Size ${item.size}`;
                          const resolvedImg =
                            productImagesById[
                              item.productId.trim().toLowerCase()
                            ] || FALLBACK_DRINK_IMAGE;

                          return (
                            <div
                              key={item.id}
                              className="flex items-start justify-between gap-3 p-3 rounded-lg bg-[#FAF6EE] border border-[#EFECE6] hover:bg-[#FAF6EE]/80 transition-colors"
                            >
                              <div className="flex items-start gap-3">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={resolvedImg}
                                  alt={item.productName}
                                  className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-[#EFECE6] bg-surface-container"
                                  onError={(e) => {
                                    const target = e.currentTarget;
                                    if (
                                      !target.src.endsWith(FALLBACK_DRINK_IMAGE)
                                    ) {
                                      target.src = FALLBACK_DRINK_IMAGE;
                                    }
                                  }}
                                />
                                <div className="flex flex-col">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-label-md text-label-md px-1.5 py-0.5 rounded bg-[#C67C4E] text-white font-bold">
                                      {item.quantity}x
                                    </span>
                                    <span className="font-title-sm text-title-sm text-[#1E1510] font-bold">
                                      {item.productName}
                                    </span>
                                  </div>
                                  <span className="font-body-sm text-[13px] text-on-surface-variant mt-0.5">
                                    {sizeDisplay}
                                  </span>
                                  {item.toppings.length > 0 && (
                                    <span className="font-body-sm text-[12px] text-[#C67C4E]">
                                      Topping:{" "}
                                      {item.toppings
                                        .map(
                                          (t) =>
                                            `${t.name} (+${formatVnd(
                                              t.priceVnd
                                            )})`
                                        )
                                        .join(", ")}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className="font-title-sm text-title-sm text-[#1E1510] font-bold flex-shrink-0">
                                {formatVnd(item.lineTotalVnd)}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Mã ưu đãi */}
                      <div className="flex flex-col gap-2 pt-2 border-t border-[#EFECE6]">
                        <div className="flex items-center justify-between">
                          <label className="font-label-md text-label-md text-[#1E1510] font-semibold">
                            Mã ưu đãi đã áp dụng
                          </label>
                          {activeOrder.couponCode ? (
                            <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-[#FEFCE8] text-[#D97706] border border-[#FDE047] font-semibold">
                              Đã áp dụng
                            </span>
                          ) : (
                            <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-surface-container text-outline">
                              Không áp dụng
                            </span>
                          )}
                        </div>
                        {activeOrder.couponCode && (
                          <>
                            <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#FAF6EE] border border-[#EFECE6]">
                              <div className="flex items-center gap-2">
                                <span className="material-symbols-outlined text-[#C67C4E] text-[18px]">
                                  loyalty
                                </span>
                                <span className="font-mono font-bold text-[#C67C4E] text-body-md tracking-wider">
                                  {activeOrder.couponCode}
                                </span>
                              </div>
                              <span className="font-label-md text-[12px] text-[#137333] font-bold bg-[#E6F4EA] px-2 py-0.5 rounded">
                                -{formatVnd(activeOrder.discountVnd)}
                              </span>
                            </div>
                            <p className="font-body-sm text-[11px] text-on-surface-variant italic">
                              * Mã ưu đãi đã được áp dụng cho đơn hàng này.
                            </p>
                          </>
                        )}
                      </div>

                      {/* Price Calculations Details */}
                      <div className="bg-[#FAF6EE] rounded-xl p-space-md flex flex-col gap-2.5 border border-[#EFECE6]">
                        <div className="flex items-center justify-between text-body-md font-body-md text-on-surface-variant">
                          <span>Tạm tính</span>
                          <span className="text-[#1E1510] font-medium font-mono">
                            {formatVnd(activeOrder.subtotalVnd)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-body-md font-body-md text-[#C67C4E]">
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px]">
                              redeem
                            </span>
                            Giảm giá mã ưu đãi
                          </span>
                          <span className="font-semibold font-mono">
                            -{formatVnd(activeOrder.discountVnd)}
                          </span>
                        </div>
                        {/* BrewPoints Earning (+pointsEarned = floor(totalVnd / 10000)) */}
                        <div className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-white border border-[#EFECE6] text-[#C67C4E] font-label-md text-label-md">
                          <span className="flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px]">
                              stars
                            </span>
                            Điểm thưởng dự kiến
                          </span>
                          <span className="font-bold">
                            +{expectedPointsEarned} điểm
                          </span>
                        </div>
                        {/* Total Amount (totalVnd / amountVnd) */}
                        <div className="pt-2 mt-1 border-t border-[#EFECE6] flex items-baseline justify-between">
                          <div className="flex flex-col">
                            <span className="font-headline-sm text-title-md text-[#1E1510] font-bold">
                              TỔNG CỘNG
                            </span>
                          </div>
                          <span
                            id="paymentTotalAmountText"
                            className="font-price-lg text-[26px] text-[#C67C4E] font-bold font-mono"
                          >
                            {formatVnd(activeOrder.totalVnd)}
                          </span>
                        </div>
                      </div>

                      {/* Khung hiển thị LỖI HTTP / Validation của POST /payments (API Contract v3.0 §3.4) */}
                      {paymentError && (
                        <div
                          id="paymentErrorBanner"
                          role="alert"
                          aria-live="assertive"
                          className="p-3.5 rounded-xl bg-[#FCE8E6] border border-[#F5C2C7] text-[#C5221F] space-y-2 text-[12px]"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5 font-bold">
                              <span className="material-symbols-outlined text-[18px]">
                                error
                              </span>
                              <span>Không thể hoàn tất thanh toán</span>
                            </div>
                            <span className="px-2 py-0.5 rounded bg-white font-mono text-[11px] font-semibold">
                              {paymentError.statusCode > 0
                                ? `HTTP ${paymentError.statusCode} • `
                                : ""}
                              {paymentError.code}
                            </span>
                          </div>
                          <p className="text-[#1E1510] leading-relaxed">
                            {paymentError.message}
                          </p>
                          {paymentError.canRetrySameKey && (
                            <button
                              id="btnRetrySameIdempotencyKey"
                              type="button"
                              disabled={
                                isSubmitting ||
                                (method === "VNPAY" && (
                                  paymentError.code === "PAYMENT_IN_PROGRESS" ||
                                  vnPayFlowState === "verifying"
                                ))
                              }
                              onClick={async () => {
                                if (method === "VNPAY") {
                                  await handleVnPayInitiate({ reuseExistingKey: true });
                                  return;
                                }
                                await handleSubmitPayment({ reuseExistingKey: true });
                              }}
                              className="w-full py-2 px-3 rounded-lg bg-[#C67C4E] hover:bg-[#b56e40] text-white font-label-md text-[12px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {method === "VNPAY" && (paymentError.code === "PAYMENT_IN_PROGRESS" || vnPayFlowState === "verifying")
                                ? "Giao dịch đang được xử lý..."
                                : "Thử gửi lại giao dịch"}{" "}
                              <span className="sr-only">({paymentError.idempotencyKey})</span>
                            </button>
                          )}
                          {method === "VNPAY" && (paymentError.code === "PAYMENT_IN_PROGRESS" || vnPayFlowState === "verifying") && activeOrder && (
                            <Link
                              id="btnCheckVnPayProcessingStatus"
                              href={`/order-confirmation?orderId=${encodeURIComponent(activeOrder.id)}&view=processing`}
                              className="w-full py-2 px-3 rounded-lg bg-[#005baa] hover:bg-[#004785] text-white font-label-md text-[12px] font-bold transition-colors flex items-center justify-center gap-1.5 text-center cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-[16px]">sync</span>
                              <span>Kiểm tra trạng thái đối soát giao dịch</span>
                            </Link>
                          )}
                        </div>
                      )}

                      {/* Thông báo khi đã mở tab VNPay thanh toán */}
                      {isVnPayTabOpened && method === "VNPAY" && (
                        <div
                          id="vnpayTabNotice"
                          className="p-3.5 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF] flex items-start gap-2.5 text-xs animate-fadeIn"
                        >
                          <span className="material-symbols-outlined text-[20px] text-[#2563EB] shrink-0 mt-0.5">
                            open_in_new
                          </span>
                          <div className="flex flex-col gap-1 w-full">
                            <p className="font-semibold text-[#1E3A8A]">
                              Cổng thanh toán VNPay đã được mở trong tab mới!
                            </p>
                            <p className="text-[#1E40AF]/90 leading-relaxed">
                              Vui lòng hoàn tất thanh toán tại tab mới vừa mở. Tab thanh toán hiện tại vẫn được giữ nguyên để bạn theo dõi đơn hàng.
                            </p>
                            <div className="pt-1.5 flex items-center justify-between flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  const vnpayUrl = `/order-confirmation?orderId=${encodeURIComponent(activeOrder.id)}&view=redirecting`;
                                  if (typeof window !== "undefined") {
                                    window.open(vnpayUrl, "_blank", "noopener,noreferrer");
                                  }
                                }}
                                className="inline-flex items-center gap-1 font-bold text-[#1D4ED8] hover:underline cursor-pointer"
                              >
                                <span>Mở lại tab VNPay</span>
                                <span className="material-symbols-outlined text-[14px]">launch</span>
                              </button>
                              <Link
                                href={`/order-confirmation?orderId=${activeOrder.id}&view=processing`}
                                className="inline-flex items-center gap-1 font-medium text-[#2563EB] hover:underline"
                              >
                                <span>Kiểm tra kết quả giao dịch</span>
                                <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                              </Link>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Checkout CTA Button: Xác nhận thanh toán (POST /payments, ZERO_AMOUNT hoặc chuyển hướng VNPay Sandbox) */}
                      <button
                        id="btnSubmitPayment"
                        type="button"
                        disabled={
                          isSubmitting ||
                          !isPayableOrder ||
                          vnPayFlowState === "verifying" ||
                          vnPayFlowState === "redirecting"
                        }
                        onClick={async () => {
                          if (activeOrder.totalVnd === 0) {
                            await handleZeroAmountSubmit();
                            return;
                          }
                          if (method === "VNPAY") {
                            await handleVnPayInitiate({ reuseExistingKey: false });
                            return;
                          }
                          await handleSubmitPayment({ reuseExistingKey: false });
                        }}
                        className={`w-full py-3.5 px-space-lg rounded-xl active:scale-[0.99] text-white font-title-sm text-title-sm font-bold flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                          activeOrder.totalVnd === 0
                            ? "bg-[#16A34A] hover:bg-[#15803D]"
                            : method === "VNPAY"
                            ? "bg-[#005baa] hover:bg-[#004785]"
                            : "bg-[#C67C4E] hover:bg-[#b56e40]"
                        }`}
                      >
                        <span
                          className={`material-symbols-outlined text-[20px] ${
                            isSubmitting ? "animate-spin" : ""
                          }`}
                        >
                          {isSubmitting
                            ? "progress_activity"
                            : orderStatus === "PAID"
                            ? "check_circle"
                            : !isPayableOrder
                            ? "block"
                            : activeOrder.totalVnd === 0
                            ? "check_circle"
                            : method === "VNPAY"
                            ? "open_in_new"
                            : "lock"}
                        </span>
                        <span>
                          {isSubmitting
                            ? vnPayFlowState === "initiating"
                              ? "Đang khởi tạo cổng VNPay..."
                              : vnPayFlowState === "redirecting"
                              ? "Đang chuyển hướng sang VNPay..."
                              : "Đang xử lý thanh toán..."
                            : orderStatus === "PAID"
                            ? `Đơn hàng đã thanh toán • ${formatVnd(
                                activeOrder.totalVnd
                              )}`
                            : !isPayableOrder
                            ? isExpiredOrder
                              ? (
                                  <>
                                    Đơn hàng đã hết hạn thanh toán
                                    <span className="sr-only"> (EXPIRED)</span>
                                  </>
                                )
                              : "Không thể thanh toán"
                            : activeOrder.totalVnd === 0
                            ? `Xác nhận đơn hàng 0 ₫ (ZERO_AMOUNT)`
                            : method === "VNPAY"
                            ? `Xác nhận thanh toán qua VNPay • ${formatVnd(
                                activeOrder.totalVnd
                              )}`
                            : orderStatus === "PAYMENT_FAILED"
                            ? `Thử thanh toán lại • ${formatVnd(
                                activeOrder.totalVnd
                              )}`
                            : `Xác nhận thanh toán • ${formatVnd(
                                activeOrder.totalVnd
                              )}`}
                        </span>
                      </button>

                      {/* SSL & Security Badges */}
                      <div className="flex items-center justify-center flex-wrap gap-3 text-outline font-label-md text-[11px] pt-1">
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px] text-[#137333]">
                            shield
                          </span>{" "}
                          SSL 256-Bit Encrypted
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px] text-[#C67C4E]">
                            security
                          </span>{" "}
                          PCI-DSS Compliant
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px] text-[#1E1510]">
                            sync_saved_locally
                          </span>{" "}
                          Idempotent Protection
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {/* Interactive Result Modal for POST /payments */}
      {isResultModalOpen && paymentResult && (
        <div
          id="paymentResultModal"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity duration-300"
        >
          <div
            id="modalCardBox"
            className="bg-white rounded-2xl max-w-md w-full p-space-xl shadow-2xl border border-[#EFECE6] flex flex-col items-center text-center"
          >
            {/* Icon Container (Dynamic: Success or Error) */}
            <div
              id="modalStatusIcon"
              className={`w-20 h-20 rounded-full flex items-center justify-center mb-space-md ${
                paymentResult.paymentStatus === "SUCCESS"
                  ? "bg-[#E6F4EA] text-[#137333]"
                  : "bg-[#FCE8E6] text-[#C5221F]"
              }`}
            >
              <span className="material-symbols-outlined text-[42px]">
                {paymentResult.paymentStatus === "SUCCESS"
                  ? "check_circle"
                  : "cancel"}
              </span>
            </div>

            {/* Status Badge */}
            <span
              id="modalStatusBadge"
              className={`px-3 py-1 rounded-full font-label-md text-label-md mb-2 font-bold border ${
                paymentResult.paymentStatus === "SUCCESS"
                  ? "bg-[#E6F4EA] text-[#137333] border-[#A8DAB5]"
                  : "bg-[#FCE8E6] text-error border-[#F5C2C7]"
              }`}
            >
              {paymentResult.paymentStatus === "SUCCESS"
                ? "● THANH TOÁN THÀNH CÔNG (SUCCESS)"
                : "● GIAO DỊCH THẤT BẠI (FAILED)"}
            </span>

            {/* Heading */}
            <h3
              id="modalHeading"
              className="font-headline-md text-headline-md text-[#1E1510] font-bold mb-2"
            >
              {paymentResult.paymentStatus === "SUCCESS"
                ? "Đơn hàng đã thanh toán!"
                : "Thanh toán không thành công"}
            </h3>
            <p
              id="modalDescription"
              className="font-body-md text-body-md text-on-surface-variant mb-space-lg leading-relaxed"
            >
              {paymentResult.paymentStatus === "SUCCESS"
                ? `Trạng thái đơn hàng chuyển sang ${paymentResult.orderStatus}. Điểm tích lũy (+${paymentResult.pointsEarned} điểm) đã được ghi nhận. Giỏ hàng đã được xóa sạch sau giao dịch.`
                : `Giao dịch bị từ chối (${
                    paymentResult.failureReason || "PAYMENT_DECLINED"
                  }). Trạng thái đơn hàng chuyển sang ${
                    paymentResult.orderStatus
                  }. Giỏ hàng được bảo toàn nguyên vẹn để bạn thử lại.`}
            </p>

            {/* Details Summary Box matching API response (API Contract v3.0 §3.3) */}
            <div className="w-full bg-[#FAF6EE] border border-[#EFECE6] rounded-xl p-space-md mb-space-lg flex flex-col gap-2 text-left font-body-sm text-body-sm">
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">orderId:</span>
                <span className="font-mono font-semibold text-[#1E1510] text-[12px] truncate">
                  {paymentResult.orderId}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">paymentId:</span>
                <span
                  className="font-mono font-semibold text-[#1E1510] text-[12px] truncate"
                  id="modalTxId"
                >
                  {paymentResult.paymentId}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">
                  Mã tham chiếu (mockReference):
                </span>
                <span
                  className="font-mono font-semibold text-[#1E1510]"
                  id="modalMockRef"
                >
                  {paymentResult.mockReference}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">
                  Số tiền (amountVnd):
                </span>
                <span className="font-bold text-[#C67C4E] font-mono">
                  {formatVnd(paymentResult.amountVnd)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">
                  Phương thức (method):
                </span>
                <span
                  className="font-mono font-semibold text-[#1E1510]"
                  id="modalMethodDisplay"
                >
                  {paymentResult.method} (**** {paymentResult.methodLast4})
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">
                  Điểm thưởng (pointsEarned):
                </span>
                <span className="font-mono font-semibold text-[#137333]">
                  +{paymentResult.pointsEarned} điểm
                </span>
              </div>
              {paymentResult.failureReason && (
                <div className="flex justify-between gap-2">
                  <span className="text-on-surface-variant">
                    Lý do (failureReason):
                  </span>
                  <span className="font-mono font-semibold text-error">
                    {paymentResult.failureReason}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-on-surface-variant">
                  Idempotency-Replayed:
                </span>
                <span className="font-mono text-[11px] text-[#53443b]">
                  {String(isReplayedResult)}
                </span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-2 w-full">
              <Link
                href={`/order-confirmation?orderId=${paymentResult.orderId}&status=${paymentResult.orderStatus}`}
                id="btnGoToOrderConfirmation"
                className="flex-1 py-3 px-4 rounded-xl bg-[#C67C4E] hover:bg-[#b56e40] text-white font-title-sm text-title-sm font-bold shadow-md transition-colors cursor-pointer text-center"
              >
                {paymentResult.paymentStatus === "SUCCESS"
                  ? "Xem xác nhận đơn hàng"
                  : "Chuyển sang trang Thử lại"}
              </Link>
              <button
                type="button"
                id="btnClosePaymentResultModal"
                onClick={() => setIsResultModalOpen(false)}
                className="py-3 px-4 rounded-xl border border-[#EFECE6] bg-[#FAF6EE] hover:bg-[#EFECE6] text-[#1E1510] font-title-sm text-title-sm font-semibold transition-colors cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
