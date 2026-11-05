"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AuthContext } from "@/context/AuthContext";
import type {
  CouponPreviewRequestDto,
  CouponPreviewResponseDto,
  CouponValidationStatus,
  CreateOrderItemDto,
  CreateOrderRequestDto,
  CreateOrderResponseDto,
  DrinkSize,
  OrderSubmissionErrorState,
} from "@/mock-data";
import {
  calculateLineTotalVnd,
  calculateSizePriceVnd,
  calculateUnitPriceVnd,
  formatVnd,
  isValidUuid,
  MAX_ORDER_QUANTITY,
  MAX_TOPPINGS_PER_ITEM,
  MIN_ORDER_QUANTITY,
} from "@/services/api.service";
import {
  ACTIVE_ORDER_SESSION_KEY,
  decodeJwtPayload,
  getStoredToken,
  getStoredUser,
} from "@/services/auth.service";
import {
  classifyCouponPreviewError,
  createOrderApi,
  previewCouponApi,
  sanitizeCreateOrderPayload,
  toOrderSubmissionErrorState,
  validateOrderResponseData,
} from "@/services/order.service";

// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU GIỎ HÀNG & ORDER FLOW (API CONTRACT v2.1 / v3.0 & SCRUM-44)
// ============================================================================

export const MAX_CART_ITEMS = 20;
export const CART_STORAGE_KEY = "brewlite_cart_v1";
export const ACTIVE_ORDER_STORAGE_KEY = ACTIVE_ORDER_SESSION_KEY;

/**
 * Bản ghi lưu snapshot đơn hàng PENDING trong sessionStorage gắn chặt với tài khoản sở hữu (`ownerUserId`).
 * Ngăn chặn triệt để việc User B đăng nhập cùng tab nhìn thấy mã đơn và tổng tiền của User A (SCRUM-44).
 */
export interface StoredActiveOrderRecord {
  ownerUserId: string;
  order: CreateOrderResponseDto;
}

/**
 * Xóa ngay snapshot đơn hàng PENDING trong sessionStorage (khi logout / đổi user / 401 / ẩn banner).
 */
export function clearStoredActiveOrder(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(ACTIVE_ORDER_STORAGE_KEY);
    }
  } catch {
    // Bỏ qua lỗi sessionStorage
  }
}

/**
 * Trích xuất userId đã xác thực từ localStorage/JWT khi không truyền trực tiếp.
 */
export function resolveStoredAuthenticatedUserId(
  tokenOverride?: string | null
): string | null {
  try {
    const candidateToken = tokenOverride || getStoredToken();
    if (!candidateToken) return null;
    const decoded = decodeJwtPayload(candidateToken);
    if (decoded && typeof decoded.sub === "string" && decoded.sub.trim()) {
      return decoded.sub.trim().toLowerCase();
    }
    const storedUser = getStoredUser();
    if (storedUser?.id && storedUser.id.trim()) {
      return storedUser.id.trim().toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lưu snapshot đơn hàng PENDING vào sessionStorage kèm `ownerUserId` của tài khoản hiện tại.
 * Nếu thiếu `order` hoặc thiếu `ownerUserId` hợp lệ thì xóa luôn dữ liệu trong sessionStorage.
 */
export function persistActiveOrderForUser(
  order: CreateOrderResponseDto | null,
  ownerUserId?: string | null
): CreateOrderResponseDto | null {
  const normalizedOwnerId =
    typeof ownerUserId === "string" ? ownerUserId.trim().toLowerCase() : "";

  if (!order || !normalizedOwnerId || !isValidUuid(normalizedOwnerId)) {
    clearStoredActiveOrder();
    return null;
  }

  try {
    const validatedOrder = validateOrderResponseData(order);
    if (typeof sessionStorage !== "undefined") {
      const record: StoredActiveOrderRecord = {
        ownerUserId: normalizedOwnerId,
        order: validatedOrder,
      };
      sessionStorage.setItem(ACTIVE_ORDER_STORAGE_KEY, JSON.stringify(record));
    }
    return validatedOrder;
  } catch {
    clearStoredActiveOrder();
    return null;
  }
}

/**
 * Khôi phục snapshot đơn hàng PENDING từ sessionStorage CHỈ KHI khớp đúng `currentUserId` đang đăng nhập.
 * Nếu chưa đăng nhập (`!currentUserId`), dữ liệu không có `ownerUserId`, hoặc `ownerUserId !== currentUserId`
 * (ví dụ User A logout rồi User B đăng nhập cùng tab), hàm sẽ lập tức xóa dữ liệu khỏi sessionStorage và trả về `null`.
 */
export function restoreActiveOrderForUser(
  currentUserId?: string | null
): CreateOrderResponseDto | null {
  const normalizedCurrentUserId =
    typeof currentUserId === "string" ? currentUserId.trim().toLowerCase() : "";

  if (!normalizedCurrentUserId || !isValidUuid(normalizedCurrentUserId)) {
    clearStoredActiveOrder();
    return null;
  }

  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(ACTIVE_ORDER_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const storedOwnerId =
      typeof parsed?.ownerUserId === "string"
        ? parsed.ownerUserId.trim().toLowerCase()
        : "";

    // Bắt buộc phải có ownerUserId hợp lệ và khớp chính xác với user hiện tại
    if (
      !storedOwnerId ||
      storedOwnerId !== normalizedCurrentUserId ||
      !parsed?.order
    ) {
      clearStoredActiveOrder();
      return null;
    }

    return validateOrderResponseData(parsed.order);
  } catch {
    clearStoredActiveOrder();
    return null;
  }
}

export interface CartItemTopping {
  id: string;
  name: string;
  priceVnd: number;
}

export interface CartItem {
  /** Mã định danh duy nhất cho dòng sản phẩm trong giỏ */
  id: string;
  /** UUID sản phẩm */
  productId: string;
  /** Tên hiển thị */
  productName: string;
  /** Ảnh đại diện */
  imageUrl: string;
  /** Kích cỡ: S | M | L | ONE_SIZE */
  size: DrinkSize;
  /** Hệ số kích cỡ (100, 120, 140, ...) */
  sizeMultiplierPercent: number;
  /** Giá theo size sau khi làm tròn floor */
  sizePriceVnd: number;
  /** Giá gốc niêm yết (basePriceVnd) */
  basePriceVnd: number;
  /** Danh sách topping đã chọn (tối đa 3 loại) */
  toppings: CartItemTopping[];
  /** Danh sách ID topping (phải khớp chính xác với toppings) */
  toppingIds: string[];
  /** Số lượng món (1 đến 10) */
  quantity: number;
  /** Đơn giá 1 ly (sizePrice + tổng topping) */
  unitPriceVnd: number;
  /** Thành tiền dòng sản phẩm (unitPrice * quantity) */
  lineTotalVnd: number;
  /** Ghi chú pha chế / yêu cầu đặc biệt */
  note?: string;
  /** Chính sách kích cỡ của sản phẩm */
  sizePolicy?: "STANDARD" | "ONE_SIZE";
}

/** Dữ liệu đầu vào khi thêm món mới vào giỏ */
export interface AddToCartInput {
  productId: string;
  productName: string;
  imageUrl?: string;
  size: DrinkSize;
  sizeMultiplierPercent: number;
  basePriceVnd: number;
  toppings?: CartItemTopping[];
  toppingIds?: string[];
  quantity: number;
  note?: string;
  sizePolicy?: "STANDARD" | "ONE_SIZE";
}

/** DTO chuyển sang Checkout / Create Order API (POST /orders) theo API Contract v2.1 Mục 8.2 */
export type { CreateOrderItemDto };
export type CreateOrderDto = CreateOrderRequestDto;

export type SubmitOrderFromCartResult =
  | {
      ok: true;
      order: CreateOrderResponseDto;
    }
  | {
      ok: false;
      skipped?: boolean;
      error: OrderSubmissionErrorState;
    };

export interface CartContextValue {
  /** Danh sách các dòng món trong giỏ */
  items: CartItem[];
  /** Tổng số lượng ly/món (cộng dồn quantity của tất cả dòng) */
  totalQuantity: number;
  /** Tổng số dòng món khác nhau trong giỏ */
  totalLines: number;
  /** Tổng tiền tạm tính của giỏ hàng */
  subtotalVnd: number;
  /** Chuỗi tổng tiền tạm tính có format ₫ */
  formattedSubtotal: string;
  /** Trạng thái mở/đóng Cart Drawer */
  isCartOpen: boolean;
  /** Mã giảm giá đang nhập trong giỏ hàng / Checkout */
  couponCode: string;
  /** Cập nhật mã giảm giá */
  setCouponCode: (code: string) => void;
  /** Thông báo feedback ngắn hạn (Toast) */
  feedbackMessage: string | null;
  feedbackType: "success" | "warning" | "error" | null;
  /** Thêm món vào giỏ hàng (trả về kết quả đồng bộ chính xác) */
  addToCart: (input: AddToCartInput) => { success: boolean; message: string };
  /** Cập nhật số lượng của dòng món */
  updateQuantity: (itemId: string, quantity: number) => void;
  /** Tăng số lượng 1 đơn vị */
  incrementQuantity: (itemId: string) => void;
  /** Giảm số lượng 1 đơn vị (nếu <= 1 thì xóa khỏi giỏ) */
  decrementQuantity: (itemId: string) => void;
  /** Xóa 1 dòng món khỏi giỏ */
  removeFromCart: (itemId: string) => void;
  /** Xóa toàn bộ giỏ hàng */
  clearCart: () => void;
  /** Mở Cart Drawer */
  openCart: () => void;
  /** Đóng Cart Drawer */
  closeCart: () => void;
  /** Đổi trạng thái mở/đóng Cart Drawer */
  toggleCart: () => void;
  /** Tắt thông báo feedback */
  dismissFeedback: () => void;
  /** Chuyển đổi giỏ hàng sang payload chuẩn bị cho POST /orders */
  mapToCreateOrderPayload: (couponCodeOverride?: string) => CreateOrderDto;
  /** Đơn hàng PENDING vừa khởi tạo thành công của đúng tài khoản hiện tại (SCRUM-44) */
  activeOrder?: CreateOrderResponseDto | null;
  /** Trạng thái đang gửi request POST /orders (khóa chỉnh sửa giỏ hàng khi true) (SCRUM-44) */
  isSubmittingOrder?: boolean;
  /** Trạng thái lỗi gần nhất của luồng tạo đơn (SCRUM-44) */
  orderError?: OrderSubmissionErrorState | null;
  /** Lưu hoặc xóa dữ liệu đơn hàng PENDING gắn với tài khoản sở hữu (SCRUM-44) */
  setActiveOrder?: (
    order: CreateOrderResponseDto | null,
    ownerUserIdOverride?: string | null
  ) => void;
  /** Cập nhật trạng thái đang gửi POST /orders (SCRUM-44) */
  setIsSubmittingOrder?: (submitting: boolean) => void;
  /** Cập nhật trạng thái lỗi của luồng đặt hàng (SCRUM-44) */
  setOrderError?: (error: OrderSubmissionErrorState | null) => void;
  /** Xóa trạng thái lỗi và đơn hàng tạm trong luồng Checkout (SCRUM-44) */
  clearOrderFlowState?: () => void;
  /** Gửi yêu cầu POST /orders trực tiếp từ CartContext và lưu snapshot Order Response (SCRUM-44) */
  submitOrderFromCart?: (options?: {
    accessToken?: string | null;
    couponCodeOverride?: string;
    createOrderFn?: (
      payload: CreateOrderRequestDto,
      tokenOverride?: string | null
    ) => Promise<CreateOrderResponseDto>;
  }) => Promise<SubmitOrderFromCartResult>;
  /** Kết quả preview coupon hợp lệ mới nhất từ POST /coupons/preview (P2-22) */
  appliedCoupon?: CouponPreviewResponseDto | null;
  /** Trạng thái kiểm tra coupon hiện tại trên UI (P2-22) */
  couponStatus?: CouponValidationStatus;
  /** Thông báo lỗi khi kiểm tra coupon thất bại (P2-22) */
  couponErrorMessage?: string | null;
  /** Mã lỗi khi kiểm tra coupon thất bại (P2-22) */
  couponErrorCode?: string | null;
  /** Gọi POST /coupons/preview để kiểm tra và áp dụng mã ưu đãi (P2-22) */
  applyCoupon?: (options?: {
    couponCodeOverride?: string;
    accessToken?: string | null;
    previewCouponFn?: typeof previewCouponApi;
  }) => Promise<CouponPreviewResponseDto | null>;
  /** Bỏ mã ưu đãi đã áp dụng hoặc đang nhập (P2-22) */
  removeCoupon?: () => void;
  /** Cập nhật đồng bộ trạng thái coupon (dùng khi đồng bộ với CartDrawer / Order rejection) (P2-22) */
  setCouponApplicationState?: (next: {
    appliedCoupon?: CouponPreviewResponseDto | null;
    status?: CouponValidationStatus;
    errorMessage?: string | null;
    errorCode?: string | null;
  }) => void;
}

export const CartContext = createContext<CartContextValue | null>(null);

const VALID_SIZES: readonly DrinkSize[] = ["S", "M", "L", "ONE_SIZE"] as const;

/**
 * Sinh chuỗi định danh duy nhất cho dòng sản phẩm dựa trên cấu hình chuẩn:
 * (productId, size, tập hợp toppingIds không phụ thuộc thứ tự).
 * Tuân thủ AC-US-CART-01-02 & AC-US-CART-05-01: Hai lần thêm cùng productId,
 * cùng size và cùng tập toppingIds luôn gộp thành 1 dòng để tránh lỗi
 * "Duplicate item configuration in cart" từ Backend.
 */
export function generateCartItemKey(
  productId: string,
  size: DrinkSize,
  toppingIds: string[]
): string {
  const normalizedProductId = productId.trim().toLowerCase();
  const sortedToppingKey = [...toppingIds]
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
  return `${normalizedProductId}_${size}_[${sortedToppingKey}]`;
}

/**
 * Gộp các dòng món trùng cấu hình (productId, size, toppingIds).
 * TUYỆT ĐỐI KHÔNG dùng Math.min() để âm thầm cắt mất quantity vượt giới hạn MAX_ORDER_QUANTITY (10 ly).
 * Nếu tổng số lượng gộp vượt quá MAX_ORDER_QUANTITY, ném lỗi để từ chối dữ liệu không hợp lệ.
 */
export function mergeDuplicateCartItems(items: CartItem[]): CartItem[] {
  const mergedMap = new Map<string, CartItem>();

  for (const item of items) {
    const key = generateCartItemKey(item.productId, item.size, item.toppingIds);
    const existing = mergedMap.get(key);

    if (existing) {
      const nextQty = existing.quantity + item.quantity;
      if (nextQty > MAX_ORDER_QUANTITY) {
        throw new Error(
          `Tổng số lượng khi gộp của món "${existing.productName}" (${nextQty} ly) vượt quá giới hạn tối đa ${MAX_ORDER_QUANTITY} ly/dòng.`
        );
      }
      mergedMap.set(key, {
        ...existing,
        quantity: nextQty,
        lineTotalVnd: calculateLineTotalVnd(existing.unitPriceVnd, nextQty),
        note: item.note || existing.note,
      });
    } else if (mergedMap.size < MAX_CART_ITEMS) {
      mergedMap.set(key, item);
    }
  }

  return Array.from(mergedMap.values());
}

/**
 * Chuyển đổi danh sách CartItem sang `CreateOrderDto` chuẩn bị gửi lên `POST /orders`
 * theo API Contract v2.1 Mục 8.2 & 9.3:
 * - Gộp các dòng trùng cấu hình (từ chối nếu vượt quá 10 ly/dòng).
 * - Chỉ giữ lại `{ items: [{ productId, size, toppingIds, quantity }], couponCode? }`.
 * - Loại bỏ toàn bộ các trường phía Client (`productName`, `basePriceVnd`, `unitPriceVnd`, `lineTotalVnd`, `note`, v.v.).
 */
export function buildCreateOrderPayloadFromCart(
  cartItems: CartItem[],
  couponCode?: string
): CreateOrderDto {
  const mergedItems = mergeDuplicateCartItems(cartItems);
  const rawItems: CreateOrderItemDto[] = mergedItems.map((item) => ({
    productId: item.productId,
    size: item.size,
    toppingIds: item.toppingIds,
    quantity: item.quantity,
  }));

  return sanitizeCreateOrderPayload({
    items: rawItems,
    ...(couponCode ? { couponCode } : {}),
  });
}

/**
 * Chuyển đổi danh sách CartItem và mã coupon sang `CouponPreviewRequestDto`
 * gửi lên `POST /coupons/preview` (SCRUM-96 / P2-21 & P2-22):
 * - Chỉ giữ lại `{ couponCode, items: [{ productId, size, toppingIds, quantity }] }`.
 * - TUYỆT ĐỐI KHÔNG gửi `discountVnd`, `subtotalVnd`, `totalVnd`, hay `userId`.
 */
export function buildCouponPreviewPayloadFromCart(
  cartItems: CartItem[],
  rawCouponCode: string
): CouponPreviewRequestDto {
  const orderPayload = buildCreateOrderPayloadFromCart(cartItems);
  const normalizedCoupon =
    typeof rawCouponCode === "string"
      ? rawCouponCode.trim().toUpperCase()
      : "";
  return {
    couponCode: normalizedCoupon,
    items: orderPayload.items,
  };
}

/**
 * [MUST FIX 1]: Hàm kiểm tra và chuẩn hóa dữ liệu từng Cart Item khi hydrate từ localStorage
 * Loại bỏ mọi dữ liệu sai cấu trúc, quantity không hợp lệ (như "abc", NaN, <= 0),
 * và tính toán lại giá để bảo đảm không bao giờ xuất hiện NaN trên UI.
 */
export function validateAndSanitizeCartItem(raw: unknown): CartItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  // 1. Kiểm tra productId & productName
  if (typeof r.productId !== "string" || !r.productId.trim()) return null;
  if (typeof r.productName !== "string" || !r.productName.trim()) return null;

  // 2. Kiểm tra size hợp lệ
  if (typeof r.size !== "string" || !VALID_SIZES.includes(r.size as DrinkSize)) {
    return null;
  }
  const size = r.size as DrinkSize;

  // 3. Kiểm tra quantity: Bắt buộc là số nguyên hợp lệ từ MIN đến MAX
  let quantity: number;
  if (typeof r.quantity === "number") {
    quantity = r.quantity;
  } else if (typeof r.quantity === "string") {
    quantity = Number(r.quantity);
  } else {
    return null;
  }

  if (
    !Number.isFinite(quantity) ||
    !Number.isInteger(quantity) ||
    quantity < MIN_ORDER_QUANTITY ||
    quantity > MAX_ORDER_QUANTITY
  ) {
    return null;
  }

  // 4. Kiểm tra basePriceVnd
  const basePriceVnd = Number(r.basePriceVnd);
  if (
    !Number.isFinite(basePriceVnd) ||
    !Number.isInteger(basePriceVnd) ||
    basePriceVnd < 0
  ) {
    return null;
  }

  // 5. Kiểm tra sizeMultiplierPercent
  const multiplier =
    typeof r.sizeMultiplierPercent === "number" &&
    Number.isFinite(r.sizeMultiplierPercent) &&
    r.sizeMultiplierPercent > 0
      ? r.sizeMultiplierPercent
      : size === "M"
      ? 120
      : size === "L"
      ? 140
      : 100;

  // 6. [MUST FIX 3]: Đồng bộ danh sách toppings và toppingIds
  const toppings: CartItemTopping[] = [];
  const rawToppings = Array.isArray(r.toppings) ? r.toppings : [];

  for (const item of rawToppings) {
    if (typeof item !== "object" || item === null) return null;
    const t = item as Record<string, unknown>;
    if (
      typeof t.id !== "string" ||
      !t.id.trim() ||
      typeof t.name !== "string" ||
      !t.name.trim() ||
      typeof t.priceVnd !== "number" ||
      !Number.isFinite(t.priceVnd) ||
      !Number.isInteger(t.priceVnd) ||
      t.priceVnd < 0
    ) {
      return null;
    }
    toppings.push({
      id: t.id.trim(),
      name: t.name.trim(),
      priceVnd: t.priceVnd,
    });
  }

  // Tối đa 3 topping không trùng lặp
  const uniqueToppingIds = Array.from(new Set(toppings.map((t) => t.id)));
  if (
    uniqueToppingIds.length !== toppings.length ||
    uniqueToppingIds.length > MAX_TOPPINGS_PER_ITEM
  ) {
    return null;
  }

  // Nếu trong raw có toppingIds, kiểm tra xem có khớp chính xác không
  if (Array.isArray(r.toppingIds)) {
    const rawIds = r.toppingIds.map((id) => String(id).trim());
    if (
      rawIds.length !== uniqueToppingIds.length ||
      rawIds.some((id) => !uniqueToppingIds.includes(id))
    ) {
      return null;
    }
  }

  // 7. Tự tính toán lại giá để bảo đảm 100% không bị NaN
  const sizePriceVnd = calculateSizePriceVnd(basePriceVnd, multiplier);
  const unitPriceVnd = calculateUnitPriceVnd(basePriceVnd, multiplier, toppings);
  const lineTotalVnd = calculateLineTotalVnd(unitPriceVnd, quantity);

  if (
    !Number.isFinite(sizePriceVnd) ||
    !Number.isFinite(unitPriceVnd) ||
    !Number.isFinite(lineTotalVnd)
  ) {
    return null;
  }

  const id =
    typeof r.id === "string" && r.id.trim()
      ? r.id.trim()
      : `cart_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const imageUrl =
    typeof r.imageUrl === "string" && r.imageUrl.trim()
      ? r.imageUrl.trim()
      : "/images/product-placeholder.svg";

  const note =
    typeof r.note === "string" && r.note.trim()
      ? r.note.trim().slice(0, 100)
      : undefined;

  const sizePolicy =
    r.sizePolicy === "ONE_SIZE" || r.sizePolicy === "STANDARD"
      ? r.sizePolicy
      : undefined;

  return {
    id,
    productId: r.productId.trim(),
    productName: r.productName.trim(),
    imageUrl,
    size,
    sizeMultiplierPercent: multiplier,
    sizePriceVnd,
    basePriceVnd,
    toppings,
    toppingIds: uniqueToppingIds,
    quantity,
    unitPriceVnd,
    lineTotalVnd,
    note,
    sizePolicy,
  };
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const authContext = useContext(AuthContext);
  const authenticatedUserId = useMemo<string | null>(() => {
    if (authContext) {
      if (authContext.isAuthenticated && authContext.user?.id) {
        return authContext.user.id.trim().toLowerCase();
      }
      return null;
    }
    return resolveStoredAuthenticatedUserId();
  }, [authContext]);

  const [items, setItems] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState<boolean>(false);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [couponCode, setCouponCodeState] = useState<string>("");
  const [appliedCoupon, setAppliedCouponState] =
    useState<CouponPreviewResponseDto | null>(null);
  const [couponStatus, setCouponStatusState] =
    useState<CouponValidationStatus>("idle");
  const [couponErrorMessage, setCouponErrorMessageState] = useState<
    string | null
  >(null);
  const [couponErrorCode, setCouponErrorCodeState] = useState<string | null>(
    null
  );
  const isApplyingCouponRef = useRef<boolean>(false);

  const [activeOrderRecord, setActiveOrderRecordState] =
    useState<StoredActiveOrderRecord | null>(null);
  const [isSubmittingOrder, setIsSubmittingOrderState] =
    useState<boolean>(false);
  const [orderError, setOrderErrorState] =
    useState<OrderSubmissionErrorState | null>(null);
  const isSubmittingOrderRef = useRef<boolean>(false);

  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<
    "success" | "warning" | "error" | null
  >(null);

  const clearAppliedCouponPreview = useCallback(() => {
    setAppliedCouponState(null);
    setCouponStatusState("idle");
    setCouponErrorMessageState(null);
    setCouponErrorCodeState(null);
  }, []);

  const setCouponApplicationState = useCallback(
    (next: {
      appliedCoupon?: CouponPreviewResponseDto | null;
      status?: CouponValidationStatus;
      errorMessage?: string | null;
      errorCode?: string | null;
    }) => {
      if (next.appliedCoupon !== undefined) {
        setAppliedCouponState(next.appliedCoupon);
      }
      if (next.status !== undefined) {
        setCouponStatusState(next.status);
      }
      if (next.errorMessage !== undefined) {
        setCouponErrorMessageState(next.errorMessage);
      }
      if (next.errorCode !== undefined) {
        setCouponErrorCodeState(next.errorCode);
      }
    },
    []
  );

  const setCouponCode = useCallback(
    (code: string) => {
      setCouponCodeState(code);
      const normalizedNext = code.trim().toUpperCase();
      setAppliedCouponState((prevApplied) => {
        if (prevApplied && prevApplied.couponCode !== normalizedNext) {
          setCouponStatusState("idle");
          setCouponErrorMessageState(null);
          setCouponErrorCodeState(null);
          return null;
        }
        if (!prevApplied) {
          setCouponStatusState((prevStatus) =>
            prevStatus === "validating" ? prevStatus : "idle"
          );
          setCouponErrorMessageState(null);
          setCouponErrorCodeState(null);
        }
        return prevApplied;
      });
    },
    []
  );

  const removeCoupon = useCallback(() => {
    setCouponCodeState("");
    clearAppliedCouponPreview();
  }, [clearAppliedCouponPreview]);

  const setIsSubmittingOrder = useCallback((submitting: boolean) => {
    isSubmittingOrderRef.current = submitting;
    setIsSubmittingOrderState(submitting);
  }, []);

  const setActiveOrder = useCallback(
    (
      order: CreateOrderResponseDto | null,
      ownerUserIdOverride?: string | null
    ) => {
      const effectiveOwnerId = (
        ownerUserIdOverride ??
        authenticatedUserId ??
        resolveStoredAuthenticatedUserId() ??
        ""
      )
        .trim()
        .toLowerCase();

      if (!order || !effectiveOwnerId) {
        setActiveOrderRecordState(null);
        clearStoredActiveOrder();
        return;
      }

      const persisted = persistActiveOrderForUser(order, effectiveOwnerId);
      if (persisted) {
        setActiveOrderRecordState({
          ownerUserId: effectiveOwnerId,
          order: persisted,
        });
      } else {
        setActiveOrderRecordState(null);
      }
    },
    [authenticatedUserId]
  );

  // Chỉ trả về activeOrder nếu khớp đúng với tài khoản đang đăng nhập hiện tại
  const activeOrder = useMemo<CreateOrderResponseDto | null>(() => {
    if (!authenticatedUserId || !activeOrderRecord) {
      return null;
    }
    if (activeOrderRecord.ownerUserId !== authenticatedUserId) {
      return null;
    }
    return activeOrderRecord.order;
  }, [activeOrderRecord, authenticatedUserId]);

  const setOrderError = useCallback(
    (error: OrderSubmissionErrorState | null) => {
      setOrderErrorState(error);
    },
    []
  );

  const clearOrderFlowState = useCallback(() => {
    setOrderErrorState(null);
    setActiveOrderRecordState(null);
    clearStoredActiveOrder();
  }, []);

  // Khôi phục giỏ hàng từ localStorage khi khởi động (SSR Safe + Chặt chẽ)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CART_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const sanitizedItems = mergeDuplicateCartItems(
            parsed
              .map(validateAndSanitizeCartItem)
              .filter((item): item is CartItem => item !== null)
          ).slice(0, MAX_CART_ITEMS);

          // eslint-disable-next-line react-hooks/set-state-in-effect
          setItems(sanitizedItems);

          // Nếu có item sai cấu trúc hoặc trùng cấu hình đã được gộp, cập nhật lại localStorage
          if (sanitizedItems.length !== parsed.length) {
            localStorage.setItem(
              CART_STORAGE_KEY,
              JSON.stringify(sanitizedItems)
            );
          }
        } else {
          setItems([]);
          localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([]));
        }
      }
    } catch {
      setItems([]);
      try {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([]));
      } catch {
        // Bỏ qua lỗi localStorage
      }
    } finally {
      setIsHydrated(true);
    }
  }, []);

  // Đồng bộ hoặc xóa snapshot đơn hàng PENDING khi user đăng nhập / logout / đổi tài khoản / 401
  useEffect(() => {
    if (authContext?.isLoading) return;

    if (!authenticatedUserId) {
      clearStoredActiveOrder();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveOrderRecordState(null);
      setOrderErrorState(null);
      return;
    }

    const restored = restoreActiveOrderForUser(authenticatedUserId);
    if (restored) {
      setActiveOrderRecordState({
        ownerUserId: authenticatedUserId,
        order: restored,
      });
    } else {
      setActiveOrderRecordState(null);
    }
  }, [authContext?.isLoading, authenticatedUserId]);

  // Lưu lại giỏ hàng vào localStorage mỗi khi có cập nhật
  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Bỏ qua lỗi quotaExceeded
    }
  }, [items, isHydrated]);

  // Hiển thị feedback nhanh
  const showFeedback = useCallback(
    (message: string, type: "success" | "warning" | "error" = "success") => {
      setFeedbackMessage(message);
      setFeedbackType(type);
    },
    []
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackMessage(null);
    setFeedbackType(null);
  }, []);

  // Tính toán tổng số lượng và tổng tiền
  const totalQuantity = useMemo(() => {
    return items.reduce((sum, item) => sum + item.quantity, 0);
  }, [items]);

  const totalLines = items.length;

  const subtotalVnd = useMemo(() => {
    return items.reduce((sum, item) => sum + item.lineTotalVnd, 0);
  }, [items]);

  const formattedSubtotal = useMemo(() => {
    return formatVnd(subtotalVnd);
  }, [subtotalVnd]);

  // Thao tác mở/đóng drawer
  const openCart = useCallback(() => setIsCartOpen(true), []);
  const closeCart = useCallback(() => {
    if (isSubmittingOrderRef.current) return;
    setIsCartOpen(false);
  }, []);
  const toggleCart = useCallback(() => {
    if (isSubmittingOrderRef.current) return;
    setIsCartOpen((prev) => !prev);
  }, []);

  // [MUST FIX 2 & 3]: Thêm món vào giỏ hàng đảm bảo tính đồng bộ kết quả trả về và đồng bộ topping
  const addToCart = useCallback(
    (input: AddToCartInput): { success: boolean; message: string } => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) {
        const msg =
          "Hệ thống đang xử lý yêu cầu đặt hàng. Vui lòng chờ giây lát trước khi thay đổi giỏ hàng.";
        showFeedback(msg, "warning");
        return { success: false, message: msg };
      }

      // 1. Validate thông tin cơ bản
      if (!input.productId || !input.productId.trim()) {
        return { success: false, message: "ID sản phẩm không hợp lệ." };
      }
      if (!input.productName || !input.productName.trim()) {
        return { success: false, message: "Tên sản phẩm không hợp lệ." };
      }
      if (!VALID_SIZES.includes(input.size)) {
        return { success: false, message: "Kích cỡ sản phẩm không hợp lệ." };
      }
      if (
        !Number.isFinite(input.basePriceVnd) ||
        input.basePriceVnd < 0 ||
        !Number.isInteger(input.basePriceVnd)
      ) {
        return { success: false, message: "Giá sản phẩm không hợp lệ." };
      }

      const requestedQty = input.quantity;
      if (
        typeof requestedQty !== "number" ||
        !Number.isFinite(requestedQty) ||
        !Number.isInteger(requestedQty) ||
        requestedQty < MIN_ORDER_QUANTITY ||
        requestedQty > MAX_ORDER_QUANTITY
      ) {
        return {
          success: false,
          message: `Số lượng mỗi lần thêm phải là số nguyên từ ${MIN_ORDER_QUANTITY} đến ${MAX_ORDER_QUANTITY} ly.`,
        };
      }

      // 2. [MUST FIX 3]: Đồng bộ và kiểm tra tính nhất quán giữa toppings và toppingIds
      const rawToppings = input.toppings || [];
      const rawToppingIds = input.toppingIds;

      // Nếu truyền toppingIds, mọi ID phải có trong rawToppings
      if (rawToppingIds && rawToppingIds.length > 0) {
        const map = new Map(rawToppings.map((t) => [t.id.trim(), t]));
        for (const tid of rawToppingIds) {
          if (!map.has(tid.trim())) {
            return {
              success: false,
              message:
                "Danh sách topping không đồng bộ (thiếu dữ liệu chi tiết topping).",
            };
          }
        }
      }

      const normalizedToppings: CartItemTopping[] = [];
      const seenToppingIds = new Set<string>();

      const toppingsToProcess = rawToppingIds
        ? rawToppingIds.map(
            (id) => rawToppings.find((t) => t.id.trim() === id.trim())!
          )
        : rawToppings;

      for (const t of toppingsToProcess) {
        if (
          !t ||
          typeof t.id !== "string" ||
          !t.id.trim() ||
          typeof t.name !== "string" ||
          !t.name.trim() ||
          typeof t.priceVnd !== "number" ||
          !Number.isFinite(t.priceVnd) ||
          !Number.isInteger(t.priceVnd) ||
          t.priceVnd < 0
        ) {
          return {
            success: false,
            message: "Dữ liệu topping không hợp lệ.",
          };
        }

        const cleanId = t.id.trim();
        if (seenToppingIds.has(cleanId)) {
          return {
            success: false,
            message: "Không được chọn trùng lặp cùng một loại topping.",
          };
        }

        seenToppingIds.add(cleanId);
        normalizedToppings.push({
          id: cleanId,
          name: t.name.trim(),
          priceVnd: t.priceVnd,
        });
      }

      if (normalizedToppings.length > MAX_TOPPINGS_PER_ITEM) {
        const msg = `Mỗi món chỉ được chọn tối đa ${MAX_TOPPINGS_PER_ITEM} loại topping.`;
        showFeedback(msg, "warning");
        return { success: false, message: msg };
      }

      const uniqueToppingIds = normalizedToppings.map((t) => t.id);

      // 3. Tính toán giá chính xác
      const sizePriceVnd = calculateSizePriceVnd(
        input.basePriceVnd,
        input.sizeMultiplierPercent
      );
      const unitPriceVnd = calculateUnitPriceVnd(
        input.basePriceVnd,
        input.sizeMultiplierPercent,
        normalizedToppings
      );

      const cleanNote = (input.note || "").trim().slice(0, 100);

      // 4. [MUST FIX 2 & AC-US-CART-01-02]: Gộp dòng theo (productId, size, toppingIds)
      const itemKey = generateCartItemKey(
        input.productId,
        input.size,
        uniqueToppingIds
      );

      const existingIndex = items.findIndex(
        (item) =>
          generateCartItemKey(item.productId, item.size, item.toppingIds) ===
          itemKey
      );

      if (existingIndex >= 0) {
        // Đã có món trong giỏ: kiểm tra tổng số lượng sau khi cộng dồn, KHÔNG dùng Math.min() để tự ý cắt bớt
        const current = items[existingIndex];
        const newQty = current.quantity + requestedQty;
        if (newQty > MAX_ORDER_QUANTITY) {
          const remaining = Math.max(0, MAX_ORDER_QUANTITY - current.quantity);
          const msg =
            remaining > 0
              ? `Không thể thêm ${requestedQty} ly. Món "${current.productName}" hiện đã có ${current.quantity} ly trong giỏ (chỉ có thể thêm tối đa ${remaining} ly nữa, giới hạn ${MAX_ORDER_QUANTITY} ly/dòng).`
              : `Đã đạt giới hạn tối đa ${MAX_ORDER_QUANTITY} ly cho món "${current.productName}" trong giỏ hàng.`;
          showFeedback(msg, "warning");
          return { success: false, message: msg };
        }

        const updatedItems = [...items];
        updatedItems[existingIndex] = {
          ...current,
          quantity: newQty,
          lineTotalVnd: calculateLineTotalVnd(current.unitPriceVnd, newQty),
          note: cleanNote || current.note,
        };

        setItems(updatedItems);
        clearAppliedCouponPreview();
        setIsCartOpen(true);
        const msg = `Đã cập nhật số lượng: ${current.productName} (${newQty} ly)`;
        showFeedback(msg, "success");
        return { success: true, message: msg };
      }

      // Chưa có món trong giỏ: kiểm tra giới hạn 20 dòng món
      if (items.length >= MAX_CART_ITEMS) {
        const msg = `Giỏ hàng chỉ có thể chứa tối đa ${MAX_CART_ITEMS} dòng món khác nhau.`;
        showFeedback(msg, "error");
        return { success: false, message: msg };
      }

      const newItem: CartItem = {
        id:
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `cart_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        productId: input.productId.trim(),
        productName: input.productName.trim(),
        imageUrl: input.imageUrl || "/images/product-placeholder.svg",
        size: input.size,
        sizeMultiplierPercent: input.sizeMultiplierPercent,
        sizePriceVnd,
        basePriceVnd: input.basePriceVnd,
        toppings: normalizedToppings,
        toppingIds: uniqueToppingIds,
        quantity: requestedQty,
        unitPriceVnd,
        lineTotalVnd: calculateLineTotalVnd(unitPriceVnd, requestedQty),
        note: cleanNote || undefined,
        sizePolicy: input.sizePolicy,
      };

      setItems([...items, newItem]);
      clearAppliedCouponPreview();
      setIsCartOpen(true);
      const msg = `Đã thêm "${newItem.productName}" vào giỏ hàng`;
      showFeedback(msg, "success");
      return { success: true, message: msg };
    },
    [clearAppliedCouponPreview, items, isSubmittingOrder, showFeedback]
  );

  // Cập nhật số lượng của dòng món (khóa khi đang gửi POST /orders)
  const updateQuantity = useCallback(
    (itemId: string, newQuantity: number) => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) return;

      if (
        typeof newQuantity !== "number" ||
        !Number.isFinite(newQuantity) ||
        !Number.isInteger(newQuantity)
      ) {
        showFeedback("Số lượng cập nhật phải là số nguyên hợp lệ.", "error");
        return;
      }

      setItems((prevItems) => {
        if (newQuantity <= 0) {
          const itemToRemove = prevItems.find((i) => i.id === itemId);
          if (itemToRemove) {
            showFeedback(`Đã xóa ${itemToRemove.productName} khỏi giỏ hàng`);
          }
          clearAppliedCouponPreview();
          return prevItems.filter((i) => i.id !== itemId);
        }

        if (newQuantity > MAX_ORDER_QUANTITY) {
          showFeedback(
            `Số lượng tối đa cho mỗi dòng là ${MAX_ORDER_QUANTITY} ly.`,
            "warning"
          );
          return prevItems;
        }

        clearAppliedCouponPreview();
        return prevItems.map((item) => {
          if (item.id === itemId) {
            return {
              ...item,
              quantity: newQuantity,
              lineTotalVnd: calculateLineTotalVnd(
                item.unitPriceVnd,
                newQuantity
              ),
            };
          }
          return item;
        });
      });
    },
    [clearAppliedCouponPreview, isSubmittingOrder, showFeedback]
  );

  const incrementQuantity = useCallback(
    (itemId: string) => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) return;
      setItems((prevItems) => {
        const item = prevItems.find((i) => i.id === itemId);
        if (!item) return prevItems;
        if (item.quantity >= MAX_ORDER_QUANTITY) {
          showFeedback(
            `Số lượng tối đa cho mỗi dòng là ${MAX_ORDER_QUANTITY} ly.`,
            "warning"
          );
          return prevItems;
        }
        clearAppliedCouponPreview();
        const nextQty = item.quantity + 1;
        return prevItems.map((i) =>
          i.id === itemId
            ? {
                ...i,
                quantity: nextQty,
                lineTotalVnd: calculateLineTotalVnd(i.unitPriceVnd, nextQty),
              }
            : i
        );
      });
    },
    [clearAppliedCouponPreview, isSubmittingOrder, showFeedback]
  );

  const decrementQuantity = useCallback(
    (itemId: string) => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) return;
      setItems((prevItems) => {
        const item = prevItems.find((i) => i.id === itemId);
        if (!item) return prevItems;
        clearAppliedCouponPreview();
        if (item.quantity <= 1) {
          showFeedback(`Đã xóa ${item.productName} khỏi giỏ hàng`);
          return prevItems.filter((i) => i.id !== itemId);
        }
        const nextQty = item.quantity - 1;
        return prevItems.map((i) =>
          i.id === itemId
            ? {
                ...i,
                quantity: nextQty,
                lineTotalVnd: calculateLineTotalVnd(i.unitPriceVnd, nextQty),
              }
            : i
        );
      });
    },
    [clearAppliedCouponPreview, isSubmittingOrder, showFeedback]
  );

  // Xóa 1 dòng món khỏi giỏ (khóa khi đang gửi POST /orders)
  const removeFromCart = useCallback(
    (itemId: string) => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) return;
      setItems((prevItems) => {
        const item = prevItems.find((i) => i.id === itemId);
        if (item) {
          showFeedback(`Đã xóa "${item.productName}" khỏi giỏ hàng`);
        }
        clearAppliedCouponPreview();
        return prevItems.filter((i) => i.id !== itemId);
      });
    },
    [clearAppliedCouponPreview, isSubmittingOrder, showFeedback]
  );

  // Xóa toàn bộ giỏ hàng (khóa khi đang gửi POST /orders)
  const clearCart = useCallback(() => {
    if (isSubmittingOrderRef.current || isSubmittingOrder) return;
    setItems([]);
    setCouponCodeState("");
    clearAppliedCouponPreview();
    showFeedback("Đã làm rỗng giỏ hàng");
  }, [clearAppliedCouponPreview, isSubmittingOrder, showFeedback]);

  // Gọi POST /coupons/preview để kiểm tra và áp dụng mã ưu đãi (P2-22)
  const applyCoupon = useCallback(
    async (options?: {
      couponCodeOverride?: string;
      accessToken?: string | null;
      previewCouponFn?: typeof previewCouponApi;
    }): Promise<CouponPreviewResponseDto | null> => {
      if (isApplyingCouponRef.current || isSubmittingOrderRef.current) {
        return null;
      }

      const rawInput =
        options?.couponCodeOverride !== undefined
          ? options.couponCodeOverride
          : couponCode;
      const normalizedCode = rawInput.trim().toUpperCase();

      if (!normalizedCode) {
        setAppliedCouponState(null);
        setCouponStatusState("invalid");
        setCouponErrorMessageState("Vui lòng nhập mã ưu đãi trước khi bấm Áp dụng.");
        setCouponErrorCodeState("VALIDATION_ERROR");
        return null;
      }

      let previewPayload: CouponPreviewRequestDto;
      try {
        previewPayload = buildCouponPreviewPayloadFromCart(items, normalizedCode);
      } catch (err: unknown) {
        const classified = classifyCouponPreviewError(err);
        setAppliedCouponState(null);
        setCouponStatusState(classified.status);
        setCouponErrorMessageState(classified.message);
        setCouponErrorCodeState(classified.code);
        return null;
      }

      isApplyingCouponRef.current = true;
      setCouponStatusState("validating");
      setCouponErrorMessageState(null);
      setCouponErrorCodeState(null);

      const callPreview = options?.previewCouponFn || previewCouponApi;
      const effectiveToken =
        options?.accessToken ?? authContext?.accessToken ?? getStoredToken();

      try {
        const previewRes = await callPreview(previewPayload, effectiveToken);
        setCouponCodeState(previewRes.couponCode);
        setAppliedCouponState(previewRes);
        setCouponStatusState("applied");
        setCouponErrorMessageState(null);
        setCouponErrorCodeState(null);
        return previewRes;
      } catch (err: unknown) {
        const classified = classifyCouponPreviewError(err);
        setAppliedCouponState(null);
        setCouponStatusState(classified.status);
        setCouponErrorMessageState(classified.message);
        setCouponErrorCodeState(classified.code);
        if (classified.statusCode === 401 && authContext?.openAuthModal) {
          authContext.openAuthModal("login", {
            resumeCheckout: true,
            reasonMessage: classified.message,
          });
        }
        return null;
      } finally {
        isApplyingCouponRef.current = false;
      }
    },
    [authContext, couponCode, items]
  );

  // Chuyển đổi giỏ hàng sang định dạng CreateOrderDto theo API Contract v2.1 Mục 8.2
  // Tuyệt đối chỉ gửi { items: [{ productId, size, toppingIds, quantity }], couponCode? }
  const mapToCreateOrderPayload = useCallback(
    (couponCodeOverride?: string): CreateOrderDto => {
      const rawCoupon =
        couponCodeOverride !== undefined
          ? couponCodeOverride
          : appliedCoupon?.couponCode ?? "";
      return buildCreateOrderPayloadFromCart(items, rawCoupon);
    },
    [appliedCoupon, items]
  );

  // Gửi yêu cầu POST /orders trực tiếp từ CartContext và đồng bộ trạng thái loading / error / activeOrder theo user (SCRUM-44)
  const submitOrderFromCart = useCallback(
    async (options?: {
      accessToken?: string | null;
      couponCodeOverride?: string;
      createOrderFn?: (
        payload: CreateOrderRequestDto,
        tokenOverride?: string | null
      ) => Promise<CreateOrderResponseDto>;
    }): Promise<SubmitOrderFromCartResult> => {
      if (isSubmittingOrderRef.current || isSubmittingOrder) {
        return {
          ok: false,
          skipped: true,
          error: {
            statusCode: 409,
            code: "PENDING_ORDER_EXISTS",
            message: "Đang xử lý yêu cầu đặt hàng, vui lòng chờ giây lát.",
            isOutcomeUncertain: false,
            detailLines: [],
          },
        };
      }

      let payload: CreateOrderRequestDto;
      try {
        payload = mapToCreateOrderPayload(options?.couponCodeOverride);
      } catch (err: unknown) {
        const preSendError = toOrderSubmissionErrorState({
          statusCode: 400,
          code: "INVALID_CART",
          message:
            err instanceof Error && err.message
              ? err.message
              : "Dữ liệu giỏ hàng không hợp lệ.",
          isOutcomeUncertain: false,
        });
        setOrderError(preSendError);
        return { ok: false, error: preSendError };
      }

      const productNamesById: Record<string, string> = {};
      for (const item of items) {
        if (item.productId && item.productName) {
          productNamesById[item.productId.trim()] = item.productName.trim();
          productNamesById[item.productId.trim().toLowerCase()] =
            item.productName.trim();
        }
      }

      const callCreateOrder = options?.createOrderFn || createOrderApi;
      setIsSubmittingOrder(true);
      setOrderError(null);

      try {
        const createdOrder = await callCreateOrder(
          payload,
          options?.accessToken
        );
        const ownerUserId =
          authenticatedUserId ||
          resolveStoredAuthenticatedUserId(options?.accessToken);
        // Giữ nguyên giỏ hàng khi đơn ở trạng thái PENDING (AC-US-CART-04-02, BR-07, API Contract v3.0)
        setActiveOrder(createdOrder, ownerUserId);
        return { ok: true, order: createdOrder };
      } catch (err: unknown) {
        const errorState = toOrderSubmissionErrorState(err, productNamesById);
        if (
          errorState.statusCode === 401 ||
          errorState.code === "UNAUTHORIZED"
        ) {
          clearOrderFlowState();
        } else {
          setOrderError(errorState);
          if (
            errorState.code === "INVALID_COUPON" ||
            errorState.code === "COUPON_UNAVAILABLE"
          ) {
            const classified = classifyCouponPreviewError(err);
            setAppliedCouponState(null);
            setCouponStatusState(classified.status);
            setCouponErrorMessageState(
              `${classified.message} Vui lòng áp dụng lại hoặc bỏ mã ưu đãi trước khi tạo đơn hàng.`
            );
            setCouponErrorCodeState(classified.code);
          }
        }
        return { ok: false, error: errorState };
      } finally {
        setIsSubmittingOrder(false);
      }
    },
    [
      authenticatedUserId,
      clearOrderFlowState,
      items,
      isSubmittingOrder,
      mapToCreateOrderPayload,
      setActiveOrder,
      setIsSubmittingOrder,
      setOrderError,
    ]
  );

  const value: CartContextValue = {
    items,
    totalQuantity,
    totalLines,
    subtotalVnd,
    formattedSubtotal,
    isCartOpen,
    couponCode,
    setCouponCode,
    feedbackMessage,
    feedbackType,
    addToCart,
    updateQuantity,
    incrementQuantity,
    decrementQuantity,
    removeFromCart,
    clearCart,
    openCart,
    closeCart,
    toggleCart,
    dismissFeedback,
    mapToCreateOrderPayload,
    activeOrder,
    isSubmittingOrder,
    orderError,
    setActiveOrder,
    setIsSubmittingOrder,
    setOrderError,
    clearOrderFlowState,
    submitOrderFromCart,
    appliedCoupon,
    couponStatus,
    couponErrorMessage,
    couponErrorCode,
    applyCoupon,
    removeCoupon,
    setCouponApplicationState,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
}
