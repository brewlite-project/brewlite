import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { beforeEach, afterEach, describe, it } from "node:test";

import { VnPayRedirectingView } from "../components/VnPayRedirectingView";
import { VnPayProcessingView } from "../components/VnPayProcessingView";
import { VnPaySuccessView } from "../components/VnPaySuccessView";
import {
  VnPayFailedRetryView,
  mapVnPayResponseCodeToMessage,
} from "../components/VnPayFailedRetryView";
import { ZeroPaymentBypassView } from "../components/ZeroPaymentBypassView";
import PaymentPageView from "../components/PaymentPageView";
import { AuthContext, type AuthContextType } from "../context/AuthContext";
import { CartContext, type CartContextValue } from "../context/CartContext";
import type { OrderConfirmationData } from "../services/order-confirmation.service";

function createSampleOrder(overrides: Partial<OrderConfirmationData> = {}): OrderConfirmationData {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    status: "PAID",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    subtotalVnd: 118000,
    discountVnd: 20000,
    totalVnd: 98000,
    couponCode: "BREW20K",
    pointsEarned: 10,
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        productName: "Caramel Cloud Cold Brew",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 45000,
        quantity: 1,
        unitPriceVnd: 54000,
        lineTotalVnd: 54000,
        toppings: [
          { id: "top-1", name: "Trân châu trắng", priceVnd: 10000 },
        ],
      },
      {
        id: "item-2",
        productId: "prod-2",
        productName: "Artisanal Iced Oat Latte",
        size: "L",
        sizeMultiplierPercent: 140,
        basePriceVnd: 45000,
        quantity: 1,
        unitPriceVnd: 64000,
        lineTotalVnd: 64000,
        toppings: [],
      },
    ],
    payment: {
      id: "pay-vnpay-01",
      status: "SUCCESS",
      method: "VNPAY",
      methodLast4: null,
      amountVnd: 98000,
      mockReference: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("VNPay Phase 2 UI & Flow Deep Test Suite", () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost:3000",
    });
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.self = dom.window;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    container = dom.window.document.getElementById("root") as HTMLDivElement;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
  });

  // =========================================================================
  // SCREEN 1: VnPayRedirectingView Tests
  // =========================================================================
  describe("1. VnPayRedirectingView (Screen 1 - Redirecting)", () => {
    it("renders BrewLite & VNPay gateway branding, spinner, and order summary", async () => {
      const order = createSampleOrder();
      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayRedirectingView, {
            order,
            autoRedirectSeconds: 60,
          })
        );
      });

      const text = container.textContent || "";
      assert.ok(text.includes("Đang chuyển hướng đến VNPay..."), "Should display main heading");
      assert.ok(text.includes("BrewLite"), "Should display BrewLite brand");
      assert.ok(text.includes("VNPAY"), "Should display VNPay brand");
      assert.ok(text.includes("98.000"), "Should display total amount in VND");
      assert.ok(text.includes("Caramel Cloud Cold Brew"), "Should display ordered product item");
      assert.ok(text.includes("PCI-DSS LEVEL 1"), "Should display PCI-DSS compliance badge");
      assert.ok(text.includes("NAPAS SWITCH"), "Should display NAPAS switch badge");

      const timerElem = container.querySelector("#vnpay-countdown-timer");
      assert.ok(timerElem, "Should have countdown timer element");
      assert.ok(timerElem.textContent?.includes("60 giây"), "Should display configured seconds");

      const manualBtn = container.querySelector("#vnpay-manual-btn");
      assert.ok(manualBtn, "Should have manual redirect fallback button");
      assert.ok(manualBtn.textContent?.includes("Tiếp tục mở cổng VNPay ngay"), "Should have correct button label");
    });

    it("triggers onManualRedirect callback when user clicks manual button", async () => {
      const order = createSampleOrder();
      let wasRedirectTriggered = false;

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayRedirectingView, {
            order,
            autoRedirectSeconds: 60,
            onManualRedirect: () => {
              wasRedirectTriggered = true;
            },
          })
        );
      });

      const manualBtn = container.querySelector("#vnpay-manual-btn") as HTMLButtonElement;
      assert.ok(manualBtn);

      await act(async () => {
        manualBtn.click();
      });

      assert.strictEqual(wasRedirectTriggered, true, "Clicking button must trigger manual redirect");
    });
  });

  // =========================================================================
  // SCREEN 2: VnPaySuccessView Tests
  // =========================================================================
  describe("2. VnPaySuccessView (Screen 2 - Payment Success)", () => {
    it("renders HTTP 200 verified badge, VNPay transaction details, and items breakdown", async () => {
      const order = createSampleOrder({
        pointsEarned: 15,
      });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPaySuccessView, {
            order,
            customerName: "Nguyễn Hải Đăng",
            userPoints: 265,
            vnpayDetails: {
              vnp_TxnRef: "VNP_TXN_550E8400_01",
              vnp_TransactionNo: "14892044",
              vnp_BankCode: "NCB / VNPAYQR",
              vnp_PayDate: "10:45:00 30/10/2026",
            },
          })
        );
      });

      const text = container.textContent || "";
      assert.ok(text.includes("Thanh toán thành công qua VNPay!"), "Should render success title");
      assert.ok(text.includes("HTTP 200 • GIAO DỊCH ĐÃ ĐƯỢC XÁC THỰC"), "Should render HTTP 200 badge");
      assert.ok(text.includes("Nguyễn Hải Đăng"), "Should render customer name");
      assert.ok(text.includes("VNP_TXN_550E8400_01"), "Should render VNPay TxnRef");
      assert.ok(text.includes("14892044"), "Should render VNPay TransactionNo");
      assert.ok(text.includes("NCB / VNPAYQR"), "Should render BankCode");
      assert.ok(text.includes("+15 điểm"), "Should render points earned");
      assert.ok(text.includes("265 điểm"), "Should render total points balance");
      assert.ok(text.includes("98.000"), "Should render total amount");
      assert.ok(text.includes("ĐÃ THANH TOÁN (PAID)"), "Should render PAID status badge");
    });
  });

  // =========================================================================
  // SCREEN 3: VnPayProcessingView Tests
  // =========================================================================
  describe("3. VnPayProcessingView (Screen 3 - VNPay Processing)", () => {
    it("renders radar animation, IPN security checklist, and BR-04 policy notice", async () => {
      const order = createSampleOrder({ status: "PENDING" });
      let refreshClicked = false;

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayProcessingView, {
            order,
            vnpTxnRef: "VNP_TXN_550E8400_01",
            amountVnd: 98000,
            isPolling: false,
            onRefreshStatus: async () => {
              refreshClicked = true;
              return order;
            },
          })
        );
      });

      const text = container.textContent || "";
      assert.ok(text.includes("Đang kiểm tra kết quả giao dịch..."), "Should render processing header");
      assert.ok(text.includes("Chi tiết phiên đối soát"), "Should render audit box");
      assert.ok(text.includes("VNP_TXN_550E8400_01"), "Should render TxnRef");
      assert.ok(text.includes("Quy tắc bảo mật BR-04"), "Should state BR-04 compliance note");
      assert.ok(text.includes("Chờ tín hiệu xác nhận máy chủ VNPay IPN"), "Should render IPN step in checklist");

      const refreshBtn = container.querySelector("#vnpay-check-status-btn") as HTMLButtonElement;
      assert.ok(refreshBtn);

      await act(async () => {
        refreshBtn.click();
      });

      assert.strictEqual(refreshClicked, true, "Clicking refresh must trigger status reload");
    });
  });

  // =========================================================================
  // SCREEN 4: VnPayFailedRetryView Tests
  // =========================================================================
  describe("4. VnPayFailedRetryView (Screen 4 - Failed & Retry)", () => {
    it("maps VNPay error codes (24, 51, 11) accurately to Vietnamese messages", () => {
      const msg24 = mapVnPayResponseCodeToMessage("24");
      assert.ok(msg24.title.includes("hủy"), "Code 24 should be cancellation");

      const msg51 = mapVnPayResponseCodeToMessage("51");
      assert.ok(msg51.title.includes("số dư"), "Code 51 should be insufficient funds");

      const msg11 = mapVnPayResponseCodeToMessage("11");
      assert.ok(msg11.title.includes("Hết hạn"), "Code 11 should be timeout");
    });

    it("renders error message, BR-05 retry rule, and active countdown when order is payable", async () => {
      const order = createSampleOrder({
        status: "PAYMENT_FAILED",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      let retryTriggered = false;

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayFailedRetryView, {
            order,
            vnpResponseCode: "24",
            vnpTxnRef: "VNP_TXN_550E8400_01",
            onRetryVnPay: () => {
              retryTriggered = true;
            },
          })
        );
      });

      const text = container.textContent || "";
      assert.ok(text.includes("Thanh toán không thành công"), "Should render failed title");
      assert.ok(text.includes("Giao dịch đã bị hủy"), "Should render code 24 error description");
      assert.ok(text.includes("vnp_ResponseCode = 24"), "Should render response code tag");
      assert.ok(text.includes("BR-05 (Controlled Retry)"), "Should cite BR-05 rule");

      const retryBtn = container.querySelector("#vnpay-retry-btn") as HTMLButtonElement;
      assert.ok(retryBtn);
      assert.strictEqual(retryBtn.disabled, false, "Retry button must be active when order is within 15 mins");

      await act(async () => {
        retryBtn.click();
      });

      assert.strictEqual(retryTriggered, true, "Clicking retry should invoke onRetryVnPay");
    });

    it("blocks retry action and displays expiration warning when order has expired (BR-03)", async () => {
      const expiredOrder = createSampleOrder({
        status: "PAYMENT_FAILED",
        expiresAt: new Date(Date.now() - 5000).toISOString(), // expired in past
      });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayFailedRetryView, {
            order: expiredOrder,
            vnpResponseCode: "11",
            vnpTxnRef: "VNP_TXN_550E8400_01",
          })
        );
      });

      const retryBtn = container.querySelector("#vnpay-retry-btn") as HTMLButtonElement;
      assert.ok(retryBtn);
      assert.strictEqual(retryBtn.disabled, true, "Retry button must be disabled when order is expired");

      const text = container.textContent || "";
      assert.ok(text.includes("Đơn hàng đã quá hạn 15 phút"), "Should notify expiration per BR-03");
    });
  });

  // =========================================================================
  // SCREEN 5: ZeroPaymentBypassView Tests
  // =========================================================================
  describe("5. ZeroPaymentBypassView (Screen 5 - Zero-Payment Bypass)", () => {
    it("renders ZERO_AMOUNT badge, 0 ₫ total, 0 loyalty points, and BR-06 policy compliance", async () => {
      const zeroOrder = createSampleOrder({
        subtotalVnd: 55000,
        discountVnd: 55000,
        totalVnd: 0,
        pointsEarned: 0, // ERD invariant: 0 VND = 0 points
        couponCode: "FREE100",
        payment: {
          id: "pay-zero-01",
          status: "SUCCESS",
          method: "ZERO_AMOUNT",
          methodLast4: null,
          amountVnd: 0,
          mockReference: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
        },
      });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(ZeroPaymentBypassView, {
            order: zeroOrder,
            customerName: "Nguyễn Hải Đăng",
            branchName: "BrewLite Saigon Center",
          })
        );
      });

      const text = container.textContent || "";
      assert.ok(text.includes("Đơn hàng hoàn tất (0 ₫)!"), "Should render 0đ complete title");
      assert.ok(text.includes("ZERO_AMOUNT"), "Should display ZERO_AMOUNT badge");
      assert.ok(text.includes("Quyết toán nội bộ 0 ₫ • Không gọi VNPay API theo BR-06"), "Should cite BR-06 rule");
      assert.ok(text.includes("ĐÃ THANH TOÁN (PAID)"), "Should show PAID status");
      assert.ok(text.includes("0 điểm"), "Should show 0 points earned per ERD rule");
      assert.ok(text.includes("FREE100"), "Should show 100% discount coupon");
      assert.ok(text.includes("BrewLite Saigon Center"), "Should show branch name");
    });
  });

  // =========================================================================
  // INTEGRATION & FLOW TESTS
  // =========================================================================
  describe("6. Integration & Security Flow Invariants", () => {
    it("guarantees runtime validation accepts VNPAY and ZERO_AMOUNT payment methods in order history", async () => {
      const { validatePaymentSnapshot } = await import("../services/payment.service");

      const validVnPayPayment = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        status: "SUCCESS",
        method: "VNPAY",
        methodLast4: null,
        amountVnd: 98000,
        mockReference: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
      };

      const resultVnPay = validatePaymentSnapshot(validVnPayPayment);
      assert.ok(resultVnPay, "validatePaymentSnapshot must accept VNPAY");
      assert.strictEqual(resultVnPay?.method, "VNPAY");

      const validZeroPayment = {
        id: "550e8400-e29b-41d4-a716-446655440002",
        status: "SUCCESS",
        method: "ZERO_AMOUNT",
        methodLast4: null,
        amountVnd: 0,
        mockReference: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
      };

      const resultZero = validatePaymentSnapshot(validZeroPayment);
      assert.ok(resultZero, "validatePaymentSnapshot must accept ZERO_AMOUNT");
      assert.strictEqual(resultZero?.method, "ZERO_AMOUNT");
    });
  });

  // =========================================================================
  // SUITE 7: VNPay Checkout Button & New Tab Redirect Flow in PaymentPageView
  // =========================================================================
  describe("7. VNPay Checkout Button & New Tab Redirect Flow in PaymentPageView", () => {
    const mockAuthContext: AuthContextType = {
      user: {
        id: "user-test-01",
        email: "test@brewlite.vn",
        fullName: "Nguyen Van A",
      },
      accessToken: "mock-jwt-token",
      isAuthenticated: true,
      isLoading: false,
      isAuthModalOpen: false,
      authModalMode: "login",
      authModalMessage: null,
      openAuthModal: () => {},
      closeAuthModal: () => {},
      login: async () => {},
      register: async () => ({ id: "user-test-01", email: "test@brewlite.vn", fullName: "Nguyen Van A" }),
      logout: () => {},
      verifySession: () => true,
      handleUnauthorizedCheckout: () => {},
      pendingCheckout: false,
      setPendingCheckout: () => {},
    };

    const mockCartContext: CartContextValue = {
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
      mapToCreateOrderPayload: () => ({} as any),
      activeOrder: null,
      setActiveOrder: () => {},
    };

    it("removes inline btnSubmitVnPay and verifies main btnSubmitPayment opens VNPay in new tab", async () => {
      const order = createSampleOrder({ status: "PENDING" });
      const openedUrls: Array<{ url: string; target: string }> = [];

      // Mock window.open
      const originalOpen = (globalThis as any).window.open;
      (globalThis as any).window.open = (url: string, target: string) => {
        openedUrls.push({ url, target });
        return null;
      };

      try {
        await act(async () => {
          root = createRoot(container);
          root.render(
            React.createElement(
              AuthContext.Provider,
              { value: mockAuthContext },
              React.createElement(
                CartContext.Provider,
                { value: mockCartContext },
                React.createElement(PaymentPageView, {
                  initialOrder: order as any,
                  initialMethod: "VNPAY",
                })
              )
            )
          );
        });

        // 1. btnSubmitVnPay is removed
        const inlineVnPayBtn = container.querySelector("#btnSubmitVnPay");
        assert.strictEqual(inlineVnPayBtn, null, "Inline btnSubmitVnPay must NOT exist in the DOM");

        // 2. Main submit button is adapted for VNPay
        const submitBtn = container.querySelector("#btnSubmitPayment") as HTMLButtonElement;
        assert.ok(submitBtn, "Main submit button #btnSubmitPayment must exist");
        assert.ok(
          submitBtn.textContent?.includes("Xác nhận thanh toán qua VNPay"),
          "Submit button label should reflect VNPay payment confirmation"
        );
        assert.ok(
          submitBtn.textContent?.includes("98.000"),
          "Submit button label should display order total"
        );

        // Notice not displayed before clicking
        assert.strictEqual(container.querySelector("#vnpayTabNotice"), null);

        // 3. User clicks main submit button
        await act(async () => {
          submitBtn.click();
        });

        // 4. Verify window.open called with new tab
        assert.strictEqual(openedUrls.length, 1, "window.open must be called exactly once");
        assert.strictEqual(openedUrls[0].target, "_blank", "Must open in a new tab (_blank)");
        assert.ok(
          openedUrls[0].url.includes(`/order-confirmation?orderId=${order.id}&view=redirecting`),
          "Must redirect to VNPay redirecting view for the specific order"
        );

        // 5. Verify current tab remains intact and displays notification banner
        const tabNotice = container.querySelector("#vnpayTabNotice");
        assert.ok(tabNotice, "Tab notice banner #vnpayTabNotice must appear on current tab");
        assert.ok(
          tabNotice.textContent?.includes("Cổng thanh toán VNPay đã được mở trong tab mới!"),
          "Notice must inform user that VNPay was opened in a new tab"
        );
        assert.ok(
          tabNotice.textContent?.includes("Tab thanh toán hiện tại vẫn được giữ nguyên"),
          "Notice must clarify current tab is retained"
        );
      } finally {
        (globalThis as any).window.open = originalOpen;
      }
    });
  });

  // =========================================================================
  // SUITE 8: Comprehensive VNPay & Backend Error Code Verification Suite
  // =========================================================================
  describe("8. Comprehensive VNPay & Backend Error Code Verification Suite", () => {
    it("8.1 maps all official VNPay error codes to precise, human-readable Vietnamese messages", () => {
      const codeExpectations: Array<{
        code: string;
        expectedTitle: string;
        expectedKeyword: string;
      }> = [
        { code: "00", expectedTitle: "Giao dịch thành công", expectedKeyword: "thành công" },
        { code: "07", expectedTitle: "Giao dịch bị nghi ngờ gian lận", expectedKeyword: "nghi ngờ" },
        { code: "09", expectedTitle: "Chưa đăng ký Internet Banking", expectedKeyword: "Internet Banking" },
        { code: "10", expectedTitle: "Xác thực thẻ quá số lần cho phép", expectedKeyword: "quá 3 lần" },
        { code: "11", expectedTitle: "Hết hạn phiên thanh toán", expectedKeyword: "quá thời gian" },
        { code: "12", expectedTitle: "Thẻ hoặc tài khoản bị khóa", expectedKeyword: "tạm khóa" },
        { code: "13", expectedTitle: "Sai mã xác thực OTP", expectedKeyword: "OTP" },
        { code: "24", expectedTitle: "Giao dịch đã bị hủy", expectedKeyword: "hủy giao dịch" },
        { code: "51", expectedTitle: "Tài khoản không đủ số dư", expectedKeyword: "số dư" },
        { code: "65", expectedTitle: "Vượt quá hạn mức giao dịch", expectedKeyword: "hạn mức" },
        { code: "75", expectedTitle: "Ngân hàng thanh toán đang bảo trì", expectedKeyword: "bảo trì" },
        { code: "79", expectedTitle: "Nhập sai mật khẩu quá số lần", expectedKeyword: "mật khẩu" },
        { code: "97", expectedTitle: "Chữ ký giao dịch không hợp lệ", expectedKeyword: "Checksum" },
        { code: "99", expectedTitle: "Lỗi hệ thống cổng VNPay", expectedKeyword: "sự cố kết nối" },
      ];

      for (const item of codeExpectations) {
        const result = mapVnPayResponseCodeToMessage(item.code);
        assert.strictEqual(result.title, item.expectedTitle, `Code ${item.code} must have correct title`);
        assert.ok(
          result.description.includes(item.expectedKeyword),
          `Code ${item.code} description must contain '${item.expectedKeyword}'`
        );
      }

      // Safe fallback on unknown / null / undefined code
      const fallbackUnknown = mapVnPayResponseCodeToMessage("UNKNOWN_CODE_888");
      assert.strictEqual(fallbackUnknown.title, "Giao dịch VNPay tạm thời gián đoạn");
      assert.ok(fallbackUnknown.description.includes("Giao dịch chưa hoàn tất"));

      const fallbackNull = mapVnPayResponseCodeToMessage(null);
      assert.strictEqual(fallbackNull.title, "Giao dịch VNPay tạm thời gián đoạn");

      const fallbackUndefined = mapVnPayResponseCodeToMessage(undefined);
      assert.strictEqual(fallbackUndefined.title, "Giao dịch VNPay tạm thời gián đoạn");
    });

    it("8.2 renders individual VNPay error views accurately with error codes and badges in DOM", async () => {
      const order = createSampleOrder({ status: "PAYMENT_FAILED" });
      const testCodes = ["24", "51", "09", "13", "75", "97", "99"];

      for (const code of testCodes) {
        await act(async () => {
          root = createRoot(container);
          root.render(
            React.createElement(VnPayFailedRetryView, {
              order,
              vnpResponseCode: code,
              vnpTxnRef: `VNP_REF_TEST_${code}`,
            })
          );
        });

        const expected = mapVnPayResponseCodeToMessage(code);
        const text = container.textContent || "";
        assert.ok(
          text.includes(expected.title),
          `Must display title '${expected.title}' for code ${code}`
        );
        assert.ok(
          text.includes(`VNP_REF_TEST_${code}`),
          `Must display transaction reference for code ${code}`
        );
        assert.ok(
          text.includes("VNPay") || text.includes("VNPAY"),
          `Must display VNPay badge or label for code ${code}`
        );

        // Clean up for next code
        await act(async () => {
          root?.unmount();
        });
      }
    });

    it("8.3 enforces BR-03 expiration & BR-05 controlled retry semantics across error scenarios", async () => {
      // Scenario A: Order within 15 minutes window -> Retry allowed (BR-05)
      const validOrder = createSampleOrder({
        status: "PAYMENT_FAILED",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      let retryInvoked = false;
      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayFailedRetryView, {
            order: validOrder,
            vnpResponseCode: "51",
            onRetryVnPay: () => {
              retryInvoked = true;
            },
          })
        );
      });

      const retryBtn = container.querySelector("#vnpay-retry-btn") as HTMLButtonElement;
      assert.ok(retryBtn, "Retry button must be present");
      assert.strictEqual(retryBtn.disabled, false, "Retry button must be active for active order");

      await act(async () => {
        retryBtn.click();
      });
      assert.strictEqual(retryInvoked, true, "Clicking active retry button must invoke onRetryVnPay");

      await act(async () => {
        root?.unmount();
      });

      // Scenario B: Order expired past 15 minutes -> Retry strictly blocked (BR-03)
      const expiredOrder = createSampleOrder({
        status: "PAYMENT_FAILED",
        createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins in the past
      });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(VnPayFailedRetryView, {
            order: expiredOrder,
            vnpResponseCode: "11",
          })
        );
      });

      const disabledRetryBtn = container.querySelector("#vnpay-retry-btn") as HTMLButtonElement;
      assert.ok(disabledRetryBtn);
      assert.strictEqual(disabledRetryBtn.disabled, true, "Retry button must be disabled when order expired");

      const bodyText = container.textContent || "";
      assert.ok(
        bodyText.includes("Đơn hàng đã quá hạn 15 phút") || bodyText.includes("BR-03"),
        "Must display clear order expiration warning per BR-03"
      );
      assert.ok(
        bodyText.includes("Đổi phương thức thanh toán") || bodyText.includes("1900 6868"),
        "Must display support contact or fallback action when expired"
      );
    });

    it("8.4 verifies Backend API Contract v3.0 error code mappings in payment service", async () => {
      const { toPaymentSubmissionErrorState } = await import("../services/payment.service");

      // 1. 409 PAYMENT_IN_PROGRESS -> canRetrySameKey = true, shouldGenerateNewKey = false
      const inProgressErr = toPaymentSubmissionErrorState(
        {
          statusCode: 409,
          code: "PAYMENT_IN_PROGRESS",
          message: "Payment is being processed; retry with the same key",
          canRetrySameKey: true,
          shouldGenerateNewKey: false,
          idempotencyKey: "idem-key-12345678",
        },
        "idem-key-12345678"
      );
      assert.strictEqual(inProgressErr.code, "PAYMENT_IN_PROGRESS");
      assert.strictEqual(inProgressErr.statusCode, 409);
      assert.strictEqual(inProgressErr.canRetrySameKey, true);
      assert.strictEqual(inProgressErr.shouldGenerateNewKey, false);

      // 2. 409 IDEMPOTENCY_KEY_CONFLICT -> canRetrySameKey = false, shouldGenerateNewKey = true
      const conflictErr = toPaymentSubmissionErrorState(
        {
          statusCode: 409,
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "Idempotency key was used with a different request payload",
          canRetrySameKey: false,
          shouldGenerateNewKey: true,
          idempotencyKey: "idem-key-conflict-01",
        },
        "idem-key-conflict-01"
      );
      assert.strictEqual(conflictErr.code, "IDEMPOTENCY_KEY_CONFLICT");
      assert.strictEqual(conflictErr.statusCode, 409);
      assert.strictEqual(conflictErr.canRetrySameKey, false);
      assert.strictEqual(conflictErr.shouldGenerateNewKey, true);

      // 3. 409 INVALID_TRANSITION -> cannot retry with same key
      const transitionErr = toPaymentSubmissionErrorState(
        {
          statusCode: 409,
          code: "INVALID_TRANSITION",
          message: "Order cannot accept a new payment",
          canRetrySameKey: false,
          shouldGenerateNewKey: false,
          idempotencyKey: "idem-key-transition-01",
        },
        "idem-key-transition-01"
      );
      assert.strictEqual(transitionErr.code, "INVALID_TRANSITION");
      assert.strictEqual(transitionErr.canRetrySameKey, false);

      // 4. 404 NOT_FOUND
      const notFoundErr = toPaymentSubmissionErrorState(
        {
          statusCode: 404,
          code: "NOT_FOUND",
          message: "Order not found",
          canRetrySameKey: false,
          shouldGenerateNewKey: false,
          idempotencyKey: "idem-key-404",
        },
        "idem-key-404"
      );
      assert.strictEqual(notFoundErr.statusCode, 404);
      assert.strictEqual(notFoundErr.code, "NOT_FOUND");

      // 5. 500 INTERNAL_ERROR
      const internalErr = toPaymentSubmissionErrorState(
        {
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          canRetrySameKey: false,
          shouldGenerateNewKey: true,
          idempotencyKey: "idem-key-500",
        },
        "idem-key-500"
      );
      assert.strictEqual(internalErr.statusCode, 500);
      assert.strictEqual(internalErr.code, "INTERNAL_ERROR");

      // 6. Generic string / unknown error normalization
      const genericErr = toPaymentSubmissionErrorState(
        { message: "Network connection drop" },
        "idem-generic"
      );
      assert.strictEqual(genericErr.code, "INTERNAL_ERROR");
      assert.ok(genericErr.message.includes("Network connection drop"));
    });
  });
  // =========================================================================
  // SUITE 9: VNPay Sandbox Exclusive Selection & Under Development Notices
  // =========================================================================
  describe("9. VNPay Sandbox Exclusive Selection & Disabled Mock Methods (CARD/WALLET)", () => {
    const mockAuthContext: AuthContextType = {
      user: {
        id: "user-test-vnpay-exclusive",
        email: "test-vnpay@brewlite.vn",
        fullName: "Tran Van Test",
      },
      accessToken: "mock-jwt-token-vnpay",
      isAuthenticated: true,
      isLoading: false,
      isAuthModalOpen: false,
      authModalMode: "login",
      authModalMessage: null,
      openAuthModal: () => {},
      closeAuthModal: () => {},
      login: async () => {},
      register: async () => ({ id: "user-test-vnpay-exclusive", email: "test-vnpay@brewlite.vn", fullName: "Tran Van Test" }),
      logout: () => {},
      verifySession: () => true,
      handleUnauthorizedCheckout: () => {},
      pendingCheckout: false,
      setPendingCheckout: () => {},
    };

    const mockCartContext: CartContextValue = {
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
      mapToCreateOrderPayload: () => ({} as any),
      activeOrder: null,
      setActiveOrder: () => {},
    };

    it("defaults to VNPay Sandbox as selected method and renders CARD/WALLET as disabled under development", async () => {
      const order = createSampleOrder({ status: "PENDING" });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(
            AuthContext.Provider,
            { value: mockAuthContext },
            React.createElement(
              CartContext.Provider,
              { value: mockCartContext },
              React.createElement(PaymentPageView, {
                initialOrder: order as any,
              })
            )
          )
        );
      });

      // 1. Radio VNPay is checked by default
      const radioVnpay = container.querySelector("#radioVnpay") as HTMLInputElement;
      assert.ok(radioVnpay, "Radio VNPAY must exist");
      assert.strictEqual(radioVnpay.checked, true, "Radio VNPAY must be checked by default");

      // 2. Radio CARD and WALLET are disabled and NOT checked
      const radioCard = container.querySelector("#radioCard") as HTMLInputElement;
      assert.ok(radioCard, "Radio CARD must exist");
      assert.strictEqual(radioCard.checked, false, "Radio CARD must NOT be checked");
      assert.strictEqual(radioCard.disabled, true, "Radio CARD must be disabled");

      const radioWallet = container.querySelector("#radioWallet") as HTMLInputElement;
      assert.ok(radioWallet, "Radio WALLET must exist");
      assert.strictEqual(radioWallet.checked, false, "Radio WALLET must NOT be checked");
      assert.strictEqual(radioWallet.disabled, true, "Radio WALLET must be disabled");

      // 3. Badges "ĐANG PHÁT TRIỂN" are rendered
      const text = container.textContent || "";
      assert.ok(text.includes("ĐANG PHÁT TRIỂN"), "Should render ĐANG PHÁT TRIỂN badges");
      assert.ok(text.includes("Cổng thanh toán VNPay Sandbox"), "Should render VNPay option");
    });

    it("displays under development alert when user clicks on CARD or WALLET and keeps VNPAY selected", async () => {
      const order = createSampleOrder({ status: "PENDING" });

      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(
            AuthContext.Provider,
            { value: mockAuthContext },
            React.createElement(
              CartContext.Provider,
              { value: mockCartContext },
              React.createElement(PaymentPageView, {
                initialOrder: order as any,
              })
            )
          )
        );
      });

      // Click on CARD label/container
      const cardOptionLabel = container.querySelector("#radioCard")?.closest("label");
      assert.ok(cardOptionLabel, "CARD option label must exist");

      await act(async () => {
        cardOptionLabel.click();
      });

      // Verify devNotice banner appears
      const noticeBanner = container.querySelector("#devPaymentNotice");
      assert.ok(noticeBanner, "devPaymentNotice alert must appear after clicking CARD");
      assert.ok(
        noticeBanner.textContent?.includes("hiện đang được phát triển"),
        "Notice must state that CARD is under development"
      );

      // Verify VNPAY remains checked
      const radioVnpay = container.querySelector("#radioVnpay") as HTMLInputElement;
      assert.strictEqual(radioVnpay.checked, true, "VNPAY must stay checked");

      // Click on WALLET option
      const walletOptionLabel = container.querySelector("#radioWallet")?.closest("label");
      assert.ok(walletOptionLabel, "WALLET option label must exist");

      await act(async () => {
        walletOptionLabel.click();
      });

      const updatedNotice = container.querySelector("#devPaymentNotice");
      assert.ok(updatedNotice, "devPaymentNotice alert must remain visible after clicking WALLET");
      assert.ok(
        updatedNotice.textContent?.includes("hiện đang được phát triển"),
        "Notice must state that WALLET is under development"
      );
      assert.strictEqual(radioVnpay.checked, true, "VNPAY must still be checked");
    });
  });
});
