"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { type OpenAuthModalOptions, useAuth } from "@/context/AuthContext";
import {
  ACTIVE_ORDER_STORAGE_KEY,
  buildCreateOrderPayloadFromCart,
  type CartItem,
  clearStoredActiveOrder,
  persistActiveOrderForUser,
  resolveStoredAuthenticatedUserId,
  restoreActiveOrderForUser,
  useCart,
} from "@/context/CartContext";
import type {
  CouponValidationStatus,
  CreateOrderRequestDto,
  CreateOrderResponseDto,
  OrderSubmissionErrorState,
} from "@/mock-data";
import { FALLBACK_DRINK_IMAGE, formatVnd } from "@/services/api.service";
import { getDisplayCustomerName } from "@/services/auth.service";
import {
  classifyCouponPreviewError,
  createOrderApi,
  getFriendlyOrderErrorTitle,
  previewCouponApi,
  toOrderSubmissionErrorState,
  type OrderServiceError,
} from "@/services/order.service";
import {
  generateIdempotencyKey,
  submitZeroAmountPaymentApi,
  validateZeroAmountPaymentResponse,
  type ZeroAmountPaymentResponseDto,
} from "@/services/payment.service";

export type CheckoutDrawerStep = "cart" | "review";

export type OrderCallOutcome =
  | {
      type: "success";
      order: CreateOrderResponseDto;
    }
  | {
      type: "error";
      statusCode: number;
      code: string;
      message: string;
      isOutcomeUncertain: boolean;
      detailLines: string[];
    };

export interface ProceedToCheckoutFlowDeps {
  itemsCount: number;
  isSubmittingOrder: boolean;
  isAuthenticated: boolean;
  verifySession: () => boolean;
  openAuthModal: (
    mode?: "login" | "register",
    options?: OpenAuthModalOptions
  ) => void;
  setVoucherNoticeVisible: (visible: boolean) => void;
  setOrderCallOutcome: (outcome: OrderCallOutcome | null) => void;
  setCheckoutStep: (step: CheckoutDrawerStep) => void;
}

/**
 * Điều phối chuyển từ Bước 1 (Giỏ hàng) -> Bước 2 (Xác nhận Đặt hàng / Checkout):
 * - Nếu giỏ hàng trống hoặc đang gửi request tạo đơn: bỏ qua.
 * - Nếu chưa đăng nhập hoặc JWT hết hạn: mở Login Modal (`resumeCheckout: true`) và giữ nguyên giỏ hàng.
 * - Nếu đã xác thực hợp lệ: chuyển sang bước `"review"`.
 */
export function proceedToCheckoutStep(deps: ProceedToCheckoutFlowDeps): boolean {
  if (deps.itemsCount === 0 || deps.isSubmittingOrder) return false;

  const hasValidSession = deps.verifySession();
  if (!hasValidSession || !deps.isAuthenticated) {
    clearStoredActiveOrder();
    deps.openAuthModal("login", {
      resumeCheckout: true,
      reasonMessage:
        "Vui lòng đăng nhập tài khoản khách hàng để tiến hành đặt hàng. Giỏ hàng của bạn được giữ nguyên.",
    });
    return false;
  }

  deps.setVoucherNoticeVisible(false);
  deps.setOrderCallOutcome(null);
  deps.setCheckoutStep("review");
  return true;
}


export interface ExecuteZeroAmountCompletionDeps {
  order: CreateOrderResponseDto;
  accessToken: string | null;
  idempotencyKey?: string;
  submittingRef: { current: boolean };
  setIsSubmitting?: (submitting: boolean) => void;
  clearCart?: () => void;
  setActiveOrder?: (order: CreateOrderResponseDto | null) => void;
  setZeroAmountPaidResult?: (res: ZeroAmountPaymentResponseDto | null) => void;
  setZeroAmountError?: (msg: string | null) => void;
  onNavigateSuccess?: (url: string) => void;
  submitZeroAmountFn?: typeof submitZeroAmountPaymentApi;
}

/**
 * Điều phối quyết toán đơn hàng `totalVnd === 0` qua `POST /payments/zero-amount` (P2-10 & P2-22):
 * - TUYỆT ĐỐI KHÔNG redirect VNPay.
 * - TUYỆT ĐỐI KHÔNG gọi Mock Payment (`POST /payments`).
 * - Chỉ hiển thị success và xóa Cart khi backend xác nhận `paymentStatus === "SUCCESS"` và `orderStatus === "PAID"`.
 * - Không tự giả lập success trên frontend.
 */
export async function executeZeroAmountOrderCompletion(
  deps: ExecuteZeroAmountCompletionDeps
): Promise<{
  skipped: boolean;
  success: boolean;
  response: ZeroAmountPaymentResponseDto | null;
  errorMessage: string | null;
}> {
  if (deps.submittingRef.current) {
    return {
      skipped: true,
      success: false,
      response: null,
      errorMessage: null,
    };
  }

  if (!deps.order || deps.order.totalVnd !== 0) {
    const msg = "Chỉ áp dụng luồng ZERO_AMOUNT cho đơn hàng có tổng thanh toán 0đ.";
    deps.setZeroAmountError?.(msg);
    return {
      skipped: false,
      success: false,
      response: null,
      errorMessage: msg,
    };
  }

  deps.submittingRef.current = true;
  deps.setIsSubmitting?.(true);
  deps.setZeroAmountError?.(null);

  const keyToUse = deps.idempotencyKey || generateIdempotencyKey("zero");
  const callZeroApi = deps.submitZeroAmountFn || submitZeroAmountPaymentApi;

  try {
    const result = await callZeroApi(
      { orderId: deps.order.id },
      keyToUse,
      { accessToken: deps.accessToken }
    );
    const verifiedZero = validateZeroAmountPaymentResponse(
      result?.response,
      deps.order.id,
      keyToUse
    );

    if (
      verifiedZero.paymentStatus === "SUCCESS" &&
      verifiedZero.orderStatus === "PAID" &&
      verifiedZero.provider === "ZERO_AMOUNT" &&
      verifiedZero.amountVnd === 0
    ) {
      deps.setZeroAmountPaidResult?.(verifiedZero);
      deps.clearCart?.();
      clearStoredActiveOrder();
      deps.setActiveOrder?.(null);
      const confirmUrl = `/order-confirmation?orderId=${encodeURIComponent(
        deps.order.id
      )}&view=zero`;
      deps.onNavigateSuccess?.(confirmUrl);
      return {
        skipped: false,
        success: true,
        response: verifiedZero,
        errorMessage: null,
      };
    }

    throw new Error(
      "Máy chủ chưa xác nhận trạng thái Payment SUCCESS / Order PAID cho đơn hàng 0đ."
    );
  } catch (err: unknown) {
    const msg =
      err instanceof Error && err.message
        ? err.message
        : "Không thể hoàn tất xác nhận đơn hàng 0đ từ máy chủ. Giỏ hàng được giữ nguyên.";
    deps.setZeroAmountError?.(msg);
    return {
      skipped: false,
      success: false,
      response: null,
      errorMessage: msg,
    };
  } finally {
    deps.submittingRef.current = false;
    deps.setIsSubmitting?.(false);
  }
}

export interface ExecuteCheckoutSubmissionDeps {
  items: CartItem[];
  accessToken: string | null;
  userId?: string | null;
  submittingRef: { current: boolean };
  isSubmittingOrder: boolean;
  setIsSubmittingOrder: (submitting: boolean) => void;
  setCheckoutStep: (step: CheckoutDrawerStep) => void;
  setOrderCallOutcome: (outcome: OrderCallOutcome | null) => void;
  setActiveOrder?: (
    order: CreateOrderResponseDto | null,
    ownerUserIdOverride?: string | null
  ) => void;
  setOrderError?: (error: OrderSubmissionErrorState | null) => void;
  onCouponRejected?: (rejected: {
    status: CouponValidationStatus;
    message: string;
    code: string;
  }) => void;
  verifySession: () => boolean;
  handleUnauthorizedCheckout: (reasonMessage?: string) => void;
  mapToCreateOrderPayload: () => CreateOrderRequestDto;
  clearCart?: () => void;
  createOrderFn?: (
    payload: CreateOrderRequestDto,
    tokenOverride?: string | null
  ) => Promise<CreateOrderResponseDto>;
}

/**
 * Điều phối gọi API `POST /orders` tại Bước 2 (Checkout) (SCRUM-43, SCRUM-44 & P2-22):
 * - Chặn double-click / double-submit đồng thời bằng cả `submittingRef` và `isSubmittingOrder`.
 * - Bật trạng thái loading (`setIsSubmittingOrder(true)`) ngay khi bắt đầu gửi request và tắt trong `finally`.
 * - Xử lý 401 UNAUTHORIZED: xóa snapshot đơn hàng PENDING (`clearStoredActiveOrder`), quay về bước `"cart"`, xóa phiên hết hạn, giữ nguyên giỏ hàng và mở Login Modal.
 * - Xử lý 201 Created (`status: "PENDING"`): lưu `orderCallOutcome = { type: "success", order }`, đồng bộ `activeOrder` gắn với `ownerUserId` vào `CartContext`/`sessionStorage` và giữ nguyên giỏ hàng.
 * - Xử lý lỗi mạng / lỗi đọc response (`isOutcomeUncertain = true`) và lỗi 400/409 (`isOutcomeUncertain = false` kèm `detailLines`).
 * - Nếu coupon hết hiệu lực trước Create Order và backend từ chối (`400 INVALID_COUPON` hoặc `409 COUPON_UNAVAILABLE`), xóa discount cũ và yêu cầu user apply lại hoặc bỏ coupon.
 */
export async function executeCheckoutOrderSubmission(
  deps: ExecuteCheckoutSubmissionDeps
): Promise<{ skipped: boolean; outcome: OrderCallOutcome | null }> {
  if (deps.submittingRef.current || deps.isSubmittingOrder) {
    return { skipped: true, outcome: null };
  }

  if (deps.items.length === 0) {
    deps.setCheckoutStep("cart");
    return { skipped: true, outcome: null };
  }

  const sessionOk = deps.verifySession();
  if (!sessionOk || !deps.accessToken) {
    clearStoredActiveOrder();
    deps.setActiveOrder?.(null);
    deps.setOrderError?.(null);
    deps.setOrderCallOutcome(null);
    deps.setCheckoutStep("cart");
    deps.handleUnauthorizedCheckout(
      "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục đặt hàng (giỏ hàng của bạn vẫn được giữ nguyên)."
    );
    return { skipped: true, outcome: null };
  }

  let payload: CreateOrderRequestDto;
  try {
    payload = deps.mapToCreateOrderPayload();
  } catch (err: unknown) {
    const preSendState = toOrderSubmissionErrorState({
      statusCode: 400,
      code: "INVALID_CART",
      message:
        err instanceof Error && err.message
          ? err.message
          : "Dữ liệu giỏ hàng không hợp lệ.",
      isOutcomeUncertain: false,
    });
    const preSendOutcome: OrderCallOutcome = {
      type: "error",
      statusCode: preSendState.statusCode,
      code: preSendState.code,
      message: preSendState.message,
      isOutcomeUncertain: preSendState.isOutcomeUncertain,
      detailLines: preSendState.detailLines,
    };
    deps.setOrderError?.(preSendState);
    deps.setOrderCallOutcome(preSendOutcome);
    return { skipped: false, outcome: preSendOutcome };
  }

  const productNamesById: Record<string, string> = {};
  for (const item of deps.items) {
    if (item.productId && item.productName) {
      productNamesById[item.productId.trim()] = item.productName.trim();
      productNamesById[item.productId.trim().toLowerCase()] =
        item.productName.trim();
    }
  }

  const callCreateOrder = deps.createOrderFn || createOrderApi;

  deps.submittingRef.current = true;
  deps.setIsSubmittingOrder(true);
  deps.setOrderError?.(null);
  deps.setOrderCallOutcome(null);

  try {
    const createdOrder = await callCreateOrder(payload, deps.accessToken);
    // TUYỆT ĐỐI KHÔNG xóa giỏ hàng khi đơn ở trạng thái PENDING (AC-US-CART-04-02, BR-07, API Contract v3.0)
    const ownerUserId = (
      deps.userId ||
      resolveStoredAuthenticatedUserId(deps.accessToken) ||
      ""
    )
      .trim()
      .toLowerCase();
    if (ownerUserId) {
      persistActiveOrderForUser(createdOrder, ownerUserId);
    }
    deps.setActiveOrder?.(createdOrder, ownerUserId || null);
    const successOutcome: OrderCallOutcome = {
      type: "success",
      order: createdOrder,
    };
    deps.setOrderCallOutcome(successOutcome);
    return { skipped: false, outcome: successOutcome };
  } catch (err: unknown) {
    const orderErr = err as Partial<OrderServiceError>;
    if (orderErr?.statusCode === 401 || orderErr?.code === "UNAUTHORIZED") {
      // 401 UNAUTHORIZED: Xóa phiên hết hạn & xóa snapshot đơn hàng PENDING, giữ nguyên giỏ hàng và mở Login modal
      clearStoredActiveOrder();
      deps.setActiveOrder?.(null);
      deps.setOrderError?.(null);
      deps.setOrderCallOutcome(null);
      deps.setCheckoutStep("cart");
      deps.handleUnauthorizedCheckout(
        "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại để tiếp tục đặt hàng (giỏ hàng của bạn được giữ nguyên)."
      );
      return { skipped: false, outcome: null };
    }

    const normalizedErr = toOrderSubmissionErrorState(err, productNamesById);
    if (
      normalizedErr.code === "INVALID_COUPON" ||
      normalizedErr.code === "COUPON_UNAVAILABLE"
    ) {
      const classified = classifyCouponPreviewError(err);
      deps.onCouponRejected?.({
        status: classified.status,
        message: `${classified.message} Vui lòng áp dụng lại hoặc bỏ mã ưu đãi trước khi tạo đơn hàng.`,
        code: classified.code,
      });
    }

    const errorOutcome: OrderCallOutcome = {
      type: "error",
      statusCode: normalizedErr.statusCode,
      code: normalizedErr.code,
      message: normalizedErr.message,
      isOutcomeUncertain: normalizedErr.isOutcomeUncertain,
      detailLines: normalizedErr.detailLines,
    };

    deps.setOrderError?.(normalizedErr);
    deps.setOrderCallOutcome(errorOutcome);
    return { skipped: false, outcome: errorOutcome };
  } finally {
    deps.submittingRef.current = false;
    deps.setIsSubmittingOrder(false);
  }
}

export interface CartDrawerProps {
  initialCheckoutStep?: CheckoutDrawerStep;
  initialIsSubmittingOrder?: boolean;
  initialOrderOutcome?: OrderCallOutcome | null;
  previewCouponFn?: typeof previewCouponApi;
  submitZeroAmountFn?: typeof submitZeroAmountPaymentApi;
  onNavigateSuccess?: (url: string) => void;
}

export default function CartDrawer({
  initialCheckoutStep = "cart",
  initialIsSubmittingOrder = false,
  initialOrderOutcome = null,
  previewCouponFn,
  submitZeroAmountFn,
  onNavigateSuccess,
}: CartDrawerProps) {
  const {
    items,
    totalQuantity,
    subtotalVnd,
    formattedSubtotal,
    isCartOpen,
    couponCode,
    setCouponCode,
    appliedCoupon,
    couponStatus,
    couponErrorMessage,
    applyCoupon,
    removeCoupon,
    setCouponApplicationState,
    openCart,
    closeCart,
    clearCart,
    incrementQuantity,
    decrementQuantity,
    removeFromCart,
    feedbackMessage,
    feedbackType,
    dismissFeedback,

    activeOrder: contextActiveOrder,
    isSubmittingOrder: contextIsSubmittingOrder,
    setActiveOrder: setContextActiveOrder,
    setIsSubmittingOrder: setContextIsSubmittingOrder,
    setOrderError: setContextOrderError,
  } = useCart();

  const {
    user,
    accessToken,
    isAuthenticated,
    pendingCheckout,
    setPendingCheckout,
    openAuthModal,
    verifySession,
    handleUnauthorizedCheckout,
  } = useAuth();

  const currentAuthUserId: string | null =
    isAuthenticated && user?.id ? user.id.trim().toLowerCase() : null;

  const [checkoutStep, setCheckoutStep] =
    useState<CheckoutDrawerStep>(initialCheckoutStep);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [localIsSubmittingOrder, setLocalIsSubmittingOrder] = useState(
    initialIsSubmittingOrder
  );
  const [outcomeRecord, setOutcomeRecord] = useState<{
    ownerUserId: string | null;
    outcome: OrderCallOutcome;
  } | null>(
    initialOrderOutcome
      ? { ownerUserId: currentAuthUserId, outcome: initialOrderOutcome }
      : null
  );
  const [voucherNoticeVisible, setVoucherNoticeVisible] = useState(false);
  const submittingRef = useRef(initialIsSubmittingOrder);
  const zeroAmountSubmittingRef = useRef(false);

  const [isCompletingZeroAmount, setIsCompletingZeroAmount] = useState(false);
  const [zeroAmountPaidResult, setZeroAmountPaidResult] =
    useState<ZeroAmountPaymentResponseDto | null>(null);
  const [zeroAmountError, setZeroAmountError] = useState<string | null>(null);

  const setOrderCallOutcome = React.useCallback(
    (outcome: OrderCallOutcome | null) => {
      if (!outcome) {
        setOutcomeRecord(null);
        return;
      }
      setOutcomeRecord({ ownerUserId: currentAuthUserId, outcome });
    },
    [currentAuthUserId]
  );

  // Chỉ hiển thị modal kết quả nếu vẫn cùng phiên tài khoản đã tạo kết quả đó
  const orderCallOutcome: OrderCallOutcome | null =
    outcomeRecord && outcomeRecord.ownerUserId === currentAuthUserId
      ? outcomeRecord.outcome
      : null;

  const isSubmittingOrder =
    localIsSubmittingOrder || Boolean(contextIsSubmittingOrder);

  const setSyncedIsSubmittingOrder = (submitting: boolean) => {
    setLocalIsSubmittingOrder(submitting);
    setContextIsSubmittingOrder?.(submitting);
  };

  // Đơn hàng PENDING đang hoạt động: chỉ hiển thị khi đã đăng nhập VÀ thuộc đúng tài khoản hiện tại
  const displayedActiveOrder = useMemo<CreateOrderResponseDto | null>(() => {
    if (!currentAuthUserId) {
      return null;
    }

    if (orderCallOutcome?.type === "success") {
      return orderCallOutcome.order;
    }

    // Kiểm tra chéo với sessionStorage nếu có bản ghi lưu trữ để đảm bảo đúng ownerUserId
    try {
      if (
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem(ACTIVE_ORDER_STORAGE_KEY) !== null
      ) {
        return restoreActiveOrderForUser(currentAuthUserId);
      }
    } catch {
      return null;
    }

    return contextActiveOrder ?? null;
  }, [contextActiveOrder, currentAuthUserId, orderCallOutcome]);

  // Tính toán bước hiển thị thực tế mà không cần gọi setState đồng bộ trong useEffect
  const activeStep: CheckoutDrawerStep = useMemo(
    () =>
      checkoutStep === "review" && (items.length === 0 || !isAuthenticated)
        ? "cart"
        : checkoutStep,
    [checkoutStep, items.length, isAuthenticated]
  );

  const handleCloseDrawer = () => {
    if (submittingRef.current || isSubmittingOrder) return;
    setConfirmClearOpen(false);
    setOrderCallOutcome(null);
    setVoucherNoticeVisible(false);
    closeCart();
  };

  // Khóa cuộn trang nền khi Cart Drawer đang mở
  useEffect(() => {
    if (isCartOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isCartOpen]);

  // Xử lý phím Escape để đóng drawer (chặn đóng khi đang gửi POST /orders)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        isCartOpen &&
        !submittingRef.current &&
        !isSubmittingOrder
      ) {
        setConfirmClearOpen(false);
        setOrderCallOutcome(null);
        setVoucherNoticeVisible(false);
        closeCart();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCartOpen, isSubmittingOrder, closeCart, setOrderCallOutcome]);

  // Tự động tắt feedback sau 3s
  useEffect(() => {
    if (feedbackMessage) {
      const timer = setTimeout(() => {
        dismissFeedback();
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [feedbackMessage, dismissFeedback]);

  // Tự động ẩn thông báo Voucher sau 4s
  useEffect(() => {
    if (voucherNoticeVisible) {
      const timer = setTimeout(() => {
        setVoucherNoticeVisible(false);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [voucherNoticeVisible]);

  // Tự động chuyển sang bước Checkout ("review") ngay sau khi khách đăng nhập thành công từ luồng Checkout
  // Tuân thủ AC-US-CART-04-02 & UC-CART-001 AF-06: Giỏ hàng được bảo toàn nguyên vẹn qua bước Login
  useEffect(() => {
    if (isAuthenticated && pendingCheckout) {
      const timer = setTimeout(() => {
        setPendingCheckout(false);
        if (items.length > 0) {
          setVoucherNoticeVisible(false);
          setOrderCallOutcome(null);
          setCheckoutStep("review");
          openCart();
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [
    isAuthenticated,
    pendingCheckout,
    items.length,
    setPendingCheckout,
    setOrderCallOutcome,
    openCart,
  ]);

  // Sau khi Create Order (POST /orders) thành công, UI bắt buộc dùng snapshot từ backend trả về làm source of truth
  const authoritativeOrderSnapshot: CreateOrderResponseDto | null =
    orderCallOutcome?.type === "success"
      ? orderCallOutcome.order
      : displayedActiveOrder;

  const displaySubtotalVnd: number = authoritativeOrderSnapshot
    ? authoritativeOrderSnapshot.subtotalVnd
    : couponStatus === "applied" && appliedCoupon
    ? appliedCoupon.subtotalVnd
    : subtotalVnd;

  const displayDiscountVnd: number = authoritativeOrderSnapshot
    ? authoritativeOrderSnapshot.discountVnd
    : couponStatus === "applied" && appliedCoupon
    ? appliedCoupon.discountVnd
    : 0;

  const displayTotalVnd: number = authoritativeOrderSnapshot
    ? authoritativeOrderSnapshot.totalVnd
    : couponStatus === "applied" && appliedCoupon
    ? appliedCoupon.totalVnd
    : subtotalVnd;

  const displayCouponCode: string | null = authoritativeOrderSnapshot
    ? authoritativeOrderSnapshot.couponCode
    : couponStatus === "applied" && appliedCoupon
    ? appliedCoupon.couponCode
    : null;

  const handleCouponCodeChange = (nextRawCode: string) => {
    if (isSubmittingOrder) return;
    setVoucherNoticeVisible(false);
    setCouponCode(nextRawCode);
  };

  const handleRemoveCoupon = () => {
    if (isSubmittingOrder) return;
    setVoucherNoticeVisible(false);
    removeCoupon();
  };

  const handleApplyCoupon = async () => {
    if (isSubmittingOrder) return;
    setVoucherNoticeVisible(false);
    await applyCoupon({
      couponCodeOverride: couponCode.trim(),
      accessToken,
      previewCouponFn,
    });
  };

  /**
   * Bước 1 -> Bước 2: Khách nhấn "Tiến hành đặt hàng" từ Giỏ hàng
   * Kiểm tra giỏ hàng -> Kiểm tra trạng thái đăng nhập (JWT)
   */
  const handleProceedToCheckout = () => {
    proceedToCheckoutStep({
      itemsCount: items.length,
      isSubmittingOrder,
      isAuthenticated,
      verifySession,
      openAuthModal,
      setVoucherNoticeVisible,
      setOrderCallOutcome,
      setCheckoutStep,
    });
  };

  /**
   * Bước 2 (Checkout) -> Gọi Create Order API (POST /orders) (SCRUM-43, SCRUM-44 & P2-22)
   * Quản lý đầy đủ trạng thái Loading / Success (201 Created) / Error.
   * Chỉ gửi couponCode khi đã được apply hợp lệ (không gửi discountVnd).
   */
  const handleConfirmCreateOrder = async () => {
    setZeroAmountPaidResult(null);
    setZeroAmountError(null);
    await executeCheckoutOrderSubmission({
      items,
      accessToken,
      userId: currentAuthUserId,
      submittingRef,
      isSubmittingOrder,
      setIsSubmittingOrder: setSyncedIsSubmittingOrder,
      setCheckoutStep,
      setOrderCallOutcome,
      setActiveOrder: setContextActiveOrder,
      setOrderError: setContextOrderError,
      onCouponRejected: (rejected) => {
        setCouponApplicationState?.({
          appliedCoupon: null,
          status: rejected.status,
          errorMessage: rejected.message,
          errorCode: rejected.code,
        });
      },
      verifySession,
      handleUnauthorizedCheckout,
      mapToCreateOrderPayload: () => {
        const couponToSend =
          couponStatus === "applied" && appliedCoupon
            ? appliedCoupon.couponCode
            : undefined;
        return buildCreateOrderPayloadFromCart(items, couponToSend);
      },
      clearCart,
    });
  };

  /**
   * Quyết toán đơn hàng 0đ (ZERO_AMOUNT) qua POST /payments/zero-amount (P2-10 & P2-22)
   */
  const handleZeroAmountComplete = async (order: CreateOrderResponseDto) => {
    await executeZeroAmountOrderCompletion({
      order,
      accessToken,
      submittingRef: zeroAmountSubmittingRef,
      setIsSubmitting: setIsCompletingZeroAmount,
      clearCart: () => {
        clearCart();
        removeCoupon();
      },
      setActiveOrder: setContextActiveOrder,
      setZeroAmountPaidResult,
      setZeroAmountError,
      onNavigateSuccess,
      submitZeroAmountFn,
    });
  };

  const getCouponStatusTitle = (status: CouponValidationStatus): string => {
    switch (status) {
      case "validating":
        return "Đang kiểm tra mã ưu đãi...";
      case "applied":
        return "Đã áp dụng mã ưu đãi";
      case "invalid":
        return "Mã ưu đãi không hợp lệ";
      case "expired":
        return "Mã ưu đãi đã hết hạn";
      case "not_eligible":
        return "Chưa đủ điều kiện áp dụng";
      case "usage_limit_exceeded":
        return "Đã hết lượt sử dụng";
      case "error":
        return "Không thể kiểm tra mã ưu đãi";
      default:
        return "";
    }
  };

  const renderCouponInputSection = (options: {
    inputId: string;
    applyButtonId: string;
    removeButtonId: string;
    statusBannerId: string;
    showTitleLabel?: boolean;
  }) => {
    const isValidating = couponStatus === "validating";
    const isApplied = couponStatus === "applied" && Boolean(appliedCoupon);
    const isErrorState =
      couponStatus === "invalid" ||
      couponStatus === "expired" ||
      couponStatus === "not_eligible" ||
      couponStatus === "usage_limit_exceeded" ||
      couponStatus === "error";

    return (
      <div className="space-y-2" data-coupon-status={couponStatus}>
        {options.showTitleLabel && (
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={options.inputId}
              className="block font-label-md text-[12px] text-on-surface font-semibold"
            >
              Mã ưu đãi / Voucher
            </label>
            {isApplied && appliedCoupon && (
              <span
                id="appliedCouponCodeBadge"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-mono text-[11px] font-bold"
              >
                Voucher {appliedCoupon.couponCode}
              </span>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="material-symbols-outlined text-[18px] text-outline absolute left-3 top-1/2 -translate-y-1/2">
              confirmation_number
            </span>
            <input
              id={options.inputId}
              type="text"
              maxLength={30}
              disabled={isSubmittingOrder}
              value={couponCode}
              onChange={(e) => handleCouponCodeChange(e.target.value)}
              onInput={(e) =>
                handleCouponCodeChange(
                  (e.currentTarget as HTMLInputElement).value
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleApplyCoupon();
                }
              }}
              placeholder="Nhập mã ưu đãi (VD: WELCOME20)"
              className="w-full pl-9 pr-3 py-2 bg-surface-container-low border border-outline-variant/40 rounded-lg font-mono text-[13px] text-on-surface placeholder:font-sans placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 disabled:cursor-not-allowed transition-all uppercase"
            />
          </div>

          <button
            id={options.applyButtonId}
            type="button"
            disabled={isSubmittingOrder || isValidating}
            aria-busy={isValidating}
            onClick={() => void handleApplyCoupon()}
            className="px-3.5 py-2 bg-primary hover:bg-primary-container text-on-primary font-label-md text-[12px] font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isValidating ? (
              <>
                <span className="material-symbols-outlined text-[15px] animate-spin">
                  progress_activity
                </span>
                <span>Đang kiểm tra...</span>
              </>
            ) : (
              <span>Áp dụng</span>
            )}
          </button>

          {(isApplied ||
            isErrorState ||
            couponCode.trim().length > 0) && (
            <button
              id={options.removeButtonId}
              type="button"
              disabled={isSubmittingOrder}
              onClick={handleRemoveCoupon}
              className="px-2.5 py-2 border border-outline-variant hover:bg-surface-container text-on-surface-variant font-label-md text-[12px] font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="Bỏ mã ưu đãi"
            >
              Bỏ mã
            </button>
          )}
        </div>

        {/* Trạng thái kiểm tra / áp dụng Coupon (idle | validating | applied | invalid | expired | not_eligible | usage_limit_exceeded | error) */}
        {couponStatus === "idle" && (
          <div
            id={options.statusBannerId}
            data-coupon-status="idle"
            className="text-[11px] text-outline flex items-center gap-1"
          >
            <span>Nhập mã ưu đãi và bấm Áp dụng để tính giảm giá trực tiếp từ máy chủ.</span>
          </div>
        )}

        {isValidating && (
          <div
            id={options.statusBannerId}
            data-coupon-status="validating"
            role="status"
            aria-live="polite"
            className="p-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-[11px] font-medium flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[15px] animate-spin flex-shrink-0">
              progress_activity
            </span>
            <span>Đang kiểm tra mã ưu đãi với máy chủ...</span>
          </div>
        )}

        {isApplied && appliedCoupon && (
          <div
            id={options.statusBannerId}
            data-coupon-status="applied"
            role="status"
            aria-live="polite"
            className="p-2.5 rounded-lg bg-secondary-container/60 border border-secondary/40 text-on-secondary-container text-[11px] flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="material-symbols-outlined text-[16px] text-primary flex-shrink-0">
                verified
              </span>
              <span className="truncate">
                Đã áp dụng{" "}
                <strong className="font-mono">
                  Voucher {appliedCoupon.couponCode}
                </strong>
                :{" "}
                <strong className="text-primary">
                  -{formatVnd(displayDiscountVnd)}
                </strong>
              </span>
            </div>
            <button
              type="button"
              disabled={isSubmittingOrder}
              onClick={handleRemoveCoupon}
              className="text-[11px] font-bold text-error hover:underline whitespace-nowrap cursor-pointer"
            >
              Bỏ coupon
            </button>
          </div>
        )}

        {isErrorState && (
          <div
            id={options.statusBannerId}
            data-coupon-status={couponStatus}
            role="alert"
            aria-live="assertive"
            className="p-2.5 rounded-lg bg-error/10 border border-error/30 text-error text-[11px] space-y-0.5"
          >
            <div className="font-bold flex items-center justify-between gap-2">
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-[15px]">
                  error
                </span>
                <span>{getCouponStatusTitle(couponStatus)}</span>
              </span>
              <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-error/15">
                {couponStatus}
              </span>
            </div>
            {couponErrorMessage && (
              <div className="text-on-surface leading-relaxed">
                {couponErrorMessage}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 1. LỚP PHỦ MỜ (SCRIM / BACKDROP) */}
      <div
        id="cartDrawerScrim"
        aria-hidden="true"
        onClick={handleCloseDrawer}
        className={`fixed inset-0 bg-inverse-surface/30 backdrop-blur-sm transition-opacity duration-300 z-40 ${
          isCartOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      />

      {/* 2. KHUNG NỘI DUNG GIỎ HÀNG & CHECKOUT TRƯỢT TỪ BÊN PHẢI */}
      <aside
        id="cartDrawerPanel"
        role="dialog"
        aria-modal="true"
        aria-busy={isSubmittingOrder}
        aria-label="Giỏ hàng và Đặt hàng"
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[460px] max-w-full bg-surface-container-lowest shadow-[-12px_0_40px_rgba(30,21,16,0.18)] flex flex-col justify-between overflow-hidden transition-transform duration-300 ease-out transform ${
          isCartOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* ================================================================== */}
        {/* HEADER GIỎ HÀNG / CHECKOUT */}
        {/* ================================================================== */}
        <div className="p-space-lg bg-surface-container-lowest flex-shrink-0 shadow-[0_1px_4px_rgba(0,0,0,0.03)] z-10">
          <div className="flex items-center justify-between pb-3 mb-2.5 border-b border-surface-container-high gap-2">
            {activeStep === "review" ? (
              <button
                id="btnBackToCartStep"
                type="button"
                disabled={isSubmittingOrder}
                onClick={() => {
                  if (isSubmittingOrder) return;
                  setVoucherNoticeVisible(false);
                  setOrderCallOutcome(null);
                  setCheckoutStep("cart");
                }}
                className="flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors font-label-md text-label-md cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[18px]">
                  arrow_back
                </span>
                <span>Quay lại Giỏ hàng</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={isSubmittingOrder}
                onClick={handleCloseDrawer}
                className="flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors font-label-md text-label-md cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[18px]">
                  arrow_back
                </span>
                <span>Quay lại Thực đơn</span>
              </button>
            )}

            <div className="flex items-center gap-2 flex-shrink-0">
              {activeStep === "cart" && items.length > 0 && (
                <button
                  type="button"
                  disabled={isSubmittingOrder}
                  onClick={() => setConfirmClearOpen(true)}
                  className="text-outline hover:text-error transition-colors font-label-md text-label-md px-2 py-1 rounded hover:bg-surface-container-high cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Xóa toàn bộ giỏ hàng"
                >
                  Xóa tất cả
                </button>
              )}
              <button
                id="btnCloseCartDrawer"
                type="button"
                disabled={isSubmittingOrder}
                onClick={handleCloseDrawer}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-high hover:bg-surface-container text-on-surface transition-colors cursor-pointer flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Đóng giỏ hàng"
              >
                <span className="material-symbols-outlined text-[18px]">
                  close
                </span>
              </button>
            </div>
          </div>

          {/* Tiêu đề theo từng bước của Checkout Flow (SCRUM-43 & SCRUM-44) — không bị xuống dòng */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="material-symbols-outlined text-primary text-[22px] flex-shrink-0">
                {activeStep === "review" ? "fact_check" : "shopping_cart"}
              </span>
              <h2 className="font-title-md text-title-md text-on-surface font-bold tracking-tight whitespace-nowrap">
                {activeStep === "review"
                  ? "Xác nhận Đặt hàng"
                  : "Giỏ hàng của bạn"}
              </h2>
              <span
                id="cartCountBadge"
                className="px-2 py-0.5 rounded-full bg-surface-container text-primary font-label-md text-[12px] font-semibold whitespace-nowrap flex-shrink-0"
              >
                ({totalQuantity} món)
              </span>
            </div>

            {/* Step Indicator gọn gàng, không xuống dòng */}
            <div className="flex items-center gap-1 text-[11px] font-label-md text-on-surface-variant whitespace-nowrap flex-shrink-0">
              <span
                className={`px-2 py-0.5 rounded-full whitespace-nowrap ${
                  activeStep === "cart"
                    ? "bg-primary text-on-primary font-semibold"
                    : "bg-surface-container"
                }`}
              >
                1. Giỏ
              </span>
              <span>→</span>
              <span
                className={`px-2 py-0.5 rounded-full whitespace-nowrap ${
                  activeStep === "review"
                    ? "bg-primary text-on-primary font-semibold"
                    : "bg-surface-container"
                }`}
              >
                2. Đặt hàng
              </span>
            </div>
          </div>

          {/* Thông báo quy tắc máy chủ theo API Contract v2.1 & Stitch UI */}
          {activeStep === "cart" && (
            <div
              id="cartServerAlert"
              className="mt-3 p-2.5 rounded-lg bg-surface-container-high border border-outline-variant/40 text-[12px] text-on-surface-variant flex items-start gap-2"
            >
              <span className="material-symbols-outlined text-[18px] text-tertiary flex-shrink-0">
                info
              </span>
              <span id="cartServerAlertMsg" className="leading-tight">
                Giá sản phẩm và tình trạng tồn kho sẽ được kiểm tra và tính giá chính xác khi tiến hành đặt hàng.
              </span>
            </div>
          )}

          {/* Toast phản hồi nhanh trong drawer */}
          {feedbackMessage && (
            <div
              className={`mt-2 p-2 rounded-lg text-[12px] font-medium flex items-center justify-between transition-all ${
                feedbackType === "error"
                  ? "bg-error/10 text-error"
                  : feedbackType === "warning"
                  ? "bg-tertiary/10 text-tertiary font-semibold"
                  : "bg-secondary-container text-on-secondary-container"
              }`}
            >
              <span>{feedbackMessage}</span>
              <button
                type="button"
                onClick={dismissFeedback}
                className="text-current opacity-70 hover:opacity-100 p-0.5 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  close
                </span>
              </button>
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* BODY: RENDER THEO BƯỚC ("cart" | "review") */}
        {/* ================================================================== */}
        <div
          className="flex-1 overflow-y-auto px-space-lg py-space-sm space-y-3.5"
          id="cartContentContainer"
        >
          {/* Thẻ tóm tắt đơn hàng PENDING đã ghi nhận của đúng tài khoản hiện tại (SCRUM-44) */}
          {displayedActiveOrder && (
            <div
              id="activePendingOrderBanner"
              className="p-3 rounded-xl bg-secondary-container/40 border border-secondary/30 text-[12px] space-y-2 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-bold text-on-surface">
                  <span className="material-symbols-outlined text-[17px] text-primary">
                    receipt_long
                  </span>
                  <span>Đơn hàng đang chờ thanh toán</span>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-[11px] font-bold">
                  {displayedActiveOrder.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[11px] text-on-surface-variant">
                <div className="truncate">
                  Mã đơn:{" "}
                  <strong className="font-mono text-on-surface">
                    {displayedActiveOrder.id}
                  </strong>
                </div>
                <div className="text-right">
                  Tổng tiền:{" "}
                  <strong className="text-primary">
                    {formatVnd(displayedActiveOrder.totalVnd)}
                  </strong>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-outline-variant/30">
                <div className="flex items-center gap-3">
                  <button
                    id="btnViewActiveOrderModal"
                    type="button"
                    disabled={isSubmittingOrder}
                    onClick={() =>
                      setOrderCallOutcome({
                        type: "success",
                        order: displayedActiveOrder,
                      })
                    }
                    className="text-[11px] font-semibold text-primary hover:underline cursor-pointer disabled:opacity-50"
                  >
                    Xem chi tiết đơn hàng
                  </button>
                  <a
                    id="btnPayActiveOrder"
                    href={`/payment?orderId=${encodeURIComponent(
                      displayedActiveOrder.id
                    )}`}
                    className="text-[11px] font-bold text-on-primary bg-primary hover:bg-primary-container px-2.5 py-1 rounded-md transition-colors"
                  >
                    Thanh toán ngay →
                  </a>
                </div>
                {setContextActiveOrder && (
                  <button
                    id="btnDismissActiveOrderBanner"
                    type="button"
                    disabled={isSubmittingOrder}
                    onClick={() => setContextActiveOrder(null)}
                    className="text-[11px] text-outline hover:text-on-surface cursor-pointer disabled:opacity-50"
                  >
                    Ẩn tóm tắt
                  </button>
                )}
              </div>
            </div>
          )}

          {/* -------------------------------------------------------------- */}
          {/* BƯỚC 1: GIỎ HÀNG ("cart") */}
          {/* -------------------------------------------------------------- */}
          {activeStep === "cart" && (
            <>
              {items.length === 0 ? (
                /* TRẠNG THÁI GIỎ HÀNG TRỐNG (EMPTY STATE) */
                <div
                  id="mockEmptyState"
                  className="py-12 flex flex-col items-center justify-center text-center h-full"
                >
                  <div className="w-20 h-20 rounded-full bg-surface-container flex items-center justify-center mb-space-md text-outline">
                    <span className="material-symbols-outlined text-[40px]">
                      remove_shopping_cart
                    </span>
                  </div>
                  <h3 className="font-headline-md text-headline-md text-on-surface font-semibold mb-1">
                    Giỏ hàng của bạn đang trống
                  </h3>
                  <p className="font-body-md text-body-md text-on-surface-variant max-w-xs mb-space-lg">
                    Khám phá các dòng cà phê thủ công đặc sản và bánh tươi để
                    thêm vào giỏ hàng ngay hôm nay!
                  </p>
                  <button
                    type="button"
                    onClick={handleCloseDrawer}
                    className="px-6 py-2.5 bg-primary text-on-primary font-label-lg text-label-lg rounded-lg shadow-sm hover:bg-primary-container transition-all cursor-pointer"
                  >
                    Khám phá thực đơn
                  </button>
                </div>
              ) : (
                /* DANH SÁCH MÓN ĐÃ CHỌN */
                items.map((item) => {
                  const sizeLabel =
                    item.size === "ONE_SIZE"
                      ? "Tiêu chuẩn"
                      : `Size ${item.size}`;

                  return (
                    <div
                      key={item.id}
                      className="p-3.5 bg-surface rounded-xl shadow-[0_2px_12px_rgba(44,32,24,0.04)] hover:shadow-md transition-shadow relative"
                    >
                      <div className="flex items-start gap-3">
                        {/* Ảnh sản phẩm */}
                        <div className="w-16 h-16 rounded-lg bg-cover bg-center flex-shrink-0 shadow-sm border border-outline-variant/30 overflow-hidden bg-surface-container">
                          <img
                            src={item.imageUrl}
                            alt={item.productName}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              const target = e.currentTarget;
                              if (!target.src.endsWith(FALLBACK_DRINK_IMAGE)) {
                                target.src = FALLBACK_DRINK_IMAGE;
                              }
                            }}
                          />
                        </div>

                        {/* Thông tin món & tùy chọn */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-1">
                            <div>
                              <h4 className="font-title-sm text-title-sm text-on-surface font-semibold truncate leading-tight">
                                {item.productName}
                              </h4>
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="px-2 py-0.5 rounded bg-surface-container-high text-primary font-label-md text-[11px] font-medium">
                                  {sizeLabel}
                                </span>
                                <span className="text-[12px] text-on-surface-variant font-body-sm">
                                  {formatVnd(item.sizePriceVnd)}/ly gốc
                                </span>
                              </div>
                            </div>

                            {/* Nút xóa món (khóa khi đang gửi POST /orders) */}
                            <button
                              type="button"
                              disabled={isSubmittingOrder}
                              onClick={() => removeFromCart(item.id)}
                              className="text-outline hover:text-error transition-colors p-1 rounded hover:bg-surface-container-high cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Xóa món này"
                              aria-label={`Xóa ${item.productName}`}
                            >
                              <span className="material-symbols-outlined text-[18px]">
                                delete
                              </span>
                            </button>
                          </div>

                          {/* Danh sách Topping đi kèm */}
                          <div className="mt-2 flex flex-wrap gap-1">
                            {item.toppings && item.toppings.length > 0 ? (
                              item.toppings.map((top) => (
                                <span
                                  key={top.id}
                                  className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-container text-[11px] text-on-surface-variant font-medium"
                                >
                                  + {top.name} (+{formatVnd(top.priceVnd)})
                                </span>
                              ))
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-surface-container text-[11px] text-outline font-medium">
                                Không kèm topping phụ
                              </span>
                            )}
                          </div>

                          {/* Ghi chú pha chế đặc biệt */}
                          {item.note && (
                            <div className="mt-1.5">
                              <span className="inline-flex items-center px-2 py-0.5 rounded bg-surface-container text-[11px] text-tertiary font-medium">
                                Yêu cầu: {item.note}
                              </span>
                            </div>
                          )}

                          {/* Bộ điều khiển số lượng & Thành tiền */}
                          <div className="flex items-center justify-between mt-3 pt-2 border-t border-surface-container-high/60">
                            <div className="flex items-center bg-surface-container rounded-lg p-0.5 shadow-inner">
                              <button
                                type="button"
                                disabled={isSubmittingOrder}
                                onClick={() => decrementQuantity(item.id)}
                                className="w-7 h-7 flex items-center justify-center rounded bg-surface hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                aria-label="Giảm số lượng"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  {item.quantity === 1 ? "delete" : "remove"}
                                </span>
                              </button>
                              <span className="font-label-lg text-label-lg text-on-surface w-7 text-center font-bold select-none">
                                {item.quantity}
                              </span>
                              <button
                                type="button"
                                disabled={isSubmittingOrder}
                                onClick={() => incrementQuantity(item.id)}
                                className="w-7 h-7 flex items-center justify-center rounded bg-surface hover:bg-surface-container-high text-on-surface transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                aria-label="Tăng số lượng"
                              >
                                <span className="material-symbols-outlined text-[15px]">
                                  add
                                </span>
                              </button>
                            </div>

                            <div className="text-right flex-shrink-0 whitespace-nowrap pl-2">
                              <div className="font-price-lg text-price-lg text-primary font-bold whitespace-nowrap">
                                {formatVnd(item.lineTotalVnd)}
                              </div>
                              <div className="text-[11px] text-outline font-body-sm">
                                {formatVnd(item.unitPriceVnd)} × {item.quantity}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* -------------------------------------------------------------- */}
          {/* BƯỚC 2: XÁC NHẬN ĐẶT HÀNG / CHECKOUT ("review") */}
          {/* -------------------------------------------------------------- */}
          {activeStep === "review" && (
            <div id="checkoutReviewSection" className="space-y-4 py-1">
              {/* Banner hiển thị trạng thái Loading khi đang gửi POST /orders */}
              {isSubmittingOrder && (
                <div
                  id="checkoutSubmittingBanner"
                  role="status"
                  aria-live="polite"
                  className="p-3.5 rounded-xl bg-primary/10 border border-primary/30 text-primary flex items-center gap-3 shadow-sm"
                >
                  <span className="material-symbols-outlined text-[22px] animate-spin flex-shrink-0">
                    progress_activity
                  </span>
                  <div className="text-[12px] leading-relaxed">
                    <div className="font-bold">
                      Đang gửi yêu cầu tạo đơn hàng tới máy chủ...
                    </div>
                    <div className="text-on-surface-variant text-[11px]">
                      Hệ thống đang kiểm tra tồn kho và khởi tạo đơn hàng{" "}
                      <code className="font-mono">PENDING</code>. Vui lòng chờ
                      trong giây lát.
                    </div>
                  </div>
                </div>
              )}

              {/* Thông tin khách hàng đã xác thực */}
              <div
                id="checkoutCustomerCard"
                className="p-3.5 rounded-xl bg-surface border border-outline-variant/40 shadow-sm space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-label-md uppercase tracking-wider text-outline font-semibold whitespace-nowrap">
                    Tài khoản đặt hàng
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container text-[11px] font-medium whitespace-nowrap">
                    <span className="material-symbols-outlined text-[13px]">
                      verified_user
                    </span>
                    Đã xác thực
                  </span>
                </div>
                <div className="font-title-sm text-title-sm text-on-surface font-bold">
                  {getDisplayCustomerName(user)}
                </div>
                {user?.email && (
                  <div className="text-[12px] text-on-surface-variant">
                    {user.email}
                  </div>
                )}
              </div>

              {/* Tóm tắt danh sách món sẽ gửi lên POST /orders */}
              <div
                id="checkoutItemsSummary"
                className="p-3.5 rounded-xl bg-surface border border-outline-variant/40 shadow-sm space-y-3"
              >
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-surface-container-high">
                  <span className="font-title-sm text-title-sm text-on-surface font-bold whitespace-nowrap">
                    Chi tiết món ({items.length} dòng • {totalQuantity} ly)
                  </span>
                  <button
                    id="btnEditCartInReview"
                    type="button"
                    disabled={isSubmittingOrder}
                    onClick={() => {
                      if (isSubmittingOrder) return;
                      setVoucherNoticeVisible(false);
                      setOrderCallOutcome(null);
                      setCheckoutStep("cart");
                    }}
                    className="text-[12px] font-label-md text-primary hover:underline cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Chỉnh sửa giỏ
                  </button>
                </div>

                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {items.map((item) => {
                    const sizeLabel =
                      item.size === "ONE_SIZE"
                        ? "Tiêu chuẩn"
                        : `Size ${item.size}`;
                    return (
                      <div
                        key={item.id}
                        className="flex items-start justify-between gap-2 text-[13px] pb-2 border-b border-surface-container last:border-b-0 last:pb-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-on-surface truncate">
                            {item.quantity}x {item.productName}
                          </div>
                          <div className="text-[11px] text-on-surface-variant mt-0.5">
                            {sizeLabel}
                            {item.toppings.length > 0
                              ? ` • +${item.toppings
                                  .map((t) => t.name)
                                  .join(", ")}`
                              : " • Không topping"}
                          </div>
                          {item.note && (
                            <div className="text-[11px] text-tertiary italic mt-0.5">
                              Ghi chú: {item.note}
                            </div>
                          )}
                        </div>
                        <div className="text-right whitespace-nowrap font-semibold text-primary">
                          {formatVnd(item.lineTotalVnd)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Ô Mã ưu đãi / Voucher ở bước Checkout (P2-22) */}
              <div className="p-3.5 rounded-xl bg-surface border border-outline-variant/40 shadow-sm space-y-2.5">
                {renderCouponInputSection({
                  inputId: "checkoutCouponInput",
                  applyButtonId: "btnApplyCheckoutCoupon",
                  removeButtonId: "btnRemoveCheckoutCoupon",
                  statusBannerId: "checkoutCouponStatusBanner",
                  showTitleLabel: true,
                })}
              </div>

              {/* Tóm tắt tính tiền tại bước Checkout (Tạm tính, Giảm giá Voucher, Tổng thanh toán) */}
              <div
                id="checkoutReviewPricingBox"
                className="p-3.5 rounded-xl bg-surface border border-outline-variant/40 shadow-sm space-y-1.5 text-[12px]"
              >
                <div className="flex items-center justify-between text-on-surface-variant">
                  <span>Tạm tính ({totalQuantity} ly):</span>
                  <span
                    id="reviewSubtotalAmount"
                    className="font-mono font-medium text-on-surface"
                  >
                    {formatVnd(displaySubtotalVnd)}
                  </span>
                </div>

                <div
                  id="reviewDiscountRow"
                  className="flex items-center justify-between text-tertiary font-medium"
                >
                  <span>
                    {displayCouponCode
                      ? `Voucher ${displayCouponCode}`
                      : "Giảm giá"}
                    {displayCouponCode && (
                      <span className="sr-only"> (Giảm giá)</span>
                    )}
                    :
                  </span>
                  <span id="reviewDiscountAmount" className="font-mono font-bold">
                    {displayDiscountVnd > 0 || displayCouponCode
                      ? `-${formatVnd(displayDiscountVnd)}`
                      : "0 ₫"}
                  </span>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-surface-container-high font-bold text-[14px] text-on-surface">
                  <span>Tổng thanh toán:</span>
                  <span
                    id="reviewTotalAmount"
                    className="font-mono text-primary text-[15px]"
                  >
                    {formatVnd(displayTotalVnd)}
                  </span>
                </div>
              </div>

              {/* Lưu ý quy tắc nghiệp vụ giữ chỗ tồn kho & bảo toàn giỏ hàng */}
              <div
                id="checkoutPricingSummary"
                className="p-3 rounded-xl bg-surface-container-high/70 border border-outline-variant/40 text-[12px] text-on-surface-variant space-y-1"
              >
                <div className="flex items-center gap-1.5 font-semibold text-on-surface">
                  <span className="material-symbols-outlined text-[16px] text-primary">
                    shield_lock
                  </span>
                  <span>Bảo toàn giỏ hàng &amp; thanh toán an toàn</span>
                </div>
                <p className="leading-relaxed text-[11px]">
                  Giỏ hàng của bạn được bảo toàn nguyên vẹn an toàn cho tới khi bạn hoàn tất thanh toán.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ================================================================== */}
        {/* FOOTER: RENDER THEO BƯỚC ("cart" | "review") */}
        {/* ================================================================== */}
        {activeStep === "cart" && items.length > 0 && (
          <div className="p-space-lg bg-surface-container-lowest flex-shrink-0 border-t border-surface-container-high shadow-[0_-4px_16px_rgba(44,32,24,0.04)] z-10 space-y-3">
            {/* Ô Mã ưu đãi / Voucher tại bước Giỏ hàng (P2-22) */}
            {renderCouponInputSection({
              inputId: "couponCodeInput",
              applyButtonId: "btnApplyVoucher",
              removeButtonId: "btnRemoveCoupon",
              statusBannerId: "cartCouponStatusBanner",
              showTitleLabel: false,
            })}

            {/* Trạng thái đăng nhập hiện tại (Auth Guard Indicator) */}
            <div
              id="cartAuthStatusBanner"
              className="px-3 py-2 rounded-lg bg-surface-container flex items-center justify-between gap-2 text-[12px]"
            >
              {isAuthenticated && user ? (
                <div className="flex items-center gap-1.5 text-on-surface truncate">
                  <span className="material-symbols-outlined text-[16px] text-primary flex-shrink-0">
                    account_circle
                  </span>
                  <span className="truncate">
                    Đặt hàng với tên:{" "}
                    <strong>{getDisplayCustomerName(user)}</strong>
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-on-surface-variant">
                    <span className="material-symbols-outlined text-[16px] text-tertiary flex-shrink-0">
                      lock
                    </span>
                    <span>Cần đăng nhập khi tiến hành đặt hàng</span>
                  </div>
                  <button
                    id="btnCartQuickLogin"
                    type="button"
                    disabled={isSubmittingOrder}
                    onClick={() =>
                      openAuthModal("login", {
                        resumeCheckout: false,
                        reasonMessage:
                          "Đăng nhập để lưu thông tin và sẵn sàng đặt hàng. Giỏ hàng của bạn được giữ nguyên.",
                      })
                    }
                    className="text-primary font-label-md font-bold hover:underline whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Đăng nhập
                  </button>
                </>
              )}
            </div>

            {/* Tổng tiền tạm tính / Giảm giá / Tổng thanh toán */}
            <div id="cartPricingBreakdown" className="pt-0.5 space-y-1 text-[12px]">
              <div className="flex justify-between items-center text-on-surface-variant">
                <span>Tạm tính ({totalQuantity} món):</span>
                <span id="cartSubtotalValue" className="font-mono font-medium text-on-surface">
                  {formatVnd(displaySubtotalVnd)}
                </span>
              </div>

              {(displayDiscountVnd > 0 || Boolean(displayCouponCode)) && (
                <div
                  id="cartDiscountRow"
                  className="flex justify-between items-center text-tertiary font-medium"
                >
                  <span>
                    Voucher {displayCouponCode}
                    <span className="sr-only"> (Giảm giá)</span>:
                  </span>
                  <span id="cartDiscountValue" className="font-mono font-bold">
                    -{formatVnd(displayDiscountVnd)}
                  </span>
                </div>
              )}

              <div className="flex justify-between items-baseline gap-3 pt-1 border-t border-surface-container-high">
                <div>
                  <span className="font-title-sm text-title-sm text-on-surface font-bold">
                    Tổng thanh toán:
                  </span>
                  <span className="block font-body-sm text-[11px] text-outline leading-tight">
                    Giá cuối cùng và khuyến mãi sẽ được máy chủ xác nhận khi đặt
                    hàng.
                  </span>
                </div>
                <div className="text-right flex-shrink-0 whitespace-nowrap pl-2">
                  <span
                    id="subtotalAmount"
                    className="font-headline-md text-headline-md text-primary font-bold whitespace-nowrap inline-block"
                  >
                    {formatVnd(displayTotalVnd)}
                  </span>
                </div>
              </div>
            </div>

            {/* Nút hành động Đặt hàng (Checkout CTA) */}
            <button
              id="btnCheckoutAction"
              type="button"
              disabled={isSubmittingOrder}
              onClick={handleProceedToCheckout}
              className="w-full py-3.5 px-space-md bg-primary hover:bg-primary-container text-on-primary rounded-xl font-title-sm text-title-sm font-semibold shadow-md hover:shadow-lg transition-all flex items-center justify-between group active:scale-[0.99] cursor-pointer whitespace-nowrap disabled:opacity-70 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="material-symbols-outlined text-[20px]">
                  shopping_bag_speed
                </span>
                <span>Tiến hành đặt hàng</span>
              </div>
              <div className="flex items-center gap-1 whitespace-nowrap">
                <span className="font-bold text-price-lg whitespace-nowrap">
                  {formatVnd(displayTotalVnd)}
                </span>
                <span className="material-symbols-outlined text-[20px] transition-transform group-hover:translate-x-1">
                  arrow_forward
                </span>
              </div>
            </button>
          </div>
        )}

        {/* FOOTER BƯỚC 2: XÁC NHẬN ĐẶT HÀNG ("review") */}
        {activeStep === "review" && items.length > 0 && (
          <div className="p-space-lg bg-surface-container-lowest flex-shrink-0 border-t border-surface-container-high shadow-[0_-4px_16px_rgba(44,32,24,0.04)] z-10 space-y-3">
            <div className="flex justify-between items-baseline gap-3">
              <span className="font-title-sm text-title-sm text-on-surface font-bold whitespace-nowrap">
                Tổng thanh toán ({totalQuantity} ly)
              </span>
              <span
                id="reviewFooterTotalAmount"
                className="font-headline-md text-headline-md text-primary font-bold whitespace-nowrap"
              >
                {formatVnd(displayTotalVnd)}
              </span>
            </div>

            <div className="flex gap-2.5">
              <button
                id="btnBackFromReviewFooter"
                type="button"
                disabled={isSubmittingOrder}
                onClick={() => {
                  if (isSubmittingOrder) return;
                  setVoucherNoticeVisible(false);
                  setOrderCallOutcome(null);
                  setCheckoutStep("cart");
                }}
                className="px-4 py-3 rounded-xl border border-outline-variant text-on-surface font-label-lg text-label-lg font-semibold hover:bg-surface-container transition-colors cursor-pointer whitespace-nowrap flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Quay lại
              </button>

              <button
                id="btnConfirmCreateOrder"
                type="button"
                disabled={isSubmittingOrder}
                aria-busy={isSubmittingOrder}
                onClick={handleConfirmCreateOrder}
                className="flex-1 py-3 px-4 bg-primary hover:bg-primary-container text-on-primary rounded-xl font-title-sm text-title-sm font-semibold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap disabled:opacity-75 disabled:cursor-wait"
              >
                {isSubmittingOrder ? (
                  <>
                    <span className="material-symbols-outlined text-[20px] animate-spin flex-shrink-0">
                      progress_activity
                    </span>
                    <span className="whitespace-nowrap">
                      Đang xử lý đặt hàng...
                    </span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[20px] flex-shrink-0">
                      check_circle
                    </span>
                    <span className="whitespace-nowrap">Xác nhận Đặt hàng</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Hộp thoại xác nhận Xóa tất cả */}
        {confirmClearOpen && (
          <div className="absolute inset-0 bg-on-surface/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="bg-surface rounded-xl p-5 shadow-2xl max-w-sm w-full text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-error/10 text-error flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-[24px]">
                  delete_forever
                </span>
              </div>
              <div>
                <h3 className="font-title-md text-title-md font-bold text-on-surface">
                  Xóa toàn bộ giỏ hàng?
                </h3>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                  Tất cả các món bạn đã chọn sẽ được xóa khỏi giỏ. Bạn có chắc
                  chắn muốn tiếp tục?
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmClearOpen(false)}
                  className="flex-1 py-2 px-3 rounded-lg border border-outline-variant text-on-surface font-label-md hover:bg-surface-container transition-colors cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearCart();
                    setConfirmClearOpen(false);
                  }}
                  className="flex-1 py-2 px-3 rounded-lg bg-error text-on-primary font-label-md hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Xác nhận xóa
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal hiển thị kết quả tạo đơn THÀNH CÔNG (HTTP 201 Created — SCRUM-44, chỉ hiển thị khi user đang đăng nhập) */}
        {orderCallOutcome?.type === "success" && Boolean(currentAuthUserId) && (
          <div
            id="orderSuccessNoticeModal"
            role="status"
            aria-live="polite"
            className="absolute inset-0 bg-on-surface/50 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          >
            <div className="bg-surface rounded-xl p-5 shadow-2xl max-w-sm w-full space-y-3.5 max-h-[90vh] overflow-y-auto">
              <div className="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-[26px]">
                  check_circle
                </span>
              </div>
              <div className="text-center space-y-1">
                <h3 className="font-title-md text-title-md font-bold text-on-surface">
                  Tạo đơn hàng thành công!
                </h3>
                <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                  Đơn hàng của bạn đã được khởi tạo và đang chờ thanh toán.
                  <span className="sr-only">PENDING {orderCallOutcome.order.status}</span>
                </p>
              </div>

              {/* Thông tin định danh & thời gian từ Order Response */}
              <div className="bg-surface-container-low p-3 rounded-lg text-[12px] space-y-1.5 border border-outline-variant/40">
                <div className="flex justify-between gap-2">
                  <span className="text-on-surface-variant whitespace-nowrap">
                    Mã đơn hàng:
                  </span>
                  <span
                    id="createdOrderIdText"
                    className="font-mono font-bold text-on-surface truncate"
                  >
                    {orderCallOutcome.order.id}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-on-surface-variant whitespace-nowrap">
                    Thời gian tạo:
                  </span>
                  <span
                    id="createdOrderCreatedAtText"
                    className="text-on-surface font-medium text-right"
                  >
                    {new Date(
                      orderCallOutcome.order.createdAt
                    ).toLocaleString("vi-VN")}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-on-surface-variant whitespace-nowrap">
                    Mã khuyến mãi:
                  </span>
                  <span
                    id="createdOrderCouponText"
                    className="font-mono text-on-surface font-medium text-right"
                  >
                    {orderCallOutcome.order.couponCode || "Không áp dụng"}
                  </span>
                </div>
              </div>

              {/* Danh sách món snapshot đầy đủ từ Server (OrderItemSnapshotDto) */}
              <div className="bg-surface-container-low p-3 rounded-lg text-[12px] space-y-2 border border-outline-variant/40">
                <div className="font-semibold text-on-surface border-b border-surface-container-high pb-1">
                  Chi tiết đơn hàng ({orderCallOutcome.order.items.length} món)
                </div>
                <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                  {orderCallOutcome.order.items.map((item) => (
                    <div
                      key={item.id}
                      className="flex justify-between items-start gap-2 text-[11px] pb-1.5 border-b border-surface-container last:border-b-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="font-semibold text-on-surface truncate">
                          {item.quantity}x {item.productName} (
                          {item.size === "ONE_SIZE"
                            ? "Tiêu chuẩn"
                            : `Size ${item.size}`}
                          )
                          <span className="sr-only"> • {item.sizeMultiplierPercent}%</span>
                        </div>
                        <div className="text-outline text-[10px]">
                          Đơn giá: {formatVnd(item.unitPriceVnd)} × {item.quantity}
                          <span className="sr-only">Giá gốc: {formatVnd(item.basePriceVnd)}</span>
                        </div>
                        {item.toppings.length > 0 && (
                          <div className="text-on-surface-variant truncate">
                            +
                            {item.toppings
                              .map(
                                (t) => `${t.name} (+${formatVnd(t.priceVnd)})`
                              )
                              .join(", ")}
                          </div>
                        )}
                      </div>
                      <span className="font-semibold text-primary whitespace-nowrap">
                        {formatVnd(item.lineTotalVnd)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="pt-2 border-t border-surface-container-high space-y-1">
                  <div className="flex justify-between text-[11px] text-on-surface-variant">
                    <span>Tạm tính:</span>
                    <span id="createdOrderSubtotalText">
                      {formatVnd(orderCallOutcome.order.subtotalVnd)}
                    </span>
                  </div>
                  <div className="flex justify-between text-[11px] text-tertiary font-medium">
                    <span>
                      {orderCallOutcome.order.couponCode
                        ? `Voucher ${orderCallOutcome.order.couponCode}`
                        : "Giảm giá"}
                      {orderCallOutcome.order.couponCode && (
                        <span className="sr-only">
                          {" "}
                          (Giảm giá {orderCallOutcome.order.couponCode})
                        </span>
                      )}
                      :
                    </span>
                    <span id="createdOrderDiscountText">
                      -{formatVnd(orderCallOutcome.order.discountVnd)}
                    </span>
                  </div>
                  <div className="flex justify-between text-[13px] font-bold text-primary pt-0.5">
                    <span>Tổng thanh toán:</span>
                    <span id="createdOrderTotalText">
                      {formatVnd(orderCallOutcome.order.totalVnd)}
                    </span>
                  </div>
                </div>

                {/* Thông báo đối soát nếu giá máy chủ khác tạm tính phía Client (API Contract v2.1 §8.3 & §9.1) */}
                {(orderCallOutcome.order.subtotalVnd !== subtotalVnd ||
                  orderCallOutcome.order.totalVnd !== subtotalVnd) && (
                  <div
                    id="serverPriceReconciliationNote"
                    className="mt-2 p-2 rounded bg-primary/10 text-[11px] text-on-surface leading-relaxed"
                  >
                    Tổng thanh toán chính thức là{" "}
                    <strong className="text-primary">
                      {formatVnd(orderCallOutcome.order.totalVnd)}
                    </strong>{" "}
                    (tạm tính trên giỏ hàng: {formattedSubtotal}).
                  </div>
                )}
              </div>

              {/* ZERO_AMOUNT Flow cho đơn hàng totalVnd === 0 (P2-10 & P2-22): Không redirect VNPay, không gọi Mock Payment */}
              {orderCallOutcome.order.totalVnd === 0 && (
                <div
                  id="zeroAmountOrderNotice"
                  className="p-3 rounded-xl bg-[#F0FDF4] border border-[#16A34A] text-[#166534] text-[11px] space-y-2"
                >
                  <div className="font-bold flex items-center gap-1.5 text-[#15803D]">
                    <span className="material-symbols-outlined text-[16px]">
                      verified
                    </span>
                    <span>Đơn hàng 0 ₫ (ZERO_AMOUNT) — Không qua cổng VNPay</span>
                  </div>
                  <p className="leading-relaxed">
                    Đơn hàng được miễn phí 100%. Bạn có thể xác nhận hoàn tất đơn hàng 0 ₫ trực tiếp bên dưới mà không cần chuyển hướng VNPay.
                  </p>

                  {zeroAmountPaidResult &&
                    zeroAmountPaidResult.paymentStatus === "SUCCESS" &&
                    zeroAmountPaidResult.orderStatus === "PAID" && (
                      <div
                        id="zeroAmountPaidSuccessBanner"
                        role="status"
                        className="p-2 rounded-lg bg-[#DCFCE7] border border-[#16A34A] text-[#14532D] font-semibold"
                      >
                        Xác nhận thanh toán 0 ₫ thành công (Payment SUCCESS • Order PAID • Mã GD:{" "}
                        <span className="font-mono">
                          {zeroAmountPaidResult.paymentId}
                        </span>
                        ).
                      </div>
                    )}

                  {zeroAmountError && (
                    <div
                      id="zeroAmountErrorBanner"
                      role="alert"
                      className="p-2 rounded-lg bg-error/10 border border-error/30 text-error font-medium"
                    >
                      {zeroAmountError}
                    </div>
                  )}

                  {!zeroAmountPaidResult && (
                    <button
                      id="btnCompleteZeroAmountOrder"
                      type="button"
                      disabled={isCompletingZeroAmount}
                      onClick={() =>
                        void handleZeroAmountComplete(orderCallOutcome.order)
                      }
                      className="w-full py-2 px-3 rounded-lg bg-[#16A34A] hover:bg-[#15803D] text-white font-label-md text-[12px] font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        check_circle
                      </span>
                      <span>
                        {isCompletingZeroAmount
                          ? "Đang xác nhận ZERO_AMOUNT..."
                          : "Xác nhận hoàn tất đơn hàng 0 ₫ ngay"}
                      </span>
                    </button>
                  )}
                </div>
              )}

              <p className="text-[11px] text-on-surface-variant text-center leading-relaxed">
                Giỏ hàng vẫn được bảo toàn nguyên vẹn trong suốt thời gian chờ thanh toán.
                <span className="sr-only">PENDING</span>
              </p>

              <a
                id="btnProceedToPayment"
                href={`/payment?orderId=${encodeURIComponent(
                  orderCallOutcome.order.id
                )}`}
                className="w-full py-2.5 px-3 rounded-lg bg-primary text-on-primary font-label-md font-bold hover:bg-primary-container transition-colors flex items-center justify-center gap-1.5 shadow-sm"
              >
                <span className="material-symbols-outlined text-[18px]">
                  payment
                </span>
                <span>
                  {orderCallOutcome.order.totalVnd === 0
                    ? "Mở trang xác nhận đơn hàng 0 ₫ →"
                    : "Tiến hành thanh toán đơn hàng →"}
                </span>
              </a>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOrderCallOutcome(null)}
                  className="flex-1 py-2.5 px-3 rounded-lg border border-outline-variant text-on-surface font-label-md hover:bg-surface-container transition-colors cursor-pointer whitespace-nowrap"
                >
                  Đóng thông báo
                </button>
                <button
                  type="button"
                  onClick={handleCloseDrawer}
                  className="flex-1 py-2.5 px-3 rounded-lg border border-outline-variant text-on-surface font-label-md hover:bg-surface-container transition-colors cursor-pointer whitespace-nowrap"
                >
                  Về thực đơn
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal hiển thị kết quả LỖI / TRẠNG THÁI KHÔNG CHẮC CHẮN khi gọi POST /orders */}
        {orderCallOutcome?.type === "error" && (
          <div
            id="orderErrorNoticeModal"
            role="alert"
            aria-live="assertive"
            className="absolute inset-0 bg-on-surface/50 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          >
            <div
              className={`bg-surface rounded-xl p-5 shadow-2xl max-w-sm w-full space-y-4 border ${
                orderCallOutcome.isOutcomeUncertain
                  ? "border-tertiary/40"
                  : "border-error/30"
              }`}
            >
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto ${
                  orderCallOutcome.isOutcomeUncertain
                    ? "bg-tertiary/15 text-tertiary"
                    : "bg-error/10 text-error"
                }`}
              >
                <span className="material-symbols-outlined text-[26px]">
                  {orderCallOutcome.isOutcomeUncertain
                    ? "sync_problem"
                    : "error"}
                </span>
              </div>

              {orderCallOutcome.isOutcomeUncertain ? (
                /* TRƯỜNG HỢP 1: TRẠNG THÁI ĐƠN HÀNG KHÔNG CHẮC CHẮN (Lỗi mạng / lỗi đọc response / 5xx sau khi đã gửi POST /orders) */
                <>
                  <div className="text-center space-y-1">
                    <h3
                      id="orderErrorModalTitle"
                      className="font-title-md text-title-md font-bold text-tertiary"
                    >
                      Chưa thể xác nhận trạng thái đơn hàng
                    </h3>
                    <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                      Yêu cầu đặt hàng đã được gửi đi nhưng phản hồi bị gián
                      đoạn (mã{" "}
                      <code className="font-mono font-semibold text-tertiary">
                        {orderCallOutcome.code}
                      </code>{" "}
                      • HTTP {orderCallOutcome.statusCode}).{" "}
                      <strong>
                        Máy chủ có thể đã ghi nhận và tạo đơn hàng của bạn.
                      </strong>
                    </p>
                  </div>

                  <div className="bg-tertiary/10 p-3 rounded-lg text-[12px] text-on-surface border border-tertiary/30 leading-relaxed">
                    {orderCallOutcome.message}
                  </div>

                  <div
                    id="uncertainOrderWarningBox"
                    className="p-2.5 rounded-lg bg-surface-container-high text-[11px] text-on-surface-variant leading-relaxed border border-outline-variant/40"
                  >
                    <strong className="text-on-surface">
                      Lưu ý tránh tạo trùng đơn:
                    </strong>{" "}
                    Vì yêu cầu đã được gửi tới máy chủ, vui lòng kiểm tra lại
                    trạng thái đơn hàng hiện tại trước khi thao tác đặt lại.
                  </div>

                  <button
                    type="button"
                    onClick={() => setOrderCallOutcome(null)}
                    className="w-full py-2.5 px-3 rounded-lg bg-primary text-on-primary font-label-md hover:bg-primary-container transition-colors cursor-pointer whitespace-nowrap"
                  >
                    Đã hiểu, kiểm tra lại trước khi đặt tiếp
                  </button>
                </>
              ) : (
                /* TRƯỜNG HỢP 2: TỪ CHỐI XÁC ĐỊNH (400 Validation/Invalid Cart/Coupon, 409 Insufficient Stock/Pending Order Exists) */
                <>
                  <div className="text-center space-y-1">
                    <h3
                      id="orderErrorModalTitle"
                      className="font-title-md text-title-md font-bold text-error"
                    >
                      {orderCallOutcome.code === "PENDING_ORDER_EXISTS"
                        ? "Đang có đơn hàng chờ xử lý"
                        : "Không thể tạo đơn hàng"}
                    </h3>
                    <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                      {getFriendlyOrderErrorTitle(
                        orderCallOutcome.code,
                        orderCallOutcome.isOutcomeUncertain
                      )}{" "}
                      • Mã{" "}
                      <code className="font-mono text-error font-semibold">
                        {orderCallOutcome.code}
                      </code>{" "}
                      (HTTP {orderCallOutcome.statusCode}).
                    </p>
                  </div>

                  <div className="bg-error/5 p-3 rounded-lg text-[12px] text-error border border-error/20 leading-relaxed space-y-1.5">
                    <div>{orderCallOutcome.message}</div>
                    {orderCallOutcome.detailLines.length > 0 && (
                      <ul
                        id="orderErrorDetailList"
                        className="list-disc pl-4 space-y-1 text-[11px] text-on-surface"
                      >
                        {orderCallOutcome.detailLines.map((line, idx) => (
                          <li key={idx}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {(orderCallOutcome.code === "INVALID_COUPON" ||
                    orderCallOutcome.code === "COUPON_UNAVAILABLE") && (
                    <div
                      id="couponOrderRejectedPrompt"
                      className="p-3 rounded-lg bg-surface-container-high border border-outline-variant/40 text-[11px] text-on-surface space-y-2"
                    >
                      <p className="leading-relaxed">
                        Mã ưu đãi đã hết hiệu lực hoặc hết lượt sử dụng trước khi tạo đơn. Vui lòng <strong>áp dụng lại</strong> mã khác hoặc <strong>bỏ mã ưu đãi</strong> để tiếp tục đặt hàng.
                      </p>
                      <div className="flex gap-2">
                        <button
                          id="btnErrorModalReapplyCoupon"
                          type="button"
                          onClick={() => {
                            setOrderCallOutcome(null);
                          }}
                          className="flex-1 py-2 px-2.5 rounded-lg border border-primary text-primary font-label-md font-semibold hover:bg-primary/10 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          Áp dụng lại mã
                        </button>
                        <button
                          id="btnErrorModalRemoveCoupon"
                          type="button"
                          onClick={() => {
                            handleRemoveCoupon();
                            setOrderCallOutcome(null);
                          }}
                          className="flex-1 py-2 px-2.5 rounded-lg bg-primary text-on-primary font-label-md font-semibold hover:bg-primary-container transition-colors cursor-pointer whitespace-nowrap"
                        >
                          Bỏ coupon
                        </button>
                      </div>
                    </div>
                  )}

                  {orderCallOutcome.code === "PENDING_ORDER_EXISTS" && (
                    <a
                      id="btnPayExistingPendingOrder"
                      href={
                        displayedActiveOrder?.id
                          ? `/payment?orderId=${encodeURIComponent(
                              displayedActiveOrder.id
                            )}`
                          : "/payment"
                      }
                      className="w-full py-2.5 px-3 rounded-lg bg-primary text-on-primary font-label-md font-bold hover:bg-primary-container transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        payment
                      </span>
                      <span>Thanh toán đơn hàng đang chờ xử lý →</span>
                    </a>
                  )}

                  <div className="flex gap-2">
                    {(orderCallOutcome.code === "INVALID_CART" ||
                      orderCallOutcome.code === "INSUFFICIENT_STOCK" ||
                      orderCallOutcome.code === "VALIDATION_ERROR") && (
                      <button
                        type="button"
                        onClick={() => {
                          setOrderCallOutcome(null);
                          setCheckoutStep("cart");
                        }}
                        className="flex-1 py-2.5 px-3 rounded-lg border border-outline-variant text-on-surface font-label-md hover:bg-surface-container transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Chỉnh sửa giỏ
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setOrderCallOutcome(null)}
                      className="flex-1 py-2.5 px-3 rounded-lg bg-error text-on-primary font-label-md hover:opacity-90 transition-opacity cursor-pointer whitespace-nowrap"
                    >
                      Đóng thông báo
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
