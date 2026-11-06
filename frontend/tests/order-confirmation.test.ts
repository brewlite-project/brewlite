import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PaymentFailedRetryView } from "../components/PaymentFailedRetryView";
import OrderConfirmationPage from "../app/order-confirmation/page";
import { AuthContext, type AuthContextType } from "../context/AuthContext";
import { CartProvider, useCart, clearStoredActiveOrder } from "../context/CartContext";
import { beforeEach, describe, it } from "node:test";
import {
  isValidIsoUtcString,
  validatePaymentResponseData,
  validatePaymentStatusResponseData,
  validatePaymentSnapshot,
  validateMyOrderSnapshot,
  validateMyOrdersResponse,
} from "../services/payment.service";
import {
  type OrderConfirmationData,
  computeOrderRemainingSeconds,
  isOrderExpired,
  canOrderRetryPayment,
  shouldPollOrderConfirmation,
  setOrderConfirmationPollingConfig,
  resetOrderConfirmationPollingConfig,
  fetchPaymentStatusApi,
  formatRemainingTime,
  findOrderForConfirmation,
  fetchMyOrdersApi,
  submitRetryPaymentApi,
  generateIdempotencyKey,
  validateAuthMeResponse,
  fetchAuthMeProfile,
} from "../services/order-confirmation.service";

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
  return `${header}.${payload}.mockSignature123`;
}

describe("SCRUM-68: Order Confirmation Service & Logic Automated Tests", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = originalFetch;
  });

  const mockOrderSuccess: OrderConfirmationData = {
    id: "550e8400-e29b-41d4-a716-446655440010",
    status: "PAID",
    createdAt: "2026-10-25T01:50:00.000Z",
    expiresAt: "2026-10-25T02:05:00.000Z",
    subtotalVnd: 118000,
    discountVnd: 20000,
    totalVnd: 98000,
    couponCode: "WELCOME20",
    pointsEarned: 9,
    items: [
      {
        id: "item-1",
        productId: "550e8400-e29b-41d4-a716-446655440001",
        productName: "Cà Phê Muối",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 35000,
        unitPriceVnd: 42000,
        quantity: 2,
        lineTotalVnd: 84000,
        toppings: [{ id: "550e8400-e29b-41d4-a716-446655440091", name: "Kem Cheese", priceVnd: 10000 }],
      },
    ],
    payment: {
      id: "550e8400-e29b-41d4-a716-446655440020",
      status: "SUCCESS",
      method: "CARD",
      methodLast4: "0001",
      amountVnd: 98000,
      mockReference: "MOCK-CARD-0001-1234",
      failureReason: null,
      createdAt: "2026-10-25T01:51:00.000Z",
    },
  };

  const mockOrderFailed: OrderConfirmationData = {
    id: "550e8400-e29b-41d4-a716-446655440011",
    status: "PAYMENT_FAILED",
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    subtotalVnd: 65000,
    discountVnd: 0,
    totalVnd: 65000,
    couponCode: null,
    pointsEarned: 0,
    items: [
      {
        id: "item-2",
        productId: "550e8400-e29b-41d4-a716-446655440002",
        productName: "Cà Phê Sữa Đá",
        size: "S",
        sizeMultiplierPercent: 100,
        basePriceVnd: 35000,
        unitPriceVnd: 35000,
        quantity: 1,
        lineTotalVnd: 35000,
        toppings: [],
      },
    ],
    payment: {
      id: "550e8400-e29b-41d4-a716-446655440021",
      status: "FAILED",
      method: "CARD",
      methodLast4: "1234",
      amountVnd: 65000,
      mockReference: "MOCK-CARD-1234-5678",
      failureReason: "PAYMENT_DECLINED",
      createdAt: new Date().toISOString(),
    },
  };

  describe("1. Expiration & Countdown Logic (15 phút theo Contract v3.0)", () => {
    it("should compute remaining seconds accurately when order is active", () => {
      const now = Date.now();
      const expiresAt = new Date(now + 300 * 1000).toISOString();
      const remaining = computeOrderRemainingSeconds(expiresAt, now);
      assert.equal(remaining, 300);
      assert.equal(formatRemainingTime(remaining), "05:00");
    });

    it("should return 0 when order expiresAt is in the past", () => {
      const now = Date.now();
      const expiresAt = new Date(now - 10 * 1000).toISOString();
      const remaining = computeOrderRemainingSeconds(expiresAt, now);
      assert.equal(remaining, 0);
      assert.equal(formatRemainingTime(remaining), "00:00");
    });

    it("should correctly identify expired orders via isOrderExpired", () => {
      const now = Date.now();
      assert.equal(isOrderExpired(mockOrderFailed, now), false);

      const expiredOrder = {
        ...mockOrderFailed,
        expiresAt: new Date(now - 1000).toISOString(),
      };
      assert.equal(isOrderExpired(expiredOrder, now), true);

      const cancelledOrder = {
        ...mockOrderFailed,
        status: "CANCELLED",
      };
      assert.equal(isOrderExpired(cancelledOrder, now), true);
    });

    it("should rely strictly on expiresAt and NOT infer/fallback from createdAt", () => {
      const now = Date.now();
      const created16MinAgo = new Date(now - 16 * 60 * 1000).toISOString();
      assert.equal(
        isOrderExpired(
          { createdAt: created16MinAgo, status: "PAYMENT_FAILED" },
          now
        ),
        false
      );
    });
  });

  describe("2. Order Lookup & Confirmation Selection (GET /orders/me)", () => {
    const orderList = [mockOrderFailed, mockOrderSuccess];

    it("should find order by specific targetOrderId", () => {
      const result = findOrderForConfirmation(orderList, mockOrderSuccess.id);
      assert.notEqual(result, null);
      assert.equal(result?.id, mockOrderSuccess.id);
      assert.equal(result?.status, "PAID");
    });

    it("should return null when targetOrderId is not found in order history (does NOT open latest order)", () => {
      const nonExistentUuid = "550e8400-e29b-41d4-a716-446655440999";
      const result = findOrderForConfirmation(orderList, nonExistentUuid);
      assert.equal(result, null);
    });

    it("should return null when targetOrderId is an invalid UUID (does NOT open latest order)", () => {
      const invalidId = "invalid-order-id-123";
      const result = findOrderForConfirmation(orderList, invalidId);
      assert.equal(result, null);
    });

    it("should return null when targetOrderId is not passed or empty (TUYỆT ĐỐI không mở nhầm đơn mới nhất)", () => {
      const result1 = findOrderForConfirmation(orderList);
      assert.equal(result1, null);

      const result2 = findOrderForConfirmation(orderList, "");
      assert.equal(result2, null);

      const result3 = findOrderForConfirmation(orderList, "   ");
      assert.equal(result3, null);

      const result4 = findOrderForConfirmation(orderList, null);
      assert.equal(result4, null);
    });

    it("should return null when orderList is empty", () => {
      assert.equal(findOrderForConfirmation([]), null);
    });
  });

  describe("3. Idempotency Key Generation", () => {
    it("should generate a 36-character UUIDv4 for Idempotency-Key", () => {
      const key = generateIdempotencyKey();
      assert.equal(typeof key, "string");
      assert.equal(key.length, 36);
      assert.equal(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          key
        ),
        true
      );
    });
  });

  describe("4. API Calls & Authorization Guards", () => {
    it("should throw UNAUTHORIZED when calling fetchMyOrdersApi without valid token", async () => {
      await assert.rejects(
        async () => {
          await fetchMyOrdersApi("");
        },
        { message: "UNAUTHORIZED" }
      );
    });

    it("should throw UNAUTHORIZED when calling submitRetryPaymentApi without token", async () => {
      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: mockOrderFailed.id,
            method: "CARD",
            identifier: "1234567890121234",
            token: "",
          });
        },
        { message: "UNAUTHORIZED" }
      );
    });

    it("should reject invalid UUID orderId in submitRetryPaymentApi", async () => {
      const validToken = createValidMockJwt();
      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: "invalid-uuid",
            method: "CARD",
            identifier: "1234567890121234",
            token: validToken,
          });
        },
        { message: "INVALID_ORDER_ID" }
      );
    });

    it("should successfully call POST /payments with correct headers and payload", async () => {
      const validToken = createValidMockJwt();
      const expectedResponse = {
        paymentId: "550e8400-e29b-41d4-a716-446655440099",
        orderId: mockOrderFailed.id,
        paymentStatus: "SUCCESS",
        orderStatus: "PAID",
        amountVnd: 65000,
        method: "CARD",
        methodLast4: "1234",
        mockReference: "MOCK-CARD-1234-abcd",
        pointsEarned: 6,
        failureReason: null,
        createdAt: new Date().toISOString(),
      };

      let capturedInit: RequestInit = {};

      global.fetch = (async (_url: string, init?: RequestInit) => {
        if (init) capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => expectedResponse,
        } as Response;
      }) as unknown as typeof fetch;

      const result = await submitRetryPaymentApi({
        orderId: mockOrderFailed.id,
        method: "CARD",
        identifier: "1234567890121234",
        token: validToken,
      });

      assert.equal(result.paymentStatus, "SUCCESS");
      assert.equal(result.orderStatus, "PAID");
      assert.equal(result.pointsEarned, 6);

      assert.equal(capturedInit.method, "POST");
      const headers = capturedInit.headers as Record<string, string>;
      assert.equal(headers?.["Authorization"], `Bearer ${validToken}`);
      assert.ok(headers?.["Idempotency-Key"]);
      const parsedBody = JSON.parse(String(capturedInit.body));
      assert.equal(parsedBody.orderId, mockOrderFailed.id);
      assert.equal(parsedBody.method, "CARD");
      assert.equal(parsedBody.paymentDetails.cardNumber, "1234567890121234");
    });

    it("should preserve and reuse the same Idempotency-Key on network retry", async () => {
      const validToken = createValidMockJwt();
      const specificKey = "idem-retry-custom-key-12345678";
      let capturedKey = "";

      global.fetch = (async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        capturedKey = headers?.["Idempotency-Key"] || "";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paymentId: "550e8400-e29b-41d4-a716-446655440099",
            orderId: mockOrderFailed.id,
            paymentStatus: "SUCCESS",
            orderStatus: "PAID",
            amountVnd: 65000,
            method: "CARD",
            methodLast4: "1234",
            mockReference: "MOCK-CARD-1234-abcd",
            pointsEarned: 6,
            failureReason: null,
            createdAt: new Date().toISOString(),
          }),
        } as Response;
      }) as unknown as typeof fetch;

      await submitRetryPaymentApi({
        orderId: mockOrderFailed.id,
        method: "CARD",
        identifier: "1234567890121234",
        token: validToken,
        idempotencyKey: specificKey,
      });

      assert.equal(capturedKey, specificKey);
    });

    it("should reject malformed payment responses (invalid UUID, wrong orderId, bad status) and NOT treat as success", async () => {
      const validToken = createValidMockJwt();

      // Case A: Missing paymentId
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          orderId: mockOrderFailed.id,
          paymentStatus: "SUCCESS",
          orderStatus: "PAID",
          amountVnd: 65000,
        }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: mockOrderFailed.id,
            method: "CARD",
            identifier: "1234567890121234",
            token: validToken,
          });
        },
        (err: unknown) => {
          const e = err as { code?: string };
          return e.code === "INTERNAL_ERROR" || Boolean(err);
        }
      );

      // Case B: Inconsistent status (SUCCESS but orderStatus is PAYMENT_FAILED)
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          paymentId: "550e8400-e29b-41d4-a716-446655440099",
          orderId: mockOrderFailed.id,
          paymentStatus: "SUCCESS",
          orderStatus: "PAYMENT_FAILED",
          amountVnd: 65000,
          method: "CARD",
          methodLast4: "1234",
          mockReference: "MOCK-001",
          pointsEarned: 6,
          failureReason: null,
          createdAt: new Date().toISOString(),
        }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: mockOrderFailed.id,
            method: "CARD",
            identifier: "1234567890121234",
            token: validToken,
          });
        },
        (err: unknown) => {
          const e = err as { code?: string };
          return e.code === "INTERNAL_ERROR" || Boolean(err);
        }
      );
    });

    it("should support 0 VND Order retry payment (amountVnd === 0, pointsEarned === 0)", async () => {
      const validToken = createValidMockJwt();
      const zeroVndResponse = {
        paymentId: "550e8400-e29b-41d4-a716-446655440055",
        orderId: mockOrderFailed.id,
        paymentStatus: "SUCCESS",
        orderStatus: "PAID",
        amountVnd: 0,
        method: "CARD",
        methodLast4: "1234",
        mockReference: "MOCK-ZERO-1234",
        pointsEarned: 0,
        failureReason: null,
        createdAt: new Date().toISOString(),
      };

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => zeroVndResponse,
      })) as unknown as typeof fetch;

      const result = await submitRetryPaymentApi({
        orderId: mockOrderFailed.id,
        method: "CARD",
        identifier: "1234567890121234",
        token: validToken,
        expectedAmountVnd: 0,
      });

      assert.equal(result.paymentStatus, "SUCCESS");
      assert.equal(result.amountVnd, 0);
      assert.equal(result.pointsEarned, 0);
    });

    it("should reject 401 UNAUTHORIZED from server and throw error", async () => {
      const validToken = createValidMockJwt();
      global.fetch = (async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized", code: "UNAUTHORIZED" }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: mockOrderFailed.id,
            method: "CARD",
            identifier: "1234567890121234",
            token: validToken,
          });
        },
        (err: unknown) => {
          const e = err as { statusCode?: number; message?: string };
          return e.statusCode === 401 || e.message === "UNAUTHORIZED";
        }
      );
    });
  });

  describe("5. Strict Runtime Validation for GET /auth/me & GET /orders/me", () => {
    it("should validate and return a valid AuthMeProfile from validateAuthMeResponse", () => {
      const validRaw = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "khachhang@brewlite.vn",
        fullName: "Nguyen Van A",
        loyaltyPoints: 120,
      };
      const result = validateAuthMeResponse(validRaw);
      assert.equal(result.id, "550e8400-e29b-41d4-a716-446655440001");
      assert.equal(result.email, "khachhang@brewlite.vn");
      assert.equal(result.fullName, "Nguyen Van A");
      assert.equal(result.loyaltyPoints, 120);
    });

    it("should reject malformed or non-object payload in validateAuthMeResponse", () => {
      assert.throws(() => validateAuthMeResponse(null), /đối tượng JSON hợp lệ/);
      assert.throws(() => validateAuthMeResponse([]), /đối tượng JSON hợp lệ/);
      assert.throws(() => validateAuthMeResponse("string"), /đối tượng JSON hợp lệ/);
    });

    it("should reject invalid UUID or invalid email in validateAuthMeResponse", () => {
      // Invalid UUID
      assert.throws(
        () =>
          validateAuthMeResponse({
            id: "not-a-uuid",
            email: "user@test.com",
            fullName: "User",
            loyaltyPoints: 10,
          }),
        /UUID hợp lệ/
      );

      // Invalid email
      assert.throws(
        () =>
          validateAuthMeResponse({
            id: "550e8400-e29b-41d4-a716-446655440001",
            email: "invalid-email-no-at",
            fullName: "User",
            loyaltyPoints: 10,
          }),
        /email/
      );
    });

    it("should accept fullName as null or whitespace and normalize to null", () => {
      const rawNull = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "user@test.com",
        fullName: null,
        loyaltyPoints: 10,
      };
      const res1 = validateAuthMeResponse(rawNull);
      assert.equal(res1.fullName, null);

      const rawWhitespace = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "user@test.com",
        fullName: "   ",
        loyaltyPoints: 10,
      };
      const res2 = validateAuthMeResponse(rawWhitespace);
      assert.equal(res2.fullName, null);
    });

    it("should reject response when required field fullName is completely missing or undefined", () => {
      const rawMissing = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "user@test.com",
        loyaltyPoints: 10,
      };
      assert.throws(
        () => validateAuthMeResponse(rawMissing),
        /thiếu trường bắt buộc 'fullName'/
      );

      const rawUndefined = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "user@test.com",
        fullName: undefined,
        loyaltyPoints: 10,
      };
      assert.throws(
        () => validateAuthMeResponse(rawUndefined),
        /thiếu trường bắt buộc 'fullName'/
      );
    });

    it("should reject non-string and non-null fullName in validateAuthMeResponse", () => {
      assert.throws(
        () =>
          validateAuthMeResponse({
            id: "550e8400-e29b-41d4-a716-446655440001",
            email: "user@test.com",
            fullName: 12345,
            loyaltyPoints: 10,
          }),
        /chuỗi hoặc null/
      );
    });

    it("should reject negative or non-integer loyaltyPoints in validateAuthMeResponse", () => {
      // Negative points
      assert.throws(
        () =>
          validateAuthMeResponse({
            id: "550e8400-e29b-41d4-a716-446655440001",
            email: "user@test.com",
            fullName: "User",
            loyaltyPoints: -5,
          }),
        /số nguyên an toàn không âm/
      );

      // Floating points
      assert.throws(
        () =>
          validateAuthMeResponse({
            id: "550e8400-e29b-41d4-a716-446655440001",
            email: "user@test.com",
            fullName: "User",
            loyaltyPoints: 12.5,
          }),
        /số nguyên an toàn không âm/
      );
    });

    it("should fetch and validate profile in fetchAuthMeProfile", async () => {
      const validToken = createValidMockJwt();
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: "550e8400-e29b-41d4-a716-446655440001",
          email: "customer@brewlite.vn",
          fullName: "Tran Thi B",
          loyaltyPoints: 50,
        }),
      })) as unknown as typeof fetch;

      const profile = await fetchAuthMeProfile(validToken);
      assert.notEqual(profile, null);
      assert.equal(profile?.loyaltyPoints, 50);
      assert.equal(profile?.fullName, "Tran Thi B");
    });

    it("should throw UNAUTHORIZED on 401 response in fetchAuthMeProfile", async () => {
      const validToken = createValidMockJwt();
      global.fetch = (async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await fetchAuthMeProfile(validToken);
        },
        (err: unknown) => {
          const e = err as { statusCode?: number; message?: string };
          return e.statusCode === 401 || e.message === "UNAUTHORIZED";
        }
      );
    });

    it("should throw error when GET /orders/me returns malformed order snapshot (missing or invalid expiresAt)", async () => {
      const validToken = createValidMockJwt();
      // Server returns order with null expiresAt (malformed order snapshot)
      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440010",
              status: "PENDING",
              createdAt: "2026-10-25T01:50:00.000Z",
              expiresAt: null, // Thiếu expiresAt từ backend
              subtotalVnd: 50000,
              discountVnd: 0,
              totalVnd: 50000,
              items: [],
            },
          ],
          meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
        }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await fetchMyOrdersApi(validToken);
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          return msg.includes("malformed order snapshot") || msg.includes("sai lệch");
        }
      );
    });

    it("should handle retry payment returning FAILED and allow caller to reload server truth", async () => {
      const validToken = createValidMockJwt();
      const failedPaymentResponse = {
        paymentId: "550e8400-e29b-41d4-a716-446655440099",
        orderId: mockOrderFailed.id,
        paymentStatus: "FAILED",
        orderStatus: "PAYMENT_FAILED",
        amountVnd: 65000,
        method: "CARD",
        methodLast4: "1234",
        mockReference: "MOCK-CARD-1234-5678",
        pointsEarned: 0,
        failureReason: "PAYMENT_DECLINED",
        createdAt: new Date().toISOString(),
      };

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => failedPaymentResponse,
      })) as unknown as typeof fetch;

      const result = await submitRetryPaymentApi({
        orderId: mockOrderFailed.id,
        method: "CARD",
        identifier: "1234567890121234",
        token: validToken,
      });

      assert.equal(result.paymentStatus, "FAILED");
      assert.equal(result.orderStatus, "PAYMENT_FAILED");
      assert.equal(result.failureReason, "PAYMENT_DECLINED");

      // Verify server truth re-fetch works seamlessly
      const mockUpdatedOrders = {
        items: [
          {
            ...mockOrderFailed,
            status: "PAYMENT_FAILED",
            payment: {
              id: result.paymentId,
              status: "FAILED",
              method: "CARD",
              methodLast4: "1234",
              amountVnd: 65000,
              mockReference: "MOCK-CARD-1234-5678",
              failureReason: "PAYMENT_DECLINED",
              createdAt: result.createdAt,
            },
          },
        ],
        meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
      };

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => mockUpdatedOrders,
      })) as unknown as typeof fetch;

      const refreshed = await fetchMyOrdersApi(validToken);
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0].id, mockOrderFailed.id);
      assert.equal(refreshed[0].payment?.failureReason, "PAYMENT_DECLINED");
    });

    it("should handle retry meeting changed order state (409 INVALID_TRANSITION) and refetch latest server truth", async () => {
      const validToken = createValidMockJwt();

      // Backend returns 409 Conflict with INVALID_TRANSITION (e.g. order was paid via another tab or cancelled)
      global.fetch = (async () => ({
        ok: false,
        status: 409,
        json: async () => ({
          statusCode: 409,
          code: "INVALID_TRANSITION",
          message: "INVALID_TRANSITION",
        }),
      })) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await submitRetryPaymentApi({
            orderId: mockOrderFailed.id,
            method: "CARD",
            identifier: "1234567890121234",
            token: validToken,
          });
        },
        (err: unknown) => {
          const e = err as { statusCode?: number; code?: string; message?: string };
          return (
            e.statusCode === 409 &&
            (e.code === "INVALID_TRANSITION" || e.message === "INVALID_TRANSITION")
          );
        }
      );

      // Caller/UI immediately refetches server truth from GET /orders/me
      const mockPaidOrderResponse = {
        items: [
          {
            ...mockOrderFailed,
            status: "PAID",
            payment: {
              id: "550e8400-e29b-41d4-a716-446655440099",
              status: "SUCCESS",
              method: "CARD",
              methodLast4: "1234",
              amountVnd: 65000,
              mockReference: "MOCK-CARD-1234-abcd",
              failureReason: null,
              createdAt: new Date().toISOString(),
            },
          },
        ],
        meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
      };

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => mockPaidOrderResponse,
      })) as unknown as typeof fetch;

      const updatedOrders = await fetchMyOrdersApi(validToken);
      const matched = findOrderForConfirmation(updatedOrders, mockOrderFailed.id);
      assert.notEqual(matched, null);
      assert.equal(matched?.status, "PAID");
    });
  });

  describe("6. Lifecycle Status & Copy Invariants", () => {
    it("should never assert an expired order is CANCELLED unless server explicitly returns CANCELLED status", () => {
      const now = Date.now();
      const expiredPendingOrder: OrderConfirmationData = {
        ...mockOrderFailed,
        status: "PENDING",
        expiresAt: new Date(now - 1000).toISOString(),
      };

      assert.equal(isOrderExpired(expiredPendingOrder, now), true);
      assert.notEqual(expiredPendingOrder.status, "CANCELLED");

      // Verify that expired notice does NOT assert CANCELLED unless status is CANCELLED
      const noticeCopy = expiredPendingOrder.status === "CANCELLED"
        ? "Đơn hàng đã bị hủy (CANCELLED)"
        : "Thời hạn giữ chỗ đơn hàng đã kết thúc (15 phút)";
      assert.equal(noticeCopy, "Thời hạn giữ chỗ đơn hàng đã kết thúc (15 phút)");
      assert.equal(noticeCopy.includes("CANCELLED"), false);
      assert.equal(noticeCopy.includes("bị hủy"), false);

      const cancelledOrder: OrderConfirmationData = {
        ...mockOrderFailed,
        status: "CANCELLED",
        expiresAt: new Date(now - 1000).toISOString(),
      };
      const cancelledNoticeCopy = cancelledOrder.status === "CANCELLED"
        ? "Đơn hàng đã bị hủy (CANCELLED)"
        : "Thời hạn giữ chỗ đơn hàng đã kết thúc (15 phút)";
      assert.equal(cancelledNoticeCopy, "Đơn hàng đã bị hủy (CANCELLED)");
    });

    it("should correctly distinguish practical lifecycle presentation copy for PAID, PREPARING, READY, COMPLETED", () => {
      function getOrderPresentationCopy(status: string) {
        switch (status) {
          case "COMPLETED":
            return {
              badge: "ĐÃ HOÀN THÀNH (COMPLETED)",
              eta: "Đã hoàn tất (Đã giao trọn vẹn cho khách hàng)",
              step2: "Đã pha chế xong",
              step3: "Đã giao hàng",
              step4: "Hoàn tất đơn hàng",
              barista: "Đã phục vụ",
            };
          case "READY":
            return {
              badge: "SẴN SÀNG PHỤC VỤ (READY)",
              eta: "Sẵn sàng ngay (Đồ uống đã hoàn tất tại quầy)",
              step2: "Đã pha chế xong",
              step3: "Sẵn sàng phục vụ",
              step4: "Giao tận tay",
              barista: "Đã sẵn sàng",
            };
          case "PREPARING":
            return {
              badge: "ĐANG PHA CHẾ (PREPARING)",
              eta: "10 - 15 phút (Đang trong quá trình pha chế thủ công)",
              step2: "Đang pha chế thủ công",
              step3: "Chờ giao hàng",
              step4: "Giao tận tay",
              barista: "Đang chiết xuất",
            };
          case "PAID":
          default:
            return {
              badge: "ĐÃ THANH TOÁN (PAID)",
              eta: "15 - 25 phút (Đã tiếp nhận, chuẩn bị vào quầy)",
              step2: "Chờ pha chế",
              step3: "Chờ giao hàng",
              step4: "Giao tận tay",
              barista: "Chờ tiếp nhận",
            };
        }
      }

      const paidCopy = getOrderPresentationCopy("PAID");
      assert.equal(paidCopy.badge, "ĐÃ THANH TOÁN (PAID)");
      assert.equal(paidCopy.step2, "Chờ pha chế");
      assert.equal(paidCopy.barista, "Chờ tiếp nhận");

      const prepCopy = getOrderPresentationCopy("PREPARING");
      assert.equal(prepCopy.badge, "ĐANG PHA CHẾ (PREPARING)");
      assert.equal(prepCopy.step2, "Đang pha chế thủ công");
      assert.equal(prepCopy.barista, "Đang chiết xuất");

      const readyCopy = getOrderPresentationCopy("READY");
      assert.equal(readyCopy.badge, "SẴN SÀNG PHỤC VỤ (READY)");
      assert.equal(readyCopy.step2, "Đã pha chế xong");
      assert.equal(readyCopy.step3, "Sẵn sàng phục vụ");
      assert.equal(readyCopy.barista, "Đã sẵn sàng");

      const compCopy = getOrderPresentationCopy("COMPLETED");
      assert.equal(compCopy.badge, "ĐÃ HOÀN THÀNH (COMPLETED)");
      assert.equal(compCopy.step3, "Đã giao hàng");
      assert.equal(compCopy.step4, "Hoàn tất đơn hàng");
      assert.equal(compCopy.barista, "Đã phục vụ");
    });

    it("should rotate Idempotency-Key upon 409 IDEMPOTENCY_KEY_CONFLICT and NOT treat it as INVALID_TRANSITION", () => {
      const originalKey = generateIdempotencyKey();
      let currentKey = originalKey;
      let isNetworkUncertain = false;
      let isRefetched = false;

      // Simulate error handling logic in PaymentFailedRetryView
      const errorResponse = {
        statusCode: 409,
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "IDEMPOTENCY_KEY_CONFLICT: Khóa đã được sử dụng với payload khác",
      };

      const msg = errorResponse.message;
      const errCode = errorResponse.code;
      const statusCode = errorResponse.statusCode;

      const isIdempotencyConflict =
        errCode === "IDEMPOTENCY_KEY_CONFLICT" ||
        msg.includes("IDEMPOTENCY_KEY_CONFLICT");

      const isNetworkErr =
        errCode === "PAYMENT_IN_PROGRESS" ||
        msg.includes("PAYMENT_IN_PROGRESS");

      if (isIdempotencyConflict) {
        isNetworkUncertain = false;
        currentKey = generateIdempotencyKey(); // ROTATE KEY
      } else if (isNetworkErr) {
        isNetworkUncertain = true;
      } else if (
        errCode === "INVALID_TRANSITION" ||
        msg.includes("INVALID_TRANSITION") ||
        (statusCode === 409 && !isIdempotencyConflict && !isNetworkErr)
      ) {
        isRefetched = true;
      }

      assert.equal(isIdempotencyConflict, true);
      assert.equal(isRefetched, false, "IDEMPOTENCY_KEY_CONFLICT must NOT trigger INVALID_TRANSITION refetch branch");
      assert.notEqual(currentKey, originalKey, "Idempotency-Key must be rotated to a fresh key");
      assert.equal(isNetworkUncertain, false);
    });

    it("should refetch server truth when encountering true 409 INVALID_TRANSITION", async () => {
      let isRefetched = false;
      let newStatus: string | undefined;

      const errorResponse = {
        statusCode: 409,
        code: "INVALID_TRANSITION",
        message: "INVALID_TRANSITION: Cannot transition order from CANCELLED to PAID",
      };

      const msg = errorResponse.message;
      const errCode = errorResponse.code;
      const statusCode = errorResponse.statusCode;

      const isIdempotencyConflict =
        errCode === "IDEMPOTENCY_KEY_CONFLICT" ||
        msg.includes("IDEMPOTENCY_KEY_CONFLICT");

      const isNetworkErr =
        errCode === "PAYMENT_IN_PROGRESS" ||
        msg.includes("PAYMENT_IN_PROGRESS");

      const isInvalidTransition =
        errCode === "INVALID_TRANSITION" ||
        msg.includes("INVALID_TRANSITION") ||
        (statusCode === 409 && !isIdempotencyConflict && !isNetworkErr);

      assert.equal(isIdempotencyConflict, false);
      assert.equal(isInvalidTransition, true);

      if (isInvalidTransition) {
        // Mock onRetryFailure refetching server truth
        const mockReloadedOrder = {
          ...mockOrderFailed,
          status: "CANCELLED",
        };
        isRefetched = true;
        newStatus = mockReloadedOrder.status;
      }

      assert.equal(isRefetched, true);
      assert.equal(newStatus, "CANCELLED");
    });

    it("should completely omit retry form and submit button when order status becomes CANCELLED (terminal state)", () => {
      // Simulate UI render predicate in PaymentFailedRetryView
      function shouldRenderRetryForm(orderStatus: string, isExpired: boolean) {
        const isCancelled = orderStatus === "CANCELLED";
        const isTerminal = isExpired || isCancelled;
        return {
          renderForm: !isTerminal,
          renderTerminalNotice: isTerminal,
          isCancelled,
        };
      }

      // Case 1: Active order in PAYMENT_FAILED, not expired
      const failedState = shouldRenderRetryForm("PAYMENT_FAILED", false);
      assert.equal(failedState.renderForm, true);
      assert.equal(failedState.renderTerminalNotice, false);

      // Case 2: Active order in PENDING, not expired
      const pendingState = shouldRenderRetryForm("PENDING", false);
      assert.equal(pendingState.renderForm, true);
      assert.equal(pendingState.renderTerminalNotice, false);

      // Case 3: Server truth refetch returned CANCELLED -> Form and retry button must vanish completely
      const cancelledState = shouldRenderRetryForm("CANCELLED", false);
      assert.equal(cancelledState.renderForm, false, "Form must NOT render when CANCELLED");
      assert.equal(cancelledState.renderTerminalNotice, true, "Terminal notice must render when CANCELLED");
      assert.equal(cancelledState.isCancelled, true);

      // Case 4: Order expired (15 minutes) -> Form and retry button must vanish completely
      const expiredState = shouldRenderRetryForm("PAYMENT_FAILED", true);
      assert.equal(expiredState.renderForm, false, "Form must NOT render when expired");
      assert.equal(expiredState.renderTerminalNotice, true);
    });
  });

  describe("7. Behavior Matrix & Mounted Component Flow Tests (JSDOM)", () => {
    let dom: JSDOM;
    let originalWindow: unknown;
    let originalDocument: unknown;
    let originalSelf: unknown;
    let originalLocalStorage: unknown;
    let originalSessionStorage: unknown;
    let globalTarget: {
      window: unknown;
      document: unknown;
      self: unknown;
      localStorage: unknown;
      sessionStorage: unknown;
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    let originalActEnv: boolean | undefined;

    const setupDom = () => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
        url: "http://localhost/order-confirmation",
      });
      globalTarget = globalThis as unknown as typeof globalTarget;
      originalWindow = globalTarget.window;
      originalDocument = globalTarget.document;
      originalSelf = globalTarget.self;
      originalLocalStorage = globalTarget.localStorage;
      originalSessionStorage = globalTarget.sessionStorage;
      originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

      globalTarget.window = dom.window;
      globalTarget.document = dom.window.document;
      globalTarget.self = dom.window;
      globalTarget.localStorage = dom.window.localStorage;
      globalTarget.sessionStorage = dom.window.sessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
    };

    const cleanupDom = () => {
      globalTarget.window = originalWindow;
      globalTarget.document = originalDocument;
      globalTarget.self = originalSelf;
      globalTarget.localStorage = originalLocalStorage;
      globalTarget.sessionStorage = originalSessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      dom.window.close();
    };

    const createTestOrder = (overrides: Partial<OrderConfirmationData> = {}): OrderConfirmationData => ({
      id: "550e8400-e29b-41d4-a716-446655440099",
      status: "PAYMENT_FAILED",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      subtotalVnd: 85000,
      discountVnd: 0,
      totalVnd: 85000,
      couponCode: null,
      payment: null,
      pointsEarned: 0,
      items: [
        {
          id: "item-test-1",
          productId: "prod-test-1",
          productName: "Cà phê Sữa Đá",
          size: "M",
          sizeMultiplierPercent: 100,
          basePriceVnd: 85000,
          quantity: 1,
          unitPriceVnd: 85000,
          lineTotalVnd: 85000,
          toppings: [],
        },
      ],
      ...overrides,
    });

    it("should rotate idempotency key when receiving 409 IDEMPOTENCY_KEY_CONFLICT while preserving orderId and payload", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      const capturedKeys: string[] = [];
      const capturedPayloads: Array<Record<string, unknown>> = [];

      global.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/payments")) {
          const headers = (init?.headers || {}) as Record<string, string>;
          capturedKeys.push(headers["Idempotency-Key"] || headers["idempotency-key"]);
          capturedPayloads.push(JSON.parse(String(init?.body || "{}")));

          if (capturedKeys.length === 1) {
            return new Response(
              JSON.stringify({
                statusCode: 409,
                message: "IDEMPOTENCY_KEY_CONFLICT: Trùng khóa thanh toán",
                error: "Conflict",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            );
          } else {
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440077",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-REF-TEST-1234",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 8,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        let retrySuccessCalled = false;
        await act(async () => {
          root.render(
            React.createElement(PaymentFailedRetryView, {
              order: testOrder,
              token: mockToken,
              onRetrySuccess: () => {
                retrySuccessCalled = true;
              },
            })
          );
        });

        // 1. First submission -> triggers 409 IDEMPOTENCY_KEY_CONFLICT
        const submitBtn = container.querySelector("#btnSubmitRetryPayment") as HTMLButtonElement;
        assert.ok(submitBtn, "Nút submit retry payment phải tồn tại");

        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(capturedKeys.length, 1);
        assert.equal(retrySuccessCalled, false);
        // Notice conflict phải hiển thị trên UI
        assert.match(container.innerHTML, /mã giao dịch mới|IDEMPOTENCY_KEY_CONFLICT/i);

        // 2. Second submission -> query fresh submit button or dispatch form submit
        await act(async () => {
          const form = container.querySelector('form') as HTMLFormElement;
          if (form) {
            form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
          }
        });

        assert.equal(capturedKeys.length, 2);
        assert.notEqual(capturedKeys[0], capturedKeys[1], "Idempotency-Key lần 2 PHẢI khác lần 1 khi conflict");
        assert.equal(capturedPayloads[0].orderId, testOrder.id);
        assert.equal(capturedPayloads[1].orderId, testOrder.id);
        assert.equal(capturedPayloads[0].method, "CARD");
        assert.equal(capturedPayloads[1].method, "CARD");
        assert.deepEqual(capturedPayloads[0].paymentDetails, { cardNumber: "1234567890121234" });
        assert.deepEqual(capturedPayloads[1].paymentDetails, { cardNumber: "1234567890121234" });
        assert.deepEqual(capturedPayloads[0].paymentDetails, capturedPayloads[1].paymentDetails);
        assert.equal(retrySuccessCalled, true);
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should preserve the SAME idempotency key when retrying after a network failure", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      const capturedKeys: string[] = [];

      global.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/payments")) {
          const headers = (init?.headers || {}) as Record<string, string>;
          capturedKeys.push(headers["Idempotency-Key"] || headers["idempotency-key"]);

          if (capturedKeys.length === 1) {
            throw new TypeError("Failed to fetch (Network connection lost)");
          } else {
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440077",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-REF-TEST-1234",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 8,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        let retrySuccessCalled = false;
        await act(async () => {
          root.render(
            React.createElement(PaymentFailedRetryView, {
              order: testOrder,
              token: mockToken,
              onRetrySuccess: () => {
                retrySuccessCalled = true;
              },
            })
          );
        });

        const submitBtn = container.querySelector("#btnSubmitRetryPayment") as HTMLButtonElement;
        assert.ok(submitBtn);

        // Lần 1: Lỗi mạng
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(capturedKeys.length, 1);
        assert.equal(retrySuccessCalled, false);
        assert.match(container.innerHTML, /Không thể kết nối đến máy chủ|Idempotency-Key đã được giữ nguyên/i);

        // Lần 2: Thử lại -> BẮT BUỘC giữ nguyên Idempotency-Key cũ
        await act(async () => {
          submitBtn.click();
        });

        assert.equal(capturedKeys.length, 2);
        assert.equal(capturedKeys[0], capturedKeys[1], "Network error BẮT BUỘC giữ nguyên cùng 1 Idempotency-Key");
        assert.equal(retrySuccessCalled, true);
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should completely remove retry form when 409 INVALID_TRANSITION causes refetch returning CANCELLED", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      let currentOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              statusCode: 409,
              message: "INVALID_TRANSITION: Order cannot transition from CANCELLED",
              error: "Conflict",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        let reloadCalled = false;
        const mockReload = async (): Promise<OrderConfirmationData | null> => {
          reloadCalled = true;
          currentOrder = {
            ...currentOrder,
            status: "CANCELLED",
          };
          return currentOrder;
        };

        const renderComponent = () =>
          React.createElement(PaymentFailedRetryView, {
            order: currentOrder,
            token: mockToken,
            onRetrySuccess: () => {},
            onRetryFailure: mockReload,
          });

        await act(async () => {
          root.render(renderComponent());
        });

        // Form ban đầu hiển thị
        assert.ok(container.querySelector("#btnSubmitRetryPayment"));

        // Click retry -> nhận 409 INVALID_TRANSITION -> kích hoạt onReloadOrder
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(reloadCalled, true);

        // Re-render với updated order (mô phỏng Confirmation page sau khi refetch server truth)
        await act(async () => {
          root.render(renderComponent());
        });

        // Form retry và submit button phải biến mất hoàn toàn
        assert.equal(container.querySelector("#btnSubmitRetryPayment"), null);
        assert.equal(container.querySelector("form"), null);
        assert.ok(container.querySelector("#orderTerminalStateNotice"));
        assert.match(container.innerHTML, /đã bị hủy/i);
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should enter blocking error state and lock retry when refetching server truth fails after 409 INVALID_TRANSITION", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              statusCode: 409,
              message: "INVALID_TRANSITION: State changed unexpectedly",
              error: "Conflict",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        let shouldFailReload = true;
        const mockReload = async (): Promise<OrderConfirmationData | null> => {
          if (shouldFailReload) {
            // Server error khi fetch GET /orders/me
            return null;
          }
          return {
            ...testOrder,
            status: "PENDING",
          };
        };

        await act(async () => {
          root.render(
            React.createElement(PaymentFailedRetryView, {
              order: testOrder,
              token: mockToken,
              onRetrySuccess: () => {},
              onRetryFailure: mockReload,
            })
          );
        });

        // Click retry
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        // Kiểm tra blocking error state: form retry biến mất, notice cảnh báo xuất hiện
        assert.equal(container.querySelector("#btnSubmitRetryPayment"), null);
        assert.ok(container.querySelector("#serverSyncFailedNotice"), "Phải hiển thị serverSyncFailedNotice");
        assert.match(container.innerHTML, /Chưa thể xác định trạng thái đơn hàng từ máy chủ|Biểu mẫu thử lại đã được khóa/i);

        // Nút thử đồng bộ lại phải xuất hiện
        const btnManualSync = container.querySelector("#btnRetrySyncServerTruth") as HTMLButtonElement;
        assert.ok(btnManualSync, "Phải có nút thử đồng bộ lại");

        // Giả lập server hồi phục, user bấm nút đồng bộ lại
        shouldFailReload = false;
        await act(async () => {
          btnManualSync.click();
        });

        // Form retry phải được mở khóa trở lại
        assert.ok(container.querySelector("#btnSubmitRetryPayment"), "Form retry phải quay lại sau khi sync server truth thành công");
        assert.equal(container.querySelector("#serverSyncFailedNotice"), null);
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should mount component with CartProvider and verify Cart only clears once upon confirmed Payment SUCCESS, and NEVER clears on FAILED, network error, or 409", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      const sampleCartItem = {
        id: "cart-item-1",
        productId: "550e8400-e29b-41d4-a716-446655440001",
        productName: "Cà phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 100,
        basePriceVnd: 35000,
        quantity: 2,
        unitPriceVnd: 35000,
        lineTotalVnd: 70000,
        toppings: [],
      };

      const CART_KEY = "brewlite_cart_v1";

      function MountedOrderConfirmationHarness({
        order,
        onSuccessCb,
      }: {
        order: OrderConfirmationData;
        onSuccessCb?: () => void;
      }) {
        const { items, clearCart } = useCart();

        // Exact handler from frontend/app/order-confirmation/page.tsx:
        const handleRetrySuccess = async () => {
          clearCart();
          clearStoredActiveOrder();
          onSuccessCb?.();
        };

        return React.createElement(
          "div",
          null,
          React.createElement("span", { id: "liveCartCount" }, String(items.length)),
          React.createElement(PaymentFailedRetryView, {
            order,
            token: mockToken,
            onRetrySuccess: handleRetrySuccess,
            onRetryFailure: async () => null,
          })
        );
      }

      const mountHarness = async (scenarioKey: string, onSuccessCb?: () => void) => {
        dom.window.localStorage.setItem(CART_KEY, JSON.stringify([sampleCartItem]));
        dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

        await act(async () => {
          root.render(
            React.createElement(
              CartProvider as React.ComponentType<{ key?: string }>,
              { key: scenarioKey },
              React.createElement(MountedOrderConfirmationHarness, {
                order: testOrder,
                onSuccessCb,
              })
            )
          );
        });
      };

      try {
        // --- CASE 1: Payment FAILED (PAYMENT_DECLINED) -> Cart MUST be preserved ---
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes("/payments")) {
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440071",
                orderId: testOrder.id,
                paymentStatus: "FAILED",
                orderStatus: "PAYMENT_FAILED",
                method: "CARD",
                methodLast4: "0002",
                mockReference: "MOCK-REF-FAILED",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 0,
                failureReason: "PAYMENT_DECLINED",
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not found", { status: 404 });
        };

        await mountHarness("case-failed");
        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1", "Giỏ hàng phải có 1 item ban đầu");

        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1", "Giỏ hàng KHÔNG được clear khi payment FAILED");
        assert.ok(dom.window.localStorage.getItem(CART_KEY), "LocalStorage cart phải được giữ nguyên khi payment FAILED");

        // --- CASE 2: Network Error -> Cart MUST be preserved ---
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes("/payments")) {
            throw new TypeError("Failed to fetch (offline)");
          }
          return new Response("Not found", { status: 404 });
        };

        await mountHarness("case-network");
        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1");

        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1", "Giỏ hàng KHÔNG được clear khi gặp lỗi mạng");
        assert.ok(dom.window.localStorage.getItem(CART_KEY), "LocalStorage cart phải được giữ nguyên khi gặp lỗi mạng");

        // --- CASE 3: 409 INVALID_TRANSITION -> Cart MUST be preserved ---
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes("/payments")) {
            return new Response(
              JSON.stringify({
                statusCode: 409,
                message: "INVALID_TRANSITION: Cannot transition order",
                error: "Conflict",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not found", { status: 404 });
        };

        await mountHarness("case-409");
        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1");

        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1", "Giỏ hàng KHÔNG được clear khi 409 INVALID_TRANSITION");
        assert.ok(dom.window.localStorage.getItem(CART_KEY), "LocalStorage cart phải được giữ nguyên khi 409");

        // --- CASE 4: Payment SUCCESS -> Cart MUST be cleared exactly once ---
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes("/payments")) {
            return new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440079",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-REF-SUCCESS",
                amountVnd: testOrder.totalVnd,
                pointsEarned: 8,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not found", { status: 404 });
        };

        let successCallbackCalled = false;
        await mountHarness("case-success", () => {
          successCallbackCalled = true;
        });

        assert.equal(container.querySelector("#liveCartCount")?.textContent, "1");

        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(successCallbackCalled, true, "onRetrySuccess phải được gọi khi payment SUCCESS");
        assert.equal(container.querySelector("#liveCartCount")?.textContent, "0", "Giỏ hàng phải được xóa về 0 sau khi retry SUCCESS");
        const finalStorageCart = dom.window.localStorage.getItem(CART_KEY);
        assert.ok(!finalStorageCart || finalStorageCart === "[]", "LocalStorage cart phải được clear sau SUCCESS");
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });
  });


  describe("8. Strict ISO 8601 UTC Timestamp Runtime Validation Tests (API Contract v3.0)", () => {
    let dom: JSDOM;
    let originalWindow: unknown;
    let originalDocument: unknown;
    let originalSelf: unknown;
    let originalLocalStorage: unknown;
    let originalSessionStorage: unknown;
    let globalTarget: {
      window: unknown;
      document: unknown;
      self: unknown;
      localStorage: unknown;
      sessionStorage: unknown;
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    let originalActEnv: boolean | undefined;

    const setupDom = () => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
        url: "http://localhost/order-confirmation",
      });
      globalTarget = globalThis as unknown as typeof globalTarget;
      originalWindow = globalTarget.window;
      originalDocument = globalTarget.document;
      originalSelf = globalTarget.self;
      originalLocalStorage = globalTarget.localStorage;
      originalSessionStorage = globalTarget.sessionStorage;
      originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

      globalTarget.window = dom.window;
      globalTarget.document = dom.window.document;
      globalTarget.self = dom.window;
      globalTarget.localStorage = dom.window.localStorage;
      globalTarget.sessionStorage = dom.window.sessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
    };

    const cleanupDom = () => {
      globalTarget.window = originalWindow;
      globalTarget.document = originalDocument;
      globalTarget.self = originalSelf;
      globalTarget.localStorage = originalLocalStorage;
      globalTarget.sessionStorage = originalSessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      dom.window.close();
    };

    it("should strictly validate ISO 8601 UTC strings and reject parseable but non-ISO UTC strings", () => {
      // Valid ISO 8601 UTC strings
      assert.equal(isValidIsoUtcString("2026-10-25T02:00:00.000Z"), true);
      assert.equal(isValidIsoUtcString("2026-10-25T02:00:00Z"), true);
      assert.equal(isValidIsoUtcString("2026-10-25T02:00:00.123456Z"), true);

      // Parseable by Date.parse() but VIOLATE ISO 8601 UTC Contract:
      assert.equal(isValidIsoUtcString("2026-10-29 10:00:00"), false, "Space separator without T/Z must be rejected");
      assert.equal(isValidIsoUtcString("10/29/2026"), false, "US date format must be rejected");
      assert.equal(isValidIsoUtcString("Thu, 29 Oct 2026 10:00:00 GMT"), false, "RFC 2822 format must be rejected");
      assert.equal(isValidIsoUtcString("2026-10-29T10:00:00+07:00"), false, "Non-UTC timezone offset (+07:00) must be rejected");
      assert.equal(isValidIsoUtcString("2026-10-29T10:00:00-05:00"), false, "Non-UTC timezone offset (-05:00) must be rejected");
      assert.equal(isValidIsoUtcString("2026-10-29T10:00:00"), false, "Missing UTC Z indicator must be rejected");
      assert.equal(isValidIsoUtcString("2026-10-29"), false, "Date-only string must be rejected");
      assert.equal(isValidIsoUtcString(""), false, "Empty string must be rejected");
      assert.equal(isValidIsoUtcString(null), false, "null must be rejected");
      assert.equal(isValidIsoUtcString(undefined), false, "undefined must be rejected");
      assert.equal(isValidIsoUtcString(123456789), false, "number must be rejected");
    });

    it("should return 0 from computeOrderRemainingSeconds when expiresAt is parseable but not ISO UTC", () => {
      const now = Date.now();
      // "2026-10-29 10:00:00" is parseable by Date.parse but NOT valid ISO UTC
      assert.equal(computeOrderRemainingSeconds("2026-10-29 10:00:00", now), 0);
      assert.equal(computeOrderRemainingSeconds("10/29/2026", now), 0);
      assert.equal(computeOrderRemainingSeconds("Thu, 29 Oct 2026 10:00:00 GMT", now), 0);
      assert.equal(computeOrderRemainingSeconds("2026-10-29T10:00:00+07:00", now), 0);
    });

    it("should reject validatePaymentResponseData when createdAt is parseable but not ISO UTC (502 INTERNAL_ERROR)", () => {
      const mockKey = "test-idempotency-key-1234";
      const samplePayload = {
        paymentId: "550e8400-e29b-41d4-a716-446655440077",
        orderId: "550e8400-e29b-41d4-a716-446655440010",
        paymentStatus: "SUCCESS",
        orderStatus: "PAID",
        method: "CARD",
        methodLast4: "1234",
        mockReference: "MOCK-REF-1234",
        amountVnd: 70000,
        pointsEarned: 7,
        failureReason: null,
        createdAt: "2026-10-29 10:00:00", // Parseable by Date.parse but NOT ISO UTC!
      };

      assert.throws(
        () => validatePaymentResponseData(samplePayload, mockKey),
        (err: unknown) => {
          const e = err as { statusCode?: number; code?: string; message?: string };
          return (
            e.statusCode === 502 &&
            e.code === "INTERNAL_ERROR" &&
            Boolean(e.message?.includes("ISO 8601 UTC"))
          );
        }
      );

      // Also reject with timezone offset +07:00
      assert.throws(
        () =>
          validatePaymentResponseData(
            { ...samplePayload, createdAt: "2026-10-29T10:00:00+07:00" },
            mockKey
          ),
        /ISO 8601 UTC/
      );
    });

    it("should reject validateMyOrderSnapshot when createdAt, expiresAt or payment.createdAt is parseable but not ISO UTC", () => {
      const validOrderObj = {
        id: "550e8400-e29b-41d4-a716-446655440010",
        status: "PENDING",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        subtotalVnd: 70000,
        discountVnd: 0,
        totalVnd: 70000,
        couponCode: null,
        pointsEarned: 0,
        payment: null,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà phê Sữa Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 35000,
            quantity: 2,
            unitPriceVnd: 35000,
            lineTotalVnd: 70000,
            toppings: [],
          },
        ],
      };

      // Valid order returns object
      assert.ok(validateMyOrderSnapshot(validOrderObj));

      // Reject non-ISO createdAt
      assert.equal(
        validateMyOrderSnapshot({ ...validOrderObj, createdAt: "2026-10-29 10:00:00" }),
        null
      );
      assert.equal(
        validateMyOrderSnapshot({ ...validOrderObj, createdAt: "2026-10-29T10:00:00+07:00" }),
        null
      );

      // Reject non-ISO expiresAt
      assert.equal(
        validateMyOrderSnapshot({ ...validOrderObj, expiresAt: "2026-10-29 10:00:00" }),
        null
      );
      assert.equal(
        validateMyOrderSnapshot({ ...validOrderObj, expiresAt: "10/29/2026" }),
        null
      );

      // Reject non-ISO payment.createdAt
      assert.equal(
        validateMyOrderSnapshot({
          ...validOrderObj,
          payment: {
            id: "550e8400-e29b-41d4-a716-446655440077",
            status: "SUCCESS",
            method: "CARD",
            methodLast4: "1234",
            amountVnd: 70000,
            mockReference: "MOCK-REF-1234",
            failureReason: null,
            createdAt: "2026-10-29 10:00:00", // Non-ISO
          },
        }),
        null
      );
    });

    it("should strictly validate PaymentSummary in GET /orders/me without silent defaulting or coercion, and fail response validation on any malformed field", async () => {
      const baseValidPayment = {
        id: "550e8400-e29b-41d4-a716-446655440077",
        status: "SUCCESS",
        method: "CARD",
        methodLast4: "1234",
        amountVnd: 70000,
        mockReference: "MOCK-REF-1234",
        failureReason: null,
        createdAt: "2026-10-29T10:00:00.000Z",
      };

      const baseValidOrder: Record<string, unknown> = {
        id: "550e8400-e29b-41d4-a716-446655440010",
        status: "PAID",
        createdAt: "2026-10-29T09:50:00.000Z",
        expiresAt: "2026-10-29T10:05:00.000Z",
        subtotalVnd: 70000,
        discountVnd: 0,
        totalVnd: 70000,
        couponCode: null,
        pointsEarned: 7,
        payment: baseValidPayment,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà phê Sữa Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 35000,
            quantity: 2,
            unitPriceVnd: 35000,
            lineTotalVnd: 70000,
            toppings: [],
          },
        ],
      };

      const isInternal502 = (err: unknown) => {
        const e = err as { statusCode?: number; code?: string } | null;
        return Boolean(e && e.statusCode === 502 && e.code === "INTERNAL_ERROR");
      };

      // 1. Valid PaymentSummary and payment = null both succeed
      const validWithPayment = validateMyOrdersResponse({ items: [baseValidOrder] });
      assert.equal(validWithPayment.items.length, 1);
      assert.equal(validWithPayment.items[0].payment?.method, "CARD");
      assert.equal(validWithPayment.items[0].payment?.methodLast4, "1234");

      const validWithNullPayment = validateMyOrdersResponse({
        items: [{ ...baseValidOrder, status: "PENDING", pointsEarned: 0, payment: null }],
      });
      assert.equal(validWithNullPayment.items.length, 1);
      assert.equal(validWithNullPayment.items[0].payment, null);

      // 2. Missing field 'payment' (omitted or undefined) MUST be rejected
      const orderMissingPaymentField = { ...baseValidOrder };
      delete orderMissingPaymentField.payment;
      assert.equal(validateMyOrderSnapshot(orderMissingPaymentField), null);
      assert.throws(() => validateMyOrdersResponse({ items: [orderMissingPaymentField] }), isInternal502);
      assert.equal(validateMyOrderSnapshot({ ...baseValidOrder, payment: undefined }), null);
      assert.throws(
        () => validateMyOrdersResponse({ items: [{ ...baseValidOrder, payment: undefined }] }),
        isInternal502
      );

      // 3. Invalid 'method' (must NOT silently default to "CARD")
      for (const badMethod of ["CASH", "BANK_TRANSFER", "INVALID", "", null, undefined, 123, {}]) {
        assert.equal(
          validatePaymentSnapshot({ ...baseValidPayment, method: badMethod }),
          null,
          `method=${JSON.stringify(badMethod)} must be rejected`
        );
        assert.throws(
          () =>
            validateMyOrdersResponse({
              items: [{ ...baseValidOrder, payment: { ...baseValidPayment, method: badMethod } }],
            }),
          isInternal502
        );
      }

      // 4. Missing required fields in PaymentSummary (must NOT coerce to null or defaults)
      const requiredPaymentFields = [
        "id",
        "status",
        "method",
        "methodLast4",
        "amountVnd",
        "mockReference",
        "failureReason",
        "createdAt",
      ];
      for (const field of requiredPaymentFields) {
        const incompletePayment: Record<string, unknown> = { ...baseValidPayment };
        delete incompletePayment[field];
        assert.equal(
          validatePaymentSnapshot(incompletePayment),
          null,
          `Missing field '${field}' in PaymentSummary must be rejected`
        );
        assert.throws(
          () =>
            validateMyOrdersResponse({
              items: [{ ...baseValidOrder, payment: incompletePayment }],
            }),
          isInternal502,
          `Missing field '${field}' in PaymentSummary must fail response validation`
        );
      }

      // 5. Wrong types / invalid formats for methodLast4, amountVnd, createdAt, mockReference, failureReason
      // 5a. methodLast4 wrong type or invalid pattern (must NOT coerce to null)
      for (const badLast4 of [1234, true, "12", "12345", "abcd", "", {}]) {
        assert.equal(
          validatePaymentSnapshot({ ...baseValidPayment, methodLast4: badLast4 }),
          null,
          `methodLast4=${JSON.stringify(badLast4)} must be rejected`
        );
        assert.throws(
          () =>
            validateMyOrdersResponse({
              items: [{ ...baseValidOrder, payment: { ...baseValidPayment, methodLast4: badLast4 } }],
            }),
          isInternal502
        );
      }
      // Valid nullable methodLast4 = null is accepted
      assert.ok(validatePaymentSnapshot({ ...baseValidPayment, methodLast4: null }));

      // 5b. amountVnd wrong type or negative/float
      for (const badAmount of ["70000", -1, 70000.5, NaN, null, undefined, true]) {
        assert.equal(
          validatePaymentSnapshot({ ...baseValidPayment, amountVnd: badAmount }),
          null,
          `amountVnd=${JSON.stringify(badAmount)} must be rejected`
        );
        assert.throws(
          () =>
            validateMyOrdersResponse({
              items: [{ ...baseValidOrder, payment: { ...baseValidPayment, amountVnd: badAmount } }],
            }),
          isInternal502
        );
      }

      // 5c. createdAt wrong type or non-ISO UTC
      for (const badCreatedAt of [1730200000000, "2026-10-29 10:00:00", "10/29/2026", "not-a-date", null, undefined, {}]) {
        assert.equal(
          validatePaymentSnapshot({ ...baseValidPayment, createdAt: badCreatedAt }),
          null,
          `createdAt=${JSON.stringify(badCreatedAt)} must be rejected`
        );
        assert.throws(
          () =>
            validateMyOrdersResponse({
              items: [{ ...baseValidOrder, payment: { ...baseValidPayment, createdAt: badCreatedAt } }],
            }),
          isInternal502
        );
      }

      // 5d. mockReference & failureReason wrong type/enum (must NOT coerce to null)
      for (const badRef of [12345, "", "   ", true, {}]) {
        assert.equal(validatePaymentSnapshot({ ...baseValidPayment, mockReference: badRef }), null);
      }
      for (const badReason of ["UNKNOWN_REASON", "INSUFFICIENT_FUNDS", "", 123, true, {}]) {
        assert.equal(validatePaymentSnapshot({ ...baseValidPayment, failureReason: badReason }), null);
      }

      // 6. End-to-end fetchMyOrdersApi must reject when GET /orders/me returns malformed PaymentSummary
      const mockToken = createValidMockJwt();
      global.fetch = async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                ...baseValidOrder,
                payment: {
                  ...baseValidPayment,
                  method: "INVALID_METHOD",
                  methodLast4: 1234,
                },
              },
            ],
            meta: { page: null, limit: null, total: 1, totalPages: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );

      await assert.rejects(
        async () => fetchMyOrdersApi(mockToken),
        isInternal502,
        "fetchMyOrdersApi must reject when PaymentSummary is malformed"
      );
    });

    it("should NEVER clear Cart when POST /payments returns HTTP 200 with malformed non-ISO timestamp", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder: OrderConfirmationData = {
        id: "550e8400-e29b-41d4-a716-446655440099",
        status: "PAYMENT_FAILED",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 70000,
        discountVnd: 0,
        totalVnd: 70000,
        couponCode: null,
        payment: null,
        pointsEarned: 0,
        items: [
          {
            id: "item-1",
            productId: "prod-1",
            productName: "Cà phê Sữa Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 70000,
            quantity: 1,
            unitPriceVnd: 70000,
            lineTotalVnd: 70000,
            toppings: [],
          },
        ],
      };
      const mockToken = createValidMockJwt();

      const sampleCartItem = {
        id: "cart-item-1",
        productId: "prod-1",
        productName: "Cà phê Sữa Đá",
        size: "M",
        sizeMultiplierPercent: 100,
        basePriceVnd: 70000,
        quantity: 1,
        unitPriceVnd: 70000,
        lineTotalVnd: 70000,
        toppings: [],
      };

      const CART_KEY = "brewlite_cart_v1";
      dom.window.localStorage.setItem(CART_KEY, JSON.stringify([sampleCartItem]));
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      // Server returns HTTP 200 but createdAt is non-ISO format "2026-10-29 10:00:00"
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              paymentId: "550e8400-e29b-41d4-a716-446655440077",
              orderId: testOrder.id,
              paymentStatus: "SUCCESS",
              orderStatus: "PAID",
              method: "CARD",
              methodLast4: "1234",
              mockReference: "MOCK-REF-1234",
              amountVnd: 70000,
              pointsEarned: 7,
              failureReason: null,
              createdAt: "2026-10-29 10:00:00", // MALFORMED NON-ISO TIMESTAMP
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      function Harness() {
        const { items, clearCart } = useCart();
        return React.createElement(
          "div",
          null,
          React.createElement("span", { id: "testCartCount" }, String(items.length)),
          React.createElement(PaymentFailedRetryView, {
            order: testOrder,
            token: mockToken,
            onRetrySuccess: async () => {
              clearCart();
            },
            onRetryFailure: async () => null,
          })
        );
      }

      try {
        await act(async () => {
          root.render(
            React.createElement(
              CartProvider as React.ComponentType<{ key?: string }>,
              { key: "malformed-timestamp-test" },
              React.createElement(Harness)
            )
          );
        });

        assert.equal(container.querySelector("#testCartCount")?.textContent, "1");

        // Submit form
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        // Error message appears
        assert.match(container.innerHTML, /ISO 8601/i);

        // CART MUST BE PRESERVED! MUST NOT BE CLEARED!
        assert.equal(
          container.querySelector("#testCartCount")?.textContent,
          "1",
          "Giỏ hàng TUYỆT ĐỐI KHÔNG được xóa khi HTTP 200 malformed timestamp!"
        );
        const storedCart = dom.window.localStorage.getItem(CART_KEY);
        assert.ok(storedCart && storedCart !== "[]", "LocalStorage cart phải được giữ nguyên");
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });
  });

  describe("9. Enhanced Mounted Component Lifecycle Tests (409 -> PAID, Double-submit, Refetch according to orderId, Exactly-once Cart Clear)", () => {
    let dom: JSDOM;
    let originalWindow: unknown;
    let originalDocument: unknown;
    let originalSelf: unknown;
    let originalLocalStorage: unknown;
    let originalSessionStorage: unknown;
    let globalTarget: {
      window: unknown;
      document: unknown;
      self: unknown;
      localStorage: unknown;
      sessionStorage: unknown;
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    let originalActEnv: boolean | undefined;

    const setupDom = () => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
        url: "http://localhost/order-confirmation?orderId=550e8400-e29b-41d4-a716-446655440099",
      });
      globalTarget = globalThis as unknown as typeof globalTarget;
      originalWindow = globalTarget.window;
      originalDocument = globalTarget.document;
      originalSelf = globalTarget.self;
      originalLocalStorage = globalTarget.localStorage;
      originalSessionStorage = globalTarget.sessionStorage;
      originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

      globalTarget.window = dom.window;
      globalTarget.document = dom.window.document;
      globalTarget.self = dom.window;
      globalTarget.localStorage = dom.window.localStorage;
      globalTarget.sessionStorage = dom.window.sessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
    };

    const cleanupDom = () => {
      globalTarget.window = originalWindow;
      globalTarget.document = originalDocument;
      globalTarget.self = originalSelf;
      globalTarget.localStorage = originalLocalStorage;
      globalTarget.sessionStorage = originalSessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      dom.window.close();
    };

    const createTestOrder = (): OrderConfirmationData => ({
      id: "550e8400-e29b-41d4-a716-446655440099",
      status: "PAYMENT_FAILED",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      subtotalVnd: 85000,
      discountVnd: 0,
      totalVnd: 85000,
      couponCode: null,
      payment: null,
      pointsEarned: 0,
      items: [
        {
          id: "item-test-1",
          productId: "prod-test-1",
          productName: "Cà phê Sữa Đá",
          size: "M",
          sizeMultiplierPercent: 100,
          basePriceVnd: 85000,
          quantity: 1,
          unitPriceVnd: 85000,
          lineTotalVnd: 85000,
          toppings: [],
        },
      ],
    });

    it("should handle 409 INVALID_TRANSITION -> refetch PAID: removes retry form, triggers onRetrySuccess and clears Cart exactly once", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      let currentOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      let clearCartCallCount = 0;
      const CART_KEY = "brewlite_cart_v1";
      dom.window.localStorage.setItem(
        CART_KEY,
        JSON.stringify([{ id: "cart-1", productId: "p-1", productName: "Item", size: "M", quantity: 1, basePriceVnd: 85000, unitPriceVnd: 85000, lineTotalVnd: 85000, toppings: [] }])
      );
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      // POST /payments returns 409 INVALID_TRANSITION (already paid in another tab)
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          return new Response(
            JSON.stringify({
              statusCode: 409,
              message: "INVALID_TRANSITION: Order is already PAID",
              error: "Conflict",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        let reloadCalled = false;
        const mockReload = async (): Promise<OrderConfirmationData | null> => {
          reloadCalled = true;
          currentOrder = {
            ...currentOrder,
            status: "PAID",
            payment: {
              id: "550e8400-e29b-41d4-a716-446655440078",
              status: "SUCCESS",
              method: "CARD",
              methodLast4: "1234",
              amountVnd: 85000,
              mockReference: "MOCK-PAID-ALREADY",
              failureReason: null,
              createdAt: new Date().toISOString(),
            },
          };
          return currentOrder;
        };

        function Harness() {
          const { items, clearCart } = useCart();
          const handleSuccess = async () => {
            clearCartCallCount++;
            clearCart();
            clearStoredActiveOrder();
          };

          return React.createElement(
            "div",
            null,
            React.createElement("span", { id: "liveCartNum" }, String(items.length)),
            React.createElement(PaymentFailedRetryView, {
              order: currentOrder,
              token: mockToken,
              onRetrySuccess: handleSuccess,
              onRetryFailure: mockReload,
            })
          );
        }

        await act(async () => {
          root.render(
            React.createElement(
              CartProvider as React.ComponentType<{ key?: string }>,
              { key: "409-paid-test" },
              React.createElement(Harness)
            )
          );
        });

        assert.equal(container.querySelector("#liveCartNum")?.textContent, "1");
        assert.ok(container.querySelector("#btnSubmitRetryPayment"));

        // Click retry -> 409 -> triggers mockReload returning PAID -> triggers onRetrySuccess
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(reloadCalled, true, "onRetryFailure phải được gọi để lấy server truth sau 409");
        assert.equal(clearCartCallCount, 1, "clearCart() PHẢI được gọi đúng một lần duy nhất");
        assert.equal(container.querySelector("#liveCartNum")?.textContent, "0", "Giỏ hàng phải chuyển về 0");

        // Notice chuyển hướng hoặc trạng thái thành công xuất hiện
        assert.match(container.innerHTML, /thành công trước đó|Đang chuyển hướng/i);
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should prevent concurrent double-submit while Retry payment is in-flight", async () => {
      setupDom();
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const testOrder = createTestOrder();
      const mockToken = createValidMockJwt();

      let paymentCallCount = 0;
      let resolvePaymentPromise!: (res: Response) => void;

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/payments")) {
          paymentCallCount++;
          return new Promise<Response>((resolve) => {
            resolvePaymentPromise = resolve;
          });
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(PaymentFailedRetryView, {
              order: testOrder,
              token: mockToken,
              onRetrySuccess: () => {},
              onRetryFailure: async () => null,
            })
          );
        });

        const submitBtn = container.querySelector("#btnSubmitRetryPayment") as HTMLButtonElement;
        assert.ok(submitBtn);
        assert.equal(submitBtn.disabled, false);

        // Submit lần 1 -> đưa vào trạng thái in-flight
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(paymentCallCount, 1, "Fetch phải được gọi lần 1");
        // Nút submit phải bị disabled trong lúc in-flight
        assert.equal(submitBtn.disabled, true, "Nút submit phải bị disabled khi đang gửi yêu cầu");

        // Cố gắng submit lần 2 trong khi in-flight
        await act(async () => {
          const form = container.querySelector("form") as HTMLFormElement;
          form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        });

        assert.equal(paymentCallCount, 1, "Fetch TUYỆT ĐỐI KHÔNG được gọi lần 2 khi đang in-flight (double-submit blocked)");

        // Hoàn tất response lần 1
        await act(async () => {
          resolvePaymentPromise(
            new Response(
              JSON.stringify({
                paymentId: "550e8400-e29b-41d4-a716-446655440077",
                orderId: testOrder.id,
                paymentStatus: "SUCCESS",
                orderStatus: "PAID",
                method: "CARD",
                methodLast4: "1234",
                mockReference: "MOCK-REF-1234",
                amountVnd: 85000,
                pointsEarned: 8,
                failureReason: null,
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        });
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("should strictly resolve target order by orderId and NEVER fallback to latest order", () => {
      const orderA: OrderConfirmationData = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        status: "PENDING",
        createdAt: "2026-10-29T10:00:00.000Z",
        expiresAt: "2026-10-29T10:15:00.000Z",
        subtotalVnd: 50000,
        discountVnd: 0,
        totalVnd: 50000,
        couponCode: null,
        payment: null,
        pointsEarned: 0,
        items: [],
      };
      const orderB: OrderConfirmationData = {
        id: "550e8400-e29b-41d4-a716-446655440002",
        status: "PAID",
        createdAt: "2026-10-29T09:00:00.000Z",
        expiresAt: "2026-10-29T09:15:00.000Z",
        subtotalVnd: 75000,
        discountVnd: 0,
        totalVnd: 75000,
        couponCode: null,
        payment: null,
        pointsEarned: 7,
        items: [],
      };

      const orders = [orderA, orderB];

      // Khi truyền đúng orderId của order B -> trả về order B
      assert.equal(findOrderForConfirmation(orders, "550e8400-e29b-41d4-a716-446655440002")?.id, orderB.id);

      // Khi URL không có orderId, null, undefined, hoặc chuỗi rỗng:
      // BẮT BUỘC trả về null, TUYỆT ĐỐI KHÔNG tự tiện fallback về order A (đơn mới nhất)
      assert.equal(findOrderForConfirmation(orders, null), null);
      assert.equal(findOrderForConfirmation(orders, undefined), null);
      assert.equal(findOrderForConfirmation(orders, ""), null);
      assert.equal(findOrderForConfirmation(orders, "   "), null);

      // Khi orderId không tồn tại hoặc sai định dạng UUID
      assert.equal(findOrderForConfirmation(orders, "550e8400-e29b-41d4-a716-446655440999"), null);
      assert.equal(findOrderForConfirmation(orders, "invalid-uuid"), null);
    });

    it("should validate Phase 2 payment snapshots (VNPAY PENDING, ZERO_AMOUNT, resolution, requiresReview, canRetry) and GET /payments/:id/status", async () => {
      const vnpayPending = validatePaymentSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440050",
        status: "PENDING",
        provider: "VNPAY",
        method: null,
        methodLast4: null,
        amountVnd: 85000,
        mockReference: null,
        failureReason: null,
        resolution: "PROCESSING",
        requiresReview: false,
        canRetry: false,
        createdAt: "2026-10-29T10:00:00.000Z",
      });
      assert.ok(vnpayPending !== null);
      assert.equal(vnpayPending.status, "PENDING");
      assert.equal(vnpayPending.provider, "VNPAY");
      assert.equal(vnpayPending.method, null);
      assert.equal(vnpayPending.resolution, "PROCESSING");
      assert.equal(vnpayPending.canRetry, false);

      const zeroAmount = validatePaymentSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440051",
        status: "SUCCESS",
        provider: "ZERO_AMOUNT",
        method: null,
        methodLast4: null,
        amountVnd: 0,
        mockReference: null,
        failureReason: null,
        resolution: "PAYMENT_ACCEPTED",
        requiresReview: false,
        canRetry: false,
        createdAt: "2026-10-29T10:00:00.000Z",
      });
      assert.ok(zeroAmount !== null);
      assert.equal(zeroAmount.status, "SUCCESS");
      assert.equal(zeroAmount.provider, "ZERO_AMOUNT");
      assert.equal(zeroAmount.amountVnd, 0);
      assert.equal(zeroAmount.resolution, "PAYMENT_ACCEPTED");

      assert.equal(
        validatePaymentSnapshot({
          id: "550e8400-e29b-41d4-a716-446655440052",
          status: "SUCCESS",
          provider: "ZERO_AMOUNT",
          method: null,
          methodLast4: null,
          amountVnd: 50000,
          mockReference: null,
          failureReason: null,
          createdAt: "2026-10-29T10:00:00.000Z",
        }),
        null
      );

      const now = Date.parse("2026-10-29T10:05:00.000Z");
      const baseOrder: OrderConfirmationData = {
        id: "550e8400-e29b-41d4-a716-446655440060",
        status: "PAYMENT_FAILED",
        createdAt: "2026-10-29T10:00:00.000Z",
        expiresAt: "2026-10-29T10:15:00.000Z",
        subtotalVnd: 85000,
        discountVnd: 0,
        totalVnd: 85000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440061",
          status: "FAILED",
          provider: "VNPAY",
          method: null,
          methodLast4: null,
          amountVnd: 85000,
          mockReference: null,
          failureReason: "24",
          resolution: "FAILED",
          requiresReview: false,
          canRetry: true,
          createdAt: "2026-10-29T10:01:00.000Z",
        },
      };
      assert.equal(canOrderRetryPayment(baseOrder, now), true);
      assert.equal(
        canOrderRetryPayment(
          {
            ...baseOrder,
            status: "PENDING",
            payment: {
              ...baseOrder.payment!,
              status: "PENDING",
              resolution: "PROCESSING",
              canRetry: false,
            },
          },
          now
        ),
        false
      );
      assert.equal(
        canOrderRetryPayment({ ...baseOrder, hasFinancialException: true }, now),
        false
      );

      const validToken = createValidMockJwt();
      const rawStatus = {
        paymentId: "550e8400-e29b-41d4-a716-446655440070",
        orderId: "550e8400-e29b-41d4-a716-446655440071",
        provider: "VNPAY",
        paymentStatus: "PENDING",
        orderStatus: "CANCELLED",
        amountVnd: 85000,
        resolution: "RECONCILING",
        requiresReview: false,
        canRetry: false,
        createdAt: "2026-10-29T10:00:00.000Z",
        orderExpiresAt: "2026-10-29T10:15:00.000Z",
        lastUpdatedAt: "2026-10-29T10:16:00.000Z",
      };
      const validated = validatePaymentStatusResponseData(rawStatus);
      assert.equal(validated.resolution, "RECONCILING");

      global.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => rawStatus,
      })) as unknown as typeof fetch;

      const apiRes = await fetchPaymentStatusApi(rawStatus.paymentId, validToken);
      assert.equal(apiRes.resolution, "RECONCILING");
      assert.equal(apiRes.orderStatus, "CANCELLED");
    });
  });

  describe("10. SCRUM-88 Review Fixes: Bounded Polling & Server Truth Precedence over Query Params", () => {
    let dom: JSDOM;
    let originalWindow: unknown;
    let originalDocument: unknown;
    let originalSelf: unknown;
    let originalLocalStorage: unknown;
    let originalSessionStorage: unknown;
    let globalTarget: {
      window: unknown;
      document: unknown;
      self: unknown;
      localStorage: unknown;
      sessionStorage: unknown;
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    let originalActEnv: boolean | undefined;

    const setupDomWithUrl = (url: string) => {
      dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
        url,
      });
      globalTarget = globalThis as unknown as typeof globalTarget;
      originalWindow = globalTarget.window;
      originalDocument = globalTarget.document;
      originalSelf = globalTarget.self;
      originalLocalStorage = globalTarget.localStorage;
      originalSessionStorage = globalTarget.sessionStorage;
      originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

      globalTarget.window = dom.window;
      globalTarget.document = dom.window.document;
      globalTarget.self = dom.window;
      globalTarget.localStorage = dom.window.localStorage;
      globalTarget.sessionStorage = dom.window.sessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = true;
    };

    const cleanupDom = () => {
      resetOrderConfirmationPollingConfig();
      globalTarget.window = originalWindow;
      globalTarget.document = originalDocument;
      globalTarget.self = originalSelf;
      globalTarget.localStorage = originalLocalStorage;
      globalTarget.sessionStorage = originalSessionStorage;
      globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      dom.window.close();
    };

    const createMockAuthContext = (token: string): AuthContextType => ({
      user: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "khachhang@brewlite.vn",
        fullName: "Nguyễn Văn A",
      },
      accessToken: token,
      isAuthenticated: true,
      isLoading: false,
      isAuthModalOpen: false,
      authModalMode: "login",
      authModalMessage: null,
      openAuthModal: () => {},
      closeAuthModal: () => {},
      login: async () => {},
      register: async () => ({
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "khachhang@brewlite.vn",
        fullName: "Nguyễn Văn A",
      }),
      logout: () => {},
      verifySession: () => true,
      handleUnauthorizedCheckout: () => {},
      pendingCheckout: false,
      setPendingCheckout: () => {},
    });

    it("10.1 shouldPollOrderConfirmation: polls on PENDING / PROCESSING / RECONCILING and stops on terminal states (PAID, FAILED, CANCELLED, Financial Exception)", () => {
      const baseOrder: OrderConfirmationData = {
        id: "550e8400-e29b-41d4-a716-446655440088",
        status: "PENDING",
        createdAt: "2026-10-29T10:00:00.000Z",
        expiresAt: "2026-10-29T10:15:00.000Z",
        subtotalVnd: 85000,
        discountVnd: 0,
        totalVnd: 85000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440089",
          status: "PENDING",
          provider: "VNPAY",
          method: null,
          methodLast4: null,
          amountVnd: 85000,
          mockReference: null,
          failureReason: null,
          resolution: "PROCESSING",
          requiresReview: false,
          canRetry: false,
          createdAt: "2026-10-29T10:01:00.000Z",
        },
      };

      // Active pollable states: PENDING, PROCESSING, RECONCILING
      assert.equal(shouldPollOrderConfirmation(baseOrder), true);
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          payment: { ...baseOrder.payment!, resolution: "RECONCILING" },
        }),
        true
      );
      assert.equal(
        shouldPollOrderConfirmation({ ...baseOrder, payment: null }),
        true
      );

      // Stop on SUCCESS / PAID terminal states
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          status: "PAID",
          payment: {
            ...baseOrder.payment!,
            status: "SUCCESS",
            resolution: "PAYMENT_ACCEPTED",
          },
        }),
        false
      );
      assert.equal(
        shouldPollOrderConfirmation({ ...baseOrder, status: "PREPARING" }),
        false
      );
      assert.equal(
        shouldPollOrderConfirmation({ ...baseOrder, status: "READY" }),
        false
      );
      assert.equal(
        shouldPollOrderConfirmation({ ...baseOrder, status: "COMPLETED" }),
        false
      );

      // Stop on FAILED terminal states
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          status: "PAYMENT_FAILED",
          payment: {
            ...baseOrder.payment!,
            status: "FAILED",
            resolution: "FAILED",
          },
        }),
        false
      );

      // Stop on CANCELLED terminal state
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          status: "CANCELLED",
        }),
        false
      );

      // Stop on Financial Exception / Requires Review
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          hasFinancialException: true,
        }),
        false
      );
      assert.equal(
        shouldPollOrderConfirmation({
          ...baseOrder,
          payment: {
            ...baseOrder.payment!,
            requiresReview: true,
            resolution: "FINANCIAL_EXCEPTION",
          },
        }),
        false
      );
    });

    it("10.2 Bounded Polling Flow: PENDING -> server changes to SUCCESS + PAID -> UI automatically transitions to Success without user refresh and stops polling", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440088";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&vnp_ResponseCode=00`
      );
      setOrderConfirmationPollingConfig({ intervalMs: 35, maxAttempts: 5 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      let ordersMeCallCount = 0;

      const pendingVnPayOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 98000,
        discountVnd: 0,
        totalVnd: 98000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà Phê Muối",
            size: "M",
            sizeMultiplierPercent: 120,
            basePriceVnd: 40000,
            quantity: 2,
            unitPriceVnd: 49000,
            lineTotalVnd: 98000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440090",
          status: "PENDING",
          provider: "VNPAY",
          method: null,
          methodLast4: null,
          amountVnd: 98000,
          mockReference: null,
          failureReason: null,
          resolution: "PROCESSING",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      const paidVnPayOrder: OrderConfirmationData = {
        ...pendingVnPayOrder,
        status: "PAID",
        pointsEarned: 9,
        payment: {
          ...pendingVnPayOrder.payment!,
          status: "SUCCESS",
          resolution: "PAYMENT_ACCEPTED",
        },
      };

      // Call 1 (initial mount): returns PENDING + PROCESSING
      // Call 2+ (background poll after IPN/QueryDR): returns PAID + SUCCESS
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          ordersMeCallCount += 1;
          const currentOrder = ordersMeCallCount === 1 ? pendingVnPayOrder : paidVnPayOrder;
          return new Response(
            JSON.stringify({
              items: [currentOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: ordersMeCallCount === 1 ? 0 : 9,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "poll-transition-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        // Ngay lúc mount (Call 1): UI hiển thị màn hình đang đối soát VNPay (VnPayProcessingView)
        assert.equal(ordersMeCallCount, 1);
        assert.ok(
          container.textContent?.includes("Đang kiểm tra kết quả giao dịch..."),
          "Ban đầu khi payment còn PENDING/PROCESSING phải hiển thị VnPayProcessingView"
        );

        // Chờ chu kỳ bounded polling tự động chạy mà KHÔNG cần user bấm refresh
        await act(async () => {
          await new Promise((r) => setTimeout(r, 110));
        });

        // UI đã tự động chuyển sang màn hình VnPaySuccessView ("Thanh toán thành công qua VNPay!")
        assert.ok(ordersMeCallCount >= 2, "Polling tự động phải gọi lại GET /orders/me");
        assert.ok(
          container.textContent?.includes("Thanh toán thành công qua VNPay!"),
          "UI phải tự động chuyển sang VnPaySuccessView khi server đổi sang SUCCESS + PAID"
        );
        assert.equal(
          container.textContent?.includes("Đang kiểm tra kết quả giao dịch..."),
          false,
          "Màn hình chờ đối soát phải biến mất sau khi đơn đã PAID"
        );

        // Kiểm chứng polling đã dừng hẳn sau khi gặp terminal state PAID
        const callsAtPaid = ordersMeCallCount;
        await act(async () => {
          await new Promise((r) => setTimeout(r, 120));
        });
        assert.equal(
          ordersMeCallCount,
          callsAtPaid,
          "Polling BẮT BUỘC phải dừng ngay sau khi gặp trạng thái kết thúc PAID"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.3 Bounded Polling Limits & Unmount Cleanup: stops after maxAttempts when remaining PENDING and cleans up on unmount", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440088";
      setupDomWithUrl(`http://localhost/order-confirmation?orderId=${targetOrderId}`);
      setOrderConfirmationPollingConfig({ intervalMs: 25, maxAttempts: 3 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      let ordersMeCallCount = 0;

      const stillPendingOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 98000,
        discountVnd: 0,
        totalVnd: 98000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà Phê Muối",
            size: "M",
            sizeMultiplierPercent: 120,
            basePriceVnd: 40000,
            quantity: 2,
            unitPriceVnd: 49000,
            lineTotalVnd: 98000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440090",
          status: "PENDING",
          provider: "VNPAY",
          method: null,
          methodLast4: null,
          amountVnd: 98000,
          mockReference: null,
          failureReason: null,
          resolution: "RECONCILING",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          ordersMeCallCount += 1;
          return new Response(
            JSON.stringify({
              items: [stillPendingOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "poll-bound-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        assert.equal(ordersMeCallCount, 1);

        // Chờ 220ms (vượt xa 3 lần * 25ms) -> tổng số lần gọi phải dừng đúng ở 1 (mount) + 3 (maxAttempts) = 4
        await act(async () => {
          await new Promise((r) => setTimeout(r, 220));
        });

        assert.equal(
          ordersMeCallCount,
          4,
          "Polling BẮT BUỘC phải dừng đúng ở giới hạn maxAttempts (1 mount + 3 polls = 4), không gọi vô hạn"
        );

        // Unmount và xác minh không còn bất kỳ cuộc gọi nào sau khi unmount
        await act(async () => {
          root.unmount();
        });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(ordersMeCallCount, 4);
      } finally {
        cleanupDom();
      }
    });

    it("10.4 Server Truth Precedence #1: PAID + ZERO_AMOUNT + view=redirecting MUST render ZeroPaymentBypassView and NEVER render VnPayRedirectingView", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440091";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&view=redirecting&vnp_ResponseCode=00`
      );

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const paidZeroOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PAID",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 55000,
        discountVnd: 55000,
        totalVnd: 0,
        couponCode: "FREE100",
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Trà Đào Cam Sả",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 55000,
            quantity: 1,
            unitPriceVnd: 55000,
            lineTotalVnd: 55000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440092",
          status: "SUCCESS",
          provider: "ZERO_AMOUNT",
          method: null,
          methodLast4: null,
          amountVnd: 0,
          mockReference: null,
          failureReason: null,
          resolution: "PAYMENT_ACCEPTED",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [paidZeroOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "paid-zero-redirecting-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        const text = container.textContent || "";
        assert.ok(
          text.includes("Đơn hàng hoàn tất (0 ₫)!"),
          "PAID + ZERO_AMOUNT + view=redirecting BẮT BUỘC phải render ZeroPaymentBypassView"
        );
        assert.ok(text.includes("ZERO_AMOUNT"));
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayRedirectingView khi đơn đã PAID + ZERO_AMOUNT"
        );
        assert.equal(
          text.includes("Đang kiểm tra kết quả giao dịch..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayProcessingView khi đơn đã PAID + ZERO_AMOUNT"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.5 Server Truth Precedence #2: PAID + MOCK + vnp_ResponseCode=00 (and view=vnpay_success / view=redirecting / view=zero) MUST render OrderSuccessView and NEVER render VNPay or Zero views", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440093";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&vnp_ResponseCode=00&view=vnpay_success`
      );

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const paidMockOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PAID",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 85000,
        discountVnd: 0,
        totalVnd: 85000,
        couponCode: null,
        pointsEarned: 8,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cold Brew Cam Vàng",
            size: "L",
            sizeMultiplierPercent: 120,
            basePriceVnd: 85000,
            quantity: 1,
            unitPriceVnd: 85000,
            lineTotalVnd: 85000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440094",
          status: "SUCCESS",
          provider: "MOCK",
          method: "CARD",
          methodLast4: "1234",
          amountVnd: 85000,
          mockReference: "MOCK-CARD-1234-ABCD",
          failureReason: null,
          resolution: "PAYMENT_ACCEPTED",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [paidMockOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 8,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "paid-mock-vnp-param-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        const text = container.textContent || "";
        // Phải render OrderSuccessView của Mock CARD
        assert.ok(
          text.includes("Đặt hàng & Thanh toán thành công!"),
          "PAID + MOCK + vnp_ResponseCode=00 BẮT BUỘC phải render OrderSuccessView"
        );
        assert.ok(
          text.includes("Card •••• 1234"),
          "Phải hiển thị đúng phương thức thanh toán Mock Card •••• 1234 từ server"
        );
        assert.equal(
          text.includes("Thanh toán thành công qua VNPay!"),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPaySuccessView khi đơn trên server là MOCK"
        );
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayRedirectingView"
        );
        assert.equal(
          text.includes("Đơn hàng hoàn tất (0 ₫)!"),
          false,
          "TUYỆT ĐỐI KHÔNG được render ZeroPaymentBypassView"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.6 Server Truth Precedence #3: PENDING + MOCK + vnp_ResponseCode=00 MUST render PaymentFailedRetryView and NEVER render VnPayProcessingView / VnPayRedirectingView", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440095";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&vnp_ResponseCode=00&view=processing`
      );
      // Tắt polling tự động trong test kiểm tra render đồng bộ của PENDING + MOCK
      setOrderConfirmationPollingConfig({ intervalMs: 3000, maxAttempts: 0 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingMockOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 75000,
        discountVnd: 0,
        totalVnd: 75000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Bạc Xỉu Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 75000,
            quantity: 1,
            unitPriceVnd: 75000,
            lineTotalVnd: 75000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440096",
          status: "FAILED",
          provider: "MOCK",
          method: "CARD",
          methodLast4: "0002",
          amountVnd: 75000,
          mockReference: "MOCK-CARD-0002-FAIL",
          failureReason: "PAYMENT_DECLINED",
          resolution: "FAILED",
          requiresReview: false,
          canRetry: true,
          createdAt: new Date().toISOString(),
        },
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [pendingMockOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "pending-mock-vnp-param-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        const text = container.textContent || "";
        // Phải render PaymentFailedRetryView của Mock Payment (có nút #btnSubmitRetryPayment)
        assert.ok(
          container.querySelector("#btnSubmitRetryPayment"),
          "PENDING + MOCK + vnp_ResponseCode=00 BẮT BUỘC phải render PaymentFailedRetryView (#btnSubmitRetryPayment)"
        );
        assert.equal(
          text.includes("Đang kiểm tra kết quả giao dịch..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayProcessingView khi đơn thuộc provider MOCK"
        );
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayRedirectingView khi đơn thuộc provider MOCK"
        );
        assert.equal(
          text.includes("Thanh toán thành công qua VNPay!"),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPaySuccessView khi đơn thuộc provider MOCK"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.7 Server Truth Precedence #4: PENDING + payment=null + vnp_ResponseCode=00 (or view=processing) MUST render PaymentFailedRetryView and NEVER infer VNPay flow", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440097";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&vnp_ResponseCode=00&view=processing`
      );
      setOrderConfirmationPollingConfig({ intervalMs: 3000, maxAttempts: 0 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingNullPaymentOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 75000,
        discountVnd: 0,
        totalVnd: 75000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Bạc Xỉu Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 75000,
            quantity: 1,
            unitPriceVnd: 75000,
            lineTotalVnd: 75000,
            toppings: [],
          },
        ],
        payment: null,
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [pendingNullPaymentOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "pending-null-payment-vnp00-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        const text = container.textContent || "";
        assert.ok(
          container.querySelector("#btnSubmitRetryPayment"),
          "PENDING + payment=null + vnp_ResponseCode=00 BẮT BUỘC phải render PaymentFailedRetryView (#btnSubmitRetryPayment)"
        );
        assert.equal(
          text.includes("Đang kiểm tra kết quả giao dịch..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayProcessingView khi payment === null"
        );
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayRedirectingView khi payment === null"
        );
        assert.equal(
          text.includes("Thanh toán thành công qua VNPay!"),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPaySuccessView khi payment === null"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.8 Server Truth Precedence #5: PENDING + payment=null + view=redirecting (and query failure vnp_ResponseCode=24) MUST render PaymentFailedRetryView and NEVER render VNPay Redirecting/Failed views", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440098";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&view=redirecting`
      );
      setOrderConfirmationPollingConfig({ intervalMs: 3000, maxAttempts: 0 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingNullPaymentOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 75000,
        discountVnd: 0,
        totalVnd: 75000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Bạc Xỉu Đá",
            size: "M",
            sizeMultiplierPercent: 100,
            basePriceVnd: 75000,
            quantity: 1,
            unitPriceVnd: 75000,
            lineTotalVnd: 75000,
            toppings: [],
          },
        ],
        payment: null,
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [pendingNullPaymentOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "pending-null-payment-redirecting-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        let text = container.textContent || "";
        assert.ok(
          container.querySelector("#btnSubmitRetryPayment"),
          "PENDING + payment=null + view=redirecting BẮT BUỘC phải render PaymentFailedRetryView (#btnSubmitRetryPayment)"
        );
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayRedirectingView khi payment === null"
        );

        // Kiểm tra thêm trường hợp query failure (vnp_ResponseCode=24&view=vnpay_failed) khi payment=null
        dom.window.history.replaceState(
          {},
          "",
          `/order-confirmation?orderId=${targetOrderId}&vnp_ResponseCode=24&view=vnpay_failed`
        );
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "pending-null-payment-vnpfail-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        text = container.textContent || "";
        assert.ok(
          container.querySelector("#btnSubmitRetryPayment"),
          "PENDING + payment=null + vnp_ResponseCode=24 BẮT BUỘC phải render PaymentFailedRetryView"
        );
        assert.equal(
          container.querySelector("#vnpay-retry-btn"),
          null,
          "TUYỆT ĐỐI KHÔNG được render VnPayFailedRetryView (#vnpay-retry-btn) khi payment === null"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.9 Server Truth Precedence #6: PENDING + VNPAY FAILED + view=redirecting MUST keep VnPayFailedRetryView and NEVER revert to VnPayRedirectingView", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440099";
      setupDomWithUrl(
        `http://localhost/order-confirmation?orderId=${targetOrderId}&view=redirecting`
      );
      setOrderConfirmationPollingConfig({ intervalMs: 3000, maxAttempts: 0 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingVnPayFailedOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 89000,
        discountVnd: 0,
        totalVnd: 89000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Trà Đào Cam Sả",
            size: "L",
            sizeMultiplierPercent: 120,
            basePriceVnd: 89000,
            quantity: 1,
            unitPriceVnd: 89000,
            lineTotalVnd: 89000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440090",
          status: "FAILED",
          provider: "VNPAY",
          method: "VNPAY",
          methodLast4: null,
          amountVnd: 89000,
          mockReference: null,
          failureReason: "VNPAY_RESPONSE_24",
          resolution: "FAILED",
          requiresReview: false,
          canRetry: true,
          createdAt: new Date().toISOString(),
        },
      };

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          return new Response(
            JSON.stringify({
              items: [pendingVnPayFailedOrder],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "pending-vnpay-failed-redirecting-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        const text = container.textContent || "";
        assert.ok(
          container.querySelector("#vnpay-retry-btn"),
          "PENDING + VNPAY FAILED + view=redirecting BẮT BUỘC phải giữ trạng thái VnPayFailedRetryView (#vnpay-retry-btn)"
        );
        assert.ok(
          text.includes("Thanh toán lại qua VNPay") && text.includes("vnp_ResponseCode = 24"),
          "Phải hiển thị đúng nội dung VnPayFailedRetryView với mã lỗi 24 từ server"
        );
        assert.equal(
          text.includes("Đang chuyển hướng đến VNPay..."),
          false,
          "TUYỆT ĐỐI KHÔNG được quay lại VnPayRedirectingView khi payment đã FAILED trên server"
        );
        assert.equal(
          text.includes("Đang kiểm tra kết quả giao dịch..."),
          false,
          "TUYỆT ĐỐI KHÔNG được render VnPayProcessingView khi payment đã FAILED trên server"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });

    it("10.10 Active Polling Unmount Cleanup: cancels scheduled timer AND ignores in-flight poll response without scheduling further polls after unmount", async () => {
      const targetOrderId = "550e8400-e29b-41d4-a716-446655440088";
      setupDomWithUrl(`http://localhost/order-confirmation?orderId=${targetOrderId}`);
      setOrderConfirmationPollingConfig({ intervalMs: 30, maxAttempts: 5 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 98000,
        discountVnd: 0,
        totalVnd: 98000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà Phê Muối",
            size: "M",
            sizeMultiplierPercent: 120,
            basePriceVnd: 40000,
            quantity: 2,
            unitPriceVnd: 49000,
            lineTotalVnd: 98000,
            toppings: [],
          },
        ],
        payment: {
          id: "550e8400-e29b-41d4-a716-446655440090",
          status: "PENDING",
          provider: "VNPAY",
          method: null,
          methodLast4: null,
          amountVnd: 98000,
          mockReference: null,
          failureReason: null,
          resolution: "PROCESSING",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      let ordersMeCallCount = 0;
      let resolveInFlightPollOrders!: (res: Response) => void;

      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          ordersMeCallCount += 1;
          if (ordersMeCallCount === 1) {
            return new Response(
              JSON.stringify({
                items: [pendingOrder],
                meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          // Call 2 (first poll request): hold in-flight until after unmount!
          return new Promise<Response>((resolve) => {
            resolveInFlightPollOrders = resolve;
          });
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "active-poll-unmount-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        // Call 1 (initial mount) hoàn tất, timer poll số 1 (30ms) đã được schedule
        assert.equal(ordersMeCallCount, 1);

        // Chờ 45ms để timer poll số 1 vừa kích hoạt và đang giữ request ở trạng thái in-flight (Call 2)
        await act(async () => {
          await new Promise((r) => setTimeout(r, 45));
        });
        assert.equal(ordersMeCallCount, 2, "Poll số 1 phải đang in-flight");
        assert.ok(typeof resolveInFlightPollOrders === "function");

        // Unmount ngay trong lúc request poll số 1 vẫn đang in-flight!
        await act(async () => {
          root.unmount();
        });

        // Sau khi đã unmount, trả kết quả cho request in-flight
        await act(async () => {
          resolveInFlightPollOrders(
            new Response(
              JSON.stringify({
                items: [pendingOrder],
                meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            )
          );
        });

        // Chờ thêm 100ms (hơn 3 chu kỳ intervalMs) để xác minh không có bất kỳ timer hay poll tiếp theo nào được lên lịch sau khi unmount
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
          ordersMeCallCount,
          2,
          "Sau khi unmount giữa chừng khi request poll đang in-flight, TUYỆT ĐỐI KHÔNG được schedule thêm bất kỳ lần poll nào"
        );
      } finally {
        cleanupDom();
      }
    });

    it("10.11 VNPay Return URL without explicit ?orderId= (using vnp_OrderInfo / vnp_TxnRef) resolves target order and transitions PENDING -> PAID via bounded polling", async () => {
      const targetOrderId = "809cdca3-8ba3-428f-b64c-84f5196e7dc0";
      const targetPaymentId = "c279e7fe-5ede-4f98-b065-9f90b651b899";
      const vnpTxnRef = targetPaymentId.replace(/-/g, "");

      setupDomWithUrl(
        `http://localhost/order-confirmation?vnp_Amount=9800000&vnp_OrderInfo=VNPaySandboxPayment&vnp_ResponseCode=00&vnp_TransactionStatus=00&vnp_TxnRef=${vnpTxnRef}`
      );
      setOrderConfirmationPollingConfig({ intervalMs: 25, maxAttempts: 5 });

      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const mockToken = createValidMockJwt();
      dom.window.localStorage.setItem("brewlite_auth_token", mockToken);

      const pendingOrder: OrderConfirmationData = {
        id: targetOrderId,
        status: "PENDING",
        createdAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        subtotalVnd: 98000,
        discountVnd: 0,
        totalVnd: 98000,
        couponCode: null,
        pointsEarned: 0,
        hasFinancialException: false,
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440011",
            productId: "550e8400-e29b-41d4-a716-446655440001",
            productName: "Cà Phê Muối",
            size: "M",
            sizeMultiplierPercent: 120,
            basePriceVnd: 40000,
            quantity: 2,
            unitPriceVnd: 49000,
            lineTotalVnd: 98000,
            toppings: [],
          },
        ],
        payment: {
          id: targetPaymentId,
          status: "PENDING",
          provider: "VNPAY",
          method: "VNPAY",
          methodLast4: null,
          amountVnd: 98000,
          mockReference: null,
          failureReason: null,
          resolution: "PROCESSING",
          requiresReview: false,
          canRetry: false,
          createdAt: new Date().toISOString(),
        },
      };

      const paidOrder: OrderConfirmationData = {
        ...pendingOrder,
        status: "PAID",
        pointsEarned: 9,
        payment: {
          ...pendingOrder.payment!,
          status: "SUCCESS",
          resolution: "PAYMENT_ACCEPTED",
        },
      };

      let ordersMeCalls = 0;
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/orders/me")) {
          ordersMeCalls += 1;
          const current = ordersMeCalls === 1 ? pendingOrder : paidOrder;
          return new Response(
            JSON.stringify({
              items: [current],
              meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (u.includes("/auth/me")) {
          return new Response(
            JSON.stringify({
              id: "550e8400-e29b-41d4-a716-446655440001",
              email: "khachhang@brewlite.vn",
              fullName: "Nguyễn Văn A",
              loyaltyPoints: ordersMeCalls === 1 ? 0 : 9,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      try {
        await act(async () => {
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: createMockAuthContext(mockToken) },
              React.createElement(
                CartProvider as React.ComponentType<{ key?: string }>,
                { key: "vnp-txnref-lookup-poll-test" },
                React.createElement(OrderConfirmationPage)
              )
            )
          );
        });

        let text = container.textContent || "";
        assert.ok(
          text.includes("Đang kiểm tra kết quả giao dịch..."),
          "Ban đầu khi PENDING phải hiển thị VnPayProcessingView"
        );

        await act(async () => {
          await new Promise((r) => setTimeout(r, 80));
        });

        text = container.textContent || "";
        assert.ok(
          text.includes("Thanh toán thành công qua VNPay!"),
          "Sau khi poll báo PAID + SUCCESS phải tự động chuyển sang VnPaySuccessView không cần F5"
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        cleanupDom();
      }
    });
  });

});
