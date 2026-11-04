"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";
import {
  MOCK_SITE_CONFIG,
  type GetMyOrdersQueryParams,
  type GetMyOrdersResponseDto,
  type OrderHistoryItemDto,
  type OrderHistoryMetaDto,
  type OrderItemSnapshotDto,
  type OrderStatus,
} from "@/mock-data";
import { formatVnd } from "@/services/api.service";
import { getDisplayCustomerName } from "@/services/auth.service";
import {
  computeOrderStatusCounts,
  filterAndSearchOrders,
  formatOrderTimestampVi,
  getMyOrdersApi,
  type OrderHistoryFilterTab,
  type OrderServiceError,
} from "@/services/order.service";

// ============================================================================
// ORDER HISTORY VIEW (`GET /orders/me` — SPRINT 3 SCRUM-64)
// Đối chiếu chuẩn 100% với:
// - Màn hình Stitch: Lịch sử đơn hàng (Order History) - Desktop (d97db97f606841e4a3fa8879b18e80ba)
// - docs/api/BrewLite_API_Contract_v3.0.md §4 (`GET /orders/me`) & §9
// - Hiển thị ảnh sản phẩm sắc nét (`w-20 h-20 rounded-xl`) và bố cục 3 phần chuẩn Stitch:
//   1. Card Header: Mã đơn `#uuid`, badge "Mới nhất", thời gian đặt, phương thức nhận, Status Pill.
//   2. Card Body (12 cols):
//      - Col 1-6: Ảnh sản phẩm `w-20 h-20` + Tóm tắt món, topping, mã giảm giá & thông tin thanh toán.
//      - Col 7-9: Tổng thanh toán & Điểm tích lũy thành viên.
//      - Col 10-12: Các nút thao tác chính + liên kết "Xem chi tiết snapshot".
//   3. Card Footer Banner (cho đơn PENDING / PAYMENT_FAILED): Thông báo giữ chỗ 15 phút (HELD).
// ============================================================================

export const DEFAULT_CLIENT_PAGE_SIZE = 4;

/**
 * Cấu hình cho phép chế độ Mock Preview:
 * - Chỉ bật trong môi trường dev/test.
 * - Tuyệt đối không cho phép production mở mock/state giả qua URL query (?state=...) hoặc các nút preview.
 * - Chặn triệt để trên production: không cho phép override kể cả khi NEXT_PUBLIC_ENABLE_MOCK_PREVIEW=true.
 */
export function isMockPreviewAllowed(): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  return true;
}

export const IS_MOCK_PREVIEW_ALLOWED = process.env.NODE_ENV !== "production";

export interface OrderHistoryErrorState {
  statusCode: number;
  code: string;
  title: string;
  message: string;
}

export interface ExecuteFetchOrderHistoryDeps {
  isAuthenticated: boolean;
  userId: string | null;
  accessToken: string | null;
  query?: GetMyOrdersQueryParams;
  useMockData?: boolean;
  signal?: AbortSignal;
  verifySession: () => boolean;
  onUnauthorized?: (message: string) => void;
  setIsLoading: (loading: boolean) => void;
  setOrders: (orders: OrderHistoryItemDto[]) => void;
  setMeta: (meta: OrderHistoryMetaDto | null) => void;
  setErrorState: (error: OrderHistoryErrorState | null) => void;
  setLoadedOwnerUserId: (userId: string | null) => void;
  fetchOrdersFn?: typeof getMyOrdersApi;
}

/**
 * Hàm điều phối tải dữ liệu `GET /orders/me` (tách biệt để kiểm thử tự động các luồng Loading,
 * 200 OK, Empty, 401 Unauthorized, Network Error, 500 Internal Error và User Isolation).
 */
export async function executeFetchOrderHistory(
  deps: ExecuteFetchOrderHistoryDeps
): Promise<GetMyOrdersResponseDto | null> {
  const {
    isAuthenticated,
    userId,
    accessToken,
    query,
    useMockData = false,
    signal,
    verifySession,
    onUnauthorized,
    setIsLoading,
    setOrders,
    setMeta,
    setErrorState,
    setLoadedOwnerUserId,
    fetchOrdersFn = getMyOrdersApi,
  } = deps;

  const safeUseMockData = Boolean(useMockData && isMockPreviewAllowed());

  if (!safeUseMockData) {
    if (!isAuthenticated || !userId || !accessToken || !verifySession()) {
      setIsLoading(false);
      setOrders([]);
      setMeta(null);
      setErrorState(null);
      setLoadedOwnerUserId(null);
      return null;
    }
  }

  setIsLoading(true);
  setErrorState(null);

  try {
    const response = await fetchOrdersFn({
      query,
      tokenOverride: accessToken,
      signal,
      useMockData: safeUseMockData,
    });

    if (signal?.aborted) {
      return null;
    }

    setOrders(response.items);
    setMeta(response.meta);
    setErrorState(null);
    setLoadedOwnerUserId(safeUseMockData ? "mock-preview" : userId);
    return response;
  } catch (err: unknown) {
    if (signal?.aborted) {
      return null;
    }

    const orderErr = err as Partial<OrderServiceError>;
    const statusCode =
      typeof orderErr?.statusCode === "number" ? orderErr.statusCode : 500;
    const code =
      typeof orderErr?.code === "string" && orderErr.code.trim()
        ? orderErr.code.trim()
        : "INTERNAL_ERROR";
    const message =
      typeof orderErr?.message === "string" && orderErr.message.trim()
        ? orderErr.message.trim()
        : "Không thể tải danh sách lịch sử đơn hàng từ máy chủ. Vui lòng thử lại.";

    setOrders([]);
    setMeta(null);
    setLoadedOwnerUserId(null);

    if (statusCode === 401 || code === "UNAUTHORIZED") {
      onUnauthorized?.(message);
      setErrorState(null);
      return null;
    }

    const title =
      code === "NETWORK_ERROR"
        ? "Mất kết nối tới máy chủ đơn hàng"
        : code === "VALIDATION_ERROR"
        ? "Tham số truy vấn lịch sử không hợp lệ"
        : "Không thể tải lịch sử đơn hàng";

    setErrorState({
      statusCode,
      code,
      title,
      message,
    });
    return null;
  } finally {
    if (!signal?.aborted) {
      setIsLoading(false);
    }
  }
}

/**
 * Ánh xạ thông minh `productId` và `productName` trong `OrderItemSnapshotDto`
 * sang ảnh chụp sản phẩm thực tế sắc nét trong `/images/*.jpg`.
 * Lý do: `GET /orders/me` chỉ trả về `productId` và `productName` trong snapshot nên
 * Frontend cần ánh xạ theo cả UUID lẫn tên món tiếng Việt để luôn hiển thị ảnh đồ uống thật.
 */
export function resolveOrderItemImageUrl(
  productId: string,
  productName: string
): string {
  const idLower = (productId || "").trim().toLowerCase();
  const nameLower = (productName || "").trim().toLowerCase();

  // 1. Ánh xạ trực tiếp theo UUID seed.ts của Backend (9 sản phẩm chuẩn)
  const imageByProductId: Record<string, string> = {
    "a3000000-0000-4000-8000-000000000001": "/images/bac-xiu-kem-beo-phin.jpg",
    "a3000000-0000-4000-8000-000000000002": "/images/ca-phe-den-da-cau-dat.jpg",
    "a3000000-0000-4000-8000-000000000003": "/images/ca-phe-muoi-co-do.jpg",
    "a3000000-0000-4000-8000-000000000004": "/images/ca-phe-sua-da-sai-gon.jpg",
    "a3000000-0000-4000-8000-000000000005":
      "/images/cold-brew-cam-sa-thao-moc.jpg",
    "a3000000-0000-4000-8000-000000000006":
      "/images/cold-brew-vai-hoa-hong.jpg",
    "a3000000-0000-4000-8000-000000000007":
      "/images/espresso-macchiato-caramel.jpg",
    "a3000000-0000-4000-8000-000000000008":
      "/images/tra-dao-cam-sa-hoang-gia.jpg",
    "a3000000-0000-4000-8000-000000000009":
      "/images/croissant-bo-phap-nuong.jpg",
    // Legacy UUID mapping cho bài test cũ
    "a1000000-0000-4000-8000-000000000001": "/images/ca-phe-den-da-cau-dat.jpg",
    "a1000000-0000-4000-8000-000000000002": "/images/ca-phe-sua-da-sai-gon.jpg",
    "a1000000-0000-4000-8000-000000000003": "/images/bac-xiu-kem-beo-phin.jpg",
    "a1000000-0000-4000-8000-000000000004":
      "/images/espresso-macchiato-caramel.jpg",
    "a1000000-0000-4000-8000-000000000005": "/images/ca-phe-muoi-co-do.jpg",
    "a1000000-0000-4000-8000-000000000006":
      "/images/tra-dao-cam-sa-hoang-gia.jpg",
    "a1000000-0000-4000-8000-000000000007":
      "/images/cold-brew-cam-sa-thao-moc.jpg",
    "a1000000-0000-4000-8000-000000000008":
      "/images/cold-brew-vai-hoa-hong.jpg",
  };

  // 2. Ưu tiên nhận diện theo từ khóa tên món để khớp chính xác từng loại đồ uống/bánh
  if (nameLower.includes("muối")) {
    return "/images/ca-phe-muoi-co-do.jpg";
  }
  if (nameLower.includes("croissant") || nameLower.includes("bánh")) {
    return "/images/croissant-bo-phap-nuong.jpg";
  }
  if (nameLower.includes("bạc xỉu")) {
    return "/images/bac-xiu-kem-beo-phin.jpg";
  }
  if (nameLower.includes("cold brew") && nameLower.includes("vải")) {
    return "/images/cold-brew-vai-hoa-hong.jpg";
  }
  if (nameLower.includes("cold brew")) {
    return "/images/cold-brew-cam-sa-thao-moc.jpg";
  }
  if (nameLower.includes("trà đào") || nameLower.includes("cam sả")) {
    return "/images/tra-dao-cam-sa-hoang-gia.jpg";
  }
  if (
    nameLower.includes("espresso") ||
    nameLower.includes("macchiato") ||
    nameLower.includes("cappuccino") ||
    nameLower.includes("latte")
  ) {
    return "/images/espresso-macchiato-caramel.jpg";
  }
  if (nameLower.includes("đen")) {
    return "/images/ca-phe-den-da-cau-dat.jpg";
  }
  if (nameLower.includes("sữa")) {
    return "/images/ca-phe-sua-da-sai-gon.jpg";
  }

  if (imageByProductId[idLower]) {
    return imageByProductId[idLower];
  }

  return "/images/ca-phe-sua-da-sai-gon.jpg";
}

function formatSizeShort(size: string): string {
  if (size === "ONE_SIZE") {
    return "Tiêu chuẩn";
  }
  return `Size ${size}`;
}

function formatSizeLabel(size: string, multiplierPercent: number): string {
  if (size === "ONE_SIZE") {
    return "Tiêu chuẩn";
  }
  return `Size ${size}`;
}

function formatTimeOnlyVi(isoString: string): string {
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return isoString;
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function formatDateDotTimeVi(isoString: string): string {
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return isoString;
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} • ${hours}:${minutes}`;
}

/**
 * Cấu hình Badge trạng thái chuẩn theo màn hình Stitch `stitch-order-history.html`
 */
function getStitchStatusBadgeConfig(status: OrderStatus): {
  badgeText: string;
  pillClass: string;
  dotClass: string;
  isPing: boolean;
  filterGroup: Exclude<OrderHistoryFilterTab, "all">;
} {
  switch (status) {
    case "PENDING":
      return {
        badgeText: "ĐANG CHỜ THANH TOÁN",
        pillClass: "bg-[#FEFCE8] text-[#D97706] border border-[#FDE68A]",
        dotClass: "bg-[#EAB308]",
        isPing: true,
        filterGroup: "PENDING",
      };
    case "PAYMENT_FAILED":
      return {
        badgeText: "THANH TOÁN THẤT BẠI",
        pillClass: "bg-[#FEF2F2] text-[#DC2626] border border-[#FECACA]",
        dotClass: "bg-[#DC2626]",
        isPing: false,
        filterGroup: "PAYMENT_FAILED",
      };
    case "PAID":
      return {
        badgeText: "ĐÃ THANH TOÁN",
        pillClass: "bg-[#F0FDF4] text-[#16A34A] border border-[#BBF7D0]",
        dotClass: "bg-[#16A34A]",
        isPing: false,
        filterGroup: "PAID_GROUP",
      };
    case "PREPARING":
      return {
        badgeText: "ĐANG PHA CHẾ",
        pillClass: "bg-[#F0FDF4] text-[#16A34A] border border-[#BBF7D0]",
        dotClass: "bg-[#16A34A]",
        isPing: true,
        filterGroup: "PAID_GROUP",
      };
    case "READY":
      return {
        badgeText: "SẴN SÀNG NHẬN MÓN",
        pillClass: "bg-[#F0FDF4] text-[#16A34A] border border-[#BBF7D0]",
        dotClass: "bg-[#16A34A]",
        isPing: true,
        filterGroup: "PAID_GROUP",
      };
    case "COMPLETED":
      return {
        badgeText: "HOÀN TẤT",
        pillClass: "bg-[#F0FDF4] text-[#16A34A] border border-[#BBF7D0]",
        dotClass: "bg-[#16A34A]",
        isPing: false,
        filterGroup: "PAID_GROUP",
      };
    case "CANCELLED":
    default:
      return {
        badgeText: "ĐÃ HỦY",
        pillClass:
          "bg-surface-container-high text-outline border border-outline-variant/40",
        dotClass: "bg-outline",
        isPing: false,
        filterGroup: "CANCELLED",
      };
  }
}

/**
 * Kiểm tra xem đơn hàng có thể thanh toán tiếp hay không (SCRUM-65):
 * - Trạng thái phải là PENDING hoặc PAYMENT_FAILED.
 * - expiresAt phải là mốc ISO hợp lệ và lớn hơn thời điểm tham chiếu referenceTimestampMs.
 */
export function isOrderPayable(
  order: Pick<OrderHistoryItemDto, "status" | "expiresAt"> | null | undefined,
  referenceTimestampMs?: number
): boolean {
  if (!order) return false;
  if (order.status !== "PENDING" && order.status !== "PAYMENT_FAILED") {
    return false;
  }
  const expiresMs = Number.isFinite(Date.parse(order.expiresAt))
    ? new Date(order.expiresAt).getTime()
    : 0;
  if (expiresMs <= 0) {
    return false;
  }
  const now = referenceTimestampMs ?? Date.now();
  return expiresMs > now;
}

/**
 * Thiết lập timer tự động kích hoạt callback khi chạm mốc expiresAt của đơn hàng (SCRUM-65).
 * - Trả về hàm cleanup () => void để hủy timer khi unmount hoặc đổi đơn.
 * - Trả về null nếu đơn hàng đã hết hạn ngay thời điểm kiểm tra.
 */
export function setupOrderExpirationTimer(
  expiresAtIso: string,
  onExpire: () => void,
  nowMs = Date.now()
): (() => void) | null {
  const expiresMs = Number.isFinite(Date.parse(expiresAtIso))
    ? new Date(expiresAtIso).getTime()
    : 0;
  if (expiresMs <= 0) {
    onExpire();
    return null;
  }
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    onExpire();
    return null;
  }
  const timer = setTimeout(onExpire, remainingMs);
  return () => {
    clearTimeout(timer);
  };
}

export interface OrderSnapshotModalProps {
  order: OrderHistoryItemDto;
  onClose: () => void;
  onReorder: (order: OrderHistoryItemDto) => void;
  /** Thời điểm tham chiếu (ms) để xác định đơn còn hạn hay đã hết hạn. */
  referenceTimestampMs?: number;
}

export function OrderSnapshotModal({
  order,
  onClose,
  onReorder,
  referenceTimestampMs,
}: OrderSnapshotModalProps) {
  // Trạng thái live countdown: lưu orderId đã kích hoạt hết hạn để tự động cô lập theo từng đơn hàng
  const [expiredOrderId, setExpiredOrderId] = useState<string | null>(null);

  useEffect(() => {
    // 1. Chế độ test / SSR truyền referenceTimestampMs cố định: không kích hoạt live timer
    if (referenceTimestampMs !== undefined) {
      return;
    }

    // 2. Chế độ runtime: đặt timer tự động ẩn CTA ngay khi qua expiresAt
    const currentOrderId = order.id;
    const cleanup = setupOrderExpirationTimer(order.expiresAt, () => {
      setExpiredOrderId(currentOrderId);
    });

    return () => {
      cleanup?.();
    };
  }, [order.id, order.status, order.expiresAt, referenceTimestampMs]);

  // CTA chỉ hiển thị khi:
  // - Trạng thái là PENDING hoặc PAYMENT_FAILED
  // - Đơn hàng hiện tại chưa bị hết hạn trong live timer
  // - Còn trong hạn tại thời điểm tham chiếu (isOrderPayable)
  const isCurrentOrderExpiredLive = expiredOrderId === order.id;
  const isPayable =
    !isCurrentOrderExpiredLive && isOrderPayable(order, referenceTimestampMs);

  const modalStatus = getStitchStatusBadgeConfig(order.status);

  return (
    <div
      id="orderSnapshotDetailModal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="orderSnapshotModalTitle"
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-container-lowest rounded-xl shadow-2xl border border-outline-variant/40 max-w-2xl w-full max-h-[90vh] overflow-y-auto p-space-lg flex flex-col gap-space-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-surface-container pb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                id="orderSnapshotModalTitle"
                className="font-headline-md text-headline-md text-on-surface"
              >
                Chi tiết Đơn hàng
              </h3>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full font-label-md text-[11px] font-semibold ${modalStatus.pillClass}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${modalStatus.dotClass}`}
                />
                <span>{modalStatus.badgeText}</span>
              </span>
            </div>
            <p className="font-mono text-[13px] text-on-surface-variant mt-1 break-all">
              #{order.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng chi tiết đơn hàng"
            className="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">
              close
            </span>
          </button>
        </div>

        {/* Thông tin thời gian tạo & hạn thanh toán */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-surface-container-low p-3.5 rounded-xl text-body-sm">
          <div>
            <span className="text-on-surface-variant block">
              Thời điểm tạo đơn:
            </span>
            <strong className="text-on-surface">
              {formatOrderTimestampVi(order.createdAt)}
            </strong>
          </div>
          <div>
            <span className="text-on-surface-variant block">
              Hạn thanh toán:
            </span>
            <strong className="text-on-surface">
              {formatOrderTimestampVi(order.expiresAt)}
            </strong>
          </div>
        </div>

        {/* Danh sách dòng món kèm ảnh sản phẩm */}
        <div className="space-y-2.5">
          <h4 className="font-title-sm text-title-sm text-on-surface">
            Danh sách món ({order.items.length} món)
          </h4>
          <div className="space-y-2.5">
            {order.items.map((item: OrderItemSnapshotDto) => {
              const itemImg = resolveOrderItemImageUrl(
                item.productId,
                item.productName
              );
              return (
                <div
                  key={item.id}
                  className="p-3 rounded-xl bg-surface-container-low/70 border border-outline-variant/30 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-14 h-14 rounded-lg overflow-hidden bg-surface-container flex-shrink-0 border border-outline-variant/25">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={itemImg}
                        alt={item.productName}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="space-y-0.5 min-w-0">
                      <div className="font-title-sm text-title-sm text-on-surface truncate">
                        <span className="text-primary font-bold">
                          {item.quantity}x
                        </span>{" "}
                        {item.productName}{" "}
                        <span className="text-on-surface-variant font-normal text-body-sm">
                          • {formatSizeLabel(item.size, item.sizeMultiplierPercent)}
                        </span>
                      </div>
                      <div className="font-body-sm text-[12px] text-outline">
                        Đơn giá: {formatVnd(item.unitPriceVnd)} × {item.quantity}
                      </div>
                      {item.toppings.length > 0 && (
                        <div className="font-body-sm text-[12px] text-on-surface-variant">
                          Topping:{" "}
                          {item.toppings
                            .map((t) => `${t.name} (+${formatVnd(t.priceVnd)})`)
                            .join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="font-title-sm text-title-sm text-primary font-bold whitespace-nowrap">
                    {formatVnd(item.lineTotalVnd)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tóm tắt giao dịch thanh toán */}
        <div className="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/30 space-y-1.5 text-body-sm">
          <h4 className="font-title-sm text-title-sm text-on-surface">
            Thông tin thanh toán
          </h4>
          {order.payment ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <span className="text-on-surface-variant">Phương thức: </span>
                <strong className="text-on-surface">
                  {order.payment.method === "CARD"
                    ? `CARD${
                        order.payment.methodLast4
                          ? ` •••• ${order.payment.methodLast4}`
                          : ""
                      }`
                    : "WALLET"}
                </strong>
              </div>
              <div>
                <span className="text-on-surface-variant">Trạng thái: </span>
                <strong
                  className={
                    order.payment.status === "SUCCESS"
                      ? "text-[#16A34A]"
                      : "text-error"
                  }
                >
                  {order.payment.status}
                </strong>
              </div>
              {order.payment.mockReference && (
                <div>
                  <span className="text-on-surface-variant">
                    Mã tham chiếu:{" "}
                  </span>
                  <code className="font-mono text-on-surface">
                    {order.payment.mockReference}
                  </code>
                </div>
              )}
              {order.payment.failureReason && (
                <div>
                  <span className="text-on-surface-variant">
                    Lý do từ chối:{" "}
                  </span>
                  <code className="font-mono text-error font-semibold">
                    {order.payment.failureReason}
                  </code>
                </div>
              )}
            </div>
          ) : (
            <p className="text-on-surface-variant">
              Chưa phát sinh giao dịch thanh toán.
            </p>
          )}
        </div>

        {/* Bảng tổng tiền */}
        <div className="p-3.5 rounded-xl bg-surface-container rounded-lg flex flex-col gap-1.5 text-body-sm">
          <div className="flex justify-between text-on-surface-variant">
            <span>Tạm tính:</span>
            <strong className="text-on-surface">
              {formatVnd(order.subtotalVnd)}
            </strong>
          </div>
          <div className="flex justify-between text-tertiary font-medium">
            <span>
              Giảm giá
              {order.couponCode ? ` (${order.couponCode})` : ""}:
            </span>
            <span>-{formatVnd(order.discountVnd)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t border-outline/15 text-title-sm">
            <span className="font-bold text-on-surface">
              Tổng thanh toán:
            </span>
            <span className="font-bold text-primary">
              {formatVnd(order.totalVnd)}
            </span>
          </div>
          <div className="flex justify-between text-on-surface-variant pt-0.5">
            <span>Điểm tích lũy đã cộng:</span>
            <strong className="text-tertiary">
              +{order.pointsEarned} điểm
            </strong>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-container text-on-surface font-label-md text-label-md hover:bg-surface-container-high transition-colors cursor-pointer"
          >
            Đóng
          </button>
          {isPayable && (
            <Link
              id="order-snapshot-pay-cta"
              data-testid="order-snapshot-pay-cta"
              data-order-id={order.id}
              href={`/payment?orderId=${order.id}`}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary-container transition-colors flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">
                payment
              </span>
              <span>
                Thanh toán ngay ({formatVnd(order.totalVnd)})
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              onClose();
              onReorder(order);
            }}
            className="px-4 py-2 rounded-lg bg-surface-container-high text-on-surface hover:bg-surface-container-highest font-label-md text-label-md transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">
              repeat
            </span>
            <span>Đặt lại món</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OrderHistoryView() {
  const {
    user,
    accessToken,
    isAuthenticated,
    isLoading: isAuthLoading,
    verifySession,
    openAuthModal,
  } = useAuth();
  const { openCart, addToCart } = useCart();

  const currentAuthUserId =
    isAuthenticated && user?.id && user.id.trim() ? user.id.trim() : null;

  const [orders, setOrders] = useState<OrderHistoryItemDto[]>([]);
  const [meta, setMeta] = useState<OrderHistoryMetaDto | null>(null);
  const [loadedOwnerUserId, setLoadedOwnerUserId] = useState<string | null>(
    null
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorState, setErrorState] = useState<OrderHistoryErrorState | null>(
    null
  );
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [useMockPreview, setUseMockPreview] = useState<boolean>(false);

  // Bộ lọc tab trạng thái, từ khóa tìm kiếm và phân trang phía Client
  const [activeFilterTab, setActiveFilterTab] =
    useState<OrderHistoryFilterTab>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Modal xem chi tiết Snapshot hoặc Hóa đơn điện tử (e-Invoice) của đơn hàng
  // Quản lý theo Server Truth: lưu selectedOrderId, derive selectedOrderSnapshot từ danh sách orders mới nhất của server
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const selectedOrderSnapshot = useMemo(() => {
    if (!selectedOrderId) return null;
    if (!isAuthenticated || !currentAuthUserId) return null;
    if (
      loadedOwnerUserId &&
      loadedOwnerUserId !== currentAuthUserId &&
      loadedOwnerUserId !== "mock-preview"
    ) {
      return null;
    }
    return orders.find((o) => o.id === selectedOrderId) ?? null;
  }, [
    selectedOrderId,
    orders,
    isAuthenticated,
    currentAuthUserId,
    loadedOwnerUserId,
  ]);

  const setSelectedOrderSnapshot = useCallback(
    (orderOrNull: OrderHistoryItemDto | null) => {
      setSelectedOrderId(orderOrNull ? orderOrNull.id : null);
    },
    []
  );

  // Toast thông báo thao tác trên màn hình Lịch sử đơn hàng (vị trí top-right chuẩn Stitch)
  const [toastMessage, setToastMessage] = useState<string>("");
  const [toastVisible, setToastVisible] = useState<boolean>(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToastNotice = useCallback((message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
    }, 3200);
  }, []);

  const handleDismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastVisible(false);
  }, []);

  // Cô lập dữ liệu theo tài khoản: chỉ hiển thị đơn hàng khi thuộc đúng user hiện tại (hoặc chế độ mock preview)
  const visibleOrders = useMemo(() => {
    if (useMockPreview && loadedOwnerUserId === "mock-preview") {
      return orders;
    }
    if (!currentAuthUserId || loadedOwnerUserId !== currentAuthUserId) {
      return [];
    }
    return orders;
  }, [orders, useMockPreview, loadedOwnerUserId, currentAuthUserId]);

  // Tải danh sách đơn hàng từ `GET /orders/me` khi mở trang, đổi tài khoản hoặc nhấn Làm mới
  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    const searchParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    // Giới hạn query param ?state=... cho môi trường dev/test, ngăn chặn mở state giả trên production
    const rawState = searchParams?.get("state")?.toLowerCase();
    const stateParam = isMockPreviewAllowed() ? rawState : null;

    if (stateParam === "loading") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLoading(true);
      setErrorState(null);
      return;
    }

    if (stateParam === "empty") {
      setIsLoading(false);
      setErrorState(null);
      setOrders([]);
      setMeta({ page: null, limit: null, total: 0, totalPages: null });
      setLoadedOwnerUserId(currentAuthUserId || "mock-preview");
      return;
    }

    if (stateParam === "error") {
      setIsLoading(false);
      setOrders([]);
      setMeta(null);
      setErrorState({
        statusCode: 503,
        code: "NETWORK_ERROR",
        title: "Mất kết nối tới máy chủ đơn hàng",
        message:
          "Không thể kết nối đến máy chủ để tải lịch sử đơn hàng (GET /orders/me). Vui lòng kiểm tra kết nối mạng và thử lại.",
      });
      return;
    }

    const shouldUseMock =
      isMockPreviewAllowed() && (stateParam === "mock" || useMockPreview);

    if (!shouldUseMock && (!isAuthenticated || !currentAuthUserId)) {
      setIsLoading(false);
      setOrders([]);
      setMeta(null);
      setErrorState(null);
      setLoadedOwnerUserId(null);
      setSelectedOrderSnapshot(null);
      return;
    }

    const controller = new AbortController();

    void executeFetchOrderHistory({
      isAuthenticated,
      userId: currentAuthUserId,
      accessToken,
      useMockData: shouldUseMock,
      signal: controller.signal,
      verifySession,
      onUnauthorized: (msg) => {
        openAuthModal("login", {
          resumeCheckout: false,
          reasonMessage: msg,
        });
      },
      setIsLoading,
      setOrders,
      setMeta,
      setErrorState,
      setLoadedOwnerUserId,
    });

    return () => {
      controller.abort();
    };
  }, [
    isAuthLoading,
    isAuthenticated,
    currentAuthUserId,
    accessToken,
    useMockPreview,
    reloadKey,
    verifySession,
    openAuthModal,
    setSelectedOrderSnapshot,
  ]);

  const statusCounts = useMemo(
    () => computeOrderStatusCounts(visibleOrders),
    [visibleOrders]
  );

  const filteredOrders = useMemo(
    () => filterAndSearchOrders(visibleOrders, activeFilterTab, searchQuery),
    [visibleOrders, activeFilterTab, searchQuery]
  );

  const totalConfirmedPoints = useMemo(() => {
    const sumFromOrders = visibleOrders.reduce(
      (sum, order) =>
        sum +
        (Number.isSafeInteger(order.pointsEarned) && order.pointsEarned > 0
          ? order.pointsEarned
          : 0),
      0
    );
    return sumFromOrders;
  }, [visibleOrders]);

  const totalFilteredPages = Math.max(
    1,
    Math.ceil(filteredOrders.length / DEFAULT_CLIENT_PAGE_SIZE)
  );
  const safeCurrentPage = Math.min(currentPage, totalFilteredPages);

  const pagedOrders = useMemo(() => {
    const startIdx = (safeCurrentPage - 1) * DEFAULT_CLIENT_PAGE_SIZE;
    return filteredOrders.slice(startIdx, startIdx + DEFAULT_CLIENT_PAGE_SIZE);
  }, [filteredOrders, safeCurrentPage]);

  const handleSelectFilterTab = (tab: OrderHistoryFilterTab) => {
    setActiveFilterTab(tab);
    setCurrentPage(1);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const handleResetFilters = () => {
    setActiveFilterTab("all");
    setSearchQuery("");
    setCurrentPage(1);
  };

  const handleRetryLoad = () => {
    setSelectedOrderSnapshot(null);
    setReloadKey((prev) => prev + 1);
  };

  /**
   * Đặt lại các món từ một đơn hàng trong lịch sử vào Giỏ hàng hiện tại.
   */
  const handleReorderItems = (order: OrderHistoryItemDto) => {
    let addedCount = 0;
    for (const item of order.items) {
      addToCart({
        productId: item.productId,
        productName: item.productName,
        imageUrl: resolveOrderItemImageUrl(item.productId, item.productName),
        basePriceVnd: item.basePriceVnd,
        size: item.size,
        sizeMultiplierPercent: item.sizeMultiplierPercent,
        sizePolicy: item.size === "ONE_SIZE" ? "ONE_SIZE" : "STANDARD",
        toppings: item.toppings.map((t) => ({
          id: t.id,
          name: t.name,
          priceVnd: t.priceVnd,
        })),
        toppingIds: item.toppings.map((t) => t.id),
        quantity: item.quantity,
      });
      addedCount += item.quantity;
    }
    showToastNotice(
      `Đã thêm ${addedCount} món từ đơn #${order.id.slice(0, 8).toUpperCase()} vào giỏ hàng!`
    );
    openCart();
  };

  const handleFeatureNotice = (featureLabel: string) => {
    showToastNotice(
      `Chức năng "${featureLabel}" đang hoàn thiện và sẽ ra mắt ở Sprint tiếp theo.`
    );
  };

  const isShowingAuthGuard =
    !isAuthLoading &&
    !isLoading &&
    !useMockPreview &&
    (!isAuthenticated || !currentAuthUserId);

  const memberTierName = useMemo(() => {
    if (!isAuthenticated) return "Khách";
    if (totalConfirmedPoints >= 500) return "Hạng Vàng";
    if (totalConfirmedPoints >= 200) return "Hạng Bạc";
    return "Thành viên";
  }, [isAuthenticated, totalConfirmedPoints]);

  const displayCustomerName =
    isAuthenticated && user
      ? getDisplayCustomerName(user)
      : "Khách hàng BrewLite";

  const freeCoffeeEquivalent = Math.floor(totalConfirmedPoints / 100);

  return (
    <div className="min-h-screen flex flex-col bg-background font-body-md text-on-surface">
      <Header
        onCartClick={openCart}
        onFeatureNotice={handleFeatureNotice}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        activeNav="lich-su-don-hang"
        siteConfig={MOCK_SITE_CONFIG}
      />

      <main className="w-full pt-20 bg-background min-h-screen flex-1">
        {/* Thanh trạng thái đồng bộ thời gian thực khi đang tải GET /orders/me */}
        {(isLoading || isAuthLoading) && (
          <div
            role="status"
            aria-live="polite"
            className="w-full bg-gradient-to-r from-surface-container-low via-surface to-surface-container-low py-space-xs px-margin shadow-sm"
          >
            <div className="max-w-[1320px] mx-auto flex items-center justify-between">
              <div className="flex items-center gap-space-sm text-on-surface-variant font-body-sm text-body-sm">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
                </span>
                <span className="font-medium text-on-surface">
                  Đang tải dữ liệu:
                </span>
                <span>
                  Đang đồng bộ lịch sử đơn hàng...
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Container chuẩn Stitch (`max-w-[1320px] mx-auto w-full px-margin py-space-xl flex flex-col gap-space-lg`) */}
        <div className="max-w-[1320px] mx-auto w-full px-margin py-space-xl flex flex-col gap-space-lg">
          {/* 1. Top Loyalty & Account Overview Header (Chuẩn Stitch lines 10-40) */}
          <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-space-lg">
            <div className="flex flex-col gap-space-xs">
              <div className="flex items-center gap-space-xs text-on-surface-variant font-label-md text-label-md">
                <Link className="hover:text-primary transition-colors" href="/">
                  Tài khoản
                </Link>
                <span>/</span>
                <span className="text-primary font-semibold">
                  Lịch sử giao dịch
                </span>
              </div>
              <h1 className="font-display-lg text-display-lg text-on-surface tracking-tight">
                Quản lý Đơn hàng &amp; Lịch sử
              </h1>
              <p className="font-body-md text-body-md text-on-surface-variant">
                Theo dõi tình trạng chế biến, giao nhận và lưu trữ hóa đơn điện
                tử cho từng trải nghiệm cà phê của bạn.
              </p>
            </div>

            {/* Member Loyalty Banner Component chuẩn Stitch */}
            <div
              id="memberLoyaltyBanner"
              className="relative overflow-hidden flex flex-col sm:flex-row items-start sm:items-center justify-between gap-space-md p-space-md rounded-xl bg-gradient-to-r from-surface-container to-surface-container-high shadow-sm border border-outline-variant/30"
            >
              <div className="flex items-center gap-space-sm">
                <div className="w-12 h-12 rounded-xl bg-primary text-on-primary flex items-center justify-center flex-shrink-0 shadow-md">
                  <span className="material-symbols-outlined text-[26px]">
                    workspace_premium
                  </span>
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2.5 py-0.5 rounded-full bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md font-bold tracking-wide uppercase">
                      {memberTierName}
                    </span>
                    <span className="font-title-sm text-title-sm text-on-surface">
                      {displayCustomerName}
                    </span>
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                    <strong
                      id="memberTotalPointsValue"
                      className="text-primary font-bold"
                    >
                      {totalConfirmedPoints.toLocaleString("vi-VN")} điểm tích
                      lũy
                    </strong>{" "}
                    (
                    {freeCoffeeEquivalent > 0
                      ? `Đổi được ${freeCoffeeEquivalent} ly cà phê miễn phí`
                      : "Tích lũy 1 điểm / 10.000₫ thanh toán"}
                    )
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="refreshOrderHistoryBtn"
                  onClick={handleRetryLoad}
                  disabled={isLoading || isAuthLoading}
                  className="px-3.5 py-2 rounded-lg bg-surface-container-lowest text-on-surface-variant font-label-md text-label-md hover:bg-surface-container hover:text-on-surface transition-colors shadow-sm flex items-center gap-1 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <span
                    className={`material-symbols-outlined text-[16px] ${
                      isLoading ? "animate-spin" : ""
                    }`}
                  >
                    refresh
                  </span>
                  <span>Làm mới</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleFeatureNotice("Đổi quà thành viên")}
                  className="px-4 py-2 rounded-lg bg-surface-container-lowest text-primary font-label-lg text-label-lg hover:bg-primary hover:text-on-primary transition-colors shadow-sm whitespace-nowrap cursor-pointer"
                >
                  Đổi quà ngay
                </button>
              </div>
            </div>
          </div>

          {/* 2. Filter Bar and Search Controls (Chuẩn Stitch lines 42-73) */}
          <div id="orderFilterBar" className="flex flex-col gap-space-md pt-2">
            {/* State Filter Tabs (Pill buttons chuẩn Stitch) */}
            <div
              id="orderFilterTabs"
              className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none"
              role="tablist"
              aria-label="Lọc đơn hàng theo trạng thái"
            >
              {(
                [
                  {
                    id: "all" as const,
                    label: "Tất cả đơn",
                    count: statusCounts.all,
                  },
                  {
                    id: "PENDING" as const,
                    label: "Chờ xử lý",
                    count: statusCounts.PENDING,
                  },
                  {
                    id: "PAID_GROUP" as const,
                    label: "Đã thanh toán",
                    count: statusCounts.PAID_GROUP,
                  },
                  {
                    id: "PAYMENT_FAILED" as const,
                    label: "Thất bại",
                    count: statusCounts.PAYMENT_FAILED,
                  },
                  {
                    id: "CANCELLED" as const,
                    label: "Đã hủy",
                    count: statusCounts.CANCELLED,
                  },
                ] as const
              ).map((tab) => {
                const isActive = activeFilterTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    data-filter={tab.id}
                    onClick={() => handleSelectFilterTab(tab.id)}
                    className={`tab-btn px-4 py-2 rounded-full font-label-lg text-label-lg transition-all whitespace-nowrap cursor-pointer ${
                      isActive
                        ? "bg-on-surface text-surface-container-lowest shadow-sm"
                        : "bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
                    }`}
                  >
                    {tab.label} ({tab.count})
                  </button>
                );
              })}
            </div>

            {/* Search & Reset Filter Bar (10 cols search + 2 cols reset chuẩn Stitch) */}
            <div className="grid grid-cols-12 gap-space-sm bg-surface-container-lowest p-space-sm rounded-xl shadow-sm border border-outline-variant/25">
              <div className="col-span-12 lg:col-span-10 relative flex items-center">
                <span className="absolute left-3.5 text-outline material-symbols-outlined text-[20px] pointer-events-none">
                  search
                </span>
                <input
                  id="order-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Tìm kiếm theo mã đơn UUID (550e8400...) hoặc tên món nước..."
                  aria-label="Tìm kiếm theo mã đơn UUID hoặc tên món nước"
                  className="w-full pl-10 pr-9 py-2.5 rounded-lg bg-surface-container-low text-on-surface font-body-sm text-body-sm placeholder:text-outline focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20 transition-all"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => handleSearchChange("")}
                    aria-label="Xóa từ khóa tìm kiếm"
                    className="absolute right-3 text-outline hover:text-on-surface cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      close
                    </span>
                  </button>
                )}
              </div>

              <div className="col-span-12 lg:col-span-2 flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="w-full py-2.5 px-4 rounded-lg bg-surface-container text-on-surface-variant font-label-md text-label-md hover:bg-surface-container-high hover:text-on-surface transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    restart_alt
                  </span>
                  <span>Đặt lại bộ lọc</span>
                </button>
              </div>
            </div>
          </div>

          {/* Banner thông báo khi đang xem ở chế độ Mock Preview */}
          {isMockPreviewAllowed() && useMockPreview && (
            <div
              id="mockPreviewNoticeBanner"
              className="p-3.5 rounded-xl bg-tertiary-fixed/50 border border-tertiary/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2.5 text-on-surface font-body-sm text-body-sm">
                <span className="material-symbols-outlined text-tertiary text-[20px]">
                  visibility
                </span>
                <span>
                  Đang hiển thị <strong>4 đơn hàng mẫu giao diện</strong>. Bạn có thể chuyển về dữ liệu tài khoản bất cứ lúc nào.
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setUseMockPreview(false);
                  setOrders([]);
                  setMeta(null);
                  setLoadedOwnerUserId(null);
                  setReloadKey((prev) => prev + 1);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-surface-container-lowest border border-outline-variant text-on-surface font-label-md text-label-md hover:bg-surface-container transition-colors cursor-pointer whitespace-nowrap self-start sm:self-auto"
              >
                Chuyển về API thật (/orders/me)
              </button>
            </div>
          )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 1: LOADING (SKELETON CARDS CHUẨN BỐ CỤC STITCH)        */}
          {/* ================================================================= */}
          {(isLoading || isAuthLoading) && (
            <div
              id="orderHistoryLoadingState"
              role="status"
              aria-live="polite"
              className="flex flex-col gap-space-md"
            >
              {[1, 2, 3].map((skeletonIdx) => (
                <div
                  key={skeletonIdx}
                  className="p-space-lg rounded-xl bg-surface-container-lowest shadow-sm flex flex-col gap-space-md animate-pulse"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm pb-space-sm border-b border-surface-container">
                    <div className="flex items-center gap-space-sm">
                      <div className="h-6 w-64 bg-surface-container-high rounded-md" />
                      <div className="h-4 w-36 bg-surface-container rounded-md" />
                    </div>
                    <div className="h-7 w-52 bg-surface-container-high rounded-full" />
                  </div>
                  <div className="grid grid-cols-12 gap-space-md items-center py-space-sm">
                    <div className="col-span-12 lg:col-span-6 flex items-start gap-space-md">
                      <div className="w-20 h-20 rounded-xl bg-surface-container-high flex-shrink-0" />
                      <div className="flex-1 space-y-2 py-1">
                        <div className="h-5 w-4/5 bg-surface-container-high rounded-md" />
                        <div className="h-4 w-2/3 bg-surface-container rounded-md" />
                        <div className="h-5 w-48 bg-surface-container rounded-md" />
                      </div>
                    </div>
                    <div className="col-span-6 lg:col-span-3 flex flex-col lg:items-center gap-2">
                      <div className="h-3.5 w-24 bg-surface-container rounded" />
                      <div className="h-6 w-28 bg-surface-container-high rounded-md" />
                      <div className="h-4 w-32 bg-surface-container rounded" />
                    </div>
                    <div className="col-span-6 lg:col-span-3 flex flex-col items-end gap-2">
                      <div className="h-10 w-44 bg-surface-container-high rounded-lg" />
                      <div className="h-4 w-32 bg-surface-container rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 2: CHƯA ĐĂNG NHẬP / 401 UNAUTHORIZED                   */}
          {/* ================================================================= */}
          {isShowingAuthGuard && (
            <div
              id="orderHistoryAuthGuardState"
              className="py-14 px-6 text-center bg-surface-container-lowest rounded-2xl border border-outline-variant/40 shadow-sm max-w-2xl mx-auto w-full"
            >
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 text-primary">
                <span className="material-symbols-outlined text-[32px]">
                  lock_person
                </span>
              </div>
              <h2 className="font-headline-md text-headline-md text-on-surface mb-2">
                Vui lòng đăng nhập để xem lịch sử đơn hàng
              </h2>
              <p className="font-body-md text-body-md text-on-surface-variant max-w-lg mx-auto mb-6 leading-relaxed">
                Lịch sử giao dịch và trạng thái đơn hàng (
                <code className="font-mono text-primary">GET /orders/me</code>)
                được bảo mật riêng cho từng tài khoản thành viên. Giỏ hàng hiện
                tại của bạn vẫn được giữ nguyên.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  id="orderHistoryLoginBtn"
                  onClick={() => openAuthModal("login")}
                  className="px-6 py-2.5 rounded-lg bg-primary hover:bg-primary-container text-on-primary font-label-lg text-label-lg transition-colors flex items-center gap-2 shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    login
                  </span>
                  <span>Đăng nhập ngay</span>
                </button>
                {isMockPreviewAllowed() && (
                  <button
                    type="button"
                    id="orderHistoryMockPreviewBtn"
                    onClick={() => setUseMockPreview(true)}
                    className="px-5 py-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-lg text-label-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px] text-primary">
                      visibility
                    </span>
                    <span>Xem mẫu giao diện (4 đơn mẫu)</span>
                  </button>
                )}
                <Link
                  href="/"
                  className="px-5 py-2.5 rounded-lg border border-outline-variant text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low font-label-lg text-label-lg transition-colors flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    local_cafe
                  </span>
                  <span>Khám phá thực đơn</span>
                </Link>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 3: LỖI KẾT NỐI / 500 / 400 (ERROR STATE)               */}
          {/* ================================================================= */}
          {!isLoading && !isAuthLoading && !isShowingAuthGuard && errorState && (
            <div
              id="orderHistoryErrorState"
              role="alert"
              aria-live="assertive"
              className="py-12 px-6 text-center bg-surface-container-lowest rounded-2xl border border-error/30 shadow-sm max-w-2xl mx-auto w-full"
            >
              <div className="w-16 h-16 rounded-full bg-error-container flex items-center justify-center mx-auto mb-4 text-on-error-container">
                <span className="material-symbols-outlined text-[32px]">
                  cloud_off
                </span>
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-error/10 text-error font-mono text-[12px] font-semibold mb-3">
                <span>HTTP {errorState.statusCode}</span>
                <span>•</span>
                <span id="orderHistoryErrorCode">{errorState.code}</span>
              </div>
              <h2
                id="orderHistoryErrorTitle"
                className="font-headline-md text-headline-md text-on-surface mb-2"
              >
                {errorState.title}
              </h2>
              <p
                id="orderHistoryErrorMessage"
                className="font-body-md text-body-md text-on-surface-variant max-w-lg mx-auto mb-4 leading-relaxed"
              >
                {errorState.message}
              </p>
              <p className="font-body-sm text-body-sm text-outline max-w-md mx-auto mb-6">
                Truy vấn{" "}
                <code className="font-mono text-on-surface">
                  GET /orders/me
                </code>{" "}
                là thao tác chỉ đọc (idempotent) — bạn có thể bấm tải lại an
                toàn mà không lo phát sinh trùng đơn hàng.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  id="retryLoadOrdersBtn"
                  onClick={handleRetryLoad}
                  className="px-6 py-2.5 rounded-lg bg-primary hover:bg-primary-container text-on-primary font-label-lg text-label-lg transition-colors flex items-center gap-2 shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    refresh
                  </span>
                  <span>Thử tải lại lịch sử</span>
                </button>
                {isMockPreviewAllowed() && (
                  <button
                    type="button"
                    onClick={() => {
                      setErrorState(null);
                      setUseMockPreview(true);
                    }}
                    className="px-5 py-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-lg text-label-lg transition-colors cursor-pointer"
                  >
                    Xem mẫu giao diện (Mock)
                  </button>
                )}
                <Link
                  href="/"
                  className="px-5 py-2.5 rounded-lg border border-outline-variant text-on-surface-variant hover:text-on-surface font-label-lg text-label-lg transition-colors"
                >
                  Về trang thực đơn
                </Link>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 4: EMPTY STATE — TÀI KHOẢN CHƯA CÓ ĐƠN HÀNG NÀO        */}
          {/* ================================================================= */}
          {!isLoading &&
            !isAuthLoading &&
            !isShowingAuthGuard &&
            !errorState &&
            visibleOrders.length === 0 && (
              <div
                id="orderHistoryEmptyState"
                className="py-16 px-6 text-center bg-surface-container-lowest rounded-2xl border border-dashed border-outline-variant"
              >
                <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mx-auto mb-4 text-primary">
                  <span className="material-symbols-outlined text-[32px]">
                    receipt_long
                  </span>
                </div>
                <h2 className="font-title-md text-title-md text-on-surface mb-1">
                  Bạn chưa có đơn hàng nào
                </h2>
                <p className="font-body-md text-body-md text-on-surface-variant max-w-md mx-auto mb-6">
                  Khi bạn đặt cà phê hoặc bánh ngọt tại BrewLite, toàn bộ lịch
                  sử đơn hàng, hình ảnh món uống, trạng thái xử lý và điểm tích
                  lũy sẽ hiển thị tại đây.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Link
                    href="/"
                    className="px-6 py-2.5 bg-primary text-on-primary rounded-lg font-label-lg text-label-lg hover:bg-primary-container transition-colors flex items-center gap-2 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      local_cafe
                    </span>
                    <span>Khám phá thực đơn ngay</span>
                  </Link>
                  {isMockPreviewAllowed() && (
                    <button
                      type="button"
                      onClick={() => setUseMockPreview(true)}
                      className="px-5 py-2.5 bg-surface-container hover:bg-surface-container-high text-on-surface rounded-lg font-label-lg text-label-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[18px] text-primary">
                        visibility
                      </span>
                      <span>Xem mẫu giao diện (4 đơn mẫu)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRetryLoad}
                    className="px-5 py-2.5 border border-outline-variant text-on-surface-variant hover:text-on-surface rounded-lg font-label-lg text-label-lg transition-colors cursor-pointer"
                  >
                    Làm mới
                  </button>
                </div>
              </div>
            )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 5: FILTER EMPTY STATE — KHÔNG KHỚP BỘ LỌC / TÌM KIẾM   */}
          {/* ================================================================= */}
          {!isLoading &&
            !isAuthLoading &&
            !isShowingAuthGuard &&
            !errorState &&
            visibleOrders.length > 0 &&
            filteredOrders.length === 0 && (
              <div
                id="empty-state"
                className="py-16 text-center bg-surface-container-lowest rounded-2xl border border-dashed border-outline-variant"
              >
                <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mx-auto mb-4 text-outline">
                  <span className="material-symbols-outlined text-[32px]">
                    receipt_long
                  </span>
                </div>
                <h3 className="font-title-md text-title-md text-on-surface mb-1">
                  Không tìm thấy đơn hàng phù hợp
                </h3>
                <p className="font-body-md text-body-md text-on-surface-variant max-w-md mx-auto mb-6">
                  Hiện chưa có đơn hàng nào khớp với bộ lọc trạng thái hoặc từ
                  khóa tìm kiếm của bạn.
                </p>
                <button
                  type="button"
                  id="resetFilterBtn"
                  onClick={handleResetFilters}
                  className="px-5 py-2.5 bg-primary text-on-primary rounded-lg font-label-lg text-label-lg hover:bg-primary-container transition-colors cursor-pointer"
                >
                  Đặt lại bộ lọc
                </button>
              </div>
            )}

          {/* ================================================================= */}
          {/* TRẠNG THÁI 6: DANH SÁCH THẺ ĐƠN HÀNG CHUẨN THIẾT KẾ STITCH        */}
          {/* ================================================================= */}
          {!isLoading &&
            !isAuthLoading &&
            !isShowingAuthGuard &&
            !errorState &&
            pagedOrders.length > 0 && (
              <div id="orders-container" className="flex flex-col gap-space-md">
                {pagedOrders.map((order, orderIndex) => {
                  const stitchStatus = getStitchStatusBadgeConfig(order.status);
                  const primaryItem = order.items[0];
                  const primaryImageUrl = primaryItem
                    ? resolveOrderItemImageUrl(
                        primaryItem.productId,
                        primaryItem.productName
                      )
                    : "/images/ca-phe-sua-da-sai-gon.jpg";

                  const extraItemsCount = Math.max(0, order.items.length - 1);
                  const headlineItemsText = order.items
                    .map(
                      (item) =>
                        `${item.quantity}x ${item.productName} (${formatSizeShort(
                          item.size
                        )})`
                    )
                    .join(", ");

                  const allToppingsSummary = order.items
                    .flatMap((item) => item.toppings)
                    .map((t) => `${t.name} (+${formatVnd(t.priceVnd)})`);

                  const potentialPoints = Math.floor(order.totalVnd / 10000);
                  const isNewestOrder =
                    safeCurrentPage === 1 &&
                    orderIndex === 0 &&
                    activeFilterTab === "all" &&
                    !searchQuery.trim();

                  return (
                    <article
                      key={order.id}
                      data-order-id={order.id}
                      data-status={stitchStatus.filterGroup}
                      data-raw-status={order.status}
                      className={`order-card p-space-lg rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-all duration-200 flex flex-col gap-space-md border border-outline-variant/25 ${
                        order.status === "CANCELLED" ? "opacity-90" : ""
                      }`}
                    >
                      {/* ROW 1: Card Header (Order UUID, Badge Mới nhất, Thời gian đặt, Pick-up, Status Pill) */}
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm pb-space-sm border-b border-surface-container">
                        <div className="flex flex-wrap items-center gap-space-sm">
                          <span className="font-headline-md text-headline-md text-on-surface font-bold tracking-tight font-mono text-[17px]">
                            #{order.id}
                          </span>
                          {isNewestOrder && (
                            <span className="text-xs px-2.5 py-0.5 rounded-full bg-primary-fixed text-on-primary-fixed font-label-md uppercase font-semibold">
                              Mới nhất
                            </span>
                          )}
                          <span className="text-on-surface-variant font-body-sm text-body-sm flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px]">
                              schedule
                            </span>
                            <span>{formatDateDotTimeVi(order.createdAt)}</span>
                          </span>
                          <span className="text-on-surface-variant font-body-sm text-body-sm flex items-center gap-1">
                            <span className="material-symbols-outlined text-primary text-[16px]">
                              storefront
                            </span>
                            <span>Nhận tại quầy (Pick-up)</span>
                          </span>
                        </div>

                        <div className="flex items-center">
                          <span
                            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-label-md text-label-md font-semibold ${stitchStatus.pillClass}`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                stitchStatus.dotClass
                              } ${stitchStatus.isPing ? "animate-ping" : ""}`}
                            />
                            <span>{stitchStatus.badgeText}</span>
                          </span>
                        </div>
                      </div>

                      {/* ROW 2: Card Body 12 cột (Col 1-6: Ảnh w-20 h-20 + Chi tiết món; Col 7-9: Tổng tiền & Điểm; Col 10-12: Actions) */}
                      <div className="grid grid-cols-12 gap-space-md items-center py-space-sm">
                        {/* Cột 1-6: Ảnh sản phẩm `w-20 h-20 rounded-xl` + Tóm tắt món, topping, thanh toán */}
                        <div className="col-span-12 lg:col-span-6 flex items-start gap-space-md">
                          <div
                            onClick={() => setSelectedOrderSnapshot(order)}
                            className="relative w-20 h-20 rounded-xl overflow-hidden bg-surface-container flex-shrink-0 shadow-xs border border-outline-variant/30 cursor-pointer group"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={primaryImageUrl}
                              alt={primaryItem?.productName || "Đồ uống BrewLite"}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                            {extraItemsCount > 0 && (
                              <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-on-surface/80 text-surface-container-lowest font-label-md text-[10px] font-bold">
                                +{extraItemsCount} món
                              </span>
                            )}
                          </div>

                          <div className="flex flex-col justify-center min-w-0 flex-1">
                            <h4 className="font-title-sm text-title-sm text-on-surface font-semibold leading-snug">
                              {headlineItemsText}
                            </h4>

                            {/* Dòng phụ thứ 1: Topping / Giảm giá / Lý do thất bại / Phương thức thanh toán */}
                            {order.status === "PAYMENT_FAILED" &&
                            order.payment ? (
                              <p className="font-body-sm text-body-sm text-error mt-1 font-medium">
                                failureReason:{" "}
                                {order.payment.failureReason ||
                                  "PAYMENT_DECLINED"}{" "}
                                ({order.payment.method}
                                {order.payment.methodLast4
                                  ? ` •••• ${order.payment.methodLast4}`
                                  : ""}
                                )
                              </p>
                            ) : order.status === "CANCELLED" ? (
                              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                                Đã hủy đơn &amp; hoàn trả tồn kho, giải phóng mã
                                giảm giá (RELEASED)
                              </p>
                            ) : (
                              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                                {allToppingsSummary.length > 0
                                  ? `Topping: ${allToppingsSummary.join(" • ")}`
                                  : "Không thêm topping"}
                                {order.discountVnd > 0
                                  ? ` • Giảm giá${
                                      order.couponCode
                                        ? ` (${order.couponCode})`
                                        : ""
                                    }: -${formatVnd(order.discountVnd)}`
                                  : ""}
                              </p>
                            )}

                            {/* Dòng phụ thứ 2: Nhãn phương thức thanh toán & Mốc hết hạn giữ chỗ / Mã giao dịch */}
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              {order.payment ? (
                                <>
                                  <span className="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-label-md text-[11px]">
                                    Phương thức: {order.payment.method}
                                    {order.payment.methodLast4
                                      ? ` •••• ${order.payment.methodLast4}`
                                      : ""}
                                  </span>
                                  {order.payment.mockReference && (
                                    <span className="text-on-surface-variant font-body-sm text-[12px] font-mono">
                                      Mã GD: {order.payment.mockReference}
                                    </span>
                                  )}
                                </>
                              ) : order.status === "PENDING" ? (
                                <>
                                  <span className="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-label-md text-[11px]">
                                    Phương thức: Chưa chọn
                                  </span>
                                  <span className="text-tertiary font-body-sm text-[12px] font-medium">
                                    Hết hạn lúc:{" "}
                                    {formatTimeOnlyVi(order.expiresAt)} (giữ chỗ
                                    15 phút)
                                  </span>
                                </>
                              ) : (
                                <span className="px-2 py-0.5 rounded bg-surface-container text-outline font-label-md text-[11px]">
                                  Chưa phát sinh thanh toán
                                </span>
                              )}

                              {order.status === "PAYMENT_FAILED" && (
                                <span className="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-label-md text-[11px]">
                                  Tồn kho &amp; Voucher
                                  {order.couponCode
                                    ? ` (${order.couponCode})`
                                    : ""}
                                  : Được giữ nguyên (HELD)
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Cột 7-9: Tổng thanh toán & Điểm tích lũy thành viên */}
                        <div className="col-span-6 lg:col-span-3 flex flex-col lg:items-center justify-center">
                          <span className="font-body-sm text-body-sm text-on-surface-variant">
                            {order.discountVnd > 0
                              ? "Tổng thanh toán (Sau giảm)"
                              : "Tổng thanh toán"}
                          </span>
                          <span
                            className={`font-price-lg text-price-lg font-bold mt-0.5 ${
                              order.status === "CANCELLED"
                                ? "text-outline line-through"
                                : order.status === "PENDING"
                                ? "text-primary"
                                : "text-on-surface"
                            }`}
                          >
                            {formatVnd(order.totalVnd)}
                          </span>

                          {order.pointsEarned > 0 ? (
                            <span className="font-label-md text-label-md text-tertiary flex items-center gap-1 mt-0.5">
                              <span className="material-symbols-outlined text-[14px]">
                                stars
                              </span>
                              <span>+{order.pointsEarned} điểm tích lũy</span>
                            </span>
                          ) : order.status === "PENDING" ? (
                            <span className="font-label-md text-label-md text-tertiary flex items-center gap-1 mt-0.5">
                              <span className="material-symbols-outlined text-[14px]">
                                stars
                              </span>
                              <span>+{potentialPoints} điểm khi hoàn tất</span>
                            </span>
                          ) : (
                            <span className="font-label-md text-label-md text-outline flex items-center gap-1 mt-0.5">
                              <span className="material-symbols-outlined text-[14px]">
                                stars
                              </span>
                              <span>
                                0 điểm{" "}
                                {order.status === "PAYMENT_FAILED"
                                  ? "(Chưa thanh toán)"
                                  : "tích lũy"}
                              </span>
                            </span>
                          )}
                        </div>

                        {/* Cột 10-12: Các nút thao tác chính + liên kết "Xem chi tiết snapshot" */}
                        <div className="col-span-6 lg:col-span-3 flex flex-col items-end justify-center gap-2">
                          <div className="flex flex-wrap items-center gap-2 w-full justify-end">
                            {order.status === "PENDING" ? (
                              <button
                                type="button"
                                onClick={() => setSelectedOrderSnapshot(order)}
                                className="px-4 py-2 rounded-lg bg-surface-container-high text-on-surface hover:bg-surface-container-highest font-label-md text-label-md shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  receipt_long
                                </span>
                                <span>
                                  Chi tiết đơn chờ ({formatVnd(order.totalVnd)})
                                </span>
                              </button>
                            ) : order.status === "PAYMENT_FAILED" ? (
                              <button
                                type="button"
                                onClick={() => setSelectedOrderSnapshot(order)}
                                className="px-4 py-2 rounded-lg bg-error-container/40 text-on-error-container hover:bg-error-container/60 font-label-md text-label-md shadow-sm transition-all flex items-center gap-1.5 cursor-pointer"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  info
                                </span>
                                <span>Xem lý do thất bại</span>
                              </button>
                            ) : (
                              <>
                                {stitchStatus.filterGroup === "PAID_GROUP" && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSelectedOrderSnapshot(order)
                                    }
                                    className="px-3.5 py-2 rounded-lg bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface font-label-md text-label-md transition-colors flex items-center gap-1 cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[16px]">
                                      receipt_long
                                    </span>
                                    <span>Hóa đơn (VAT)</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleReorderItems(order)}
                                  className="px-4 py-2 rounded-lg bg-surface-container-high text-primary hover:bg-primary hover:text-on-primary font-label-md text-label-md transition-all flex items-center gap-1.5 cursor-pointer"
                                >
                                  <span className="material-symbols-outlined text-[16px]">
                                    repeat
                                  </span>
                                  <span>Đặt lại đơn này</span>
                                </button>
                              </>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => setSelectedOrderSnapshot(order)}
                            className="font-label-md text-label-md text-on-surface-variant hover:text-primary transition-colors flex items-center gap-0.5 cursor-pointer"
                          >
                            <span>Xem chi tiết snapshot</span>
                            <span className="material-symbols-outlined text-[16px]">
                              chevron_right
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* ROW 3: Thanh ghi chú giữ chỗ 15 phút cho đơn PENDING (Chuẩn Stitch line 77) */}
                      {order.status === "PENDING" && (
                        <div className="p-space-sm rounded-lg bg-surface-container-low flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-body-sm font-body-sm">
                          <div className="flex items-center gap-2 text-tertiary font-semibold">
                            <span className="material-symbols-outlined text-[18px]">
                              timer
                            </span>
                            <span>
                              Đơn hàng sẽ tự động hủy sau 15 phút (
                              {formatDateDotTimeVi(order.expiresAt)}) nếu chưa
                              thanh toán. Sản phẩm và mã ưu đãi sẽ được hoàn lại.
                            </span>
                          </div>
                          <span className="text-on-surface-variant text-[12px] whitespace-nowrap">
                            Tự động hủy khi hết hạn
                          </span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

          {/* ================================================================= */}
          {/* PAGINATION & SUMMARY FOOTER (Chuẩn thiết kế Stitch lines 86-103)  */}
          {/* ================================================================= */}
          {!isLoading &&
            !isAuthLoading &&
            !isShowingAuthGuard &&
            !errorState &&
            filteredOrders.length > 0 && (
              <div
                id="orderHistoryPagination"
                className="flex flex-col sm:flex-row items-center justify-between gap-space-md pt-space-md"
              >
                <div className="flex items-center gap-1.5 text-on-surface-variant font-body-sm text-body-sm">
                  <span>Hiển thị trang</span>
                  <strong className="text-on-surface">
                    {safeCurrentPage} / {totalFilteredPages}
                  </strong>
                  <span>
                    (
                    <strong className="text-on-surface">
                      {pagedOrders.length}
                    </strong>{" "}
                    /{" "}
                    <strong className="text-on-surface">
                      {filteredOrders.length}
                    </strong>{" "}
                    đơn hàng)
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={safeCurrentPage <= 1}
                    onClick={() =>
                      setCurrentPage((prev) => Math.max(1, prev - 1))
                    }
                    aria-label="Trang trước"
                    className="w-10 h-10 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      chevron_left
                    </span>
                  </button>
                  {Array.from(
                    { length: totalFilteredPages },
                    (_, i) => i + 1
                  ).map((pageNum) => (
                    <button
                      key={pageNum}
                      type="button"
                      onClick={() => setCurrentPage(pageNum)}
                      aria-current={
                        pageNum === safeCurrentPage ? "page" : undefined
                      }
                      className={`w-10 h-10 rounded-lg font-label-md text-label-md transition-colors cursor-pointer ${
                        pageNum === safeCurrentPage
                          ? "bg-primary text-on-primary shadow-sm"
                          : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={safeCurrentPage >= totalFilteredPages}
                    onClick={() =>
                      setCurrentPage((prev) =>
                        Math.min(totalFilteredPages, prev + 1)
                      )
                    }
                    aria-label="Trang kế tiếp"
                    className="w-10 h-10 rounded-lg bg-surface-container text-on-surface-variant flex items-center justify-center hover:bg-surface-container-high disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      chevron_right
                    </span>
                  </button>
                </div>
              </div>
            )}
        </div>
      </main>

      {/* =================================================================== */}
      {/* MODAL CHI TIẾT SNAPSHOT ĐƠN HÀNG & HÓA ĐƠN ĐIỆN TỬ                  */}
      {/* =================================================================== */}
      {selectedOrderSnapshot && (
        <OrderSnapshotModal
          key={selectedOrderSnapshot.id}
          order={selectedOrderSnapshot}
          onClose={() => setSelectedOrderSnapshot(null)}
          onReorder={handleReorderItems}
        />
      )}

      {/* Toast thông báo thao tác (vị trí top-right chuẩn Stitch) */}
      <div
        id="toast-notification"
        role="status"
        aria-live="polite"
        className={`fixed top-24 right-8 z-50 transform transition-all duration-300 flex items-center gap-space-sm px-space-md py-space-sm rounded-xl bg-surface-container-highest shadow-xl text-on-surface border border-outline-variant/40 ${
          toastVisible
            ? "translate-y-0 opacity-100"
            : "translate-y-[-120%] opacity-0 pointer-events-none"
        }`}
      >
        <span className="material-symbols-outlined text-primary text-[22px]">
          check_circle
        </span>
        <span className="font-body-md text-body-md font-medium">
          {toastMessage}
        </span>
        <button
          type="button"
          onClick={handleDismissToast}
          aria-label="Đóng thông báo"
          className="ml-1 p-1 rounded-lg text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>

      <Footer siteConfig={MOCK_SITE_CONFIG} />
    </div>
  );
}
