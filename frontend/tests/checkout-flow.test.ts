import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactDOMServer from "react-dom/server";
import { JSDOM } from "jsdom";
import CartDrawer, {
  executeCheckoutOrderSubmission,
  executeCouponPreview,
  executeZeroAmountOrderCompletion,
  type OrderCallOutcome,
  proceedToCheckoutStep,
} from "@/components/CartDrawer";
import { AuthContext, type AuthContextType } from "@/context/AuthContext";
import {
  ACTIVE_ORDER_STORAGE_KEY,
  buildCouponPreviewPayloadFromCart,
  buildCreateOrderPayloadFromCart,
  CART_OWNER_STORAGE_KEY,
  CartContext,
  type CartContextValue,
  type CartItem,
  CartProvider,
  generateCartItemKey,
  mergeDuplicateCartItems,
  persistActiveOrderForUser,
  restoreActiveOrderForUser,
  useCart,
  validateAndSanitizeCartItem,
} from "@/context/CartContext";
import type {
  CouponPreviewResponseDto,
  CouponValidationStatus,
  CreateOrderRequestDto,
  CreateOrderResponseDto,
  OrderSubmissionErrorState,
} from "@/mock-data";
import {
  clearStoredSession,
  getStoredToken,
  setStoredSession,
} from "@/services/auth.service";
import {
  createOrderApi,
  describeOrderErrorDetails,
  getFriendlyOrderErrorTitle,
  normalizeCouponCode,
  type OrderServiceError,
  sanitizeCreateOrderPayload,
  toOrderSubmissionErrorState,
  validateCouponCodeInput,
  validateCreateOrderPayload,
  validateOrderResponseData,
} from "@/services/order.service";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const localStorageMock = new MemoryStorage();
const sessionStorageMock = new MemoryStorage();

(globalThis as Record<string, unknown>).localStorage = localStorageMock;
(globalThis as Record<string, unknown>).sessionStorage = sessionStorageMock;
(globalThis as Record<string, unknown>).window = globalThis;

function createValidMockJwt(
  sub = "550e8400-e29b-41d4-a716-446655440000",
  expiresInSeconds = 3600
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createSampleCartItems(): CartItem[] {
  return [
    {
      id: "cart-line-1",
      productId: "550e8400-e29b-41d4-a716-446655440000",
      productName: "Cà Phê Sữa Đá Sài Gòn",
      imageUrl: "/images/ca-phe-sua-da-sai-gon.jpg",
      size: "M",
      sizeMultiplierPercent: 120,
      sizePriceVnd: 54000,
      basePriceVnd: 45000,
      toppings: [
        {
          id: "7d44a44c-8d1a-4af3-98cb-90e5d4c8a001",
          name: "Trân châu trắng",
          priceVnd: 5000,
        },
      ],
      toppingIds: ["7d44a44c-8d1a-4af3-98cb-90e5d4c8a001"],
      quantity: 2,
      unitPriceVnd: 59000,
      lineTotalVnd: 118000,
      note: "Ít đá",
      sizePolicy: "STANDARD",
    },
  ];
}

function createValidOrderResponse(): CreateOrderResponseDto {
  return {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    status: "PENDING",
    items: [
      {
        id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
        productId: "550e8400-e29b-41d4-a716-446655440000",
        productName: "Cà Phê Sữa Đá Sài Gòn",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 45000,
        quantity: 2,
        unitPriceVnd: 59000,
        lineTotalVnd: 118000,
        toppings: [
          {
            id: "7d44a44c-8d1a-4af3-98cb-90e5d4c8a001",
            name: "Trân châu trắng",
            priceVnd: 5000,
          },
        ],
      },
    ],
    couponCode: null,
    subtotalVnd: 118000,
    discountVnd: 0,
    totalVnd: 118000,
    createdAt: "2026-10-26T15:00:00.000Z",
  };
}

function renderCartDrawerMarkup(options: {
  items?: CartItem[];
  isAuthenticated?: boolean;
  userId?: string;
  initialCheckoutStep?: "cart" | "review";
  initialIsSubmittingOrder?: boolean;
  initialOrderOutcome?: OrderCallOutcome | null;
  activeOrder?: CreateOrderResponseDto | null;
  onClearCart?: () => void;
  couponCode?: string;
  appliedCoupon?: CouponPreviewResponseDto | null;
  couponStatus?: CouponValidationStatus;
  couponErrorMessage?: string | null;
  couponErrorCode?: string | null;
}): string {
  const items = options.items ?? createSampleCartItems();
  const isAuthenticated = options.isAuthenticated ?? true;
  const userId = options.userId ?? "550e8400-e29b-41d4-a716-446655440000";
  const mockToken = isAuthenticated ? createValidMockJwt(userId) : null;
  const appliedCoupon = options.appliedCoupon ?? null;

  const cartValue: CartContextValue = {
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    totalLines: items.length,
    subtotalVnd: items.reduce((sum, i) => sum + i.lineTotalVnd, 0),
    formattedSubtotal: "118.000 ₫",
    isCartOpen: true,
    couponCode: options.couponCode ?? appliedCoupon?.couponCode ?? "",
    setCouponCode: () => {},
    appliedCoupon,
    couponStatus: options.couponStatus ?? (appliedCoupon ? "applied" : "idle"),
    couponErrorMessage: options.couponErrorMessage ?? null,
    couponErrorCode: options.couponErrorCode ?? null,
    applyCoupon: async () => appliedCoupon,
    removeCoupon: () => {},
    setCouponApplicationState: () => {},
    feedbackMessage: null,
    feedbackType: null,
    addToCart: () => ({ success: true, message: "OK" }),
    updateQuantity: () => {},
    incrementQuantity: () => {},
    decrementQuantity: () => {},
    removeFromCart: () => {},
    clearCart: options.onClearCart ?? (() => {}),
    openCart: () => {},
    closeCart: () => {},
    toggleCart: () => {},
    dismissFeedback: () => {},
    mapToCreateOrderPayload: (couponOverride) =>
      buildCreateOrderPayloadFromCart(
        items,
        couponOverride !== undefined ? couponOverride : appliedCoupon?.couponCode
      ),
    activeOrder: options.activeOrder ?? null,
    isSubmittingOrder: options.initialIsSubmittingOrder ?? false,
    orderError: null,
    setActiveOrder: () => {},
    setIsSubmittingOrder: () => {},
    setOrderError: () => {},
    clearOrderFlowState: () => {},
  };

  const authValue: AuthContextType = {
    user: isAuthenticated
      ? {
          id: userId,
          email: "khachhang@brewlite.vn",
          fullName: "Nguyễn Văn A",
        }
      : null,
    accessToken: mockToken,
    isAuthenticated,
    isLoading: false,
    login: async () => {},
    register: async () => ({
      id: userId,
      email: "khachhang@brewlite.vn",
      fullName: "Nguyễn Văn A",
      createdAt: "2026-10-26T15:00:00.000Z",
    }),
    logout: () => {},
    verifySession: () => isAuthenticated,
    handleUnauthorizedCheckout: () => {},
    pendingCheckout: false,
    setPendingCheckout: () => {},
    isAuthModalOpen: false,
    authModalMode: "login",
    authModalMessage: null,
    openAuthModal: () => {},
    closeAuthModal: () => {},
  };

  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      AuthContext.Provider,
      { value: authValue },
      React.createElement(
        CartContext.Provider,
        { value: cartValue },
        React.createElement(CartDrawer, {
          initialCheckoutStep: options.initialCheckoutStep ?? "review",
          initialIsSubmittingOrder: options.initialIsSubmittingOrder ?? false,
          initialOrderOutcome: options.initialOrderOutcome ?? null,
        })
      )
    )
  );
}

describe("SCRUM-43 & SCRUM-44 Checkout Flow, Cart Integration & POST /orders Automated Tests", () => {
  beforeEach(() => {
    localStorageMock.clear();
    sessionStorageMock.clear();
  });

  describe("1. Payload Mapping & Cart Normalization (API Contract v2.1 / v3.0)", () => {
    it("maps CartItem[] to CreateOrderDto stripping all client-only fields and normalizing UUIDs/couponCode", () => {
      const cartItems = createSampleCartItems();
      cartItems[0].productId = "  550E8400-E29B-41D4-A716-446655440000  ";
      cartItems[0].toppingIds = ["  7D44A44C-8D1A-4AF3-98CB-90E5D4C8A001 "];

      const payload = buildCreateOrderPayloadFromCart(
        cartItems,
        "  welcome20  "
      );

      assert.deepEqual(payload, {
        items: [
          {
            productId: "550e8400-e29b-41d4-a716-446655440000",
            size: "M",
            toppingIds: ["7d44a44c-8d1a-4af3-98cb-90e5d4c8a001"],
            quantity: 2,
          },
        ],
        couponCode: "WELCOME20",
      });

      // Verify forbidden client fields are never present
      const rawRecord = payload as unknown as Record<string, unknown>;
      assert.equal("userId" in rawRecord, false);
      assert.equal("status" in rawRecord, false);
      assert.equal("totalVnd" in rawRecord, false);
      assert.equal("subtotalVnd" in rawRecord, false);
      assert.equal(
        "unitPriceVnd" in
          (payload.items[0] as unknown as Record<string, unknown>),
        false
      );
      assert.equal(
        "productName" in
          (payload.items[0] as unknown as Record<string, unknown>),
        false
      );
    });

    it("rejects decimal quantity without Math.trunc auto-fixing and rejects duplicate merged quantity > 10 without Math.min clamping", () => {
      const decimalValidation = validateCreateOrderPayload({
        items: [
          {
            productId: "550e8400-e29b-41d4-a716-446655440000",
            size: "M",
            toppingIds: [],
            quantity: 2.5,
          },
        ],
      });
      assert.equal(decimalValidation.isValid, false);
      assert.equal(decimalValidation.error?.code, "VALIDATION_ERROR");
      assert.equal(decimalValidation.error?.isOutcomeUncertain, false);

      // Merging two duplicate lines (6 + 5 = 11 > 10) must throw instead of clamping to 10
      const itemA = validateAndSanitizeCartItem({
        id: "line-a",
        productId: "550e8400-e29b-41d4-a716-446655440000",
        productName: "Cà Phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 35000,
        toppings: [],
        quantity: 6,
      });
      const itemB = validateAndSanitizeCartItem({
        id: "line-b",
        productId: "550e8400-e29b-41d4-a716-446655440000",
        productName: "Cà Phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 35000,
        toppings: [],
        quantity: 5,
      });
      assert.ok(itemA && itemB);
      assert.equal(
        generateCartItemKey(itemA.productId, itemA.size, ["t2", "t1"]),
        generateCartItemKey(itemB.productId, itemB.size, ["T1", "T2"])
      );
      assert.throws(() => {
        mergeDuplicateCartItems([itemA, itemB]);
      }, /vượt quá giới hạn tối đa 10 ly/);
    });

    it("normalizes and validates couponCode whitespace and length constraints", () => {
      assert.equal(normalizeCouponCode("   "), undefined);
      assert.equal(
        validateCouponCodeInput("WELCOME10 EXTRA").isValid,
        false
      );
      assert.equal(validateCouponCodeInput("A".repeat(31)).isValid, false);
      assert.deepEqual(
        sanitizeCreateOrderPayload({
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440000",
              size: "S",
              toppingIds: [],
              quantity: 1,
            },
          ],
          couponCode: "   ",
        }),
        {
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440000",
              size: "S",
              toppingIds: [],
              quantity: 1,
            },
          ],
        }
      );
    });
  });

  describe("2. Error Details Mapping & Error State Normalization per API Contract (SCRUM-43 & SCRUM-44)", () => {
    it("maps INSUFFICIENT_STOCK details with requestedQuantity and availableQuantity per API Contract §8.7", () => {
      const productId = "550e8400-e29b-41d4-a716-446655440000";
      const lines = describeOrderErrorDetails(
        [
          {
            productId,
            requestedQuantity: 6,
            availableQuantity: 5,
          },
        ],
        { [productId]: "Cà Phê Sữa Đá Sài Gòn" }
      );

      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes("Cà Phê Sữa Đá Sài Gòn"));
      assert.ok(lines[0].includes("yêu cầu: 6, khả dụng: 5"));
    });

    it("maps INVALID_CART reasons (PRODUCT_UNAVAILABLE, INVALID_SIZE, TOPPING_NOT_ALLOWED, etc.) per API Contract §8.7", () => {
      const lines = describeOrderErrorDetails([
        { itemIndex: 0, reason: "PRODUCT_UNAVAILABLE" },
        { itemIndex: 1, reason: "INVALID_SIZE" },
        { itemIndex: 2, reason: "TOPPING_NOT_ALLOWED" },
        { itemIndex: 3, reason: "TOPPING_NOT_FOUND" },
        { itemIndex: 4, reason: "TOPPING_UNAVAILABLE" },
        { itemIndex: 5, reason: "DUPLICATE_TOPPING" },
        { itemIndex: 6, reason: "TOO_MANY_TOPPINGS" },
        { itemIndex: 7, reason: "DUPLICATE_CONFIGURATION" },
        { itemIndex: 8, reason: "INVALID_PRICE_DATA" },
      ]);

      assert.equal(lines.length, 9);
      assert.ok(lines[0].includes("Dòng món #1") && lines[0].includes("không khả dụng"));
      assert.ok(lines[1].includes("Dòng món #2") && lines[1].includes("Kích cỡ đã chọn không hợp lệ"));
      assert.ok(lines[2].includes("Dòng món #3") && lines[2].includes("không hỗ trợ thêm topping"));
      assert.ok(lines[3].includes("Dòng món #4") && lines[3].includes("Topping đã chọn không tồn tại"));
      assert.ok(lines[4].includes("Dòng món #5") && lines[4].includes("Topping đã chọn hiện không khả dụng"));
      assert.ok(lines[5].includes("Dòng món #6") && lines[5].includes("trùng một loại topping"));
      assert.ok(lines[6].includes("Dòng món #7") && lines[6].includes("tối đa 3 loại topping"));
      assert.ok(lines[7].includes("Dòng món #8") && lines[7].includes("Trùng cấu hình"));
      assert.ok(lines[8].includes("Dòng món #9") && lines[8].includes("bảng giá"));
    });

    it("normalizes error codes (INVALID_COUPON, COUPON_UNAVAILABLE, PENDING_ORDER_EXISTS, INTERNAL_ERROR) via toOrderSubmissionErrorState", () => {
      const couponErr = toOrderSubmissionErrorState({
        statusCode: 400,
        code: "INVALID_COUPON",
        isOutcomeUncertain: false,
      });
      assert.equal(couponErr.isOutcomeUncertain, false);
      assert.equal(
        getFriendlyOrderErrorTitle(couponErr.code, couponErr.isOutcomeUncertain),
        "Mã khuyến mãi không khả dụng"
      );
      assert.ok(couponErr.message.includes("Mã khuyến mãi"));

      const internalErr = toOrderSubmissionErrorState({
        statusCode: 500,
        code: "INTERNAL_ERROR",
      });
      assert.equal(internalErr.isOutcomeUncertain, true);
      assert.equal(
        getFriendlyOrderErrorTitle(
          internalErr.code,
          internalErr.isOutcomeUncertain
        ),
        "Chưa thể xác nhận trạng thái đơn hàng"
      );
    });
  });

  describe("3. Checkout Step Auth Guard & 401 Unauthorized Handling", () => {
    it("blocks unauthenticated guest from entering review step, opens Login modal with resumeCheckout=true, and preserves Cart", () => {
      let authModalOpenedWith: {
        mode?: string;
        resumeCheckout?: boolean;
      } | null = null;
      let currentStep: "cart" | "review" = "cart";

      const proceeded = proceedToCheckoutStep({
        itemsCount: 2,
        isSubmittingOrder: false,
        isAuthenticated: false,
        verifySession: () => false,
        openAuthModal: (mode, options) => {
          authModalOpenedWith = {
            mode,
            resumeCheckout: options?.resumeCheckout,
          };
        },
        setVoucherNoticeVisible: () => {},
        setOrderCallOutcome: () => {},
        setCheckoutStep: (step) => {
          currentStep = step;
        },
      });

      assert.equal(proceeded, false);
      assert.equal(currentStep, "cart");
      assert.deepEqual(authModalOpenedWith, {
        mode: "login",
        resumeCheckout: true,
      });
    });

    it("handles 401 UNAUTHORIZED from POST /orders by clearing session and activeOrder snapshot, preserving Cart, reverting to cart step, and triggering handleUnauthorizedCheckout", async () => {
      const userId = "550e8400-e29b-41d4-a716-446655440000";
      const mockToken = createValidMockJwt(userId);
      setStoredSession(mockToken, {
        id: userId,
        email: "user@brewlite.vn",
        fullName: "Khách Hàng",
      });
      persistActiveOrderForUser(createValidOrderResponse(), userId);
      assert.ok(sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY));

      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );

      const savedFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            statusCode: 401,
            code: "UNAUTHORIZED",
            message: "Unauthorized",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );

      let stepAfter401: "cart" | "review" = "review";
      let unauthorizedReason: string | undefined;
      let isSubmitting = false;
      let activeOrderAfter401 = createValidOrderResponse() as CreateOrderResponseDto | null;
      const submittingRef = { current: false };
      const cartItems = createSampleCartItems();

      try {
        await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          userId,
          submittingRef,
          isSubmittingOrder: isSubmitting,
          setIsSubmittingOrder: (val) => {
            isSubmitting = val;
          },
          setCheckoutStep: (step) => {
            stepAfter401 = step;
          },
          setOrderCallOutcome: () => {},
          setActiveOrder: (order) => {
            activeOrderAfter401 = order;
          },
          verifySession: () => true,
          handleUnauthorizedCheckout: (reason) => {
            unauthorizedReason = reason;
          },
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(cartItems),
        });

        assert.equal(stepAfter401, "cart");
        assert.ok(
          unauthorizedReason &&
            unauthorizedReason.includes("giỏ hàng của bạn được giữ nguyên")
        );
        assert.equal(getStoredToken(), null, "Expired token must be cleared");
        assert.equal(
          sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY),
          null,
          "Active PENDING order snapshot in sessionStorage must be cleared on 401"
        );
        assert.equal(
          activeOrderAfter401,
          null,
          "Active order state must be reset to null on 401"
        );
        assert.equal(cartItems.length, 1, "In-memory cart items must remain intact");
        assert.ok(
          localStorageMock
            .getItem("brewlite_cart_v1")
            ?.includes("550e8400-e29b-41d4-a716-446655440000"),
          "localStorage cart must be preserved on 401"
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });

  describe("4. Loading State & Double-Submit Prevention during POST /orders", () => {
    it("sets isSubmittingOrder=true while POST /orders is in-flight, blocks concurrent double-submit, and renders loading UI", async () => {
      const cartItems = createSampleCartItems();
      const mockToken = createValidMockJwt();
      const submittingRef = { current: false };
      const loadingTransitions: boolean[] = [];
      let isSubmitting = false;
      let apiCallCount = 0;

      let resolveOrderPromise!: (value: CreateOrderResponseDto) => void;
      const slowCreateOrderFn = async (
        payload: CreateOrderRequestDto
      ): Promise<CreateOrderResponseDto> => {
        apiCallCount++;
        assert.equal(payload.items.length, 1);
        return new Promise<CreateOrderResponseDto>((resolve) => {
          resolveOrderPromise = resolve;
        });
      };

      // Start first submission (do not await yet)
      const firstCallPromise = executeCheckoutOrderSubmission({
        items: cartItems,
        accessToken: mockToken,
        submittingRef,
        isSubmittingOrder: isSubmitting,
        setIsSubmittingOrder: (val) => {
          isSubmitting = val;
          loadingTransitions.push(val);
        },
        setCheckoutStep: () => {},
        setOrderCallOutcome: () => {},
        verifySession: () => true,
        handleUnauthorizedCheckout: () => {},
        mapToCreateOrderPayload: () =>
          buildCreateOrderPayloadFromCart(cartItems),
        createOrderFn: slowCreateOrderFn,
      });

      // Immediately verify loading state is active
      assert.equal(submittingRef.current, true);
      assert.equal(isSubmitting, true);
      assert.deepEqual(loadingTransitions, [true]);

      // Render CartDrawer in loading state and verify loading UI & disabled button
      const loadingHtml = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        initialIsSubmittingOrder: true,
      });
      assert.ok(
        loadingHtml.includes('id="checkoutSubmittingBanner"'),
        "Must render #checkoutSubmittingBanner while submitting"
      );
      assert.ok(
        loadingHtml.includes("Đang xử lý đặt hàng..."),
        "Confirm button must show loading text"
      );
      assert.ok(
        loadingHtml.includes('aria-busy="true"'),
        "Confirm button and drawer must indicate aria-busy=true"
      );

      // Attempt a second concurrent submission (double-click) while first is still pending
      const secondCallResult = await executeCheckoutOrderSubmission({
        items: cartItems,
        accessToken: mockToken,
        submittingRef,
        isSubmittingOrder: isSubmitting,
        setIsSubmittingOrder: (val) => {
          isSubmitting = val;
        },
        setCheckoutStep: () => {},
        setOrderCallOutcome: () => {},
        verifySession: () => true,
        handleUnauthorizedCheckout: () => {},
        mapToCreateOrderPayload: () =>
          buildCreateOrderPayloadFromCart(cartItems),
        createOrderFn: slowCreateOrderFn,
      });

      assert.equal(secondCallResult.skipped, true);
      assert.equal(
        apiCallCount,
        1,
        "Double-click must NEVER trigger a second POST /orders call"
      );

      // Resolve first request and verify loading state resets to false
      resolveOrderPromise(createValidOrderResponse());
      const firstCallResult = await firstCallPromise;
      assert.equal(firstCallResult.skipped, false);
      assert.equal(firstCallResult.outcome?.type, "success");
      assert.equal(submittingRef.current, false);
      assert.equal(isSubmitting, false);
      assert.deepEqual(loadingTransitions, [true, false]);
    });
  });

  describe("5. 201 Created (PENDING) Order Success, ERD Invariants & Complete Snapshot Rendering (SCRUM-44)", () => {
    it("accepts HTTP 201 Created with valid PENDING order response, syncs activeOrder to CartContext, preserves Cart, and renders full OrderResponse snapshot", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const validOrder: CreateOrderResponseDto = {
        ...createValidOrderResponse(),
        couponCode: "WELCOME10",
        subtotalVnd: 118000,
        discountVnd: 11800,
        totalVnd: 106200,
      };

      const savedFetch = globalThis.fetch;
      let capturedAuthHeader = "";
      let capturedBody: Record<string, unknown> | null = null;

      globalThis.fetch = async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        capturedAuthHeader = headers?.Authorization || "";
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(validOrder), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      };

      let capturedOutcome = null as OrderCallOutcome | null;
      let syncedActiveOrder: CreateOrderResponseDto | null = null;
      let clearCartCalled = false;
      localStorageMock.setItem("brewlite_cart_v1", JSON.stringify(cartItems));
      const clearCartSpy = () => {
        clearCartCalled = true;
        cartItems.length = 0;
        localStorageMock.removeItem("brewlite_cart_v1");
      };

      try {
        const res = await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          submittingRef: { current: false },
          isSubmittingOrder: false,
          setIsSubmittingOrder: () => {},
          setCheckoutStep: () => {},
          setOrderCallOutcome: (val) => {
            capturedOutcome = val;
          },
          setActiveOrder: (order) => {
            syncedActiveOrder = order;
          },
          verifySession: () => true,
          handleUnauthorizedCheckout: () => {},
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(cartItems),
          clearCart: clearCartSpy,
        });

        assert.equal(capturedAuthHeader, `Bearer ${mockToken}`);
        assert.deepEqual(capturedBody, {
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440000",
              size: "M",
              toppingIds: ["7d44a44c-8d1a-4af3-98cb-90e5d4c8a001"],
              quantity: 2,
            },
          ],
        });

        const outcome = res.outcome ?? capturedOutcome;
        assert.ok(outcome && outcome.type === "success");
        assert.equal(outcome.order.id, validOrder.id);
        assert.equal(outcome.order.status, "PENDING");
        assert.deepEqual(syncedActiveOrder, validOrder);

        const successHtml = renderCartDrawerMarkup({
          items: cartItems,
          initialCheckoutStep: "review",
          initialOrderOutcome: outcome,
          activeOrder: syncedActiveOrder,
          onClearCart: clearCartSpy,
        });

        assert.equal(
          clearCartCalled,
          false,
          "Cart must NOT be cleared while order is PENDING"
        );
        assert.equal(
          cartItems.length,
          1,
          "Cart items in memory must remain intact after 201 PENDING order creation"
        );
        assert.ok(
          localStorageMock
            .getItem("brewlite_cart_v1")
            ?.includes("550e8400-e29b-41d4-a716-446655440000"),
          "Cart items in localStorage must remain intact after 201 PENDING order creation"
        );
        assert.ok(successHtml.includes('id="orderSuccessNoticeModal"'));
        assert.ok(successHtml.includes('id="activePendingOrderBanner"'));
        assert.ok(successHtml.includes(validOrder.id));
        assert.ok(successHtml.includes("PENDING"));
        assert.ok(successHtml.includes("WELCOME10"));
        assert.ok(successHtml.includes("120%"));
        assert.ok(successHtml.includes("45.000"));
        assert.ok(successHtml.includes("59.000"));
        assert.ok(successHtml.includes("118.000"));
        assert.ok(successHtml.includes("11.800"));
        assert.ok(successHtml.includes("106.200"));
        assert.ok(
          successHtml.includes('id="serverPriceReconciliationNote"'),
          "Must display server-vs-client reconciliation note when totalVnd differs from client subtotal"
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("scopes PENDING order snapshot to the authenticated ownerUserId, restores only for the same user, and purges snapshot on logout or when User B logs in on the same tab", () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const userBId = "660e8400-e29b-41d4-a716-446655440099";
      const userAToken = createValidMockJwt(userAId);
      const userBToken = createValidMockJwt(userBId);

      const userAOrder: CreateOrderResponseDto = {
        ...createValidOrderResponse(),
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        subtotalVnd: 118000,
        discountVnd: 18000,
        totalVnd: 100000,
      };

      setStoredSession(userAToken, {
        id: userAId,
        email: "usera@brewlite.vn",
        fullName: "User A",
      });
      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );

      // 1. Persist snapshot for User A -> restores when currentUserId === userAId
      persistActiveOrderForUser(userAOrder, userAId);
      const restoredForUserA = restoreActiveOrderForUser(userAId);
      assert.ok(restoredForUserA);
      assert.equal(restoredForUserA.id, userAOrder.id);

      const userAHtml = renderCartDrawerMarkup({
        isAuthenticated: true,
        userId: userAId,
        initialCheckoutStep: "cart",
        activeOrder: restoredForUserA,
      });
      assert.ok(userAHtml.includes('id="activePendingOrderBanner"'));
      assert.ok(userAHtml.includes(userAOrder.id));

      // 2. If User B logs in on the same tab while User A's snapshot is still in sessionStorage:
      // CartDrawer & restoreActiveOrderForUser(userBId) & setStoredSession must purge User A's snapshot
      // and NEVER leak User A's order ID or totalVnd (100.000) to User B!
      const userBHtmlWhileSessionHasUserA = renderCartDrawerMarkup({
        isAuthenticated: true,
        userId: userBId,
        initialCheckoutStep: "cart",
        activeOrder: userAOrder, // Even if stale activeOrder was passed, cross-check against sessionStorage ownerUserId blocks it
      });
      assert.equal(
        userBHtmlWhileSessionHasUserA.includes('id="activePendingOrderBanner"'),
        false,
        "User B must NEVER see User A's activePendingOrderBanner"
      );
      assert.equal(
        userBHtmlWhileSessionHasUserA.includes(userAOrder.id),
        false,
        "User B must NEVER see User A's order ID"
      );
      assert.equal(
        sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY),
        null,
        "Mismatched user snapshot must be immediately purged from sessionStorage"
      );

      // 3. Re-seed User A snapshot, then call setStoredSession for User B -> purges User A snapshot immediately
      persistActiveOrderForUser(userAOrder, userAId);
      assert.ok(sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY));
      setStoredSession(userBToken, {
        id: userBId,
        email: "userb@brewlite.vn",
        fullName: "User B",
      });
      assert.equal(
        sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY),
        null,
        "setStoredSession for User B must purge User A's active order snapshot"
      );
      assert.equal(restoreActiveOrderForUser(userBId), null);

      // 4. Re-seed User A snapshot, then User A logs out (clearStoredSession) -> purges active order snapshot while preserving Cart
      persistActiveOrderForUser(userAOrder, userAId);
      assert.ok(sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY));
      clearStoredSession();
      assert.equal(
        sessionStorageMock.getItem(ACTIVE_ORDER_STORAGE_KEY),
        null,
        "Logout (clearStoredSession) must remove active order snapshot from sessionStorage"
      );
      assert.ok(
        localStorageMock
          .getItem("brewlite_cart_v1")
          ?.includes("550e8400-e29b-41d4-a716-446655440000"),
        "Logout must preserve Cart in localStorage"
      );

      const guestHtmlAfterLogout = renderCartDrawerMarkup({
        isAuthenticated: false,
        initialCheckoutStep: "cart",
        activeOrder: userAOrder,
      });
      assert.equal(
        guestHtmlAfterLogout.includes('id="activePendingOrderBanner"'),
        false,
        "Logged-out guest must NEVER see activePendingOrderBanner"
      );
      assert.equal(
        guestHtmlAfterLogout.includes(userAOrder.id),
        false,
        "Logged-out guest must NEVER see previous user's order ID"
      );
    });

    it("rejects HTTP 200 OK (requires 201 Created) and rejects missing required fields or ERD arithmetic invariant violations in Order Response with isOutcomeUncertain=true", async () => {
      const mockToken = createValidMockJwt();
      const orderDto: CreateOrderRequestDto = {
        items: [
          {
            productId: "550e8400-e29b-41d4-a716-446655440000",
            size: "M",
            toppingIds: [],
            quantity: 1,
          },
        ],
      };

      const savedFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () =>
          new Response(JSON.stringify(createValidOrderResponse()), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });

        await assert.rejects(
          async () => {
            await createOrderApi(orderDto, mockToken);
          },
          (err: OrderServiceError) => {
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "SERVER_ERROR");
            assert.equal(err.isOutcomeUncertain, true);
            return true;
          }
        );

        // Missing item.id in validateOrderResponseData must throw with isOutcomeUncertain = true
        const brokenOrder = createValidOrderResponse();
        brokenOrder.items[0].id = "";
        assert.throws(
          () => {
            validateOrderResponseData(brokenOrder);
          },
          (err: OrderServiceError) => {
            assert.equal(err.isOutcomeUncertain, true);
            return true;
          }
        );

        // ERD pricing invariant violation: totalVnd !== subtotalVnd - discountVnd
        const invalidTotalOrder = createValidOrderResponse();
        invalidTotalOrder.discountVnd = 10000;
        invalidTotalOrder.totalVnd = 118000; // should be 108000
        assert.throws(
          () => {
            validateOrderResponseData(invalidTotalOrder);
          },
          (err: OrderServiceError) => {
            assert.equal(err.isOutcomeUncertain, true);
            assert.ok(err.message.includes("totalVnd = subtotalVnd - discountVnd"));
            return true;
          }
        );

        // ERD line total invariant violation: lineTotalVnd !== unitPriceVnd * quantity
        const invalidLineOrder = createValidOrderResponse();
        invalidLineOrder.items[0].lineTotalVnd = 99000;
        invalidLineOrder.subtotalVnd = 99000;
        invalidLineOrder.totalVnd = 99000;
        assert.throws(
          () => {
            validateOrderResponseData(invalidLineOrder);
          },
          (err: OrderServiceError) => {
            assert.equal(err.isOutcomeUncertain, true);
            assert.ok(err.message.includes("lineTotalVnd = unitPriceVnd * quantity"));
            return true;
          }
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });

  describe("6. Network Error (No Retry) & Uncertain Order State vs Deterministic 400/409 Errors", () => {
    it("does NOT retry POST /orders on network failure, sets isOutcomeUncertain=true, and renders uncertain order state modal", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;
      let fetchAttempts = 0;

      globalThis.fetch = async () => {
        fetchAttempts++;
        throw new TypeError("Failed to fetch");
      };

      let capturedOutcome = null as OrderCallOutcome | null;
      let syncedOrderError = null as OrderSubmissionErrorState | null;

      try {
        const res = await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          submittingRef: { current: false },
          isSubmittingOrder: false,
          setIsSubmittingOrder: () => {},
          setCheckoutStep: () => {},
          setOrderCallOutcome: (val) => {
            capturedOutcome = val;
          },
          setOrderError: (err) => {
            syncedOrderError = err;
          },
          verifySession: () => true,
          handleUnauthorizedCheckout: () => {},
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(cartItems),
        });

        assert.equal(
          fetchAttempts,
          1,
          "POST /orders must NEVER retry on network error"
        );
        const outcome = res.outcome ?? capturedOutcome;
        assert.ok(outcome && outcome.type === "error");
        assert.equal(outcome.code, "NETWORK_ERROR");
        assert.equal(outcome.statusCode, 503);
        assert.equal(outcome.isOutcomeUncertain, true);
        assert.ok(syncedOrderError && syncedOrderError.isOutcomeUncertain);

        const uncertainErrorHtml = renderCartDrawerMarkup({
          items: cartItems,
          initialCheckoutStep: "review",
          initialOrderOutcome: outcome,
        });
        assert.ok(
          uncertainErrorHtml.includes("Chưa thể xác nhận trạng thái đơn hàng"),
          "Must display uncertain order status title"
        );
        assert.ok(
          uncertainErrorHtml.includes('id="uncertainOrderWarningBox"'),
          "Must display anti-duplicate warning box"
        );
        assert.equal(
          uncertainErrorHtml.includes("Đơn hàng chưa được tạo"),
          false,
          "Must NEVER falsely claim the order was not created when network fails after send"
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("renders deterministic 409 INSUFFICIENT_STOCK error with isOutcomeUncertain=false and mapped requestedQuantity/availableQuantity details", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            statusCode: 409,
            message: "Insufficient product stock",
            error: "Conflict",
            code: "INSUFFICIENT_STOCK",
            details: [
              {
                productId: "550e8400-e29b-41d4-a716-446655440000",
                requestedQuantity: 6,
                availableQuantity: 5,
              },
            ],
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );

      let capturedOutcome = null as OrderCallOutcome | null;

      try {
        const res = await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          submittingRef: { current: false },
          isSubmittingOrder: false,
          setIsSubmittingOrder: () => {},
          setCheckoutStep: () => {},
          setOrderCallOutcome: (val) => {
            capturedOutcome = val;
          },
          verifySession: () => true,
          handleUnauthorizedCheckout: () => {},
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(cartItems),
        });

        const outcome = res.outcome ?? capturedOutcome;
        assert.ok(outcome && outcome.type === "error");
        assert.equal(outcome.statusCode, 409);
        assert.equal(outcome.code, "INSUFFICIENT_STOCK");
        assert.equal(outcome.isOutcomeUncertain, false);
        assert.equal(outcome.detailLines.length, 1);
        assert.ok(
          outcome.detailLines[0].includes("Cà Phê Sữa Đá Sài Gòn") &&
            outcome.detailLines[0].includes("yêu cầu: 6, khả dụng: 5")
        );

        const stockErrorHtml = renderCartDrawerMarkup({
          items: cartItems,
          initialCheckoutStep: "review",
          initialOrderOutcome: outcome,
        });
        assert.ok(stockErrorHtml.includes("Không thể tạo đơn hàng"));
        assert.ok(stockErrorHtml.includes('id="orderErrorDetailList"'));
        assert.ok(stockErrorHtml.includes("yêu cầu: 6, khả dụng: 5"));
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });

  describe("7. P2-22 Coupon Application Frontend Flow & ZERO_AMOUNT Integration", () => {
    it("enables coupon input & Apply button (no longer 'Sắp ra mắt') and builds POST /coupons/preview payload without client discount fields", () => {
      const cartItems = createSampleCartItems();
      const cartStepHtml = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "cart",
        couponCode: "WELCOME20",
        couponStatus: "idle",
      });

      assert.equal(
        cartStepHtml.includes("Nhập mã ưu đãi (Sắp ra mắt)"),
        false,
        "Disabled 'Nhập mã ưu đãi (Sắp ra mắt)' placeholder must be replaced with live coupon input"
      );
      assert.ok(
        cartStepHtml.includes('id="couponCodeInput"'),
        "Cart step must render #couponCodeInput"
      );
      assert.ok(
        cartStepHtml.includes('id="btnApplyVoucher"'),
        "Cart step must render #btnApplyVoucher"
      );

      const reviewStepHtml = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        couponCode: "WELCOME20",
        couponStatus: "idle",
      });
      assert.ok(
        reviewStepHtml.includes('id="checkoutCouponInput"'),
        "Review step must render #checkoutCouponInput"
      );
      assert.ok(
        reviewStepHtml.includes('id="btnApplyCheckoutCoupon"'),
        "Review step must render #btnApplyCheckoutCoupon"
      );

      const previewPayload = buildCouponPreviewPayloadFromCart(
        cartItems,
        "  welcome20 "
      );
      assert.deepEqual(previewPayload, {
        items: [
          {
            productId: "550e8400-e29b-41d4-a716-446655440000",
            size: "M",
            toppingIds: ["7d44a44c-8d1a-4af3-98cb-90e5d4c8a001"],
            quantity: 2,
          },
        ],
        couponCode: "WELCOME20",
      });
      const rawRecord = previewPayload as unknown as Record<string, unknown>;
      assert.equal("discountVnd" in rawRecord, false);
      assert.equal("subtotalVnd" in rawRecord, false);
      assert.equal("totalVnd" in rawRecord, false);
      assert.equal("userId" in rawRecord, false);
    });

    it("renders Apply loading (validating) state and transitions to applied state with backend subtotal/discount/total without creating an Order", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;
      const calledEndpoints: string[] = [];
      const observedStatuses: CouponValidationStatus[] = [];

      // Verify loading markup when couponStatus === "validating"
      const validatingHtml = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        couponCode: "FREE100",
        couponStatus: "validating",
      });
      assert.ok(validatingHtml.includes('data-coupon-status="validating"'));
      assert.ok(validatingHtml.includes("Đang kiểm tra..."));
      assert.ok(validatingHtml.includes('aria-busy="true"'));

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        calledEndpoints.push(url);
        return new Response(
          JSON.stringify({
            valid: true,
            couponCode: "FREE100",
            subtotalVnd: 158400,
            discountVnd: 158400,
            totalVnd: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const finalState = await executeCouponPreview({
          items: cartItems,
          couponCode: "  free100 ",
          accessToken: mockToken,
          isAuthenticated: true,
          applyingRef: { current: false },
          isSubmittingOrder: false,
          verifySession: () => true,
          openAuthModal: () => {},
          setCouponStatus: (status) => {
            observedStatuses.push(status);
          },
          setAppliedCoupon: () => {},
          setCouponErrorMessage: () => {},
          setCouponCode: () => {},
        });

        // Must transition through validating -> applied
        assert.deepEqual(observedStatuses, ["validating", "applied"]);
        assert.equal(finalState.status, "applied");
        assert.deepEqual(finalState.preview, {
          valid: true,
          couponCode: "FREE100",
          subtotalVnd: 158400,
          discountVnd: 158400,
          totalVnd: 0,
        });

        // Previewing coupon must NEVER call POST /orders
        assert.equal(calledEndpoints.length, 1);
        assert.ok(calledEndpoints[0].endsWith("/coupons/preview"));
        assert.equal(
          calledEndpoints.some((u) => u.endsWith("/orders")),
          false,
          "Coupon preview must NEVER create an Order"
        );

        // Render applied coupon in both cart and review steps:
        // Tạm tính: 158.400 ₫ | Voucher FREE100: -158.400 ₫ | Tổng thanh toán: 0 ₫
        const appliedReviewHtml = renderCartDrawerMarkup({
          items: cartItems,
          initialCheckoutStep: "review",
          couponCode: "FREE100",
          appliedCoupon: finalState.preview,
          couponStatus: "applied",
        });
        assert.ok(appliedReviewHtml.includes('data-coupon-status="applied"'));
        assert.ok(appliedReviewHtml.includes("158.400\u00A0₫"));
        assert.ok(appliedReviewHtml.includes("Voucher FREE100"));
        assert.ok(appliedReviewHtml.includes("-158.400\u00A0₫"));
        assert.ok(appliedReviewHtml.includes("0\u00A0₫"));
        assert.ok(
          appliedReviewHtml.includes('id="btnRemoveCheckoutCoupon"'),
          "Applied coupon must render remove button"
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("handles invalid, expired, not_eligible, usage_limit_exceeded, and backend/network error states while preserving cart", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;
      let cartCleared = false;

      const errorScenarios: Array<{
        coupon: string;
        httpStatus: number;
        body: Record<string, unknown> | "NETWORK_THROW";
        expectedStatus: CouponValidationStatus;
        expectedBannerSubstring: string;
      }> = [
        {
          coupon: "UNKNOWN99",
          httpStatus: 400,
          body: {
            statusCode: 400,
            code: "INVALID_COUPON",
            message: "Coupon does not exist",
          },
          expectedStatus: "invalid",
          expectedBannerSubstring: "không hợp lệ",
        },
        {
          coupon: "EXPIRED10_GENERIC",
          httpStatus: 400,
          body: {
            statusCode: 400,
            code: "INVALID_COUPON",
            message: "Coupon has expired",
          },
          expectedStatus: "invalid",
          expectedBannerSubstring: "không hợp lệ",
        },
        {
          coupon: "EXPIRED10",
          httpStatus: 400,
          body: {
            statusCode: 400,
            code: "INVALID_COUPON",
            reason: "EXPIRED",
            message: "Coupon has expired",
          },
          expectedStatus: "expired",
          expectedBannerSubstring: "đã hết hạn",
        },
        {
          coupon: "GIAM50K",
          httpStatus: 400,
          body: {
            statusCode: 400,
            code: "INVALID_COUPON",
            subcode: "MIN_SUBTOTAL_NOT_MET",
            message: "Order subtotal does not meet coupon minimum",
          },
          expectedStatus: "not_eligible",
          expectedBannerSubstring: "chưa đủ điều kiện áp dụng",
        },
        {
          coupon: "WELCOME20",
          httpStatus: 409,
          body: {
            statusCode: 409,
            code: "COUPON_UNAVAILABLE",
            message: "Coupon usage limit reached",
          },
          expectedStatus: "usage_limit_exceeded",
          expectedBannerSubstring: "hết lượt sử dụng",
        },
        {
          coupon: "WELCOME20",
          httpStatus: 500,
          body: {
            statusCode: 500,
            code: "INTERNAL_ERROR",
            message: "Internal server error",
          },
          expectedStatus: "error",
          expectedBannerSubstring: "Không thể kết nối",
        },
        {
          coupon: "WELCOME20",
          httpStatus: 503,
          body: "NETWORK_THROW",
          expectedStatus: "error",
          expectedBannerSubstring: "Không thể kết nối",
        },
      ];

      try {
        for (const scenario of errorScenarios) {
          globalThis.fetch = async () => {
            if (scenario.body === "NETWORK_THROW") {
              throw new TypeError("Failed to fetch");
            }
            return new Response(JSON.stringify(scenario.body), {
              status: scenario.httpStatus,
              headers: { "Content-Type": "application/json" },
            });
          };

          const state = await executeCouponPreview({
            items: cartItems,
            couponCode: scenario.coupon,
            accessToken: mockToken,
            isAuthenticated: true,
            applyingRef: { current: false },
            isSubmittingOrder: false,
            verifySession: () => true,
            openAuthModal: () => {},
            setCouponStatus: () => {},
            setAppliedCoupon: () => {},
            setCouponErrorMessage: () => {},
            setCouponCode: () => {},
          });

          assert.equal(
            state.status,
            scenario.expectedStatus,
            `Coupon ${scenario.coupon} must classify as ${scenario.expectedStatus}`
          );
          assert.equal(
            state.preview,
            null,
            "Failed coupon validation must never leave an appliedCoupon"
          );
          assert.ok(
            state.errorMessage?.includes(scenario.expectedBannerSubstring),
            `Expected "${state.errorMessage}" to include "${scenario.expectedBannerSubstring}"`
          );

          const html = renderCartDrawerMarkup({
            items: cartItems,
            initialCheckoutStep: "review",
            couponCode: scenario.coupon,
            appliedCoupon: null,
            couponStatus: state.status,
            couponErrorMessage: state.errorMessage,
            couponErrorCode: state.errorCode,
            onClearCart: () => {
              cartCleared = true;
            },
          });
          assert.ok(
            html.includes(`data-coupon-status="${scenario.expectedStatus}"`),
            `Markup must render data-coupon-status="${scenario.expectedStatus}"`
          );
          assert.equal(
            cartCleared,
            false,
            "Cart must NEVER be cleared when coupon validation fails"
          );
        }
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("clears stale discount immediately when coupon is removed/changed and sends couponCode on Create Order without client discountVnd", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;

      const appliedWelcome20: CouponPreviewResponseDto = {
        valid: true,
        couponCode: "WELCOME20",
        subtotalVnd: 118000,
        discountVnd: 23600,
        totalVnd: 94400,
      };

      // 1. While coupon is applied, discount row is rendered
      const htmlWithCoupon = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        couponCode: "WELCOME20",
        appliedCoupon: appliedWelcome20,
        couponStatus: "applied",
      });
      assert.ok(htmlWithCoupon.includes("-23.600\u00A0₫"));
      assert.ok(htmlWithCoupon.includes("94.400\u00A0₫"));

      // 2. After coupon is removed or code is changed, discount row disappears and total returns to 118.000 ₫
      const htmlAfterRemove = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        couponCode: "",
        appliedCoupon: null,
        couponStatus: "idle",
      });
      assert.equal(
        htmlAfterRemove.includes("-23.600\u00A0₫"),
        false,
        "Old discount must NOT remain when coupon is removed/changed"
      );
      assert.ok(htmlAfterRemove.includes("118.000\u00A0₫"));

      // 3. Create Order sends couponCode when coupon is applied, and never sends discountVnd/subtotalVnd/totalVnd
      let capturedCreateOrderBody = null as Record<string, unknown> | null;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedCreateOrderBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        const responseOrder: CreateOrderResponseDto = {
          ...createValidOrderResponse(),
          couponCode: "WELCOME20",
          subtotalVnd: 118000,
          discountVnd: 23600,
          totalVnd: 94400,
        };
        return new Response(JSON.stringify(responseOrder), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      };

      try {
        const submission = await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          submittingRef: { current: false },
          isSubmittingOrder: false,
          setIsSubmittingOrder: () => {},
          setCheckoutStep: () => {},
          setOrderCallOutcome: () => {},
          verifySession: () => true,
          handleUnauthorizedCheckout: () => {},
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(
              cartItems,
              appliedWelcome20.couponCode
            ),
        });

        assert.ok(submission.outcome?.type === "success");
        assert.ok(capturedCreateOrderBody);
        assert.equal(capturedCreateOrderBody.couponCode, "WELCOME20");
        assert.equal("discountVnd" in capturedCreateOrderBody, false);
        assert.equal("subtotalVnd" in capturedCreateOrderBody, false);
        assert.equal("totalVnd" in capturedCreateOrderBody, false);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("uses backend Order snapshot to override cached preview after Create Order, and prompts user to re-apply or remove coupon if backend rejects coupon on Create Order", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;

      // Cached preview had discount 50.000đ -> total 68.000đ,
      // but backend Create Order returns authoritative discount 30.000đ -> total 88.000đ.
      const staleCachedPreview: CouponPreviewResponseDto = {
        valid: true,
        couponCode: "GIAM50K",
        subtotalVnd: 118000,
        discountVnd: 50000,
        totalVnd: 68000,
      };
      const authoritativeBackendOrder: CreateOrderResponseDto = {
        ...createValidOrderResponse(),
        couponCode: "GIAM50K",
        subtotalVnd: 118000,
        discountVnd: 30000,
        totalVnd: 88000,
      };

      const htmlAfterCreateOrder = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        couponCode: "GIAM50K",
        appliedCoupon: staleCachedPreview,
        couponStatus: "applied",
        activeOrder: authoritativeBackendOrder,
        initialOrderOutcome: {
          type: "success",
          order: authoritativeBackendOrder,
        },
      });

      assert.ok(
        htmlAfterCreateOrder.includes("-30.000\u00A0₫") &&
          htmlAfterCreateOrder.includes("88.000\u00A0₫"),
        "UI must render backend Order snapshot (-30.000 ₫ / 88.000 ₫) as authoritative source of truth"
      );
      assert.equal(
        htmlAfterCreateOrder.includes("-50.000\u00A0₫"),
        false,
        "UI must NOT use cached preview discount (-50.000 ₫) after Create Order"
      );

      // Now test when coupon expires right before Create Order -> backend returns 400 INVALID_COUPON
      let couponRejectedMessage: string | null = null;
      let couponRejectedCode: string | null = null;
      let capturedOutcome = null as OrderCallOutcome | null;

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            statusCode: 400,
            code: "INVALID_COUPON",
            message: "Coupon has expired",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );

      try {
        await executeCheckoutOrderSubmission({
          items: cartItems,
          accessToken: mockToken,
          submittingRef: { current: false },
          isSubmittingOrder: false,
          setIsSubmittingOrder: () => {},
          setCheckoutStep: () => {},
          setOrderCallOutcome: (val) => {
            capturedOutcome = val;
          },
          verifySession: () => true,
          handleUnauthorizedCheckout: () => {},
          onCouponRejected: (rejected) => {
            couponRejectedMessage = rejected.message;
            couponRejectedCode = rejected.code;
          },
          mapToCreateOrderPayload: () =>
            buildCreateOrderPayloadFromCart(cartItems, "EXPIRED10"),
        });

        assert.equal(couponRejectedCode, "INVALID_COUPON");
        assert.ok(couponRejectedMessage);
        assert.ok(capturedOutcome && capturedOutcome.type === "error");

        const rejectedOrderHtml = renderCartDrawerMarkup({
          items: cartItems,
          initialCheckoutStep: "review",
          couponCode: "EXPIRED10",
          appliedCoupon: null,
          couponStatus: "expired",
          couponErrorMessage: couponRejectedMessage,
          couponErrorCode: couponRejectedCode,
          initialOrderOutcome: capturedOutcome,
        });
        assert.ok(
          rejectedOrderHtml.includes('id="couponOrderRejectedPrompt"'),
          "Must display #couponOrderRejectedPrompt when backend rejects coupon during Create Order"
        );
        assert.ok(
          rejectedOrderHtml.includes('id="btnErrorModalReapplyCoupon"'),
          "Must offer button to re-apply/change coupon"
        );
        assert.ok(
          rejectedOrderHtml.includes('id="btnErrorModalRemoveCoupon"'),
          "Must offer button to remove coupon"
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("executes ZERO_AMOUNT flow when order.totalVnd = 0 (FREE100): never redirects VNPay, never calls Mock Payment, and never fakes payment success", async () => {
      const mockToken = createValidMockJwt();
      const cartItems = createSampleCartItems();
      const savedFetch = globalThis.fetch;

      const zeroAmountOrder: CreateOrderResponseDto = {
        ...createValidOrderResponse(),
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb99",
        couponCode: "FREE100",
        subtotalVnd: 118000,
        discountVnd: 118000,
        totalVnd: 0,
      };

      // 1. Success modal for totalVnd === 0 renders ZERO_AMOUNT completion CTA (#btnCompleteZeroAmountOrder)
      // and explicitly states that it does NOT go through VNPay
      const zeroModalHtml = renderCartDrawerMarkup({
        items: cartItems,
        initialCheckoutStep: "review",
        activeOrder: zeroAmountOrder,
        initialOrderOutcome: {
          type: "success",
          order: zeroAmountOrder,
        },
      });
      assert.ok(
        zeroModalHtml.includes('id="zeroAmountOrderNotice"'),
        "Zero-amount order modal must display #zeroAmountOrderNotice"
      );
      assert.ok(
        zeroModalHtml.includes('id="btnCompleteZeroAmountOrder"'),
        "Zero-amount order modal must display #btnCompleteZeroAmountOrder"
      );
      assert.ok(
        zeroModalHtml.includes("Không qua cổng VNPay"),
        "Zero-amount order modal must clarify that 0 VND order does not redirect to VNPay"
      );

      // 2. When backend POST /payments/zero-amount fails (or returns non-SUCCESS),
      // frontend must NOT fake payment success and must NOT clear cart!
      const calledUrlsOnFailure: string[] = [];
      let cartClearedOnFailure = false;
      let navigatedUrlOnFailure: string | null = null;
      let capturedZeroError: string | null = null;

      globalThis.fetch = async (input: RequestInfo | URL) => {
        calledUrlsOnFailure.push(String(input));
        return new Response(
          JSON.stringify({
            statusCode: 409,
            code: "PAYMENT_CONFLICT",
            message: "Order is not eligible for zero-amount completion",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const failedResult = await executeZeroAmountOrderCompletion({
          order: zeroAmountOrder,
          accessToken: mockToken,
          submittingRef: { current: false },
          setIsSubmitting: () => {},
          setZeroAmountError: (msg) => {
            capturedZeroError = msg;
          },
          clearCart: () => {
            cartClearedOnFailure = true;
          },
          setActiveOrder: () => {},
          onNavigateSuccess: (url) => {
            navigatedUrlOnFailure = url;
          },
        });

        assert.equal(failedResult.success, false);
        assert.equal(
          cartClearedOnFailure,
          false,
          "Must NEVER clear cart when POST /payments/zero-amount fails"
        );
        assert.equal(
          navigatedUrlOnFailure,
          null,
          "Must NEVER navigate to confirmation or fake payment success when backend rejects"
        );
        assert.ok(capturedZeroError);
        assert.equal(calledUrlsOnFailure.length, 1);
        assert.ok(calledUrlsOnFailure[0].endsWith("/payments/zero-amount"));
        assert.equal(
          calledUrlsOnFailure.some((u) => u.includes("/payments/vnpay/initiate")),
          false,
          "Must NEVER call VNPay initiate for totalVnd = 0"
        );
        assert.equal(
          calledUrlsOnFailure.some((u) => u.endsWith("/payments")),
          false,
          "Must NEVER call Mock Payment POST /payments for totalVnd = 0"
        );

        // 3. When backend POST /payments/zero-amount confirms paymentStatus=SUCCESS and orderStatus=PAID,
        // frontend clears cart and navigates to confirmation
        const calledUrlsOnSuccess: string[] = [];
        let cartClearedOnSuccess = false;
        let navigatedUrlOnSuccess: string | null = null;

        globalThis.fetch = async (input: RequestInfo | URL) => {
          calledUrlsOnSuccess.push(String(input));
          return new Response(
            JSON.stringify({
              paymentId: "771deb4d-3b7d-4bad-9bdd-2b0d7b3dcb77",
              orderId: zeroAmountOrder.id,
              provider: "ZERO_AMOUNT",
              paymentStatus: "SUCCESS",
              orderStatus: "PAID",
              amountVnd: 0,
              pointsEarned: 0,
              createdAt: "2026-11-05T07:00:00.000Z",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        };

        const successResult = await executeZeroAmountOrderCompletion({
          order: zeroAmountOrder,
          accessToken: mockToken,
          submittingRef: { current: false },
          setIsSubmitting: () => {},
          setZeroAmountError: () => {},
          clearCart: () => {
            cartClearedOnSuccess = true;
          },
          setActiveOrder: () => {},
          onNavigateSuccess: (url) => {
            navigatedUrlOnSuccess = url;
          },
        });

        assert.equal(successResult.success, true);
        assert.equal(
          cartClearedOnSuccess,
          true,
          "Cart must be cleared once backend confirms ZERO_AMOUNT payment SUCCESS and order PAID"
        );
        assert.equal(
          navigatedUrlOnSuccess,
          `/order-confirmation?orderId=${encodeURIComponent(zeroAmountOrder.id)}&view=zero`
        );
        assert.equal(calledUrlsOnSuccess.length, 1);
        assert.ok(calledUrlsOnSuccess[0].endsWith("/payments/zero-amount"));
        assert.equal(
          calledUrlsOnSuccess.some((u) => u.includes("/payments/vnpay/initiate")),
          false
        );
        assert.equal(
          calledUrlsOnSuccess.some((u) => u.endsWith("/payments")),
          false
        );
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it("mounted JSDOM: preview pending -> cart changes (quantity update or item removal) -> stale preview response is ignored", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const tokenA = createValidMockJwt(userAId);
      setStoredSession(tokenA, {
        id: userAId,
        email: "usera@brewlite.vn",
        fullName: "Nguyễn Văn A",
      });
      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const authValue: AuthContextType = {
        user: {
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
        },
        accessToken: tokenA,
        isAuthenticated: true,
        isLoading: false,
        login: async () => {},
        register: async () => ({
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => true,
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      };

      const pendingRequests: Array<{
        resolve: (val: CouponPreviewResponseDto) => void;
        signal?: AbortSignal;
      }> = [];

      const mockPreviewFn = (
        _payload: unknown,
        _token?: string | null,
        options?: { signal?: AbortSignal }
      ) =>
        new Promise<CouponPreviewResponseDto>((resolve) => {
          pendingRequests.push({ resolve, signal: options?.signal });
        });

      const setInputValue = (input: HTMLInputElement, val: string) => {
        const prev = input.value;
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, val);
        const tracker = (
          input as unknown as { _valueTracker?: { setValue: (v: string) => void } }
        )._valueTracker;
        tracker?.setValue(prev);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      };

      try {
        await act(async () => {
          root = createRoot(container);
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authValue },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                  previewCouponFn: mockPreviewFn,
                })
              )
            )
          );
        });

        await act(async () => {
          cartCtxRef.current?.openCart();
        });

        const couponInput = container.querySelector(
          "#checkoutCouponInput"
        ) as HTMLInputElement;
        const applyBtn = container.querySelector(
          "#btnApplyCheckoutCoupon"
        ) as HTMLButtonElement;
        assert.ok(couponInput, "Must mount #checkoutCouponInput in JSDOM");
        assert.ok(applyBtn, "Must mount #btnApplyCheckoutCoupon in JSDOM");

        // 1. User types WELCOME20 and clicks Apply -> request 1 is pending
        await act(async () => {
          setInputValue(couponInput, "WELCOME20");
        });
        await act(async () => {
          applyBtn.click();
        });

        assert.equal(pendingRequests.length, 1);
        assert.ok(
          container
            .querySelector("#checkoutCouponStatusBanner")
            ?.getAttribute("data-coupon-status") === "validating",
          "Coupon box must be in validating state while preview is pending"
        );

        // 2. While preview is pending, user changes item quantity (qty 2 -> 3)
        await act(async () => {
          cartCtxRef.current?.incrementQuantity("cart-line-1");
        });

        assert.equal(
          pendingRequests[0].signal?.aborted,
          true,
          "Changing cart quantity must abort the pending coupon preview request"
        );
        assert.equal(
          container
            .querySelector("#checkoutCouponStatusBanner")
            ?.getAttribute("data-coupon-status"),
          "idle",
          "Coupon status must reset to idle immediately when cart changes"
        );

        // 3. Stale response for the old 2-item cart arrives late -> must be ignored
        await act(async () => {
          pendingRequests[0].resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 118000,
            discountVnd: 23600,
            totalVnd: 94400,
          });
        });

        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Stale preview response after quantity change must NOT set appliedCoupon in CartContext"
        );
        assert.equal(
          container
            .querySelector("#checkoutCouponStatusBanner")
            ?.getAttribute("data-coupon-status"),
          "idle",
          "Stale preview response after quantity change must NOT transition UI to applied"
        );
        const drawerTextAfterQtyChange = container.textContent ?? "";
        assert.equal(
          drawerTextAfterQtyChange.includes("-23.600"),
          false,
          "Stale discount (-23.600 ₫) must NOT be rendered after cart quantity changed"
        );
        assert.ok(
          drawerTextAfterQtyChange.includes("177.000"),
          "Updated cart subtotal/total (3 x 59.000 = 177.000 ₫) must be rendered"
        );

        // 4. Start another preview and remove item while pending -> stale response is also ignored
        await act(async () => {
          applyBtn.click();
        });
        assert.equal(pendingRequests.length, 2);

        await act(async () => {
          cartCtxRef.current?.removeFromCart("cart-line-1");
        });
        assert.equal(
          pendingRequests[1].signal?.aborted,
          true,
          "Removing cart item must abort the pending coupon preview request"
        );

        await act(async () => {
          pendingRequests[1].resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 177000,
            discountVnd: 35400,
            totalVnd: 141600,
          });
        });

        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Stale preview response after item removal must NOT set appliedCoupon"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });

    it("mounted JSDOM: preview pending -> logout or user switch (User A -> User B) -> stale response is ignored and User A coupon/cart is isolated from User B", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const userBId = "660e8400-e29b-41d4-a716-446655440999";
      const tokenA = createValidMockJwt(userAId);
      const tokenB = createValidMockJwt(userBId);

      setStoredSession(tokenA, {
        id: userAId,
        email: "usera@brewlite.vn",
        fullName: "Nguyễn Văn A",
      });
      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const makeAuthValue = (
        userId: string | null,
        token: string | null
      ): AuthContextType => ({
        user: userId
          ? {
              id: userId,
              email: `${userId}@brewlite.vn`,
              fullName: userId === userAId ? "Nguyễn Văn A" : "Trần Thị B",
            }
          : null,
        accessToken: token,
        isAuthenticated: Boolean(userId && token),
        isLoading: false,
        login: async () => {},
        register: async () => ({
          id: userId ?? "",
          email: "test@brewlite.vn",
          fullName: "Test",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => Boolean(userId && token),
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      });

      const pendingRequests: Array<{
        resolve: (val: CouponPreviewResponseDto) => void;
        signal?: AbortSignal;
      }> = [];

      const mockPreviewFn = (
        _payload: unknown,
        _token?: string | null,
        options?: { signal?: AbortSignal }
      ) =>
        new Promise<CouponPreviewResponseDto>((resolve) => {
          pendingRequests.push({ resolve, signal: options?.signal });
        });

      const renderWithAuth = async (authVal: AuthContextType) => {
        await act(async () => {
          if (!root) {
            root = createRoot(container);
          }
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authVal },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                  previewCouponFn: mockPreviewFn,
                })
              )
            )
          );
        });
      };

      const setInputValue = (input: HTMLInputElement, val: string) => {
        const prev = input.value;
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, val);
        const tracker = (
          input as unknown as { _valueTracker?: { setValue: (v: string) => void } }
        )._valueTracker;
        tracker?.setValue(prev);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      };

      try {
        // 1. Mount as User A with cart items and start a pending preview for WELCOME20
        await renderWithAuth(makeAuthValue(userAId, tokenA));
        await act(async () => {
          cartCtxRef.current?.openCart();
        });

        const couponInput = container.querySelector(
          "#checkoutCouponInput"
        ) as HTMLInputElement;
        const applyBtn = container.querySelector(
          "#btnApplyCheckoutCoupon"
        ) as HTMLButtonElement;
        assert.ok(couponInput && applyBtn);

        await act(async () => {
          setInputValue(couponInput, "WELCOME20");
        });
        await act(async () => {
          applyBtn.click();
        });
        assert.equal(pendingRequests.length, 1);

        // 2. While User A's preview is pending, User A logs out (auth -> null)
        clearStoredSession();
        await renderWithAuth(makeAuthValue(null, null));

        assert.equal(
          pendingRequests[0].signal?.aborted,
          true,
          "Logging out must abort User A's pending coupon preview request"
        );
        assert.equal(
          cartCtxRef.current?.couponCode,
          "",
          "Logging out must clear couponCode"
        );
        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Logging out must clear appliedCoupon"
        );
        assert.equal(
          cartCtxRef.current?.items.length,
          0,
          "Logging out must clear User A's cart so next user/guest does not reuse User A's cart"
        );

        // 3. User A's delayed preview response resolves after logout -> must be ignored
        await act(async () => {
          pendingRequests[0].resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 118000,
            discountVnd: 23600,
            totalVnd: 94400,
          });
        });

        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Delayed response from User A must NEVER apply after logout"
        );
        assert.equal(
          (container.textContent ?? "").includes("-23.600"),
          false,
          "Delayed response from User A must NEVER render discount after logout"
        );

        // 4. Now test User A (with applied coupon & cart) switching directly to User B (A -> B)
        setStoredSession(tokenA, {
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
        });
        await renderWithAuth(makeAuthValue(userAId, tokenA));

        await act(async () => {
          cartCtxRef.current?.addToCart(createSampleCartItems()[0]);
          cartCtxRef.current?.openCart();
        });
        assert.equal(cartCtxRef.current?.items.length, 1);

        const cartCouponInput = (container.querySelector("#checkoutCouponInput") ??
          container.querySelector("#couponCodeInput")) as HTMLInputElement;
        const cartApplyBtn = (container.querySelector("#btnApplyCheckoutCoupon") ??
          container.querySelector("#btnApplyVoucher")) as HTMLButtonElement;
        assert.ok(cartCouponInput && cartApplyBtn);

        await act(async () => {
          setInputValue(cartCouponInput, "WELCOME20");
        });
        await act(async () => {
          cartApplyBtn.click();
        });
        assert.equal(pendingRequests.length, 2);

        // Switch directly from User A to User B while preview #2 is pending
        setStoredSession(tokenB, {
          id: userBId,
          email: "userb@brewlite.vn",
          fullName: "Trần Thị B",
        });
        await renderWithAuth(makeAuthValue(userBId, tokenB));

        assert.equal(
          pendingRequests[1].signal?.aborted,
          true,
          "Switching from User A to User B must abort User A's pending preview"
        );
        assert.equal(
          cartCtxRef.current?.items.length,
          0,
          "User B must NOT inherit User A's cart items"
        );
        assert.equal(
          cartCtxRef.current?.couponCode,
          "",
          "User B must NOT inherit User A's couponCode"
        );
        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "User B must NOT inherit User A's appliedCoupon"
        );

        // Resolve User A's pending preview after User B is active -> must be ignored
        await act(async () => {
          pendingRequests[1].resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 118000,
            discountVnd: 23600,
            totalVnd: 94400,
          });
        });

        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "User A's stale preview response must NEVER set appliedCoupon on User B's session"
        );
        assert.equal(
          (container.textContent ?? "").includes("-23.600"),
          false,
          "User A's stale discount must NEVER render in User B's UI"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });

    it("mounted JSDOM: coupon A request -> coupon B request -> late coupon A response never overwrites coupon B", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const tokenA = createValidMockJwt(userAId);
      setStoredSession(tokenA, {
        id: userAId,
        email: "usera@brewlite.vn",
        fullName: "Nguyễn Văn A",
      });
      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const authValue: AuthContextType = {
        user: {
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
        },
        accessToken: tokenA,
        isAuthenticated: true,
        isLoading: false,
        login: async () => {},
        register: async () => ({
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => true,
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      };

      const pendingByCode = new Map<
        string,
        {
          resolve: (val: CouponPreviewResponseDto) => void;
          signal?: AbortSignal;
        }
      >();

      const mockPreviewFn = (
        rawPayload: unknown,
        _token?: string | null,
        options?: { signal?: AbortSignal }
      ) => {
        const code = String(
          (rawPayload as Record<string, unknown>)?.couponCode ?? ""
        );
        return new Promise<CouponPreviewResponseDto>((resolve) => {
          pendingByCode.set(code, { resolve, signal: options?.signal });
        });
      };

      const setInputValue = (input: HTMLInputElement, val: string) => {
        const prev = input.value;
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, val);
        const tracker = (
          input as unknown as { _valueTracker?: { setValue: (v: string) => void } }
        )._valueTracker;
        tracker?.setValue(prev);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      };

      try {
        await act(async () => {
          root = createRoot(container);
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authValue },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                  previewCouponFn: mockPreviewFn,
                })
              )
            )
          );
        });

        await act(async () => {
          cartCtxRef.current?.openCart();
        });

        const couponInput = container.querySelector(
          "#checkoutCouponInput"
        ) as HTMLInputElement;
        const applyBtn = container.querySelector(
          "#btnApplyCheckoutCoupon"
        ) as HTMLButtonElement;
        assert.ok(couponInput && applyBtn);

        // 1. User enters Coupon A (WELCOME20) and clicks Apply -> Request A is in-flight
        await act(async () => {
          setInputValue(couponInput, "WELCOME20");
        });
        await act(async () => {
          applyBtn.click();
        });
        const reqA = pendingByCode.get("WELCOME20");
        assert.ok(reqA, "Request A (WELCOME20) must be started");

        // 2. While Request A is still pending, user switches input to Coupon B (GIAM50K) and clicks Apply
        await act(async () => {
          setInputValue(couponInput, "GIAM50K");
        });
        assert.equal(
          reqA.signal?.aborted,
          true,
          "Changing coupon code from WELCOME20 to GIAM50K must abort Request A"
        );

        await act(async () => {
          applyBtn.click();
        });
        const reqB = pendingByCode.get("GIAM50K");
        assert.ok(reqB, "Request B (GIAM50K) must be started");

        // 3. Request B resolves first with -50.000 ₫ (total 68.000 ₫)
        await act(async () => {
          reqB.resolve({
            valid: true,
            couponCode: "GIAM50K",
            subtotalVnd: 118000,
            discountVnd: 50000,
            totalVnd: 68000,
          });
        });

        assert.equal(cartCtxRef.current?.appliedCoupon?.couponCode, "GIAM50K");
        assert.equal(cartCtxRef.current?.appliedCoupon?.discountVnd, 50000);
        assert.ok((container.textContent ?? "").includes("Voucher GIAM50K"));
        assert.ok((container.textContent ?? "").includes("-50.000"));
        assert.ok((container.textContent ?? "").includes("68.000"));

        // 4. Late Request A (WELCOME20, -23.600 ₫, total 94.400 ₫) resolves AFTER Request B -> must NOT overwrite B!
        await act(async () => {
          reqA.resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 118000,
            discountVnd: 23600,
            totalVnd: 94400,
          });
        });

        assert.equal(
          cartCtxRef.current?.appliedCoupon?.couponCode,
          "GIAM50K",
          "Late response A (WELCOME20) must NEVER overwrite applied coupon B (GIAM50K)"
        );
        assert.equal(
          cartCtxRef.current?.appliedCoupon?.discountVnd,
          50000,
          "Discount must remain 50.000 ₫ from coupon B"
        );
        const finalText = container.textContent ?? "";
        assert.ok(
          finalText.includes("Voucher GIAM50K") &&
            finalText.includes("-50.000") &&
            finalText.includes("68.000"),
          "UI must continue displaying Voucher GIAM50K (-50.000 ₫ / 68.000 ₫)"
        );
        assert.equal(
          finalText.includes("Voucher WELCOME20") || finalText.includes("-23.600"),
          false,
          "UI must NOT display stale Voucher WELCOME20 or -23.600 ₫"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });

    it("mounted JSDOM: reload app with AuthProvider initially loading (isLoading=true) -> restores User A -> cart of User A remains intact without premature wipe", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const tokenA = createValidMockJwt(userAId);
      const sampleItems = createSampleCartItems();

      // Giả lập trạng thái trước khi reload: User A đã có cart trong localStorage
      localStorageMock.setItem("brewlite_cart_v1", JSON.stringify(sampleItems));
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);
      localStorageMock.setItem(
        `brewlite_cart_user_${userAId.toLowerCase()}`,
        JSON.stringify(sampleItems)
      );

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const makeAuthValue = (
        userId: string | null,
        token: string | null,
        isLoading: boolean
      ): AuthContextType => ({
        user: userId
          ? {
              id: userId,
              email: `${userId}@brewlite.vn`,
              fullName: "Nguyễn Văn A",
            }
          : null,
        accessToken: token,
        isAuthenticated: Boolean(userId && token),
        isLoading,
        login: async () => {},
        register: async () => ({
          id: userId ?? "",
          email: "test@brewlite.vn",
          fullName: "Test",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => Boolean(userId && token),
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      });

      const renderWithAuth = async (authVal: AuthContextType) => {
        await act(async () => {
          if (!root) {
            root = createRoot(container);
          }
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authVal },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                })
              )
            )
          );
        });
      };

      try {
        // 1. App vừa reload: AuthProvider bắt đầu với isLoading = true, user = null, accessToken = null
        await renderWithAuth(makeAuthValue(null, null, true));

        // Trong lúc auth đang loading, CartContext KHÔNG được vội vàng coi là guest và xóa sạch cart của User A trong localStorage!
        assert.ok(
          localStorageMock.getItem("brewlite_cart_v1") !== "[]",
          "localStorage must NOT be wiped with [] while AuthProvider is isLoading=true"
        );
        assert.equal(
          localStorageMock.getItem(CART_OWNER_STORAGE_KEY),
          userAId,
          "CART_OWNER_STORAGE_KEY must remain userAId while AuthProvider is loading"
        );

        // 2. AuthProvider hoàn tất khôi phục session (isLoading = false, user = User A)
        await renderWithAuth(makeAuthValue(userAId, tokenA, false));

        // Cart của User A phải được khôi phục nguyên vẹn 100%!
        assert.ok(cartCtxRef.current, "CartContext must be mounted");
        assert.equal(
          cartCtxRef.current?.items.length,
          sampleItems.length,
          "Cart of User A must remain intact after session restore"
        );
        assert.equal(
          cartCtxRef.current?.items[0].productName,
          sampleItems[0].productName,
          "First item of User A cart must match sample item"
        );
        assert.equal(
          cartCtxRef.current?.totalQuantity,
          2,
          "Total quantity of User A cart must be preserved"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });

    it("mounted JSDOM: real race window test: mutate cart and resolve preview in the same act/microtask before passive effect -> stale preview & stale error responses are completely ignored", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const tokenA = createValidMockJwt(userAId);

      setStoredSession(tokenA, {
        id: userAId,
        email: "usera@brewlite.vn",
        fullName: "Nguyễn Văn A",
      });
      localStorageMock.setItem(
        "brewlite_cart_v1",
        JSON.stringify(createSampleCartItems())
      );
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const authValue: AuthContextType = {
        user: {
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
        },
        accessToken: tokenA,
        isAuthenticated: true,
        isLoading: false,
        login: async () => {},
        register: async () => ({
          id: userAId,
          email: "usera@brewlite.vn",
          fullName: "Nguyễn Văn A",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => true,
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      };

      const pendingList: Array<{
        resolve: (val: CouponPreviewResponseDto) => void;
        reject: (err: unknown) => void;
        signal?: AbortSignal;
      }> = [];

      const mockPreviewFn = (
        _payload: unknown,
        _token?: string | null,
        options?: { signal?: AbortSignal }
      ) =>
        new Promise<CouponPreviewResponseDto>((resolve, reject) => {
          pendingList.push({ resolve, reject, signal: options?.signal });
        });

      const setInputValue = (input: HTMLInputElement, val: string) => {
        const prev = input.value;
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, val);
        const tracker = (
          input as unknown as { _valueTracker?: { setValue: (v: string) => void } }
        )._valueTracker;
        tracker?.setValue(prev);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      };

      try {
        await act(async () => {
          root = createRoot(container);
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authValue },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                  previewCouponFn: mockPreviewFn,
                })
              )
            )
          );
        });

        await act(async () => {
          cartCtxRef.current?.openCart();
        });

        const couponInput = container.querySelector(
          "#checkoutCouponInput"
        ) as HTMLInputElement;
        const applyBtn = container.querySelector(
          "#btnApplyCheckoutCoupon"
        ) as HTMLButtonElement;
        assert.ok(couponInput && applyBtn);

        // 1. Bắt đầu preview WELCOME20
        await act(async () => {
          setInputValue(couponInput, "WELCOME20");
        });
        await act(async () => {
          applyBtn.click();
        });
        assert.equal(pendingList.length, 1);
        const req1 = pendingList[0];

        // 2. Real race window: Trong cùng một act, gọi mutate giỏ hàng và resolve preview ngay lập tức
        // trước khi bất kỳ passive effect nào của CartDrawer có cơ hội chạy
        await act(async () => {
          // Invalidate xảy ra đồng bộ ngay tại đây!
          cartCtxRef.current?.incrementQuantity("cart-line-1");
          // Response cũ trả về ngay sau mutation
          req1.resolve({
            valid: true,
            couponCode: "WELCOME20",
            subtotalVnd: 118000,
            discountVnd: 23600,
            totalVnd: 94400,
          });
        });

        // Kết quả: response cũ bị drop hoàn toàn! Không có applied coupon nào được commit
        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Stale response resolved in same act/tick as mutation must NOT commit discount"
        );
        assert.equal(
          container.querySelector("#checkoutCouponStatusBanner")?.getAttribute("data-coupon-status"),
          "idle",
          "Status must remain idle, never transition to applied from stale response"
        );

        // 3. Stale error response protection:
        // Bắt đầu preview thứ hai
        await act(async () => {
          applyBtn.click();
        });
        assert.equal(pendingList.length, 2);
        const req2 = pendingList[1];

        // Mutate cart và reject với 400 INVALID_COUPON trong cùng act
        await act(async () => {
          cartCtxRef.current?.decrementQuantity("cart-line-1");
          const errorObj = new Error("Mã ưu đãi không hợp lệ.");
          (errorObj as unknown as { response: { status: number; data: unknown } }).response = {
            status: 400,
            data: {
              code: "INVALID_COUPON",
              message: "Mã ưu đãi đã hết hạn hoặc không tồn tại.",
            },
          };
          req2.reject(errorObj);
        });

        // Stale error response cũng phải bị drop hoàn toàn, không được ghi đè state mới!
        assert.equal(
          cartCtxRef.current?.couponStatus,
          "idle",
          "Stale error response must NOT overwrite new idle coupon state"
        );
        assert.equal(
          cartCtxRef.current?.couponErrorMessage,
          null,
          "Stale error response must NOT overwrite couponErrorMessage"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });

    it("mounted JSDOM: scoped cart persistence across logout & login: User A cart is preserved scoped, User B gets isolated empty cart, User A logs back in and restores original cart", async () => {
      const userAId = "550e8400-e29b-41d4-a716-446655440000";
      const userBId = "660e8400-e29b-41d4-a716-446655440999";
      const tokenA = createValidMockJwt(userAId);
      const tokenB = createValidMockJwt(userBId);

      const sampleItems = createSampleCartItems();
      localStorageMock.setItem(
        `brewlite_cart_user_${userAId.toLowerCase()}`,
        JSON.stringify(sampleItems)
      );
      localStorageMock.setItem("brewlite_cart_v1", JSON.stringify(sampleItems));
      localStorageMock.setItem(CART_OWNER_STORAGE_KEY, userAId);

      const dom = new JSDOM(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        { url: "http://localhost:3000" }
      );
      const g = globalThis as Record<string, unknown>;
      const savedWindow = g.window;
      const savedDocument = g.document;
      const savedSelf = g.self;
      const savedActEnv = g.IS_REACT_ACT_ENVIRONMENT;

      g.window = dom.window;
      g.document = dom.window.document;
      g.self = dom.window;
      g.HTMLElement = dom.window.HTMLElement;
      g.HTMLInputElement = dom.window.HTMLInputElement;
      g.HTMLButtonElement = dom.window.HTMLButtonElement;
      g.Element = dom.window.Element;
      g.Node = dom.window.Node;
      g.Event = dom.window.Event;
      g.InputEvent = dom.window.InputEvent;
      g.MouseEvent = dom.window.MouseEvent;
      g.IS_REACT_ACT_ENVIRONMENT = true;
      Object.defineProperty(dom.window, "localStorage", { value: localStorageMock, configurable: true });
      Object.defineProperty(dom.window, "sessionStorage", { value: sessionStorageMock, configurable: true });

      const container = dom.window.document.getElementById("root") as HTMLDivElement;
      let root: Root | null = null;
      const cartCtxRef: { current: CartContextValue | null } = { current: null };

      function CartInspector() {
        cartCtxRef.current = useCart();
        return null;
      }

      const makeAuthValue = (
        userId: string | null,
        token: string | null
      ): AuthContextType => ({
        user: userId
          ? {
              id: userId,
              email: `${userId}@brewlite.vn`,
              fullName: userId === userAId ? "Nguyễn Văn A" : "Trần Thị B",
            }
          : null,
        accessToken: token,
        isAuthenticated: Boolean(userId && token),
        isLoading: false,
        login: async () => {},
        register: async () => ({
          id: userId ?? "",
          email: "test@brewlite.vn",
          fullName: "Test",
          createdAt: "2026-10-26T15:00:00.000Z",
        }),
        logout: () => {},
        verifySession: () => Boolean(userId && token),
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
      });

      const renderWithAuth = async (authVal: AuthContextType) => {
        await act(async () => {
          if (!root) {
            root = createRoot(container);
          }
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: authVal },
              React.createElement(
                CartProvider,
                null,
                React.createElement(CartInspector),
                React.createElement(CartDrawer, {
                  initialCheckoutStep: "review",
                })
              )
            )
          );
        });
      };

      try {
        // 1. Mount ban đầu với User A: Cart của User A được nạp đúng
        await renderWithAuth(makeAuthValue(userAId, tokenA));
        assert.equal(cartCtxRef.current?.items.length, sampleItems.length);

        // 2. User A logout -> auth chuyển sang null
        await renderWithAuth(makeAuthValue(null, null));

        // Khi logout, coupon bị xóa và cart active hiện tại chuyển sang cart guest (rỗng),
        // NHƯNG cart của User A trong scoped storage key của A KHÔNG bị xóa bừa!
        assert.equal(
          cartCtxRef.current?.couponCode,
          "",
          "Logout must clear couponCode"
        );
        assert.equal(
          cartCtxRef.current?.appliedCoupon,
          null,
          "Logout must clear appliedCoupon"
        );
        assert.ok(
          localStorageMock.getItem(`brewlite_cart_user_${userAId.toLowerCase()}`) !== "[]",
          "User A's scoped cart in localStorage must NOT be destroyed on logout"
        );

        // 3. User B đăng nhập -> User B chỉ thấy giỏ hàng của B (chưa có gì = rỗng), không thừa hưởng của User A!
        await renderWithAuth(makeAuthValue(userBId, tokenB));
        assert.equal(
          cartCtxRef.current?.items.length,
          0,
          "User B must have an isolated empty cart, never inheriting User A's cart"
        );

        // 4. User B thêm 1 món riêng vào giỏ hàng
        await act(async () => {
          cartCtxRef.current?.addToCart({
            productId: "770e8400-e29b-41d4-a716-446655440111",
            productName: "Trà Đào Cam Sả (User B)",
            size: "M",
            sizeMultiplierPercent: 120,
            basePriceVnd: 45000,
            quantity: 1,
          });
        });
        assert.equal(cartCtxRef.current?.items.length, 1);
        assert.equal(cartCtxRef.current?.items[0].productName, "Trà Đào Cam Sả (User B)");

        // 5. User B logout và User A đăng nhập lại -> User A khôi phục lại nguyên vẹn giỏ hàng cũ của mình!
        await renderWithAuth(makeAuthValue(null, null));
        await renderWithAuth(makeAuthValue(userAId, tokenA));

        assert.equal(
          cartCtxRef.current?.items.length,
          sampleItems.length,
          "User A logs back in and restores original cart items intact"
        );
        assert.equal(
          cartCtxRef.current?.items[0].productName,
          sampleItems[0].productName,
          "User A first product name must be Cà Phê Sữa Đá Sài Gòn"
        );
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        g.window = savedWindow;
        g.document = savedDocument;
        g.self = savedSelf;
        g.IS_REACT_ACT_ENVIRONMENT = savedActEnv;
      }
    });
  });
});
