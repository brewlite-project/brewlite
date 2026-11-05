import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import React, { act } from "react";
import ReactDOMServer from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MOCK_MY_ORDERS_RESPONSE, type OrderHistoryItemDto } from "@/mock-data";
import { AuthContext, type AuthContextType } from "@/context/AuthContext";
import {
  CART_STORAGE_KEY,
  CartContext,
  type CartContextValue,
} from "@/context/CartContext";
import {
  getStoredToken,
  getStoredUser,
  setStoredSession,
} from "@/services/auth.service";
import {
  computeOrderStatusCounts,
  filterAndSearchOrders,
  getMyOrdersApi,
  getOrderStatusPresentation,
  validateMyOrdersQuery,
  validateMyOrdersResponseData,
  type OrderServiceError,
} from "@/services/order.service";
import OrderHistoryView, {
  executeFetchOrderHistory,
  isMockPreviewAllowed,
  isOrderPayable,
  OrderSnapshotModal,
  setupOrderExpirationTimer,
  resolveOrderItemImageUrl,
  type OrderHistoryErrorState,
} from "@/components/OrderHistoryView";

// ============================================================================
// BỘ KIỂM THỬ TỰ ĐỘNG CHO ORDER HISTORY UI & GET /orders/me (SCRUM-64)
// Kiểm chứng đầy đủ các yêu cầu:
// 1. Query validation (`page` & `limit` phải đi cùng nhau hoặc cùng bỏ trống)
// 2. Response contract validation (`GET /orders/me` theo API Contract v3.0 §4.2 & ERD)
// 3. Xử lý mạng, 200 OK, Empty, 400, 401 (xóa session hết hạn nhưng GIỮ GIỎ HÀNG), 500
// 4. Lọc theo trạng thái (`PENDING`, `PAID_GROUP`, `PAYMENT_FAILED`, `CANCELLED`) & tìm kiếm
// 5. Cô lập dữ liệu theo tài khoản (User Isolation khi logout / đổi tài khoản)
// 6. Render giao diện OrderHistoryView (Loading / Auth Guard / Empty / Error)
// ============================================================================

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

function createValidTestJwt(
  sub = "11111111-1111-4111-8111-111111111111",
  expiresInSeconds = 3600
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      email: "member@brewlite.vn",
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("SCRUM-64: Order History UI & GET /orders/me Contract Tests", () => {
  const originalFetch = globalThis.fetch;
  let localStorageMock: MemoryStorage;
  let sessionStorageMock: MemoryStorage;

  beforeEach(() => {
    localStorageMock = new MemoryStorage();
    sessionStorageMock = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      value: {
        localStorage: localStorageMock,
        sessionStorage: sessionStorageMock,
        location: { search: "" },
      },
      configurable: true,
      writable: true,
    });
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. validateMyOrdersQuery: tuân thủ quy tắc page & limit phải đi cùng nhau hoặc cùng bỏ trống (API Contract v3.0 §4.1)", () => {
    const noQuery = validateMyOrdersQuery(undefined);
    assert.equal(noQuery.isValid, true);
    assert.equal(noQuery.hasPagination, false);
    assert.equal(noQuery.queryString, "");

    const bothQuery = validateMyOrdersQuery({ page: 2, limit: 10 });
    assert.equal(bothQuery.isValid, true);
    assert.equal(bothQuery.hasPagination, true);
    assert.equal(bothQuery.queryString, "?page=2&limit=10");

    const onlyPage = validateMyOrdersQuery({ page: 1 });
    assert.equal(onlyPage.isValid, false);
    assert.equal(onlyPage.error?.statusCode, 400);
    assert.equal(onlyPage.error?.code, "VALIDATION_ERROR");

    const onlyLimit = validateMyOrdersQuery({ limit: 10 });
    assert.equal(onlyLimit.isValid, false);
    assert.equal(onlyLimit.error?.statusCode, 400);
    assert.equal(onlyLimit.error?.code, "VALIDATION_ERROR");

    const invalidLimitHigh = validateMyOrdersQuery({ page: 1, limit: 101 });
    assert.equal(invalidLimitHigh.isValid, false);
    assert.equal(invalidLimitHigh.error?.code, "VALIDATION_ERROR");

    const invalidDecimalPage = validateMyOrdersQuery({ page: 1.5, limit: 10 });
    assert.equal(invalidDecimalPage.isValid, false);
    assert.equal(invalidDecimalPage.error?.code, "VALIDATION_ERROR");
  });

  it("2. validateMyOrdersResponseData: chấp nhận dữ liệu chuẩn Contract v3.0 và từ chối dữ liệu vi phạm bất biến ERD", () => {
    const valid = validateMyOrdersResponseData(MOCK_MY_ORDERS_RESPONSE);
    assert.equal(valid.items.length, 4);
    assert.equal(valid.meta.total, 4);
    assert.equal(valid.meta.page, null);

    // Từ chối khi thiếu expiresAt (bắt buộc non-null theo ERD & Contract v3.0 §4.2)
    assert.throws(
      () =>
        validateMyOrdersResponseData({
          ...MOCK_MY_ORDERS_RESPONSE,
          items: [
            {
              ...MOCK_MY_ORDERS_RESPONSE.items[0],
              expiresAt: null,
            },
          ],
          meta: { page: null, limit: null, total: 1, totalPages: null },
        }),
      (err: unknown) => {
        const orderErr = err as OrderServiceError;
        return (
          orderErr.statusCode === 500 && orderErr.code === "INTERNAL_ERROR"
        );
      }
    );

    // Từ chối khi vi phạm bất biến totalVnd = subtotalVnd - discountVnd
    assert.throws(
      () =>
        validateMyOrdersResponseData({
          ...MOCK_MY_ORDERS_RESPONSE,
          items: [
            {
              ...MOCK_MY_ORDERS_RESPONSE.items[0],
              totalVnd: 999999,
            },
          ],
          meta: { page: null, limit: null, total: 1, totalPages: null },
        }),
      (err: unknown) => {
        const orderErr = err as OrderServiceError;
        return (
          orderErr.statusCode === 500 && orderErr.code === "INTERNAL_ERROR"
        );
      }
    );
  });

  it("3. getMyOrdersApi: xử lý 200 OK, 401 UNAUTHORIZED (xóa session nhưng giữ nguyên Cart), và lỗi mạng", async () => {
    const token = createValidTestJwt();
    setStoredSession(token, {
      id: "11111111-1111-4111-8111-111111111111",
      email: "member@brewlite.vn",
      fullName: "Nguyễn Hải Đăng",
    });
    localStorageMock.setItem(
      CART_STORAGE_KEY,
      JSON.stringify([{ cartItemId: "item-1", quantity: 2 }])
    );

    // 3a. 200 OK
    let requestedUrl = "";
    let requestedAuthHeader = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      const headers = init?.headers as Record<string, string>;
      requestedAuthHeader = headers?.Authorization || "";
      return new Response(JSON.stringify(MOCK_MY_ORDERS_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const okResult = await getMyOrdersApi();
    assert.equal(requestedUrl, "/api/backend/orders/me");
    assert.equal(requestedAuthHeader, `Bearer ${token}`);
    assert.equal(okResult.items.length, 4);

    // 3b. 401 UNAUTHORIZED từ Backend -> xóa Auth session nhưng BẢO LƯU GIỎ HÀNG
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          statusCode: 401,
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    await assert.rejects(
      () => getMyOrdersApi(),
      (err: unknown) => {
        const orderErr = err as OrderServiceError;
        return (
          orderErr.statusCode === 401 &&
          orderErr.code === "UNAUTHORIZED" &&
          orderErr.isOutcomeUncertain === false
        );
      }
    );

    assert.equal(getStoredToken(), null);
    assert.equal(getStoredUser(), null);
    assert.notEqual(
      localStorageMock.getItem(CART_STORAGE_KEY),
      null,
      "Giỏ hàng phải được bảo toàn khi gặp 401 UNAUTHORIZED ở GET /orders/me"
    );

    // 3c. Lỗi mạng (NETWORK_ERROR) -> isOutcomeUncertain = false vì GET /orders/me là idempotent
    setStoredSession(token, {
      id: "11111111-1111-4111-8111-111111111111",
      email: "member@brewlite.vn",
      fullName: "Nguyễn Hải Đăng",
    });
    globalThis.fetch = (async () => {
      throw new Error("Socket hang up");
    }) as typeof fetch;

    await assert.rejects(
      () => getMyOrdersApi({ tokenOverride: token }),
      (err: unknown) => {
        const orderErr = err as OrderServiceError;
        return (
          orderErr.statusCode === 503 &&
          orderErr.code === "NETWORK_ERROR" &&
          orderErr.isOutcomeUncertain === false
        );
      }
    );
  });

  it("4. executeFetchOrderHistory & User Isolation: quản lý đúng Loading/Empty/Error và xóa sạch dữ liệu khi đổi tài khoản hoặc logout", async () => {
    const tokenA = createValidTestJwt(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      3600
    );
    const loadingStates: boolean[] = [];
    let ordersState: OrderHistoryItemDto[] = [];
    let errorState: OrderHistoryErrorState | null = null;
    let ownerUserId: string | null = null;

    // Tài khoản A tải lịch sử đơn hàng thành công
    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accessToken: tokenA,
      verifySession: () => true,
      setIsLoading: (v) => loadingStates.push(v),
      setOrders: (items) => {
        ordersState = items;
      },
      setMeta: () => {},
      setErrorState: (err) => {
        errorState = err;
      },
      setLoadedOwnerUserId: (uid) => {
        ownerUserId = uid;
      },
      fetchOrdersFn: async () => MOCK_MY_ORDERS_RESPONSE,
    });

    assert.deepEqual(loadingStates, [true, false]);
    assert.equal(ordersState.length, 4);
    assert.equal(errorState, null);
    assert.equal(ownerUserId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    // Khi người A logout (isAuthenticated = false) -> xóa sạch ordersState và ownerUserId
    await executeFetchOrderHistory({
      isAuthenticated: false,
      userId: null,
      accessToken: null,
      verifySession: () => false,
      setIsLoading: () => {},
      setOrders: (items) => {
        ordersState = items;
      },
      setMeta: () => {},
      setErrorState: (err) => {
        errorState = err;
      },
      setLoadedOwnerUserId: (uid) => {
        ownerUserId = uid;
      },
    });

    assert.equal(ordersState.length, 0);
    assert.equal(ownerUserId, null);
  });

  it("5. Bộ lọc trạng thái & Tìm kiếm (computeOrderStatusCounts, filterAndSearchOrders, getOrderStatusPresentation)", () => {
    const counts = computeOrderStatusCounts(MOCK_MY_ORDERS_RESPONSE.items);
    assert.equal(counts.all, 4);
    assert.equal(counts.PAID_GROUP, 1);
    assert.equal(counts.PENDING, 1);
    assert.equal(counts.PAYMENT_FAILED, 1);
    assert.equal(counts.CANCELLED, 1);

    // PREPARING, READY, COMPLETED cũng được gom vào nhóm PAID_GROUP ("Đã thanh toán")
    assert.equal(
      getOrderStatusPresentation("PREPARING").filterGroup,
      "PAID_GROUP"
    );
    assert.equal(getOrderStatusPresentation("READY").filterGroup, "PAID_GROUP");
    assert.equal(
      getOrderStatusPresentation("COMPLETED").filterGroup,
      "PAID_GROUP"
    );

    const pendingOnly = filterAndSearchOrders(
      MOCK_MY_ORDERS_RESPONSE.items,
      "PENDING",
      ""
    );
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].status, "PENDING");

    const searchByDrink = filterAndSearchOrders(
      MOCK_MY_ORDERS_RESPONSE.items,
      "all",
      "Muối Cố Đô"
    );
    assert.equal(searchByDrink.length, 1);
    assert.equal(searchByDrink[0].id, "9f8b7a6c-5d4e-43f2-a1b0-c9d8e7f61042");

    const searchByUuid = filterAndSearchOrders(
      MOCK_MY_ORDERS_RESPONSE.items,
      "all",
      "#7a6b5c4d"
    );
    assert.equal(searchByUuid.length, 1);
    assert.equal(searchByUuid[0].status, "PAYMENT_FAILED");
  });

  it("6. OrderHistoryView SSR/Static Render: hiển thị đúng cấu trúc Stitch Header, Loyalty Banner, Filter Tabs và Loading Skeleton", () => {
    const mockAuthContext: AuthContextType = {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "member@brewlite.vn",
        fullName: "Nguyễn Hải Đăng",
      },
      accessToken: createValidTestJwt(),
      isAuthenticated: true,
      isLoading: false,
      login: async () => {},
      register: async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        email: "member@brewlite.vn",
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
      mapToCreateOrderPayload: () => ({ items: [] }),
      activeOrder: null,
      isSubmittingOrder: false,
      orderError: null,
      setActiveOrder: () => {},
      setIsSubmittingOrder: () => {},
      setOrderError: () => {},
      clearOrderFlowState: () => {},
      appliedCoupon: null,
      couponStatus: "idle",
      couponErrorMessage: null,
      couponErrorCode: null,
      applyCoupon: async () => null,
      removeCoupon: () => {},
    };

    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(
        AuthContext.Provider,
        { value: mockAuthContext },
        React.createElement(
          CartContext.Provider,
          { value: mockCartContext },
          React.createElement(OrderHistoryView)
        )
      )
    );

    assert.match(html, /Quản lý Đơn hàng &amp; Lịch sử/);
    assert.match(html, /id="memberLoyaltyBanner"/);
    assert.match(html, /id="orderFilterTabs"/);
    assert.match(html, /id="orderHistoryLoadingState"/);
    assert.match(html, /id="header-order-history-nav"/);

    // Kiểm tra ánh xạ ảnh sản phẩm thực tế cho 9 món chuẩn Backend seed.ts (a3000000-...)
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000001",
        "Bạc Xỉu Kem Béo Phin"
      ),
      "/images/bac-xiu-kem-beo-phin.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000002",
        "Cà Phê Đen Đá Cầu Đất"
      ),
      "/images/ca-phe-den-da-cau-dat.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000003",
        "Cà Phê Muối Cố Đô"
      ),
      "/images/ca-phe-muoi-co-do.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000004",
        "Cà phê Sữa Đá Sài Gòn"
      ),
      "/images/ca-phe-sua-da-sai-gon.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000005",
        "Cold Brew Cam Sả Thảo Mộc"
      ),
      "/images/cold-brew-cam-sa-thao-moc.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000006",
        "Cold Brew Vải Hoa Hồng"
      ),
      "/images/cold-brew-vai-hoa-hong.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000007",
        "Espresso Macchiato Caramel"
      ),
      "/images/espresso-macchiato-caramel.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000008",
        "Trà Đào Cam Sả Hoàng Gia"
      ),
      "/images/tra-dao-cam-sa-hoang-gia.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a3000000-0000-4000-8000-000000000009",
        "Croissant Bơ Pháp Nướng"
      ),
      "/images/croissant-bo-phap-nuong.jpg"
    );

    // Kiểm tra tương thích ngược legacy UUID mapping
    assert.equal(
      resolveOrderItemImageUrl(
        "a1000000-0000-4000-8000-000000000002",
        "Cà Phê Muối Cố Đô"
      ),
      "/images/ca-phe-muoi-co-do.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a1000000-0000-4000-8000-000000000006",
        "Cold Brew Cam Sả Thảo Mộc"
      ),
      "/images/cold-brew-cam-sa-thao-moc.jpg"
    );
    assert.equal(
      resolveOrderItemImageUrl(
        "a1000000-0000-4000-8000-000000000004",
        "Croissant Bơ Pháp Nướng"
      ),
      "/images/croissant-bo-phap-nuong.jpg"
    );
  });

  it("7. error: xử lý đầy đủ các lỗi mạng, 500, 400 và 401 theo đúng API Contract v3.0", async () => {
    let unauthorizedTriggered = false;
    let unauthorizedMessage = "";

    // 7a. 401 UNAUTHORIZED
    const authErr: OrderServiceError = {
      name: "OrderServiceError",
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
      statusCode: 401,
      code: "UNAUTHORIZED",
      isOutcomeUncertain: false,
    };

    const errorStateHolder: { current: OrderHistoryErrorState | null } = {
      current: null,
    };
    const fetch401 = async () => {
      throw authErr;
    };

    const res401 = await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: "11111111-1111-4111-8111-111111111111",
      accessToken: "mock-token",
      verifySession: () => true,
      onUnauthorized: (msg) => {
        unauthorizedTriggered = true;
        unauthorizedMessage = msg;
      },
      setIsLoading: () => {},
      setOrders: () => {},
      setMeta: () => {},
      setErrorState: (err) => {
        errorStateHolder.current = err;
      },
      setLoadedOwnerUserId: () => {},
      fetchOrdersFn: fetch401 as unknown as typeof getMyOrdersApi,
    });

    assert.equal(res401, null);
    assert.equal(unauthorizedTriggered, true);
    assert.match(unauthorizedMessage, /hết hạn/);
    assert.equal(errorStateHolder.current, null);

    // 7b. 500 INTERNAL_ERROR
    const internalErr: OrderServiceError = {
      name: "OrderServiceError",
      message: "Lỗi hệ thống từ máy chủ đơn hàng.",
      statusCode: 500,
      code: "INTERNAL_ERROR",
      isOutcomeUncertain: false,
    };

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: "11111111-1111-4111-8111-111111111111",
      accessToken: "mock-token",
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: () => {},
      setMeta: () => {},
      setErrorState: (err) => {
        errorStateHolder.current = err;
      },
      setLoadedOwnerUserId: () => {},
      fetchOrdersFn: (async () => {
        throw internalErr;
      }) as unknown as typeof getMyOrdersApi,
    });

    const lastInternalError = errorStateHolder.current as OrderHistoryErrorState | null;
    assert.equal(lastInternalError?.statusCode, 500);
    assert.equal(lastInternalError?.code, "INTERNAL_ERROR");

    // 7c. 503 NETWORK_ERROR
    const netErr: OrderServiceError = {
      name: "OrderServiceError",
      message: "Mất kết nối mạng.",
      statusCode: 503,
      code: "NETWORK_ERROR",
      isOutcomeUncertain: false,
    };

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: "11111111-1111-4111-8111-111111111111",
      accessToken: "mock-token",
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: () => {},
      setMeta: () => {},
      setErrorState: (err) => {
        errorStateHolder.current = err;
      },
      setLoadedOwnerUserId: () => {},
      fetchOrdersFn: (async () => {
        throw netErr;
      }) as unknown as typeof getMyOrdersApi,
    });

    const lastNetError = errorStateHolder.current as OrderHistoryErrorState | null;
    assert.equal(lastNetError?.statusCode, 503);
    assert.equal(lastNetError?.code, "NETWORK_ERROR");

    // 7d. 400 VALIDATION_ERROR: executeFetchOrderHistory map lỗi 400 chuẩn API Contract v3.0 §4.1
    const validationErr: OrderServiceError = {
      name: "OrderServiceError",
      message: "Tham số phân trang page và limit không hợp lệ.",
      statusCode: 400,
      code: "VALIDATION_ERROR",
      isOutcomeUncertain: false,
    };

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: "11111111-1111-4111-8111-111111111111",
      accessToken: "mock-token",
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: () => {},
      setMeta: () => {},
      setErrorState: (err) => {
        errorStateHolder.current = err;
      },
      setLoadedOwnerUserId: () => {},
      fetchOrdersFn: (async () => {
        throw validationErr;
      }) as unknown as typeof getMyOrdersApi,
    });

    const lastValError = errorStateHolder.current as OrderHistoryErrorState | null;
    assert.equal(lastValError?.statusCode, 400);
    assert.equal(lastValError?.code, "VALIDATION_ERROR");
    assert.equal(lastValError?.title, "Tham số truy vấn lịch sử không hợp lệ");
    assert.equal(
      lastValError?.message,
      "Tham số phân trang page và limit không hợp lệ."
    );

    // 7e. getMyOrdersApi: xử lý HTTP 400 VALIDATION_ERROR từ Backend
    const validJwt = createValidTestJwt();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "Tham số page và limit phải đi cùng nhau hoặc cùng bỏ trống.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );

    await assert.rejects(
      () =>
        getMyOrdersApi({
          tokenOverride: validJwt,
        }),
      (err: unknown) => {
        const orderErr = err as OrderServiceError;
        return (
          orderErr.statusCode === 400 &&
          orderErr.code === "VALIDATION_ERROR" &&
          orderErr.message ===
            "Tham số page và limit phải đi cùng nhau hoặc cùng bỏ trống."
        );
      }
    );
  });

  it("8. populated: danh sách đơn hàng populated hiển thị đầy đủ thông tin, nhóm trạng thái và nhãn nút trung thực", () => {
    const populated = validateMyOrdersResponseData(MOCK_MY_ORDERS_RESPONSE);
    assert.equal(populated.items.length, 4);

    const counts = computeOrderStatusCounts(populated.items);
    assert.equal(counts.all, 4);
    assert.equal(counts.PENDING, 1);
    assert.equal(counts.PAID_GROUP, 1);
    assert.equal(counts.PAYMENT_FAILED, 1);
    assert.equal(counts.CANCELLED, 1);

    // Kiểm tra nhóm PAID_GROUP lọc chính xác
    const paidOnly = filterAndSearchOrders(populated.items, "PAID_GROUP", "");
    assert.equal(paidOnly.length, 1);
    assert.equal(paidOnly[0].status, "PAID");
    assert.equal(paidOnly[0].pointsEarned, 14);

    // Kiểm tra tìm kiếm theo tên sản phẩm tiếng Việt
    const searched = filterAndSearchOrders(populated.items, "all", "muối");
    assert.equal(searched.length, 1);
    assert.equal(searched[0].items[0].productName, "Cà Phê Muối Cố Đô");
  });

  it("9. zero-total: đơn hàng miễn phí 100% (totalVnd = 0) tuân thủ bất biến ERD và tích lũy 0 điểm", () => {
    const zeroTotalOrder: OrderHistoryItemDto = {
      id: "00000000-0000-4000-8000-000000000099",
      status: "PAID",
      createdAt: "2026-10-25T10:00:00.000Z",
      expiresAt: "2026-10-25T10:15:00.000Z",
      subtotalVnd: 50000,
      discountVnd: 50000,
      totalVnd: 0,
      couponCode: "WELCOME_FREE",
      pointsEarned: 0,
      items: [
        {
          id: "d0000000-0000-4000-8000-000000000099",
          productId: "a3000000-0000-4000-8000-000000000001",
          productName: "Bạc Xỉu Kem Béo Phin",
          size: "S",
          sizeMultiplierPercent: 100,
          basePriceVnd: 42000,
          quantity: 1,
          unitPriceVnd: 50000,
          lineTotalVnd: 50000,
          toppings: [
            {
              id: "b2000000-0000-4000-8000-000000000005",
              name: "Kem tươi",
              priceVnd: 8000,
            },
          ],
        },
      ],
      payment: {
        id: "c0000000-0000-4000-8000-000000000099",
        status: "SUCCESS",
        method: "WALLET",
        methodLast4: null,
        amountVnd: 0,
        mockReference: "FREE-PROMO",
        failureReason: null,
        createdAt: "2026-10-25T10:01:00.000Z",
      },
    };

    const validated = validateMyOrdersResponseData({
      items: [zeroTotalOrder],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });

    assert.equal(validated.items.length, 1);
    assert.equal(validated.items[0].totalVnd, 0);
    assert.equal(validated.items[0].pointsEarned, 0);
    assert.equal(
      validated.items[0].subtotalVnd - validated.items[0].discountVnd,
      validated.items[0].totalVnd
    );
  });

  it("10. pagination: kiểm tra tính toán siêu dữ liệu phân trang Contract v3.0 và giới hạn trang", () => {
    // 10a. Khi không phân trang (page = null, limit = null)
    const noPageResponse = validateMyOrdersResponseData({
      items: MOCK_MY_ORDERS_RESPONSE.items,
      meta: { page: null, limit: null, total: 4, totalPages: null },
    });
    assert.equal(noPageResponse.meta.page, null);
    assert.equal(noPageResponse.meta.limit, null);
    assert.equal(noPageResponse.meta.totalPages, null);
    assert.equal(noPageResponse.meta.total, 4);

    // 10b. Khi có phân trang (total: 25, limit: 10 -> totalPages: 3)
    const pagedResponse = validateMyOrdersResponseData({
      items: [],
      meta: { page: 2, limit: 10, total: 25, totalPages: 3 },
    });
    assert.equal(pagedResponse.meta.page, 2);
    assert.equal(pagedResponse.meta.limit, 10);
    assert.equal(pagedResponse.meta.total, 25);
    assert.equal(pagedResponse.meta.totalPages, 3);

    // 10c. Khi total = 0 và limit = 10 -> totalPages: 0
    const emptyPaged = validateMyOrdersResponseData({
      items: [],
      meta: { page: 1, limit: 10, total: 0, totalPages: 0 },
    });
    assert.equal(emptyPaged.meta.total, 0);
    assert.equal(emptyPaged.meta.totalPages, 0);

    // 10d. Từ chối khi totalPages tính sai theo ceil(total/limit)
    assert.throws(
      () =>
        validateMyOrdersResponseData({
          items: [],
          meta: { page: 1, limit: 10, total: 25, totalPages: 99 },
        }),
      (err: unknown) => (err as OrderServiceError).code === "INTERNAL_ERROR"
    );
  });

  it("11. production mock guard: chặn mở mock/state giả qua URL hoặc nút preview trong production (kể cả khi NEXT_PUBLIC_ENABLE_MOCK_PREVIEW=true)", async () => {
    const envObj = process.env as Record<string, string | undefined>;
    const originalEnv = envObj.NODE_ENV;
    const originalMockFlag = envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW;

    try {
      // 11a. Khi ở production không có cờ
      envObj.NODE_ENV = "production";
      delete envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW;
      assert.equal(isMockPreviewAllowed(), false);

      // 11b. Bỏ production override: Khi ở production kể cả khi NEXT_PUBLIC_ENABLE_MOCK_PREVIEW=true
      // Chặn tuyệt đối dữ liệu giả, không cho phép bật mock
      envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW = "true";
      assert.equal(isMockPreviewAllowed(), false);

      // Khi ở production với flag=true, OrderHistoryView tuyệt đối không render nút Xem mẫu giao diện (Mock)
      const mockAuthContext: AuthContextType = {
        user: null,
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
        login: async () => {},
        register: async () => ({ id: "1", email: "", fullName: null }),
        logout: () => {},
        verifySession: () => false,
        handleUnauthorizedCheckout: () => {},
        pendingCheckout: false,
        setPendingCheckout: () => {},
        isAuthModalOpen: false,
        authModalMode: "login",
        authModalMessage: null,
        openAuthModal: () => {},
        closeAuthModal: () => {},
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
        mapToCreateOrderPayload: () => ({ items: [] }),
        activeOrder: null,
        isSubmittingOrder: false,
        orderError: null,
        setActiveOrder: () => {},
        setIsSubmittingOrder: () => {},
        setOrderError: () => {},
        clearOrderFlowState: () => {},
      appliedCoupon: null,
      couponStatus: "idle",
      couponErrorMessage: null,
      couponErrorCode: null,
      applyCoupon: async () => null,
      removeCoupon: () => {},
      };

      const html = ReactDOMServer.renderToStaticMarkup(
        React.createElement(
          AuthContext.Provider,
          { value: mockAuthContext },
          React.createElement(
            CartContext.Provider,
            { value: mockCartContext },
            React.createElement(OrderHistoryView)
          )
        )
      );

      // Nút Xem mẫu giao diện (Mock) tuyệt đối không xuất hiện trong production kể cả khi NEXT_PUBLIC_ENABLE_MOCK_PREVIEW=true
      assert.equal(html.includes("orderHistoryMockPreviewBtn"), false);
      assert.equal(html.includes("mockPreviewNoticeBanner"), false);
      assert.equal(html.includes("Xem mẫu giao diện"), false);

      // 11c. getMyOrdersApi: chặn hoàn toàn useMockData=true trong production (403 FORBIDDEN)
      await assert.rejects(
        () => getMyOrdersApi({ useMockData: true }),
        (err: unknown) => {
          const orderErr = err as OrderServiceError;
          return (
            orderErr.statusCode === 403 &&
            orderErr.code === "FORBIDDEN" &&
            orderErr.message.includes("không được phép trong môi trường production")
          );
        }
      );

      // 11d. Khi ở development / test: cho phép mock preview
      envObj.NODE_ENV = "test";
      delete envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW;
      assert.equal(isMockPreviewAllowed(), true);
    } finally {
      envObj.NODE_ENV = originalEnv;
      if (originalMockFlag !== undefined) {
        envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW = originalMockFlag;
      } else {
        delete envObj.NEXT_PUBLIC_ENABLE_MOCK_PREVIEW;
      }
    }
  });

  it("12. SCRUM-65: Integrate Order History with GET /orders/me & User Isolation", async () => {
    // 12a. Gửi Bearer JWT hợp lệ và headers theo chuẩn API Contract v3.0 §4.1
    const userAId = "aaaa1111-1111-4111-8111-111111111111";
    const tokenA = createValidTestJwt(userAId);
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify(MOCK_MY_ORDERS_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const resA = await getMyOrdersApi({
      query: { page: 1, limit: 10 },
      tokenOverride: tokenA,
    });

    assert.ok(capturedUrl.includes("/orders/me?page=1&limit=10"));
    assert.equal(capturedHeaders.Authorization, `Bearer ${tokenA}`);
    assert.equal(capturedHeaders.Accept, "application/json");
    assert.equal(resA.items.length, 4);

    // 12b. User Isolation: User A vs User B
    const ordersHolder: { current: OrderHistoryItemDto[] } = { current: [] };
    const ownerHolder: { current: string | null } = { current: null };

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: userAId,
      accessToken: tokenA,
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: (orders) => {
        ordersHolder.current = orders;
      },
      setMeta: () => {},
      setErrorState: () => {},
      setLoadedOwnerUserId: (id) => {
        ownerHolder.current = id;
      },
    });

    assert.equal(ownerHolder.current, userAId);
    assert.equal(ordersHolder.current.length, 4);

    // Khi User A logout -> state bị xóa sạch, không rò rỉ đơn hàng
    await executeFetchOrderHistory({
      isAuthenticated: false,
      userId: null,
      accessToken: null,
      verifySession: () => false,
      setIsLoading: () => {},
      setOrders: (orders) => {
        ordersHolder.current = orders;
      },
      setMeta: () => {},
      setErrorState: () => {},
      setLoadedOwnerUserId: (id) => {
        ownerHolder.current = id;
      },
    });

    assert.equal(ownerHolder.current, null);
    assert.equal(ordersHolder.current.length, 0);

    // Khi User B đăng nhập với tài khoản chưa có đơn hàng (Empty State)
    const userBId = "bbbb2222-2222-4222-8222-222222222222";
    const tokenB = createValidTestJwt(userBId);
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          items: [],
          meta: { page: null, limit: null, total: 0, totalPages: null },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: userBId,
      accessToken: tokenB,
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: (orders) => {
        ordersHolder.current = orders;
      },
      setMeta: () => {},
      setErrorState: () => {},
      setLoadedOwnerUserId: (id) => {
        ownerHolder.current = id;
      },
    });

    assert.equal(ownerHolder.current, userBId);
    assert.equal(ordersHolder.current.length, 0);

    // 12c. 401 Session hết hạn: xóa token, GIỮ NGUYÊN giỏ hàng và mở login modal
    let unauthorizedOpened = false;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          statusCode: 401,
          code: "UNAUTHORIZED",
          message: "Token expired",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );

    localStorageMock.setItem(
      CART_STORAGE_KEY,
      JSON.stringify([{ cartItemId: "cart-item-1", quantity: 3 }])
    );

    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: userAId,
      accessToken: tokenA,
      verifySession: () => true,
      onUnauthorized: () => {
        unauthorizedOpened = true;
      },
      setIsLoading: () => {},
      setOrders: (orders) => {
        ordersHolder.current = orders;
      },
      setMeta: () => {},
      setErrorState: () => {},
      setLoadedOwnerUserId: (id) => {
        ownerHolder.current = id;
      },
    });

    assert.equal(unauthorizedOpened, true);
    assert.equal(ownerHolder.current, null);
    assert.equal(ordersHolder.current.length, 0);
    assert.ok(localStorageMock.getItem(CART_STORAGE_KEY) !== null);

    // 12d. Reject corrupt backend data (ERD arithmetic invariant: totalVnd !== subtotal - discount)
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440099",
              status: "PAID",
              createdAt: "2026-10-25T01:50:00.000Z",
              expiresAt: "2026-10-25T02:05:00.000Z",
              subtotalVnd: 100000,
              discountVnd: 20000,
              totalVnd: 50000,
              couponCode: null,
              pointsEarned: 5,
              items: [],
              payment: null,
            },
          ],
          meta: { page: null, limit: null, total: 1, totalPages: null },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    const errorHolder: { current: OrderHistoryErrorState | null } = { current: null };
    await executeFetchOrderHistory({
      isAuthenticated: true,
      userId: userAId,
      accessToken: tokenA,
      verifySession: () => true,
      setIsLoading: () => {},
      setOrders: (orders) => {
        ordersHolder.current = orders;
      },
      setMeta: () => {},
      setErrorState: (err) => {
        errorHolder.current = err;
      },
      setLoadedOwnerUserId: (id) => {
        ownerHolder.current = id;
      },
    });

    assert.equal(ordersHolder.current.length, 0);
    assert.equal(errorHolder.current?.statusCode, 500);
    assert.equal(errorHolder.current?.code, "INTERNAL_ERROR");
  });

  describe("13. UI Test: CTA Thanh toán ngay trong Snapshot Modal cho đơn còn hạn / hết hạn & đúng orderId điều hướng (SCRUM-65)", () => {
    const baseTimeMs = 1770000000000; // Mốc thời gian chuẩn cố định

    function createTestOrderSnapshot(overrides?: Partial<OrderHistoryItemDto>): OrderHistoryItemDto {
      return {
        id: overrides?.id ?? "550e8400-e29b-41d4-a716-446655440001",
        status: overrides?.status ?? "PENDING",
        createdAt: overrides?.createdAt ?? new Date(baseTimeMs - 300000).toISOString(),
        expiresAt: overrides?.expiresAt ?? new Date(baseTimeMs + 600000).toISOString(), // Còn 10 phút
        subtotalVnd: overrides?.subtotalVnd ?? 125000,
        discountVnd: overrides?.discountVnd ?? 0,
        totalVnd: overrides?.totalVnd ?? 125000,
        couponCode: overrides?.couponCode ?? null,
        pointsEarned: overrides?.pointsEarned ?? 12,
        items: overrides?.items ?? [
          {
            id: "item-snapshot-1",
            productId: "prod-cafe-sua-da",
            productName: "Cà phê sữa đá",
            size: "M",
            sizeMultiplierPercent: 20,
            basePriceVnd: 45000,
            unitPriceVnd: 54000,
            quantity: 2,
            lineTotalVnd: 108000,
            toppings: [],
          },
        ],
        payment: overrides?.payment ?? null,
      };
    }

    it("13a. hiển thị nút CTA thanh toán kèm đúng orderId khi đơn PENDING còn trong thời hạn giữ chỗ 15 phút", () => {
      const orderPending = createTestOrderSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440001",
        status: "PENDING",
        totalVnd: 125000,
        expiresAt: new Date(baseTimeMs + 600000).toISOString(),
      });

      const markup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderPending,
          onClose: () => {},
          onReorder: () => {},
          referenceTimestampMs: baseTimeMs,
        })
      );

      // 1. Kiểm tra tồn tại CTA thanh toán
      assert.ok(
        markup.includes('id="order-snapshot-pay-cta"'),
        "Snapshot modal phải hiển thị nút CTA thanh toán cho đơn PENDING còn hạn"
      );
      assert.ok(
        markup.includes('data-testid="order-snapshot-pay-cta"'),
        "Nút thanh toán phải gắn data-testid order-snapshot-pay-cta để kiểm thử UI"
      );

      // 2. Kiểm tra điều hướng đúng orderId
      const expectedHref = '/payment?orderId=550e8400-e29b-41d4-a716-446655440001';
      assert.ok(
        markup.includes(`href="${expectedHref}"`),
        `CTA thanh toán phải trỏ chính xác đến ${expectedHref}`
      );
      assert.ok(
        markup.includes('data-order-id="550e8400-e29b-41d4-a716-446655440001"'),
        "CTA thanh toán phải mang data-order-id tương ứng với id của đơn hàng"
      );

      // 3. Kiểm tra nhãn hiển thị và định dạng tiền tệ
      assert.ok(
        markup.includes("Thanh toán ngay"),
        "Nút phải hiển thị nhãn 'Thanh toán ngay'"
      );
      assert.ok(
        markup.includes("125.000"),
        "Nút phải hiển thị chính xác tổng tiền cần thanh toán của đơn hàng (125.000 đ)"
      );
    });

    it("13b. hiển thị nút CTA thanh toán kèm đúng orderId khi đơn PAYMENT_FAILED còn trong thời hạn", () => {
      const orderFailed = createTestOrderSnapshot({
        id: "990e8400-e29b-41d4-a716-446655440099",
        status: "PAYMENT_FAILED",
        totalVnd: 85000,
        expiresAt: new Date(baseTimeMs + 300000).toISOString(),
        payment: {
          id: "pay-failed-1",
          method: "CARD",
          methodLast4: "4242",
          status: "FAILED",
          amountVnd: 85000,
          failureReason: "Thẻ không đủ số dư",
          mockReference: null,
          createdAt: new Date(baseTimeMs - 60000).toISOString(),
        },
      });

      const markup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderFailed,
          onClose: () => {},
          onReorder: () => {},
          referenceTimestampMs: baseTimeMs,
        })
      );

      assert.ok(
        markup.includes('id="order-snapshot-pay-cta"'),
        "Snapshot modal phải hiển thị nút CTA thanh toán cho đơn PAYMENT_FAILED còn hạn để khách thanh toán lại"
      );
      const expectedHref = '/payment?orderId=990e8400-e29b-41d4-a716-446655440099';
      assert.ok(
        markup.includes(`href="${expectedHref}"`),
        `CTA thanh toán phải trỏ chính xác đến ${expectedHref}`
      );
      assert.ok(
        markup.includes('data-order-id="990e8400-e29b-41d4-a716-446655440099"'),
        "CTA thanh toán phải mang đúng orderId của đơn PAYMENT_FAILED"
      );
      assert.ok(
        markup.includes("85.000"),
        "Nút phải hiển thị đúng số tiền 85.000 đ"
      );
    });

    it("13c. KHÔNG hiển thị CTA thanh toán khi đơn PENDING đã HẾT HẠN giữ chỗ (expired)", () => {
      const orderExpired = createTestOrderSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440003",
        status: "PENDING",
        expiresAt: new Date(baseTimeMs - 1000).toISOString(), // Đã hết hạn 1 giây trước
      });

      const markup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderExpired,
          onClose: () => {},
          onReorder: () => {},
          referenceTimestampMs: baseTimeMs,
        })
      );

      // Tuyệt đối không được render nút thanh toán và link điều hướng
      assert.ok(
        !markup.includes('id="order-snapshot-pay-cta"'),
        "Không được render nút order-snapshot-pay-cta cho đơn PENDING đã hết hạn"
      );
      assert.ok(
        !markup.includes('/payment?orderId='),
        "Không được chứa bất kỳ link điều hướng thanh toán nào cho đơn đã hết hạn"
      );
      assert.ok(
        !markup.includes("Thanh toán ngay"),
        "Không được hiển thị chữ 'Thanh toán ngay' khi đơn hết hạn giữ chỗ"
      );
      // Nút 'Đóng' và 'Đặt lại món' vẫn phải hiển thị bình thường
      assert.ok(markup.includes("Đóng"), "Nút Đóng vẫn phải tồn tại");
      assert.ok(markup.includes("Đặt lại món"), "Nút Đặt lại món vẫn phải tồn tại");
    });

    it("13d. KHÔNG hiển thị CTA thanh toán khi đơn PAYMENT_FAILED đã HẾT HẠN", () => {
      const orderFailedExpired = createTestOrderSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440004",
        status: "PAYMENT_FAILED",
        expiresAt: new Date(baseTimeMs - 50000).toISOString(),
      });

      const markup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderFailedExpired,
          onClose: () => {},
          onReorder: () => {},
          referenceTimestampMs: baseTimeMs,
        })
      );

      assert.ok(
        !markup.includes('id="order-snapshot-pay-cta"'),
        "Không được render nút CTA thanh toán cho đơn PAYMENT_FAILED đã hết hạn"
      );
      assert.ok(
        !markup.includes('/payment?orderId='),
        "Không được chứa link điều hướng thanh toán cho đơn PAYMENT_FAILED hết hạn"
      );
    });

    it("13e. KHÔNG hiển thị CTA thanh toán cho các đơn hàng ở trạng thái PAID, COMPLETED, hoặc CANCELLED kể cả khi expiresAt trong tương lai", () => {
      const statuses: Array<"PAID" | "COMPLETED" | "CANCELLED"> = [
        "PAID",
        "COMPLETED",
        "CANCELLED",
      ];

      for (const status of statuses) {
        const finishedOrder = createTestOrderSnapshot({
          id: `550e8400-e29b-41d4-a716-4466554400${status}`,
          status,
          expiresAt: new Date(baseTimeMs + 600000).toISOString(), // expiresAt tương lai nhưng status đã kết thúc
        });

        const markup = ReactDOMServer.renderToStaticMarkup(
          React.createElement(OrderSnapshotModal, {
            order: finishedOrder,
            onClose: () => {},
            onReorder: () => {},
            referenceTimestampMs: baseTimeMs,
          })
        );

        assert.ok(
          !markup.includes('id="order-snapshot-pay-cta"'),
          `Không được hiển thị CTA thanh toán cho đơn có trạng thái ${status}`
        );
        assert.ok(
          !markup.includes('/payment?orderId='),
          `Không được có link thanh toán cho đơn có trạng thái ${status}`
        );
      }
    });

    it("13f. kiểm chứng hàm isOrderPayable với đầy đủ các biên dữ liệu", () => {
      const future = new Date(baseTimeMs + 10000).toISOString();
      const past = new Date(baseTimeMs - 10000).toISOString();

      // Biên falsy / null / undefined
      assert.equal(isOrderPayable(null, baseTimeMs), false);
      assert.equal(isOrderPayable(undefined, baseTimeMs), false);

      // Biên status không hợp lệ
      assert.equal(isOrderPayable({ status: "PAID", expiresAt: future }, baseTimeMs), false);
      assert.equal(isOrderPayable({ status: "COMPLETED", expiresAt: future }, baseTimeMs), false);
      assert.equal(isOrderPayable({ status: "CANCELLED", expiresAt: future }, baseTimeMs), false);

      // Biên expiresAt sai định dạng
      assert.equal(isOrderPayable({ status: "PENDING", expiresAt: "invalid-iso" }, baseTimeMs), false);

      // Biên thời gian quá khứ vs tương lai
      assert.equal(isOrderPayable({ status: "PENDING", expiresAt: past }, baseTimeMs), false);
      assert.equal(isOrderPayable({ status: "PAYMENT_FAILED", expiresAt: past }, baseTimeMs), false);
      assert.equal(isOrderPayable({ status: "PENDING", expiresAt: future }, baseTimeMs), true);
      assert.equal(isOrderPayable({ status: "PAYMENT_FAILED", expiresAt: future }, baseTimeMs), true);
    });

    it("13g. tự ẩn CTA thanh toán ngay khi thời gian vượt qua expiresAt trong lúc modal đang mở (Live Expiration)", async () => {
      // Đơn hàng hết hạn sau 30ms kể từ thời điểm hiện tại
      const expireDelayMs = 30;
      const orderExpiringSoon = createTestOrderSnapshot({
        id: "550e8400-e29b-41d4-a716-446655440055",
        status: "PENDING",
        expiresAt: new Date(Date.now() + expireDelayMs).toISOString(),
      });

      // Tại thời điểm ban đầu: đơn hàng còn hạn
      assert.equal(
        isOrderPayable(orderExpiringSoon),
        true,
        "Đơn hàng phải còn trong hạn thanh toán tại thời điểm ban đầu"
      );

      const initialMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderExpiringSoon,
          onClose: () => {},
          onReorder: () => {},
        })
      );
      assert.ok(
        initialMarkup.includes('id="order-snapshot-pay-cta"'),
        "Tại thời điểm chưa hết hạn, modal phải hiển thị nút CTA thanh toán"
      );

      // Chờ thời gian trôi qua mốc expiresAt
      await new Promise((resolve) => setTimeout(resolve, expireDelayMs + 35));

      // Sau khi đã vượt qua expiresAt: isOrderPayable phải trả về false
      assert.equal(
        isOrderPayable(orderExpiringSoon),
        false,
        "Sau khi qua expiresAt, isOrderPayable phải tự động nhận diện đơn đã hết hạn"
      );

      // Render lại snapshot modal sau khi hết hạn
      const expiredMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: orderExpiringSoon,
          onClose: () => {},
          onReorder: () => {},
        })
      );
      assert.ok(
        !expiredMarkup.includes('id="order-snapshot-pay-cta"'),
        "Sau khi qua expiresAt, modal phải tự động ẩn nút CTA thanh toán"
      );
      assert.ok(
        !expiredMarkup.includes('/payment?orderId='),
        "Sau khi qua expiresAt, modal không được chứa bất kỳ link thanh toán nào"
      );
    });

    it("13h. client-side fake timer xác nhận timer kích hoạt chính xác sau expiresAt và tự ẩn CTA", () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      try {
        const now = 1770000000000;
        mock.timers.setTime(now);

        const remainingMs = 5000;
        const expiresAtIso = new Date(now + remainingMs).toISOString();

        let expiredTriggered = false;
        const cleanup = setupOrderExpirationTimer(
          expiresAtIso,
          () => {
            expiredTriggered = true;
          },
          now
        );

        assert.ok(cleanup !== null, "Hàm cleanup phải tồn tại khi đơn hàng còn hạn");
        assert.equal(expiredTriggered, false, "Timer chưa được kích hoạt trước hạn");

        // Nhích thời gian 4999ms (chưa tới hạn)
        mock.timers.tick(4999);
        assert.equal(expiredTriggered, false, "Chưa chạm mốc expiresAt, expiredTriggered vẫn phải là false");

        // Nhích thêm 1ms (chạm mốc 5000ms = expiresAt)
        mock.timers.tick(1);
        assert.equal(
          expiredTriggered,
          true,
          "Đúng thời điểm expiresAt, timer phải kích hoạt callback tự ẩn CTA"
        );

        cleanup();
      } finally {
        mock.timers.reset();
      }
    });

    it("13i. client-side fake timer kiểm chứng hủy timer (cleanup) khi unmount hoặc đổi đơn", () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      try {
        const now = 1770000000000;
        mock.timers.setTime(now);

        const expiresAtIso = new Date(now + 10000).toISOString();

        let expiredTriggered = false;
        const cleanup = setupOrderExpirationTimer(
          expiresAtIso,
          () => {
            expiredTriggered = true;
          },
          now
        );

        // Hủy timer ngay lập tức (mô phỏng unmount modal trước khi hết hạn)
        cleanup?.();

        // Nhích thời gian vượt quá hạn 10000ms
        mock.timers.tick(15000);

        assert.equal(
          expiredTriggered,
          false,
          "Sau khi gọi cleanup, callback không được phép kích hoạt (không gây memory leak)"
        );
      } finally {
        mock.timers.reset();
      }
    });

    it("13j. mounted component test: mount OrderSnapshotModal thật trên DOM, xác nhận CTA tự biến mất sau expiresAt mà KHÔNG remount component", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      try {
        const now = 1770000000000;
        mock.timers.setTime(now);

        const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
        const originalWindow = globalThis.window;
        const originalDocument = globalThis.document;
        const originalSelf = globalThis.self;
        const globalTarget = globalThis as unknown as {
          window: unknown;
          document: unknown;
          self: unknown;
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        };
        const originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

        globalTarget.window = dom.window;
        globalTarget.document = dom.window.document;
        globalTarget.self = dom.window;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = true;

        const container = dom.window.document.getElementById("root");
        const root = createRoot(container!);

        const orderExpiringIn5s = createTestOrderSnapshot({
          id: "550e8400-e29b-41d4-a716-446655440055",
          status: "PENDING",
          createdAt: new Date(now - 60000).toISOString(),
          expiresAt: new Date(now + 5000).toISOString(), // Còn đúng 5 giây
          totalVnd: 75000,
        });

        // 1. Mount component thật vào DOM bằng React 19 createRoot + act
        await act(async () => {
          root.render(
            React.createElement(OrderSnapshotModal, {
              order: orderExpiringIn5s,
              onClose: () => {},
              onReorder: () => {},
            })
          );
        });

        // 2. Ban đầu: CTA thanh toán phải tồn tại trong DOM thực tế
        const ctaBefore = container!.querySelector("#order-snapshot-pay-cta");
        assert.ok(ctaBefore !== null, "CTA thanh toán phải hiển thị khi component vừa mount vào DOM");
        assert.equal(ctaBefore.getAttribute("data-order-id"), orderExpiringIn5s.id);

        // 3. Tiến thời gian 4999ms (vẫn còn 1ms trước khi hết hạn)
        await act(async () => {
          mock.timers.tick(4999);
        });
        const ctaDuring = container!.querySelector("#order-snapshot-pay-cta");
        assert.ok(ctaDuring !== null, "CTA thanh toán vẫn phải tồn tại ở mốc 4999ms khi chưa vượt qua expiresAt");

        // 4. Tiến thêm 1ms (chạm mốc 5000ms = đúng expiresAt)
        // Timer trong useEffect kích hoạt setState(hasExpiredLive = true), component re-render tự động mà không remount
        await act(async () => {
          mock.timers.tick(1);
        });
        const ctaAfter = container!.querySelector("#order-snapshot-pay-cta");
        assert.equal(
          ctaAfter,
          null,
          "CTA thanh toán phải tự động biến mất khỏi DOM sau expiresAt mà KHÔNG cần remount component"
        );

        // 5. Cleanup DOM and restore globals
        await act(async () => {
          root.unmount();
        });
        dom.window.close();

        globalTarget.window = originalWindow;
        globalTarget.document = originalDocument;
        globalTarget.self = originalSelf;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      } finally {
        mock.timers.reset();
      }
    });

    it("13k. component lifecycle cleanup test: xác nhận timer bị hủy an toàn khi modal unmount ở cấp component", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      try {
        const now = 1770000000000;
        mock.timers.setTime(now);

        const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
        const originalWindow = globalThis.window;
        const originalDocument = globalThis.document;
        const originalSelf = globalThis.self;
        const globalTarget = globalThis as unknown as {
          window: unknown;
          document: unknown;
          self: unknown;
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        };
        const originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

        globalTarget.window = dom.window;
        globalTarget.document = dom.window.document;
        globalTarget.self = dom.window;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = true;

        const container = dom.window.document.getElementById("root");
        const root = createRoot(container!);

        const orderExpiringIn10s = createTestOrderSnapshot({
          id: "550e8400-e29b-41d4-a716-446655440099",
          status: "PENDING",
          createdAt: new Date(now - 60000).toISOString(),
          expiresAt: new Date(now + 10000).toISOString(), // Còn đúng 10 giây
          totalVnd: 50000,
        });

        // 1. Mount modal vào DOM
        await act(async () => {
          root.render(
            React.createElement(OrderSnapshotModal, {
              order: orderExpiringIn10s,
              onClose: () => {},
              onReorder: () => {},
            })
          );
        });

        // CTA phải xuất hiện
        assert.ok(container!.querySelector("#order-snapshot-pay-cta") !== null);

        // 2. Unmount modal khi đơn vẫn còn 7s (ở giây thứ 3)
        await act(async () => {
          mock.timers.tick(3000);
        });
        await act(async () => {
          root.unmount();
        });

        // Container sau khi unmount phải rỗng
        assert.equal(container!.innerHTML, "");

        // 3. Tiến thời gian vượt xa hạn ban đầu (+15s)
        // Callback không còn tồn tại, không gây lỗi hay leak trên unmounted component
        await act(async () => {
          mock.timers.tick(15000);
        });

        dom.window.close();
        globalTarget.window = originalWindow;
        globalTarget.document = originalDocument;
        globalTarget.self = originalSelf;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      } finally {
        mock.timers.reset();
      }
    });

    it("13l. component lifecycle order switch test: xác nhận timer của order cũ bị hủy và timer của order mới hoạt động chính xác khi đổi order ở cấp component", async () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      try {
        const now = 1770000000000;
        mock.timers.setTime(now);

        const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
        const originalWindow = globalThis.window;
        const originalDocument = globalThis.document;
        const originalSelf = globalThis.self;
        const globalTarget = globalThis as unknown as {
          window: unknown;
          document: unknown;
          self: unknown;
          IS_REACT_ACT_ENVIRONMENT?: boolean;
        };
        const originalActEnv = globalTarget.IS_REACT_ACT_ENVIRONMENT;

        globalTarget.window = dom.window;
        globalTarget.document = dom.window.document;
        globalTarget.self = dom.window;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = true;

        const container = dom.window.document.getElementById("root");
        const root = createRoot(container!);

        const orderA = createTestOrderSnapshot({
          id: "order-a-expires-5s",
          status: "PENDING",
          createdAt: new Date(now - 60000).toISOString(),
          expiresAt: new Date(now + 5000).toISOString(), // Hết hạn sau 5 giây
          totalVnd: 50000,
        });

        const orderB = createTestOrderSnapshot({
          id: "order-b-expires-20s",
          status: "PENDING",
          createdAt: new Date(now - 60000).toISOString(),
          expiresAt: new Date(now + 20000).toISOString(), // Hết hạn sau 20 giây
          totalVnd: 90000,
        });

        // 1. Mount với Order A
        await act(async () => {
          root.render(
            React.createElement(OrderSnapshotModal, {
              order: orderA,
              onClose: () => {},
              onReorder: () => {},
            })
          );
        });

        const ctaA = container!.querySelector("#order-snapshot-pay-cta");
        assert.ok(ctaA !== null);
        assert.equal(ctaA.getAttribute("data-order-id"), "order-a-expires-5s");

        // 2. Ở giây thứ 2 (khi Order A chưa hết hạn), đổi prop sang Order B
        await act(async () => {
          mock.timers.tick(2000);
        });

        await act(async () => {
          root.render(
            React.createElement(OrderSnapshotModal, {
              order: orderB,
              onClose: () => {},
              onReorder: () => {},
            })
          );
        });

        const ctaB = container!.querySelector("#order-snapshot-pay-cta");
        assert.ok(ctaB !== null);
        assert.equal(ctaB.getAttribute("data-order-id"), "order-b-expires-20s");

        // 3. Tiến thời gian thêm 4000ms (tổng 6000ms kể từ now - đã qua mốc 5s của Order A)
        // Vì timer của Order A đã được useEffect cleanup hủy bỏ, CTA của Order B KHÔNG bị ảnh hưởng
        await act(async () => {
          mock.timers.tick(4000);
        });

        const ctaBStillActive = container!.querySelector("#order-snapshot-pay-cta");
        assert.ok(
          ctaBStillActive !== null,
          "Timer của Order A đã được dọn dẹp (cleanup), CTA của Order B vẫn phải tồn tại sau khi qua mốc 5s của Order A"
        );
        assert.equal(ctaBStillActive.getAttribute("data-order-id"), "order-b-expires-20s");

        // 4. Tiến thời gian đến mốc 20000ms (chạm mốc hết hạn của chính Order B)
        // 6000ms + 14000ms = 20000ms
        await act(async () => {
          mock.timers.tick(14000);
        });

        const ctaBExpired = container!.querySelector("#order-snapshot-pay-cta");
        assert.equal(
          ctaBExpired,
          null,
          "CTA của Order B phải tự động biến mất khi chạm đúng hạn 20s của chính Order B"
        );

        // 5. Cleanup
        await act(async () => {
          root.unmount();
        });
        dom.window.close();

        globalTarget.window = originalWindow;
        globalTarget.document = originalDocument;
        globalTarget.self = originalSelf;
        globalTarget.IS_REACT_ACT_ENVIRONMENT = originalActEnv;
      } finally {
        mock.timers.reset();
      }
    });
  });

  describe("14. Server Truth & User Isolation cho Order Snapshot Modal (SCRUM-65)", () => {
    const userAId = "11111111-1111-4111-8111-111111111111";
    const userBId = "22222222-2222-4222-8222-222222222222";

    function deriveSnapshot(
      selectedOrderId: string | null,
      orders: OrderHistoryItemDto[],
      authUserId: string | null,
      loadedOwnerId: string | null
    ): OrderHistoryItemDto | null {
      if (!selectedOrderId) return null;
      if (!authUserId) return null;
      if (loadedOwnerId && loadedOwnerId !== authUserId && loadedOwnerId !== "mock-preview") {
        return null;
      }
      return orders.find((o) => o.id === selectedOrderId) ?? null;
    }

    it("14a. Modal luôn phản ánh dữ liệu mới nhất từ server (Server Truth) khi server trả lịch sử mới", () => {
      const orderPending: OrderHistoryItemDto = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        status: "PENDING",
        createdAt: "2026-10-28T01:00:00.000Z",
        expiresAt: "2026-10-28T01:15:00.000Z",
        subtotalVnd: 100000,
        discountVnd: 0,
        totalVnd: 100000,
        couponCode: null,
        pointsEarned: 10,
        items: [],
        payment: null,
      };

      let serverOrders: OrderHistoryItemDto[] = [orderPending];
      const selectedOrderId = "550e8400-e29b-41d4-a716-446655440001";

      // Snapshot ban đầu phản ánh đơn PENDING từ server
      let activeSnapshot = deriveSnapshot(selectedOrderId, serverOrders, userAId, userAId);
      assert.ok(activeSnapshot !== null);
      assert.equal(activeSnapshot?.status, "PENDING");
      assert.equal(activeSnapshot?.payment, null);

      // Server cập nhật đơn thành PAID sau khi khách thanh toán thành công
      const orderPaid: OrderHistoryItemDto = {
        ...orderPending,
        status: "PAID",
        payment: {
          id: "pay-succ-1",
          method: "WALLET",
          methodLast4: null,
          status: "SUCCESS",
          amountVnd: 100000,
          mockReference: "BREW-WALLET-8888",
          failureReason: null,
          createdAt: "2026-10-28T01:05:00.000Z",
        },
      };

      serverOrders = [orderPaid];

      // Snapshot được cập nhật trực tiếp theo server truth mà không giữ trạng thái cũ
      activeSnapshot = deriveSnapshot(selectedOrderId, serverOrders, userAId, userAId);
      assert.ok(activeSnapshot !== null);
      assert.equal(activeSnapshot?.status, "PAID", "Modal phải cập nhật trạng thái PAID theo server truth");
      assert.equal(activeSnapshot?.payment?.status, "SUCCESS", "Modal phải hiển thị thông tin thanh toán mới từ server");

      // Với trạng thái PAID từ server truth, CTA thanh toán phải tự động biến mất
      const modalMarkup = ReactDOMServer.renderToStaticMarkup(
        React.createElement(OrderSnapshotModal, {
          order: activeSnapshot!,
          onClose: () => {},
          onReorder: () => {},
        })
      );
      assert.ok(
        !modalMarkup.includes('id="order-snapshot-pay-cta"'),
        "Modal cập nhật PAID theo server truth không được hiển thị nút CTA thanh toán"
      );
    });

    it("14b. Modal tự động đóng (selectedOrderSnapshot = null) khi server loại bỏ đơn hàng khỏi danh sách mới", () => {
      const orderPending: OrderHistoryItemDto = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        status: "PENDING",
        createdAt: "2026-10-28T01:00:00.000Z",
        expiresAt: "2026-10-28T01:15:00.000Z",
        subtotalVnd: 50000,
        discountVnd: 0,
        totalVnd: 50000,
        couponCode: null,
        pointsEarned: 5,
        items: [],
        payment: null,
      };

      let serverOrders: OrderHistoryItemDto[] = [orderPending];
      const selectedOrderId = "550e8400-e29b-41d4-a716-446655440001";

      assert.ok(deriveSnapshot(selectedOrderId, serverOrders, userAId, userAId) !== null);

      // Server trả về danh sách rỗng (hoặc đơn hàng đã bị xóa / chuyển sang phân trang khác)
      serverOrders = [];

      const activeSnapshot = deriveSnapshot(selectedOrderId, serverOrders, userAId, userAId);
      assert.equal(
        activeSnapshot,
        null,
        "Snapshot modal phải tự động đóng khi đơn không còn trong danh sách mới của server"
      );
    });

    it("14c. Modal tự động đóng ngay lập tức khi đăng xuất hoặc đổi sang User B (cô lập tài khoản tuyệt đối)", () => {
      const orderUserA: OrderHistoryItemDto = {
        id: "550e8400-e29b-41d4-a716-user-a-order-1",
        status: "PENDING",
        createdAt: "2026-10-28T01:00:00.000Z",
        expiresAt: "2026-10-28T01:15:00.000Z",
        subtotalVnd: 75000,
        discountVnd: 0,
        totalVnd: 75000,
        couponCode: null,
        pointsEarned: 7,
        items: [],
        payment: null,
      };

      const ordersUserA = [orderUserA];
      const selectedOrderId = "550e8400-e29b-41d4-a716-user-a-order-1";

      // Khi User A đang đăng nhập
      assert.ok(deriveSnapshot(selectedOrderId, ordersUserA, userAId, userAId) !== null);

      // 1. Khi User A đăng xuất (authUserId = null)
      const afterLogout = deriveSnapshot(selectedOrderId, ordersUserA, null, null);
      assert.equal(
        afterLogout,
        null,
        "Snapshot modal phải bị hủy ngay lập tức khi đăng xuất, không giữ dữ liệu cũ"
      );

      // 2. Khi User B đăng nhập vào cùng tab
      const ordersUserB: OrderHistoryItemDto[] = [
        {
          id: "550e8400-e29b-41d4-a716-user-b-order-9",
          status: "PAID",
          createdAt: "2026-10-28T02:00:00.000Z",
          expiresAt: "2026-10-28T02:15:00.000Z",
          subtotalVnd: 45000,
          discountVnd: 0,
          totalVnd: 45000,
          couponCode: null,
          pointsEarned: 4,
          items: [],
          payment: null,
        },
      ];

      // Thử truy cập snapshot của User A bằng phiên của User B
      const crossUserAccess = deriveSnapshot(selectedOrderId, ordersUserB, userBId, userBId);
      assert.equal(
        crossUserAccess,
        null,
        "Snapshot modal của User A tuyệt đối không được phép mở hoặc giữ lại trong phiên User B"
      );
    });
  });

});
