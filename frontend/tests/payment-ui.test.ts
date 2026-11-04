import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import PaymentPageView, {
  executePaymentSubmission,
  type ExecutePaymentSubmissionDeps,
} from "@/components/PaymentPageView";
import { AuthContext, type AuthContextType } from "@/context/AuthContext";
import { CartContext, type CartContextValue } from "@/context/CartContext";
import type {
  MyOrderDto,
  OrderStatus,
  PaymentResponseDto,
  PaymentSubmissionErrorState,
} from "@/mock-data";
import {
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
  getStoredToken,
} from "@/services/auth.service";
import {
  buildCreatePaymentPayload,
  fetchMyOrdersApi,
  generateIdempotencyKey,
  isOrderExpired,
  isOrderPayable,
  isOrderPayableStatus,
  validateMyOrdersResponse,
  selectTargetOrderFromMyOrders,
  submitPaymentApi,
  toPaymentSubmissionErrorState,
  validateCreatePaymentPayload,
  validateIdempotencyKey,
  validatePaymentResponseData,
  type SubmitPaymentApiResult,
} from "@/services/payment.service";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const localStorageMock = new MemoryStorage();
const sessionStorageMock = new MemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "sessionStorage", {
  value: sessionStorageMock,
  configurable: true,
  writable: true,
});

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

function createSampleOrderSnapshot(
  status: OrderStatus = "PENDING"
): MyOrderDto {
  const now = Date.now();
  return {
    id: "550e8400-e29b-41d4-a716-446655440010",
    status,
    createdAt: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 14 * 60 * 1000).toISOString(),
    pointsEarned: 0,
    payment: null,
    subtotalVnd: 118000,
    discountVnd: 20000,
    totalVnd: 98000,
    couponCode: "WELCOME20",
    items: [
      {
        id: "550e8400-e29b-41d4-a716-446655440011",
        productId: "a1000000-0000-4000-8000-000000000001",
        productName: "Cà phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 30000,
        quantity: 1,
        unitPriceVnd: 46000,
        lineTotalVnd: 46000,
        toppings: [
          {
            id: "7d44a44c-8d1a-4af3-98cb-90e5d4c8a001",
            name: "Thạch Cà Phê",
            priceVnd: 10000,
          },
        ],
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440012",
        productId: "a2000000-0000-4000-8000-000000000002",
        productName: "Cold Brew Cam Sả",
        size: "L",
        sizeMultiplierPercent: 140,
        basePriceVnd: 43000,
        quantity: 1,
        unitPriceVnd: 72000,
        lineTotalVnd: 72000,
        toppings: [
          {
            id: "7d44a44c-8d1a-4af3-98cb-90e5d4c8a002",
            name: "Kem Cheese",
            priceVnd: 12000,
          },
        ],
      },
    ],
  };
}

function createSubmissionHarness(
  overrides: Partial<ExecutePaymentSubmissionDeps> = {}
) {
  const order =
    overrides.activeOrder !== undefined
      ? overrides.activeOrder
      : createSampleOrderSnapshot("PENDING");
  const token =
    overrides.accessToken !== undefined
      ? overrides.accessToken
      : createValidMockJwt();

  let isSubmittingState = overrides.isSubmitting ?? false;
  let idempotencyKeyState =
    overrides.idempotencyKey ?? "idem-initial-12345678";
  let lastPayloadJson = "";
  let paymentResultState: PaymentResponseDto | null = null;
  let isReplayedState = false;
  let orderStatusState: OrderStatus =
    (overrides.orderStatus as OrderStatus) ?? order?.status ?? "PENDING";
  let isResultModalOpenState = false;
  let paymentErrorState: PaymentSubmissionErrorState | null = null;
  let clearCartCount = 0;
  let clearedContextActiveOrder = false;
  let pointsAdded = 0;
  const authModalCalls: Array<{
    mode?: "login" | "register";
    reasonMessage?: string;
  }> = [];

  const submittingRef = overrides.submittingRef ?? {
    current: isSubmittingState,
  };

  const deps: ExecutePaymentSubmissionDeps = {
    activeOrder: order,
    orderStatus: orderStatusState,
    payload:
      overrides.payload ??
      buildCreatePaymentPayload({
        orderId: order?.id || "550e8400-e29b-41d4-a716-446655440010",
        method: "CARD",
        cardNumber: "1234567890121234",
      }),
    idempotencyKey: idempotencyKeyState,
    reuseExistingKey: overrides.reuseExistingKey ?? false,
    accessToken: token,
    isAuthenticated: overrides.isAuthenticated ?? true,
    verifySession: overrides.verifySession ?? (() => true),
    openAuthModal:
      overrides.openAuthModal ??
      ((mode, opts) => {
        authModalCalls.push({ mode, reasonMessage: opts?.reasonMessage });
      }),
    submittingRef,
    isSubmitting: isSubmittingState,
    setIsSubmitting: (val) => {
      isSubmittingState = val;
    },
    setIdempotencyKey: (key) => {
      idempotencyKeyState = key;
    },
    setLastSubmittedPayloadJson: (json) => {
      lastPayloadJson = json;
    },
    setPaymentResult: (res) => {
      paymentResultState = res;
    },
    setIsReplayedResult: (rep) => {
      isReplayedState = rep;
    },
    setOrderStatus: (st) => {
      orderStatusState = st;
    },
    setIsResultModalOpen: (open) => {
      isResultModalOpenState = open;
    },
    setPaymentError: (err) => {
      paymentErrorState = err;
    },
    clearCart: () => {
      clearCartCount += 1;
    },
    setContextActiveOrder: (nextOrder) => {
      if (nextOrder === null) {
        clearedContextActiveOrder = true;
      }
    },
    onPointsEarned: (pts) => {
      pointsAdded += pts;
    },
    submitPaymentFn: overrides.submitPaymentFn,
  };

  return {
    deps,
    getState: () => ({
      isSubmitting: isSubmittingState,
      submittingRefCurrent: submittingRef.current,
      idempotencyKey: idempotencyKeyState,
      lastPayloadJson,
      paymentResult: paymentResultState,
      isReplayed: isReplayedState,
      orderStatus: orderStatusState,
      isResultModalOpen: isResultModalOpenState,
      paymentError: paymentErrorState,
      clearCartCount,
      clearedContextActiveOrder,
      pointsAdded,
      authModalCalls,
    }),
  };
}

function renderPaymentMarkup(
  props: React.ComponentProps<typeof PaymentPageView> = {}
): string {
  const order =
    props.initialOrder === undefined
      ? createSampleOrderSnapshot()
      : props.initialOrder;

  const cartValue: CartContextValue = {
    items: [],
    totalQuantity: 0,
    totalLines: 0,
    subtotalVnd: 0,
    formattedSubtotal: "0 ₫",
    isCartOpen: false,
    couponCode: "",
    setCouponCode: () => {},
    feedbackMessage: null,
    feedbackType: null,
    addToCart: () => ({ success: true, message: "OK" }),
    updateQuantity: () => {},
    incrementQuantity: () => {},
    decrementQuantity: () => {},
    removeFromCart: () => {},
    clearCart: () => {},
    openCart: () => {},
    closeCart: () => {},
    toggleCart: () => {},
    dismissFeedback: () => {},
    mapToCreateOrderPayload: () => ({ items: [] }),
    activeOrder: order,
  };

  const authValue: AuthContextType = {
    user: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "haidang@brewlite.vn",
      fullName: "Nguyễn Hải Đăng",
    },
    accessToken: createValidMockJwt(),
    isAuthenticated: true,
    isLoading: false,
    login: async () => {},
    register: async () => ({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "haidang@brewlite.vn",
      fullName: "Nguyễn Hải Đăng",
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

  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      AuthContext.Provider,
      { value: authValue },
      React.createElement(
        CartContext.Provider,
        { value: cartValue },
        React.createElement(PaymentPageView, {
          ...props,
          initialOrder: order,
        })
      )
    )
  );
}

describe("SCRUM-67 Payment UI & Real API Integration (POST /payments & GET /orders/me — Contract v3.0)", () => {
  beforeEach(() => {
    localStorageMock.clear();
    sessionStorageMock.clear();
  });

  it("1. builds and validates strict CARD and WALLET payloads & Idempotency-Key constraints per API Contract v3.0 §3.1-3.2", () => {
    const cardPayload = buildCreatePaymentPayload({
      orderId: "  550E8400-E29B-41D4-A716-446655440010 ",
      method: "CARD",
      cardNumber: "1234567890121234",
      phoneNumber: "0912345678",
    });

    assert.deepEqual(cardPayload, {
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      method: "CARD",
      paymentDetails: { cardNumber: "1234567890121234" },
    });
    assert.equal("phoneNumber" in cardPayload.paymentDetails, false);
    assert.equal(
      "userId" in (cardPayload as unknown as Record<string, unknown>),
      false
    );
    assert.equal(
      "amountVnd" in (cardPayload as unknown as Record<string, unknown>),
      false
    );

    const walletPayload = buildCreatePaymentPayload({
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      method: "WALLET",
      cardNumber: "1234567890121234",
      phoneNumber: "0912345678",
    });

    assert.deepEqual(walletPayload, {
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      method: "WALLET",
      paymentDetails: { phoneNumber: "0912345678" },
    });
    assert.equal("cardNumber" in walletPayload.paymentDetails, false);

    // Reject invalid lengths or mismatched paymentDetails
    assert.equal(
      validateCreatePaymentPayload({
        orderId: "550e8400-e29b-41d4-a716-446655440010",
        method: "CARD",
        paymentDetails: { cardNumber: "12345" },
      }).isValid,
      false
    );
    assert.equal(
      validateCreatePaymentPayload({
        orderId: "550e8400-e29b-41d4-a716-446655440010",
        method: "WALLET",
        paymentDetails: { phoneNumber: "09123" },
      }).isValid,
      false
    );

    // Idempotency-Key constraints: 8..64 chars
    const generatedKey = generateIdempotencyKey("idem");
    assert.equal(validateIdempotencyKey(generatedKey).isValid, true);
    assert.equal(validateIdempotencyKey("short7").isValid, false);
    assert.equal(validateIdempotencyKey("a".repeat(65)).isValid, false);
  });

  it("2. calls real POST /payments (SUCCESS -> PAID) and GET /orders/me APIs, clearing Cart and updating points on SUCCESS", async () => {
    const token = createValidMockJwt();
    const idemKey = generateIdempotencyKey("idem");

    const savedFetch = globalThis.fetch;
    try {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: unknown = null;

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const url = String(input);
        capturedHeaders = (init?.headers || {}) as Record<string, string>;
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;

        if (url.endsWith("/payments")) {
          return new Response(
            JSON.stringify({
              paymentId: "550e8400-e29b-41d4-a716-446655440020",
              orderId: "550e8400-e29b-41d4-a716-446655440010",
              paymentStatus: "SUCCESS",
              orderStatus: "PAID",
              amountVnd: 98000,
              method: "CARD",
              methodLast4: "1234",
              mockReference: "MOCK-0003",
              pointsEarned: 9,
              failureReason: null,
              createdAt: "2026-10-27T02:00:00.000Z",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Replayed": "false",
              },
            }
          );
        }

        const myOrder: MyOrderDto = {
          ...createSampleOrderSnapshot(),
          expiresAt: "2026-10-27T02:15:00.000Z",
          pointsEarned: 0,
          payment: null,
        };
        return new Response(
          JSON.stringify({
            items: [myOrder],
            meta: { page: null, limit: null, total: 1, totalPages: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      // Test GET /orders/me
      const myOrders = await fetchMyOrdersApi(token);
      assert.equal(myOrders.items.length, 1);
      const selected = selectTargetOrderFromMyOrders(myOrders.items, null);
      assert.ok(selected);
      assert.equal(selected.id, "550e8400-e29b-41d4-a716-446655440010");

      // Test POST /payments via executePaymentSubmission
      const harness = createSubmissionHarness({
        accessToken: token,
        idempotencyKey: idemKey,
      });
      const execResult = await executePaymentSubmission(harness.deps);

      assert.equal(execResult.skipped, false);
      assert.equal(execResult.outcome?.type, "success");
      assert.equal(capturedHeaders["Authorization"], `Bearer ${token}`);
      assert.equal(capturedHeaders["Idempotency-Key"], idemKey);
      assert.deepEqual(capturedBody, {
        orderId: "550e8400-e29b-41d4-a716-446655440010",
        method: "CARD",
        paymentDetails: { cardNumber: "1234567890121234" },
      });

      const state = harness.getState();
      assert.equal(state.clearCartCount, 1);
      assert.equal(state.clearedContextActiveOrder, true);
      assert.equal(state.orderStatus, "PAID");
      assert.equal(state.pointsAdded, 9);
      assert.equal(state.paymentResult?.paymentStatus, "SUCCESS");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("3. handles FAILED payment (HTTP 200 PAYMENT_DECLINED): preserves Cart, transitions to PAYMENT_FAILED, and rotates Idempotency-Key", async () => {
    const token = createValidMockJwt();
    const initialKey = "idem-fail-attempt-0001";
    const savedFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            paymentId: "550e8400-e29b-41d4-a716-446655440021",
            orderId: "550e8400-e29b-41d4-a716-446655440010",
            paymentStatus: "FAILED",
            orderStatus: "PAYMENT_FAILED",
            amountVnd: 98000,
            method: "CARD",
            methodLast4: "0002",
            mockReference: "MOCK-0004",
            pointsEarned: 0,
            failureReason: "PAYMENT_DECLINED",
            createdAt: "2026-10-27T02:01:00.000Z",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Replayed": "false",
            },
          }
        )) as typeof fetch;

      const harness = createSubmissionHarness({
        accessToken: token,
        idempotencyKey: initialKey,
        payload: buildCreatePaymentPayload({
          orderId: "550e8400-e29b-41d4-a716-446655440010",
          method: "CARD",
          cardNumber: "1234567890120002",
        }),
      });

      const execResult = await executePaymentSubmission(harness.deps);
      assert.equal(execResult.skipped, false);
      assert.equal(execResult.outcome?.type, "failed");

      const state = harness.getState();
      // Cart MUST NOT be cleared on FAILED payment
      assert.equal(state.clearCartCount, 0);
      assert.equal(state.clearedContextActiveOrder, false);
      assert.equal(state.pointsAdded, 0);
      assert.equal(state.orderStatus, "PAYMENT_FAILED");
      assert.equal(state.paymentResult?.paymentStatus, "FAILED");
      assert.equal(state.paymentResult?.failureReason, "PAYMENT_DECLINED");
      // New Idempotency-Key generated for the next retry attempt
      assert.notEqual(state.idempotencyKey, initialKey);
      assert.equal(validateIdempotencyKey(state.idempotencyKey).isValid, true);
      // Order in PAYMENT_FAILED remains payable
      assert.equal(
        isOrderPayable(createSampleOrderSnapshot("PAYMENT_FAILED")),
        true
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("4. blocks payment form and prevents POST /payments when Order is NOT in PENDING or PAYMENT_FAILED (e.g., PAID, CANCELLED)", async () => {
    assert.equal(isOrderPayableStatus("PENDING"), true);
    assert.equal(isOrderPayableStatus("PAYMENT_FAILED"), true);
    assert.equal(isOrderPayableStatus("PAID"), false);
    assert.equal(isOrderPayableStatus("CANCELLED"), false);
    assert.equal(isOrderPayableStatus("EXPIRED"), false);

    // 4a. UI blocks payment form inputs and disables submit button for CANCELLED and PAID orders
    const cancelledOrder = createSampleOrderSnapshot("CANCELLED");
    const cancelledHtml = renderPaymentMarkup({ initialOrder: cancelledOrder });
    assert.ok(cancelledHtml.includes('id="nonPayableOrderBanner"'));
    assert.equal(cancelledHtml.includes('id="radioCard"'), false);
    assert.equal(cancelledHtml.includes('id="radioWallet"'), false);
    assert.equal(cancelledHtml.includes('id="cardInputNumber"'), false);
    assert.equal(cancelledHtml.includes('id="walletInputPhone"'), false);
    assert.ok(cancelledHtml.includes("Không thể thanh toán"));

    const paidOrder = createSampleOrderSnapshot("PAID");
    const paidHtml = renderPaymentMarkup({ initialOrder: paidOrder });
    assert.ok(paidHtml.includes('id="nonPayableOrderBanner"'));
    assert.equal(paidHtml.includes('id="cardInputNumber"'), false);
    assert.equal(paidHtml.includes('id="walletInputPhone"'), false);

    // 4b. executePaymentSubmission blocks submission before calling submitPaymentFn
    let apiCalled = false;
    const harness = createSubmissionHarness({
      activeOrder: cancelledOrder,
      orderStatus: "CANCELLED",
      submitPaymentFn: async () => {
        apiCalled = true;
        throw new Error("Should never be called");
      },
    });

    const result = await executePaymentSubmission(harness.deps);
    assert.equal(apiCalled, false);
    assert.equal(result.skipped, false);
    assert.equal(result.outcome?.type, "error");
    const state = harness.getState();
    assert.equal(state.clearCartCount, 0);
    assert.equal(state.paymentError?.statusCode, 409);
    assert.equal(state.paymentError?.code, "INVALID_TRANSITION");
    assert.equal(state.paymentError?.canRetrySameKey, false);
  });

  it("5. rejects malformed or mismatched payment responses without clearing Cart or showing SUCCESS", async () => {
    const baseValidResponse: PaymentResponseDto = {
      paymentId: "550e8400-e29b-41d4-a716-446655440020",
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      paymentStatus: "SUCCESS",
      orderStatus: "PAID",
      amountVnd: 98000,
      method: "CARD",
      methodLast4: "1234",
      mockReference: "MOCK-0003",
      pointsEarned: 9,
      failureReason: null,
      createdAt: "2026-10-27T02:00:00.000Z",
    };

    const expectedCtx = {
      expectedOrderId: "550e8400-e29b-41d4-a716-446655440010",
      expectedMethod: "CARD" as const,
      expectedMethodLast4: "1234",
      expectedAmountVnd: 98000,
    };

    // Valid response passes
    assert.doesNotThrow(() =>
      validatePaymentResponseData(baseValidResponse, "idem-12345678", expectedCtx)
    );

    // Mismatched orderId (belongs to a different order)
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          orderId: "550e8400-e29b-41d4-a716-446655440099",
        },
        "idem-12345678",
        expectedCtx
      )
    );

    // Mismatched amountVnd (does not match order.totalVnd)
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          amountVnd: 50000,
          pointsEarned: 5,
        },
        "idem-12345678",
        expectedCtx
      )
    );

    // Mismatched method or methodLast4
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          method: "WALLET",
        },
        "idem-12345678",
        expectedCtx
      )
    );
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          methodLast4: "9999",
        },
        "idem-12345678",
        expectedCtx
      )
    );

    // SUCCESS with non-null failureReason or wrong pointsEarned formula
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          failureReason: "PAYMENT_DECLINED",
        },
        "idem-12345678",
        expectedCtx
      )
    );
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          pointsEarned: 999,
        },
        "idem-12345678",
        expectedCtx
      )
    );

    // FAILED with null failureReason or non-zero pointsEarned
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          paymentStatus: "FAILED",
          orderStatus: "PAYMENT_FAILED",
          failureReason: null,
          pointsEarned: 0,
        },
        "idem-12345678",
        expectedCtx
      )
    );
    assert.throws(() =>
      validatePaymentResponseData(
        {
          ...baseValidResponse,
          paymentStatus: "FAILED",
          orderStatus: "PAYMENT_FAILED",
          failureReason: "PAYMENT_DECLINED",
          pointsEarned: 5,
        },
        "idem-12345678",
        expectedCtx
      )
    );

    // Verify executePaymentSubmission NEVER clears Cart or sets paymentResult when response is mismatched/malformed
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            ...baseValidResponse,
            // Wrong orderId returned by server!
            orderId: "550e8400-e29b-41d4-a716-446655440099",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;

      const harness = createSubmissionHarness({
        idempotencyKey: "idem-mismatch-12345",
      });
      const res = await executePaymentSubmission(harness.deps);

      assert.equal(res.outcome?.type, "error");
      const state = harness.getState();
      assert.equal(state.clearCartCount, 0);
      assert.equal(state.paymentResult, null);
      assert.equal(state.orderStatus, "PENDING");
      assert.equal(state.paymentError?.code, "INTERNAL_ERROR");
      assert.equal(state.paymentError?.canRetrySameKey, true);
      assert.equal(state.idempotencyKey, "idem-mismatch-12345");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("6. handles 401 UNAUTHORIZED (expired token & server 401): clears session, preserves Cart, and opens Login modal", async () => {
    const expiredToken = createValidMockJwt(
      "550e8400-e29b-41d4-a716-446655440000",
      -60
    );
    localStorageMock.setItem(TOKEN_STORAGE_KEY, expiredToken);
    localStorageMock.setItem(
      USER_STORAGE_KEY,
      JSON.stringify({ id: "550e8400-e29b-41d4-a716-446655440000" })
    );

    // 6a. Pre-flight expired token check
    const expiredHarness = createSubmissionHarness({
      accessToken: expiredToken,
    });
    const expiredRes = await executePaymentSubmission(expiredHarness.deps);
    assert.equal(expiredRes.outcome?.type, "error");
    assert.equal(expiredHarness.getState().clearCartCount, 0);
    assert.equal(expiredHarness.getState().paymentError?.statusCode, 401);
    assert.equal(expiredHarness.getState().paymentError?.code, "UNAUTHORIZED");
    assert.equal(expiredHarness.getState().authModalCalls.length, 1);
    assert.equal(getStoredToken(), null);

    // 6b. Server returns HTTP 401 on POST /payments
    const validToken = createValidMockJwt();
    localStorageMock.setItem(TOKEN_STORAGE_KEY, validToken);
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            statusCode: 401,
            code: "UNAUTHORIZED",
            message: "Token expired or invalid",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;

      const server401Harness = createSubmissionHarness({
        accessToken: validToken,
      });
      const res401 = await executePaymentSubmission(server401Harness.deps);

      assert.equal(res401.outcome?.type, "error");
      const state = server401Harness.getState();
      assert.equal(state.clearCartCount, 0);
      assert.equal(state.paymentError?.statusCode, 401);
      assert.equal(state.paymentError?.code, "UNAUTHORIZED");
      assert.equal(state.paymentError?.canRetrySameKey, false);
      assert.equal(state.authModalCalls.length, 1);
      assert.equal(getStoredToken(), null);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("7. handles network errors, malformed JSON, 409 PAYMENT_IN_PROGRESS (same-key retry), and 409 IDEMPOTENCY_KEY_CONFLICT (key rotation)", async () => {
    const token = createValidMockJwt();
    const fixedKey = "idem-retry-key-0001";
    const savedFetch = globalThis.fetch;

    try {
      // 7a. Network error preserves Cart and keeps same Idempotency-Key for retry
      globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch;

      const netHarness = createSubmissionHarness({
        accessToken: token,
        idempotencyKey: fixedKey,
      });
      const netRes = await executePaymentSubmission(netHarness.deps);
      assert.equal(netRes.outcome?.type, "error");
      assert.equal(netHarness.getState().clearCartCount, 0);
      assert.equal(netHarness.getState().paymentError?.code, "NETWORK_ERROR");
      assert.equal(netHarness.getState().paymentError?.canRetrySameKey, true);
      assert.equal(netHarness.getState().idempotencyKey, fixedKey);

      // 7b. Malformed non-JSON response (e.g., 502 Bad Gateway HTML) preserves Cart and allows same-key retry
      globalThis.fetch = (async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        })) as typeof fetch;

      const badJsonHarness = createSubmissionHarness({
        accessToken: token,
        idempotencyKey: fixedKey,
      });
      await executePaymentSubmission(badJsonHarness.deps);
      assert.equal(badJsonHarness.getState().clearCartCount, 0);
      assert.equal(
        badJsonHarness.getState().paymentError?.code,
        "INTERNAL_ERROR"
      );
      assert.equal(
        badJsonHarness.getState().paymentError?.canRetrySameKey,
        true
      );
      assert.equal(badJsonHarness.getState().idempotencyKey, fixedKey);

      // 7c. 409 PAYMENT_IN_PROGRESS keeps same key; 409 IDEMPOTENCY_KEY_CONFLICT rotates to a new key
      const inProgressState = toPaymentSubmissionErrorState(
        { statusCode: 409, code: "PAYMENT_IN_PROGRESS" },
        fixedKey
      );
      assert.equal(inProgressState.canRetrySameKey, true);
      assert.equal(inProgressState.shouldGenerateNewKey, false);

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            statusCode: 409,
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "Idempotency key already used with different payload",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch;

      const conflictHarness = createSubmissionHarness({
        accessToken: token,
        idempotencyKey: fixedKey,
      });
      await executePaymentSubmission(conflictHarness.deps);
      assert.equal(conflictHarness.getState().clearCartCount, 0);
      assert.equal(
        conflictHarness.getState().paymentError?.code,
        "IDEMPOTENCY_KEY_CONFLICT"
      );
      assert.equal(
        conflictHarness.getState().paymentError?.shouldGenerateNewKey,
        true
      );
      assert.notEqual(conflictHarness.getState().idempotencyKey, fixedKey);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("8. prevents concurrent double-submit while POST /payments is in-flight and renders loading/error UI states", async () => {
    let resolvePayment!: (value: SubmitPaymentApiResult) => void;
    let apiCallCount = 0;

    const slowSubmitFn: typeof submitPaymentApi = () => {
      apiCallCount += 1;
      return new Promise<SubmitPaymentApiResult>((resolve) => {
        resolvePayment = resolve;
      });
    };

    const harness = createSubmissionHarness({
      idempotencyKey: "idem-double-submit-01",
      submitPaymentFn: slowSubmitFn,
    });

    // Trigger first submission (now in-flight)
    const firstCallPromise = executePaymentSubmission(harness.deps);
    assert.equal(harness.getState().isSubmitting, true);
    assert.equal(harness.getState().submittingRefCurrent, true);

    // Trigger second concurrent submission while first is in-flight -> MUST be skipped
    const secondCallResult = await executePaymentSubmission(harness.deps);
    assert.equal(secondCallResult.skipped, true);
    assert.equal(secondCallResult.outcome, null);
    assert.equal(apiCallCount, 1);

    // Resolve first submission
    resolvePayment({
      replayed: false,
      idempotencyKey: "idem-double-submit-01",
      response: {
        paymentId: "550e8400-e29b-41d4-a716-446655440020",
        orderId: "550e8400-e29b-41d4-a716-446655440010",
        paymentStatus: "SUCCESS",
        orderStatus: "PAID",
        amountVnd: 98000,
        method: "CARD",
        methodLast4: "1234",
        mockReference: "MOCK-0003",
        pointsEarned: 9,
        failureReason: null,
        createdAt: "2026-10-27T02:00:00.000Z",
      },
    });

    const firstCallResult = await firstCallPromise;
    assert.equal(firstCallResult.skipped, false);
    assert.equal(firstCallResult.outcome?.type, "success");
    assert.equal(harness.getState().isSubmitting, false);
    assert.equal(harness.getState().submittingRefCurrent, false);
    assert.equal(apiCallCount, 1);

    // Verify rendered HTML for default payable, loading, and retryable error states
    const defaultHtml = renderPaymentMarkup();
    assert.ok(defaultHtml.includes('id="radioCard"'));
    assert.ok(defaultHtml.includes('id="radioWallet"'));
    assert.ok(defaultHtml.includes('id="cardInputNumber"'));
    assert.ok(defaultHtml.includes('id="walletInputPhone"'));
    assert.ok(defaultHtml.includes('id="btnSubmitPayment"'));

    const loadingHtml = renderPaymentMarkup({ initialIsSubmitting: true });
    assert.ok(loadingHtml.includes("Đang xử lý thanh toán..."));

    const errorHtml = renderPaymentMarkup({
      initialPaymentError: {
        statusCode: 409,
        code: "PAYMENT_IN_PROGRESS",
        message: "Giao dịch đang xử lý.",
        canRetrySameKey: true,
        shouldGenerateNewKey: false,
        idempotencyKey: "idem-test-12345678",
      },
    });
    assert.ok(errorHtml.includes('id="paymentErrorBanner"'));
    assert.ok(errorHtml.includes('id="btnRetrySameIdempotencyKey"'));
    assert.ok(errorHtml.includes("idem-test-12345678"));
  });

  it("9. blocks payment and POST /payments when Order has expired expiresAt (countdown reached 0)", async () => {
    const expiredOrder: MyOrderDto = {
      ...createSampleOrderSnapshot(),
      id: "550e8400-e29b-41d4-a716-446655440050",
      status: "PENDING",
      createdAt: "2026-10-25T01:00:00.000Z",
      expiresAt: "2026-10-25T01:15:00.000Z", // Quá khứ
      totalVnd: 50000,
    };

    const now = new Date("2026-10-25T01:20:00.000Z").getTime();
    assert.equal(isOrderExpired(expiredOrder, now), true);
    assert.equal(isOrderPayable(expiredOrder, "PENDING", now), false);

    let apiCallCount = 0;
    const harness = createSubmissionHarness({
      activeOrder: expiredOrder,
      orderStatus: "PENDING",
      submitPaymentFn: async () => {
        apiCallCount++;
        throw new Error("Should not be called");
      },
    });

    const result = await executePaymentSubmission(harness.deps);

    assert.equal(result.skipped, false);
    assert.equal(result.outcome?.type, "error");
    assert.equal(result.outcome?.error.code, "INVALID_TRANSITION");
    assert.equal(apiCallCount, 0);

    // Verify rendered HTML shows nonPayableOrderBanner with expired notice
    const expiredHtml = renderPaymentMarkup({
      initialOrder: expiredOrder,
    });
    assert.ok(expiredHtml.includes('id="nonPayableOrderBanner"'));
    assert.ok(expiredHtml.includes("EXPIRED"));
  });

  it("10. supports Order with 0 VND (totalVnd === 0, amountVnd === 0) per API Contract v3.0 §3.2", async () => {
    const zeroVndOrder: MyOrderDto = {
      ...createSampleOrderSnapshot(),
      id: "550e8400-e29b-41d4-a716-446655440051",
      status: "PENDING",
      totalVnd: 0,
      subtotalVnd: 50000,
      discountVnd: 50000, // 100% coupon discount
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    // isOrderPayable must return true for 0 VND (only rejects < 0)
    assert.equal(isOrderPayable(zeroVndOrder), true);

    const negativeOrder = { ...zeroVndOrder, totalVnd: -1000 };
    assert.equal(isOrderPayable(negativeOrder), false);

    // validatePaymentResponseData must accept amountVnd: 0 and pointsEarned: 0
    const rawZeroResponse = {
      paymentId: "550e8400-e29b-41d4-a716-446655440052",
      orderId: zeroVndOrder.id,
      paymentStatus: "SUCCESS",
      orderStatus: "PAID",
      amountVnd: 0,
      method: "CARD",
      methodLast4: "1234",
      mockReference: "MOCK-ZERO-0001",
      pointsEarned: 0,
      failureReason: null,
      createdAt: new Date().toISOString(),
    };

    const validated = validatePaymentResponseData(
      rawZeroResponse,
      "idem-zero-key-12345678",
      {
        expectedOrderId: zeroVndOrder.id,
        expectedAmountVnd: 0,
        expectedMethod: "CARD",
        expectedMethodLast4: "1234",
      }
    );
    assert.equal(validated.amountVnd, 0);
    assert.equal(validated.pointsEarned, 0);
    assert.equal(validated.paymentStatus, "SUCCESS");

    // executePaymentSubmission with 0 VND succeeds
    let apiCalled = false;
    const harness = createSubmissionHarness({
      activeOrder: zeroVndOrder,
      orderStatus: "PENDING",
      submitPaymentFn: async (_payload, ikey) => {
        apiCalled = true;
        return {
          response: rawZeroResponse as PaymentResponseDto,
          replayed: false,
          idempotencyKey: ikey || "idem-zero-key-12345678",
        };
      },
    });

    const submissionResult = await executePaymentSubmission(harness.deps);

    assert.equal(apiCalled, true);
    assert.equal(submissionResult.outcome?.type, "success");
    assert.equal(harness.getState().clearCartCount, 1);
  });

  it("11. runtime-validates GET /orders/me response fields, throwing 502 on malformed or corrupt snapshots", async () => {
    const isInternal502 = (err: unknown) => {
      const e = err as { statusCode?: number; code?: string } | null;
      return Boolean(e && e.statusCode === 502 && e.code === "INTERNAL_ERROR");
    };

    // 1. Root items is not an array
    assert.throws(
      () => validateMyOrdersResponse({ items: "not-an-array" }),
      isInternal502
    );

    // 2. Order missing or invalid UUID id
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [{ ...createSampleOrderSnapshot(), id: "not-a-uuid" }],
        }),
      isInternal502
    );

    // 3. Order with invalid status
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [{ ...createSampleOrderSnapshot(), status: "UNKNOWN_STATUS" }],
        }),
      isInternal502
    );

    // 4. Order with negative totalVnd
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [{ ...createSampleOrderSnapshot(), totalVnd: -5000 }],
        }),
      isInternal502
    );

    // 5. Order with corrupt item (missing productId)
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [
            {
              ...createSampleOrderSnapshot(),
              items: [{ id: "it-1", productId: "invalid", quantity: 1 }],
            },
          ],
        }),
      isInternal502
    );

    // 6. Order missing expiresAt (must throw 502 malformed response, NO fallback to createdAt)
    const sample = createSampleOrderSnapshot();
    const orderMissingExpiresAt = { ...sample };
    delete (orderMissingExpiresAt as Record<string, unknown>).expiresAt;
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [orderMissingExpiresAt],
        }),
      isInternal502
    );

    // 7. Order with invalid/malformed expiresAt date string
    assert.throws(
      () =>
        validateMyOrdersResponse({
          items: [{ ...createSampleOrderSnapshot(), expiresAt: "not-a-valid-date" }],
        }),
      isInternal502
    );

    // 8. Valid response conforms cleanly
    const validRaw = {
      items: [createSampleOrderSnapshot()],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    };
    const validatedResult = validateMyOrdersResponse(validRaw);
    assert.equal(validatedResult.items.length, 1);
    assert.equal(validatedResult.items[0].id, validRaw.items[0].id);
    assert.equal(validatedResult.items[0].totalVnd, validRaw.items[0].totalVnd);
  });
});
