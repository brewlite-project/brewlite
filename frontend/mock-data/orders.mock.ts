import type { GetMyOrdersResponseDto, OrderHistoryItemDto } from "./types";

// ============================================================================
// DỮ LIỆU MOCK LỊCH SỬ ĐƠN HÀNG (`GET /orders/me` — SPRINT 3 SCRUM-64)
// Đồng bộ 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md §4 (`GET /orders/me`) & §9
// - Màn hình Stitch: Lịch sử đơn hàng (Order History) - Desktop (d97db97f606841e4a3fa8879b18e80ba)
// - Đảm bảo toàn bộ bất biến toán học ERD:
//   * lineTotalVnd = unitPriceVnd * quantity
//   * subtotalVnd = sum(lineTotalVnd)
//   * totalVnd = subtotalVnd - discountVnd
// ============================================================================

export const MOCK_ORDER_HISTORY_ITEMS: OrderHistoryItemDto[] = [
  {
    id: "9f8b7a6c-5d4e-43f2-a1b0-c9d8e7f61042",
    status: "PAID",
    createdAt: "2026-10-24T09:15:00.000Z",
    expiresAt: "2026-10-24T09:30:00.000Z",
    subtotalVnd: 151600,
    discountVnd: 10000,
    totalVnd: 141600,
    couponCode: "BREWLITE10K",
    pointsEarned: 14,
    items: [
      {
        id: "d1000000-0000-4000-8000-000000001001",
        productId: "a3000000-0000-4000-8000-000000000003",
        productName: "Cà Phê Muối Cố Đô",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 39000,
        quantity: 2,
        unitPriceVnd: 56800,
        lineTotalVnd: 113600,
        toppings: [
          {
            id: "b2000000-0000-4000-8000-000000000002",
            name: "Kem cheese",
            priceVnd: 10000,
          },
        ],
      },
      {
        id: "d1000000-0000-4000-8000-000000001002",
        productId: "a3000000-0000-4000-8000-000000000009",
        productName: "Croissant Bơ Pháp Nướng",
        size: "ONE_SIZE",
        sizeMultiplierPercent: 100,
        basePriceVnd: 38000,
        quantity: 1,
        unitPriceVnd: 38000,
        lineTotalVnd: 38000,
        toppings: [],
      },
    ],
    payment: {
      id: "c1000000-0000-4000-8000-000000001042",
      status: "SUCCESS",
      method: "CARD",
      methodLast4: "4242",
      amountVnd: 141600,
      mockReference: "MOCK-20261024-8821",
      failureReason: null,
      createdAt: "2026-10-24T09:16:10.000Z",
    },
  },
  {
    id: "4e2d1c9a-8f7b-46e5-94c3-b2a1908f0988",
    status: "PENDING",
    createdAt: "2026-10-23T14:30:00.000Z",
    expiresAt: "2026-10-23T14:45:00.000Z",
    subtotalVnd: 80600,
    discountVnd: 0,
    totalVnd: 80600,
    couponCode: null,
    pointsEarned: 0,
    items: [
      {
        id: "d1000000-0000-4000-8000-000000002001",
        productId: "a3000000-0000-4000-8000-000000000005",
        productName: "Cold Brew Cam Sả Thảo Mộc",
        size: "L",
        sizeMultiplierPercent: 140,
        basePriceVnd: 49000,
        quantity: 1,
        unitPriceVnd: 80600,
        lineTotalVnd: 80600,
        toppings: [
          {
            id: "b2000000-0000-4000-8000-000000000003",
            name: "Thêm shot espresso",
            priceVnd: 12000,
          },
        ],
      },
    ],
    payment: null,
  },
  {
    id: "7a6b5c4d-3e2f-41a0-89b8-c7d6e5f40915",
    status: "PAYMENT_FAILED",
    createdAt: "2026-10-18T16:45:00.000Z",
    expiresAt: "2026-10-18T17:00:00.000Z",
    subtotalVnd: 150000,
    discountVnd: 0,
    totalVnd: 150000,
    couponCode: null,
    pointsEarned: 0,
    items: [
      {
        id: "d1000000-0000-4000-8000-000000003001",
        productId: "a3000000-0000-4000-8000-000000000007",
        productName: "Espresso Macchiato Caramel",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 45000,
        quantity: 2,
        unitPriceVnd: 54000,
        lineTotalVnd: 108000,
        toppings: [],
      },
      {
        id: "d1000000-0000-4000-8000-000000003002",
        productId: "a3000000-0000-4000-8000-000000000001",
        productName: "Bạc Xỉu Kem Béo Phin",
        size: "S",
        sizeMultiplierPercent: 100,
        basePriceVnd: 42000,
        quantity: 1,
        unitPriceVnd: 42000,
        lineTotalVnd: 42000,
        toppings: [],
      },
    ],
    payment: {
      id: "c1000000-0000-4000-8000-000000000915",
      status: "FAILED",
      method: "WALLET",
      methodLast4: null,
      amountVnd: 150000,
      mockReference: "MOCK-20261018-3310",
      failureReason: "PAYMENT_DECLINED",
      createdAt: "2026-10-18T16:46:05.000Z",
    },
  },
  {
    id: "1b2c3d4e-5f6a-47b8-9c0d-1e2f3a4b0841",
    status: "CANCELLED",
    createdAt: "2026-10-12T08:10:00.000Z",
    expiresAt: "2026-10-12T08:25:00.000Z",
    subtotalVnd: 42000,
    discountVnd: 0,
    totalVnd: 42000,
    couponCode: null,
    pointsEarned: 0,
    items: [
      {
        id: "d1000000-0000-4000-8000-000000004001",
        productId: "a3000000-0000-4000-8000-000000000004",
        productName: "Cà phê Sữa Đá Sài Gòn",
        size: "M",
        sizeMultiplierPercent: 120,
        basePriceVnd: 35000,
        quantity: 1,
        unitPriceVnd: 42000,
        lineTotalVnd: 42000,
        toppings: [],
      },
    ],
    payment: null,
  },
];

export const MOCK_MY_ORDERS_RESPONSE: GetMyOrdersResponseDto = {
  items: MOCK_ORDER_HISTORY_ITEMS,
  meta: {
    page: null,
    limit: null,
    total: MOCK_ORDER_HISTORY_ITEMS.length,
    totalPages: null,
  },
};
