import {
  MOCK_MY_ORDERS_RESPONSE,
  type CouponPreviewRequestDto,
  type CouponPreviewResponseDto,
  type CouponValidationStatus,
  type CreateOrderItemDto,
  type CreateOrderRequestDto,
  type CreateOrderResponseDto,
  type DrinkSize,
  type GetMyOrdersQueryParams,
  type GetMyOrdersResponseDto,
  type InsufficientStockDetail,
  type InvalidCartDetail,
  type OrderErrorCode,
  type OrderHistoryItemDto,
  type OrderHistoryMetaDto,
  type OrderItemSnapshotDto,
  type OrderPaymentSummaryDto,
  type OrderStatus,
  type OrderSubmissionErrorState,
  type OrderToppingSnapshotDto,
  type PaymentMethod,
  type PaymentProvider,
  type PaymentResolution,
  type PaymentStatus,
} from "@/mock-data";
import { isValidIsoUtcString } from "./payment.service";
import {
  API_BASE_URL,
  isValidUuid,
  MAX_ORDER_QUANTITY,
  MAX_TOPPINGS_PER_ITEM,
  MIN_ORDER_QUANTITY,
} from "./api.service";
import {
  clearStoredSession,
  getStoredToken,
  validateJwtToken,
} from "./auth.service";

// ============================================================================
// ORDER & CHECKOUT SERVICE — SPRINT 2 & 3 (SCRUM-43 & SCRUM-44)
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md & Appendix A (v2.1 Mục 5.3, 8, 9)
// - database/schema.dbml & backend/prisma/schema.prisma
// - backend/src/orders/orders.controller.ts & orders.service.ts
//
// Nguyên tắc bắt buộc:
// 1. Chỉ gửi { items: [{ productId, size, toppingIds, quantity }], couponCode? }
// 2. Không dùng Math.trunc() để tự sửa quantity thập phân; từ chối dữ liệu sai.
// 3. Không tự động gửi lại (retry) POST /orders khi fetch bị lỗi mạng vì request
//    đầu tiên có thể đã tạo Order thành công trên máy chủ.
// 4. Chỉ coi HTTP 201 Created là thành công cho POST /orders (không chấp nhận mọi 2xx).
// 5. Kiểm tra chặt chẽ toàn bộ trường bắt buộc và bất biến toán học (ERD invariants)
//    trong CreateOrderResponseDto, không tự điền giá trị mặc định che giấu dữ liệu sai.
// 6. Phân biệt rõ lỗi từ chối xác định trước khi tạo đơn (isOutcomeUncertain = false)
//    và lỗi mạng / lỗi đọc response sau khi đã gửi request (isOutcomeUncertain = true).
// ============================================================================

export const MAX_ORDER_ITEMS = 20;
export const MAX_COUPON_CODE_LENGTH = 30;
export const MIN_COUPON_LENGTH = 1;
export const MAX_COUPON_LENGTH = MAX_COUPON_CODE_LENGTH;

const VALID_DRINK_SIZES: readonly DrinkSize[] = [
  "S",
  "M",
  "L",
  "ONE_SIZE",
] as const;

export interface OrderServiceError extends Error {
  statusCode: number;
  code: OrderErrorCode | string;
  /**
   * `true` khi request `POST /orders` đã được gửi đi nhưng gặp lỗi mạng, lỗi đọc/parse
   * hoặc lỗi kiểm tra dữ liệu phản hồi / 5xx từ máy chủ — tức là Backend CÓ THỂ đã tạo
   * đơn hàng thành công. UI phải hiển thị trạng thái không chắc chắn để tránh hướng
   * người dùng bấm đặt lại ngay gây trùng đơn.
   */
  isOutcomeUncertain: boolean;
  details?: InvalidCartDetail[] | InsufficientStockDetail[] | unknown;
}

function createOrderError(
  message: string,
  statusCode: number,
  code: OrderErrorCode | string,
  details?: unknown,
  isOutcomeUncertain = false
): OrderServiceError {
  const err = new Error(message) as OrderServiceError;
  err.statusCode = statusCode;
  err.code = code;
  err.isOutcomeUncertain = isOutcomeUncertain;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

/**
 * Chuyển đổi mảng `details` từ phản hồi lỗi Backend (400 INVALID_CART, 409 INSUFFICIENT_STOCK, v.v.)
 * sang danh sách thông điệp tiếng Việt dễ hiểu cho người dùng ở màn hình Checkout.
 * Tuân thủ đầy đủ cấu trúc API Contract v2.1 §8.7 / v3.0:
 * - INSUFFICIENT_STOCK: `{ productId, requestedQuantity, availableQuantity }` (hỗ trợ cả alias `requestedQty`, `availableQty`, `name`, `itemId`)
 * - INVALID_CART: `{ itemIndex?, productId?, reason }` với đầy đủ mã `reason` trong Contract:
 *   `DUPLICATE_CONFIGURATION`, `DUPLICATE_TOPPING`, `PRODUCT_NOT_FOUND`, `TOPPING_NOT_FOUND`,
 *   `PRODUCT_UNAVAILABLE`, `INVALID_SIZE`, `TOPPING_NOT_ALLOWED`, `TOPPING_UNAVAILABLE`,
 *   `TOO_MANY_TOPPINGS`, `INVALID_PRICE_DATA`.
 */
export function describeOrderErrorDetails(
  details: unknown,
  productNamesById?: Record<string, string>
): string[] {
  if (!Array.isArray(details) || details.length === 0) {
    return [];
  }

  const messages: string[] = [];

  const lookupProductName = (rawId?: unknown): string | undefined => {
    if (typeof rawId !== "string" || !rawId.trim() || !productNamesById) {
      return undefined;
    }
    const trimmed = rawId.trim();
    return (
      productNamesById[trimmed] ||
      productNamesById[trimmed.toLowerCase()] ||
      productNamesById[trimmed.toUpperCase()]
    );
  };

  for (const rawItem of details) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;

    // 1. Trường hợp 409 INSUFFICIENT_STOCK theo API Contract: { productId, requestedQuantity, availableQuantity }
    const requestedQuantity =
      typeof item.requestedQuantity === "number"
        ? item.requestedQuantity
        : typeof item.requestedQty === "number"
        ? item.requestedQty
        : undefined;
    const availableQuantity =
      typeof item.availableQuantity === "number"
        ? item.availableQuantity
        : typeof item.availableQty === "number"
        ? item.availableQty
        : undefined;

    if (
      requestedQuantity !== undefined &&
      availableQuantity !== undefined
    ) {
      const rawId =
        typeof item.productId === "string" && item.productId.trim()
          ? item.productId.trim()
          : typeof item.itemId === "string" && item.itemId.trim()
          ? item.itemId.trim()
          : "";
      const mappedName = lookupProductName(rawId);
      const displayName =
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : mappedName
          ? mappedName
          : rawId || "Sản phẩm";
      const itemTypeLabel =
        item.itemType === "TOPPING" ? "Topping" : "Sản phẩm";
      messages.push(
        `${itemTypeLabel} "${displayName}" không đủ tồn kho (yêu cầu: ${requestedQuantity}, khả dụng: ${availableQuantity}).`
      );
      continue;
    }

    // 2. Trường hợp 400 INVALID_CART theo API Contract: { itemIndex?, productId?, reason }
    if (typeof item.reason === "string") {
      const mappedName = lookupProductName(item.productId);
      const linePrefix =
        typeof item.itemIndex === "number"
          ? mappedName
            ? `Dòng món #${item.itemIndex + 1} (${mappedName})`
            : `Dòng món #${item.itemIndex + 1}`
          : mappedName
          ? `Món "${mappedName}"`
          : typeof item.productId === "string" && item.productId.trim()
          ? `Món (${item.productId.trim()})`
          : "Món trong giỏ";

      switch (item.reason) {
        case "PRODUCT_NOT_FOUND":
          messages.push(
            `${linePrefix}: Sản phẩm không tồn tại trên hệ thống.`
          );
          break;
        case "PRODUCT_UNAVAILABLE":
        case "PRODUCT_INACTIVE":
        case "PRODUCT_OUT_OF_STOCK":
          messages.push(
            `${linePrefix}: Sản phẩm hiện không khả dụng hoặc đã tạm hết hàng.`
          );
          break;
        case "INVALID_SIZE":
        case "INVALID_SIZE_FOR_CATEGORY":
          messages.push(
            `${linePrefix}: Kích cỡ đã chọn không hợp lệ hoặc không áp dụng cho sản phẩm này.`
          );
          break;
        case "TOPPING_NOT_ALLOWED":
        case "TOPPING_NOT_ALLOWED_FOR_PRODUCT":
          messages.push(
            `${linePrefix}: Sản phẩm này không hỗ trợ thêm topping.`
          );
          break;
        case "TOPPING_NOT_FOUND":
        case "TOPPING_NOT_FOUND_OR_INACTIVE":
          messages.push(
            `${linePrefix}: Topping đã chọn không tồn tại trên hệ thống.`
          );
          break;
        case "TOPPING_UNAVAILABLE":
        case "TOPPING_OUT_OF_STOCK":
          messages.push(
            `${linePrefix}: Topping đã chọn hiện không khả dụng hoặc đã hết hàng.`
          );
          break;
        case "DUPLICATE_TOPPING":
          messages.push(
            `${linePrefix}: Không được chọn trùng một loại topping trong cùng 1 dòng món.`
          );
          break;
        case "TOO_MANY_TOPPINGS":
          messages.push(
            `${linePrefix}: Vượt quá giới hạn tối đa ${MAX_TOPPINGS_PER_ITEM} loại topping cho 1 dòng món.`
          );
          break;
        case "DUPLICATE_CONFIGURATION":
          messages.push(
            `${linePrefix}: Trùng cấu hình sản phẩm, kích cỡ và topping với một dòng khác.`
          );
          break;
        case "INVALID_PRICE_DATA":
          messages.push(
            `${linePrefix}: Dữ liệu bảng giá của sản phẩm trên hệ thống không hợp lệ.`
          );
          break;
        default:
          messages.push(
            `${linePrefix}: Dữ liệu cấu hình không hợp lệ (${item.reason}).`
          );
          break;
      }
    }
  }

  return messages;
}

/**
 * Trả về tiêu đề thông báo lỗi thân thiện theo đúng mã lỗi trong API Contract v3.0 (SCRUM-44).
 */
export function getFriendlyOrderErrorTitle(
  code: OrderErrorCode | string,
  isOutcomeUncertain: boolean
): string {
  if (isOutcomeUncertain) {
    return "Chưa thể xác nhận trạng thái đơn hàng";
  }

  switch (code) {
    case "PENDING_ORDER_EXISTS":
      return "Đang có đơn hàng chờ xử lý";
    case "INSUFFICIENT_STOCK":
      return "Sản phẩm hoặc topping không đủ tồn kho";
    case "INVALID_CART":
      return "Cấu hình giỏ hàng cần cập nhật";
    case "INVALID_COUPON":
    case "COUPON_UNAVAILABLE":
      return "Mã khuyến mãi không khả dụng";
    case "VALIDATION_ERROR":
      return "Dữ liệu đặt hàng không hợp lệ";
    default:
      return "Không thể tạo đơn hàng";
  }
}

/**
 * Chuẩn hóa đối tượng lỗi từ `createOrderApi` hoặc luồng Checkout thành `OrderSubmissionErrorState`
 * để đồng bộ giữa `CartContext` và `CartDrawer` (SCRUM-44).
 */
export function toOrderSubmissionErrorState(
  err: unknown,
  productNamesById?: Record<string, string>
): OrderSubmissionErrorState {
  const orderErr = err as Partial<OrderServiceError>;
  const resolvedStatus =
    typeof orderErr?.statusCode === "number" ? orderErr.statusCode : 500;
  const resolvedCode =
    typeof orderErr?.code === "string" && orderErr.code.trim()
      ? orderErr.code.trim()
      : "SERVER_ERROR";
  const isUncertain =
    typeof orderErr?.isOutcomeUncertain === "boolean"
      ? orderErr.isOutcomeUncertain
      : resolvedStatus >= 500 ||
        resolvedCode === "NETWORK_ERROR" ||
        resolvedCode === "SERVER_ERROR" ||
        resolvedCode === "INTERNAL_ERROR";

  const defaultMessageByCode = (): string => {
    if (isUncertain) {
      return "Không thể xác nhận phản hồi từ máy chủ sau khi gửi yêu cầu đặt hàng. Đơn hàng có thể đã được ghi nhận trên hệ thống.";
    }
    switch (resolvedCode) {
      case "PENDING_ORDER_EXISTS":
        return "Tài khoản của bạn đang có một đơn hàng ở trạng thái PENDING chờ xử lý. Vui lòng hoàn tất hoặc hủy đơn hiện tại trước khi tạo đơn mới.";
      case "INSUFFICIENT_STOCK":
        return "Một hoặc nhiều sản phẩm/topping trong giỏ hàng hiện không đủ số lượng tồn kho.";
      case "INVALID_CART":
        return "Một số món trong giỏ hàng có cấu hình không hợp lệ hoặc đã thay đổi trạng thái.";
      case "INVALID_COUPON":
        return "Mã khuyến mãi không tồn tại, đã hết hạn hoặc chưa đạt giá trị đơn hàng tối thiểu.";
      case "COUPON_UNAVAILABLE":
        return "Mã khuyến mãi đã hết lượt sử dụng.";
      default:
        return "Không thể tạo đơn hàng. Vui lòng kiểm tra lại thông tin giỏ hàng.";
    }
  };

  return {
    statusCode: resolvedStatus,
    code: resolvedCode,
    message:
      typeof orderErr?.message === "string" && orderErr.message.trim()
        ? orderErr.message.trim()
        : defaultMessageByCode(),
    isOutcomeUncertain: isUncertain,
    detailLines: describeOrderErrorDetails(orderErr?.details, productNamesById),
    details: orderErr?.details,
  };
}

/**
 * Chuẩn hóa mã khuyến mãi (couponCode):
 * - Trim khoảng trắng hai đầu và chuyển thành chữ IN HOA (theo schema.dbml & CreateOrderDto).
 * - Nếu sau khi trim là chuỗi rỗng, trả về undefined để không gửi chuỗi rỗng lên Backend.
 */
export function normalizeCouponCode(
  couponCode?: string | null
): string | undefined {
  if (typeof couponCode !== "string") return undefined;
  const trimmed = couponCode.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Kiểm tra định dạng mã khuyến mãi phía Client trước khi gửi:
 * - Không bắt buộc (rỗng hoặc chỉ chứa khoảng trắng -> hợp lệ, normalized = undefined).
 * - Không được chứa khoảng trắng ở giữa (chỉ cho phép tối đa 1 mã coupon theo AC-US-PRO-01-03).
 * - Độ dài từ 1 đến 30 ký tự (theo database/schema.dbml varchar(30) & CreateOrderDto).
 */
export function validateCouponCodeInput(couponCode?: string | null): {
  isValid: boolean;
  normalized?: string;
  error?: string;
  code?: OrderErrorCode;
} {
  if (typeof couponCode !== "string") {
    return { isValid: true, normalized: undefined };
  }

  const trimmed = couponCode.trim();
  if (trimmed.length === 0) {
    return { isValid: true, normalized: undefined };
  }

  if (/\s/.test(trimmed)) {
    return {
      isValid: false,
      error:
        "Mỗi đơn hàng chỉ được áp dụng tối đa 1 mã khuyến mãi (không chứa khoảng trắng).",
      code: "VALIDATION_ERROR",
    };
  }

  if (trimmed.length > MAX_COUPON_CODE_LENGTH) {
    return {
      isValid: false,
      error: `Mã khuyến mãi không được vượt quá ${MAX_COUPON_CODE_LENGTH} ký tự.`,
      code: "VALIDATION_ERROR",
    };
  }

  return {
    isValid: true,
    normalized: trimmed.toUpperCase(),
  };
}

/**
 * Chuẩn hóa nghiêm ngặt payload gửi lên `POST /orders` theo API Contract v2.1 Mục 8.2 & 9.3:
 * - Loại bỏ mọi trường cấm (userId, status, price, unitPriceVnd, lineTotalVnd, subtotalVnd, discountVnd, totalVnd)
 * - Trim và lowercase UUID (productId, toppingIds)
 * - Trim và uppercase couponCode (bỏ qua nếu rỗng)
 * - TUYỆT ĐỐI KHÔNG dùng Math.trunc() để tự sửa quantity thập phân; giữ nguyên giá trị để validateCreateOrderPayload từ chối nếu sai kiểu/thập phân.
 */
export function sanitizeCreateOrderPayload(
  raw: CreateOrderRequestDto
): CreateOrderRequestDto {
  const cleanItems: CreateOrderItemDto[] = Array.isArray(raw?.items)
    ? raw.items.map((item) => ({
        productId:
          typeof item?.productId === "string"
            ? item.productId.trim().toLowerCase()
            : "",
        size: item?.size,
        toppingIds: Array.isArray(item?.toppingIds)
          ? item.toppingIds.map((id) =>
              typeof id === "string" ? id.trim().toLowerCase() : ""
            )
          : [],
        quantity: item?.quantity as number,
      }))
    : [];

  const normalizedCoupon = normalizeCouponCode(raw?.couponCode);

  return {
    items: cleanItems,
    ...(normalizedCoupon ? { couponCode: normalizedCoupon } : {}),
  };
}

/**
 * Kiểm tra tính hợp lệ của payload `CreateOrderRequestDto` trước khi gọi API.
 * Từ chối thẳng mọi dữ liệu sai (bao gồm quantity thập phân, không phải number, vượt ngưỡng).
 */
export function validateCreateOrderPayload(raw: CreateOrderRequestDto): {
  isValid: boolean;
  payload?: CreateOrderRequestDto;
  error?: OrderServiceError;
} {
  if (!raw || !Array.isArray(raw.items) || raw.items.length === 0) {
    return {
      isValid: false,
      error: createOrderError(
        "Giỏ hàng đang trống. Vui lòng chọn ít nhất 1 món trước khi đặt hàng.",
        400,
        "INVALID_CART"
      ),
    };
  }

  if (raw.items.length > MAX_ORDER_ITEMS) {
    return {
      isValid: false,
      error: createOrderError(
        `Đơn hàng chỉ cho phép tối đa ${MAX_ORDER_ITEMS} dòng sản phẩm.`,
        400,
        "VALIDATION_ERROR"
      ),
    };
  }

  const couponValidation = validateCouponCodeInput(raw.couponCode);
  if (!couponValidation.isValid) {
    return {
      isValid: false,
      error: createOrderError(
        couponValidation.error || "Mã khuyến mãi không hợp lệ.",
        400,
        couponValidation.code || "VALIDATION_ERROR"
      ),
    };
  }

  // Kiểm tra kiểu dữ liệu gốc của từng dòng trước khi chuẩn hóa
  for (let i = 0; i < raw.items.length; i++) {
    const rawItem = raw.items[i];
    if (!rawItem || typeof rawItem !== "object") {
      return {
        isValid: false,
        error: createOrderError(
          `Dữ liệu dòng sản phẩm thứ ${i + 1} không hợp lệ.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }

    if (
      typeof rawItem.quantity !== "number" ||
      !Number.isFinite(rawItem.quantity) ||
      !Number.isInteger(rawItem.quantity) ||
      rawItem.quantity < MIN_ORDER_QUANTITY ||
      rawItem.quantity > MAX_ORDER_QUANTITY
    ) {
      return {
        isValid: false,
        error: createOrderError(
          `Số lượng mỗi dòng sản phẩm phải là số nguyên từ ${MIN_ORDER_QUANTITY} đến ${MAX_ORDER_QUANTITY}.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }

    if (!Array.isArray(rawItem.toppingIds)) {
      return {
        isValid: false,
        error: createOrderError(
          `Danh sách topping ở dòng ${i + 1} không hợp lệ.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }
  }

  const sanitized = sanitizeCreateOrderPayload(raw);
  const seenConfigKeys = new Set<string>();

  for (let i = 0; i < sanitized.items.length; i++) {
    const item = sanitized.items[i];

    if (!item.productId || !isValidUuid(item.productId)) {
      return {
        isValid: false,
        error: createOrderError(
          `Mã sản phẩm ở dòng ${i + 1} không đúng định dạng UUID.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }

    if (!VALID_DRINK_SIZES.includes(item.size)) {
      return {
        isValid: false,
        error: createOrderError(
          `Kích cỡ sản phẩm ở dòng ${i + 1} không hợp lệ.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }

    if (item.toppingIds.some((tid) => !tid || !isValidUuid(tid))) {
      return {
        isValid: false,
        error: createOrderError(
          `Mã topping ở dòng ${i + 1} không đúng định dạng UUID.`,
          400,
          "VALIDATION_ERROR"
        ),
      };
    }

    if (item.toppingIds.length > MAX_TOPPINGS_PER_ITEM) {
      return {
        isValid: false,
        error: createOrderError(
          `Mỗi dòng sản phẩm chỉ được chọn tối đa ${MAX_TOPPINGS_PER_ITEM} loại topping.`,
          400,
          "INVALID_CART",
          [
            {
              productId: item.productId,
              itemIndex: i,
              reason: "TOO_MANY_TOPPINGS",
            },
          ]
        ),
      };
    }

    if (new Set(item.toppingIds).size !== item.toppingIds.length) {
      return {
        isValid: false,
        error: createOrderError(
          "Không được chọn trùng lặp cùng một loại topping trong 1 dòng món.",
          400,
          "INVALID_CART",
          [
            {
              productId: item.productId,
              itemIndex: i,
              reason: "DUPLICATE_TOPPING",
            },
          ]
        ),
      };
    }

    const configKey = `${item.productId}_${item.size}_[${[...item.toppingIds]
      .sort()
      .join(",")}]`;
    if (seenConfigKeys.has(configKey)) {
      return {
        isValid: false,
        error: createOrderError(
          "Giỏ hàng có hai dòng trùng cấu hình sản phẩm, kích cỡ và topping.",
          400,
          "INVALID_CART",
          [
            {
              productId: item.productId,
              itemIndex: i,
              reason: "DUPLICATE_CONFIGURATION",
            },
          ]
        ),
      };
    }
    seenConfigKeys.add(configKey);
  }

  return {
    isValid: true,
    payload: sanitized,
  };
}

/**
 * Kiểm tra chặt chẽ toàn bộ các trường bắt buộc và bất biến toán học (ERD & API Contract v3.0 §7)
 * trong `CreateOrderResponseDto` trả về từ máy chủ (HTTP 201 Created).
 * Tuyệt đối không tự điền giá trị mặc định che giấu dữ liệu sai hoặc thiếu từ Backend.
 * Vì hàm này chỉ chạy sau khi request đã được gửi tới máy chủ, mọi lỗi phát sinh tại đây
 * đều mang `isOutcomeUncertain = true` (đơn hàng có thể đã được tạo trên Backend).
 */
export function validateOrderResponseData(
  data: unknown
): CreateOrderResponseDto {
  if (!data || typeof data !== "object") {
    throw createOrderError(
      "Phản hồi đơn hàng từ máy chủ không hợp lệ hoặc không thể đọc dữ liệu.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  const record = data as Record<string, unknown>;

  if (typeof record.id !== "string" || !isValidUuid(record.id.trim())) {
    throw createOrderError(
      "Mã đơn hàng (id) trả về từ máy chủ không hợp lệ.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  if (record.status !== "PENDING") {
    throw createOrderError(
      "Trạng thái đơn hàng mới tạo (status) phải là PENDING theo hợp đồng API.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw createOrderError(
      "Danh sách món trong phản hồi đơn hàng (items) bị rỗng hoặc không hợp lệ.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  if (
    record.couponCode !== null &&
    (typeof record.couponCode !== "string" || !record.couponCode.trim())
  ) {
    throw createOrderError(
      "Trường couponCode trong phản hồi đơn hàng không hợp lệ.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  if (
    typeof record.subtotalVnd !== "number" ||
    !Number.isSafeInteger(record.subtotalVnd) ||
    record.subtotalVnd < 0 ||
    typeof record.discountVnd !== "number" ||
    !Number.isSafeInteger(record.discountVnd) ||
    record.discountVnd < 0 ||
    typeof record.totalVnd !== "number" ||
    !Number.isSafeInteger(record.totalVnd) ||
    record.totalVnd < 0 ||
    record.discountVnd > record.subtotalVnd ||
    record.totalVnd !== record.subtotalVnd - record.discountVnd
  ) {
    throw createOrderError(
      "Dữ liệu tổng tiền (subtotalVnd, discountVnd, totalVnd) từ máy chủ không hợp lệ hoặc vi phạm bất biến totalVnd = subtotalVnd - discountVnd.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  if (
    typeof record.createdAt !== "string" ||
    !isValidIsoUtcString(record.createdAt)
  ) {
    throw createOrderError(
      "Thời gian tạo đơn (createdAt) từ máy chủ không đúng chuẩn ISO 8601.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  const validatedItems: OrderItemSnapshotDto[] = record.items.map(
    (rawItem: unknown, idx: number) => {
      if (!rawItem || typeof rawItem !== "object") {
        throw createOrderError(
          `Dữ liệu dòng món thứ ${idx + 1} trong phản hồi đơn hàng không hợp lệ.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      const item = rawItem as Record<string, unknown>;

      if (typeof item.id !== "string" || !isValidUuid(item.id.trim())) {
        throw createOrderError(
          `Thiếu hoặc sai định dạng id ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.productId !== "string" ||
        !isValidUuid(item.productId.trim())
      ) {
        throw createOrderError(
          `Thiếu hoặc sai định dạng productId ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.productName !== "string" ||
        !item.productName.trim()
      ) {
        throw createOrderError(
          `Thiếu productName ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.size !== "string" ||
        !VALID_DRINK_SIZES.includes(item.size as DrinkSize)
      ) {
        throw createOrderError(
          `Kích cỡ (size) ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng không hợp lệ.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.sizeMultiplierPercent !== "number" ||
        !Number.isSafeInteger(item.sizeMultiplierPercent) ||
        item.sizeMultiplierPercent <= 0
      ) {
        throw createOrderError(
          `Hệ số kích cỡ (sizeMultiplierPercent) ở dòng món thứ ${idx + 1} không hợp lệ.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.basePriceVnd !== "number" ||
        !Number.isSafeInteger(item.basePriceVnd) ||
        item.basePriceVnd < 0
      ) {
        throw createOrderError(
          `Giá gốc (basePriceVnd) ở dòng món thứ ${idx + 1} không hợp lệ.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.quantity !== "number" ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < MIN_ORDER_QUANTITY ||
        item.quantity > MAX_ORDER_QUANTITY
      ) {
        throw createOrderError(
          `Số lượng (quantity) ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng không hợp lệ.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (
        typeof item.unitPriceVnd !== "number" ||
        !Number.isSafeInteger(item.unitPriceVnd) ||
        item.unitPriceVnd < 0 ||
        typeof item.lineTotalVnd !== "number" ||
        !Number.isSafeInteger(item.lineTotalVnd) ||
        item.lineTotalVnd < 0 ||
        item.lineTotalVnd !== item.unitPriceVnd * item.quantity
      ) {
        throw createOrderError(
          `Đơn giá hoặc thành tiền ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng không hợp lệ (yêu cầu lineTotalVnd = unitPriceVnd * quantity).`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      if (!Array.isArray(item.toppings)) {
        throw createOrderError(
          `Danh sách toppings ở dòng món thứ ${idx + 1} trong phản hồi đơn hàng không phải mảng.`,
          500,
          "SERVER_ERROR",
          undefined,
          true
        );
      }

      const validatedToppings: OrderToppingSnapshotDto[] = item.toppings.map(
        (rawTop: unknown, topIdx: number) => {
          if (!rawTop || typeof rawTop !== "object") {
            throw createOrderError(
              `Topping thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} không hợp lệ.`,
              500,
              "SERVER_ERROR",
              undefined,
              true
            );
          }

          const top = rawTop as Record<string, unknown>;
          if (typeof top.id !== "string" || !isValidUuid(top.id.trim())) {
            throw createOrderError(
              `Mã topping (id) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} không hợp lệ.`,
              500,
              "SERVER_ERROR",
              undefined,
              true
            );
          }

          if (typeof top.name !== "string" || !top.name.trim()) {
            throw createOrderError(
              `Tên topping (name) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} không hợp lệ.`,
              500,
              "SERVER_ERROR",
              undefined,
              true
            );
          }

          if (
            typeof top.priceVnd !== "number" ||
            !Number.isSafeInteger(top.priceVnd) ||
            top.priceVnd < 0
          ) {
            throw createOrderError(
              `Giá topping (priceVnd) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} không hợp lệ.`,
              500,
              "SERVER_ERROR",
              undefined,
              true
            );
          }

          return {
            id: top.id.trim(),
            name: top.name.trim(),
            priceVnd: top.priceVnd,
          };
        }
      );

      return {
        id: item.id.trim(),
        productId: item.productId.trim(),
        productName: item.productName.trim(),
        size: item.size as DrinkSize,
        sizeMultiplierPercent: item.sizeMultiplierPercent,
        basePriceVnd: item.basePriceVnd,
        quantity: item.quantity,
        unitPriceVnd: item.unitPriceVnd,
        lineTotalVnd: item.lineTotalVnd,
        toppings: validatedToppings,
      };
    }
  );

  const computedItemsSubtotal = validatedItems.reduce(
    (sum, item) => sum + item.lineTotalVnd,
    0
  );
  if (computedItemsSubtotal !== record.subtotalVnd) {
    throw createOrderError(
      "Tổng thành tiền các dòng món (lineTotalVnd) không khớp với subtotalVnd từ máy chủ.",
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  return {
    id: record.id.trim(),
    status: "PENDING",
    items: validatedItems,
    couponCode:
      typeof record.couponCode === "string" ? record.couponCode.trim() : null,
    subtotalVnd: record.subtotalVnd,
    discountVnd: record.discountVnd,
    totalVnd: record.totalVnd,
    createdAt: record.createdAt.trim(),
  };
}

/**
 * Gọi API `POST /orders` tới Backend thật để tạo đơn hàng `PENDING` từ giỏ hàng hiện tại (SCRUM-43 & SCRUM-44).
 * - Kiểm tra chặt chẽ JWT trước khi gửi request.
 * - Chỉ gửi `{ items: [{ productId, size, toppingIds, quantity }], couponCode? }`.
 * - TUYỆT ĐỐI KHÔNG tự động gửi lại (retry) `POST /orders` khi `fetch` bị lỗi mạng.
 * - Chỉ chấp nhận đúng HTTP `201 Created` theo API Contract v2.1 / v3.0.
 */
export async function createOrderApi(
  rawPayload: CreateOrderRequestDto,
  tokenOverride?: string | null
): Promise<CreateOrderResponseDto> {
  // 1. Kiểm tra JWT token hợp lệ và chưa hết hạn trước khi gửi request (chưa gửi request -> isOutcomeUncertain = false)
  const candidateToken = tokenOverride || getStoredToken();
  if (!candidateToken) {
    clearStoredSession();
    throw createOrderError(
      "Vui lòng đăng nhập để tiến hành đặt hàng.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  try {
    validateJwtToken(candidateToken);
  } catch {
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  // 2. Validate và chuẩn hóa payload nghiêm ngặt theo API Contract v2.1 Mục 8.2 & 9.3 (chưa gửi request -> isOutcomeUncertain = false)
  const validation = validateCreateOrderPayload(rawPayload);
  if (!validation.isValid || !validation.payload) {
    throw (
      validation.error ||
      createOrderError(
        "Dữ liệu đơn hàng không hợp lệ.",
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      )
    );
  }

  const sanitizedPayload = validation.payload;

  // 3. Gửi duy nhất 1 request tới Backend `POST /orders`
  // TUYỆT ĐỐI KHÔNG tự động gửi lại (retry) khi fetch lỗi mạng vì request đầu tiên có thể đã tạo Order trên Server
  const endpoint =
    typeof window !== "undefined"
      ? "/api/backend/orders"
      : `${API_BASE_URL}/orders`;

  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${candidateToken.trim()}`,
    },
    body: JSON.stringify(sanitizedPayload),
    cache: "no-store",
  };

  let response: Response;
  try {
    response = await fetch(endpoint, requestInit);
  } catch {
    // Request đã được phát đi trên mạng: Backend có thể đã nhận và tạo Order thành công -> isOutcomeUncertain = true
    throw createOrderError(
      "Kết nối đến máy chủ bị gián đoạn sau khi gửi yêu cầu đặt hàng. Đơn hàng của bạn có thể đã được hệ thống ghi nhận — vui lòng kiểm tra lại trạng thái đơn hàng trước khi thử lại để tránh tạo trùng đơn.",
      503,
      "NETWORK_ERROR",
      undefined,
      true
    );
  }

  // 4. Chỉ coi HTTP 201 Created là thành công đúng hợp đồng API Contract v2.1 Mục 8.3
  if (response.status === 201) {
    let rawData: unknown;
    try {
      rawData = await response.json();
    } catch {
      throw createOrderError(
        "Máy chủ đã phản hồi HTTP 201 Created nhưng xảy ra lỗi khi đọc dữ liệu phản hồi. Đơn hàng có thể đã được tạo trên hệ thống — vui lòng không bấm đặt lại ngay.",
        500,
        "SERVER_ERROR",
        undefined,
        true
      );
    }
    return validateOrderResponseData(rawData);
  }

  // Nếu máy chủ trả về một mã 2xx khác 201 (ví dụ 200 hoặc 204), coi là sai hợp đồng API nhưng trạng thái đơn là không chắc chắn (isOutcomeUncertain = true)
  if (response.status >= 200 && response.status < 300) {
    throw createOrderError(
      `Phản hồi từ máy chủ không đúng hợp đồng POST /orders (nhận HTTP ${response.status}, yêu cầu HTTP 201 Created). Đơn hàng có thể đã được xử lý trên máy chủ.`,
      500,
      "SERVER_ERROR",
      undefined,
      true
    );
  }

  // 5. Xử lý các mã lỗi HTTP từ Backend (400, 401, 409, 5xx)
  const errorData = await response.json().catch(() => null);
  const is5xx = response.status >= 500 && response.status <= 599;
  const isDeterministic4xx = response.status >= 400 && response.status < 500;

  if (response.status === 401 || errorData?.code === "UNAUTHORIZED") {
    // Token hết hạn hoặc user không còn tồn tại: xóa phiên Auth nhưng BẢO LƯU GIỎ HÀNG
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.",
      401,
      "UNAUTHORIZED",
      errorData?.details,
      false
    );
  }

  const resolvedCode: OrderErrorCode | string =
    typeof errorData?.code === "string" && errorData.code.trim()
      ? errorData.code.trim()
      : response.status === 409
      ? "PENDING_ORDER_EXISTS"
      : response.status === 400
      ? "VALIDATION_ERROR"
      : is5xx
      ? "SERVER_ERROR"
      : "SERVER_ERROR";

  const rawMessage = Array.isArray(errorData?.message)
    ? errorData.message.join(", ")
    : typeof errorData?.message === "string" && errorData.message.trim()
    ? errorData.message.trim()
    : is5xx
    ? "Máy chủ gặp sự cố trong quá trình phản hồi yêu cầu đặt hàng. Trạng thái đơn hàng hiện chưa thể xác nhận chắc chắn."
    : `Không thể tạo đơn hàng (HTTP ${response.status}).`;

  // Với các lỗi 4xx tường minh từ Backend (400 INVALID_CART / VALIDATION_ERROR / INVALID_COUPON, 409 INSUFFICIENT_STOCK / PENDING_ORDER_EXISTS / COUPON_UNAVAILABLE),
  // Backend đã từ chối tạo đơn mới trước khi commit -> isOutcomeUncertain = false.
  // Ngược lại, với 5xx hoặc lỗi không xác định sau khi đã gửi request -> isOutcomeUncertain = true.
  throw createOrderError(
    rawMessage,
    response.status,
    resolvedCode,
    errorData?.details,
    !isDeterministic4xx
  );
}

// ============================================================================
// COUPON PREVIEW & VALIDATION SERVICE (`POST /coupons/preview` — P2-21 & P2-22)
// Đối chiếu chuẩn 100% với:
// - docs/api/SCRUM96_Coupon_Preview_Addendum.md
// - backend/src/coupons/coupons.controller.ts & coupons.service.ts
// - backend/src/promotions/promotion-policy.ts
//
// Nguyên tắc bắt buộc:
// 1. Frontend KHÔNG tự quyết định coupon hợp lệ hay tự tính authoritative discount.
// 2. Chỉ gửi `{ couponCode, items: [{ productId, size, toppingIds, quantity }] }`.
// 3. Không gửi discountVnd, subtotalVnd, totalVnd hay userId từ client.
// 4. Kiểm tra chặt chẽ toàn bộ trường trả về của `CouponPreviewResponseDto`:
//    `valid === true`, `couponCode`, `subtotalVnd >= 0`, `discountVnd >= 0`,
//    `discountVnd <= subtotalVnd`, `totalVnd === subtotalVnd - discountVnd`.
// ============================================================================

/**
 * Kiểm tra chặt chẽ phản hồi `CouponPreviewResponseDto` từ `POST /coupons/preview` (HTTP 200 OK).
 * Vì `POST /coupons/preview` là truy vấn chỉ đọc (stateless, không tạo Order hay giữ chỗ),
 * mọi lỗi phát sinh tại đây đều mang `isOutcomeUncertain = false`.
 */
export function validateCouponPreviewResponseData(
  data: unknown
): CouponPreviewResponseDto {
  if (!data || typeof data !== "object") {
    throw createOrderError(
      "Phản hồi kiểm tra mã ưu đãi từ máy chủ không hợp lệ.",
      502,
      "SERVER_ERROR",
      undefined,
      false
    );
  }

  const record = data as Record<string, unknown>;

  if (record.valid !== true) {
    throw createOrderError(
      "Trường valid trong phản hồi kiểm tra mã ưu đãi phải là true.",
      502,
      "SERVER_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.couponCode !== "string" ||
    record.couponCode.trim().length < MIN_COUPON_LENGTH ||
    record.couponCode.trim().length > MAX_COUPON_LENGTH
  ) {
    throw createOrderError(
      "Mã ưu đãi (couponCode) trả về từ máy chủ không hợp lệ.",
      502,
      "SERVER_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.subtotalVnd !== "number" ||
    !Number.isSafeInteger(record.subtotalVnd) ||
    record.subtotalVnd < 0 ||
    typeof record.discountVnd !== "number" ||
    !Number.isSafeInteger(record.discountVnd) ||
    record.discountVnd < 0 ||
    typeof record.totalVnd !== "number" ||
    !Number.isSafeInteger(record.totalVnd) ||
    record.totalVnd < 0 ||
    record.discountVnd > record.subtotalVnd ||
    record.totalVnd !== record.subtotalVnd - record.discountVnd
  ) {
    throw createOrderError(
      "Dữ liệu giảm giá (subtotalVnd, discountVnd, totalVnd) từ máy chủ không hợp lệ hoặc vi phạm bất biến totalVnd = subtotalVnd - discountVnd.",
      502,
      "SERVER_ERROR",
      undefined,
      false
    );
  }

  return {
    couponCode: record.couponCode.trim().toUpperCase(),
    subtotalVnd: record.subtotalVnd,
    discountVnd: record.discountVnd,
    totalVnd: record.totalVnd,
    valid: true,
  };
}

/**
 * Phân loại lỗi từ `POST /coupons/preview` (hoặc `POST /orders` khi từ chối coupon)
 * sang trạng thái UI tường minh theo yêu cầu P2-22:
 * - `invalid` (`400 INVALID_COUPON` "Coupon does not exist" / `400 VALIDATION_ERROR`)
 * - `expired` (`400 INVALID_COUPON` "Coupon has expired")
 * - `not_eligible` (`400 INVALID_COUPON` "Order subtotal does not meet coupon minimum" / "Coupon is not active yet")
 * - `usage_limit_exceeded` (`409 COUPON_UNAVAILABLE` "Coupon usage limit reached")
 * - `error` (Lỗi mạng, `500 INTERNAL_ERROR`, `401 UNAUTHORIZED`, `400 INVALID_CART`)
 */
export function extractCouponErrorSubcode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const record = err as Record<string, unknown>;
  if (typeof record.subcode === "string" && record.subcode.trim()) {
    return record.subcode.trim().toUpperCase();
  }
  if (typeof record.reason === "string" && record.reason.trim()) {
    return record.reason.trim().toUpperCase();
  }
  const details = record.details;
  if (Array.isArray(details) && details.length > 0) {
    const first = details[0] as Record<string, unknown> | null;
    if (first && typeof first === "object") {
      if (typeof first.subcode === "string" && first.subcode.trim()) {
        return first.subcode.trim().toUpperCase();
      }
      if (typeof first.reason === "string" && first.reason.trim()) {
        return first.reason.trim().toUpperCase();
      }
    }
  } else if (details && typeof details === "object") {
    const detRecord = details as Record<string, unknown>;
    if (typeof detRecord.subcode === "string" && detRecord.subcode.trim()) {
      return detRecord.subcode.trim().toUpperCase();
    }
    if (typeof detRecord.reason === "string" && detRecord.reason.trim()) {
      return detRecord.reason.trim().toUpperCase();
    }
  }
  return null;
}

export function classifyCouponPreviewError(err: unknown): {
  status: Exclude<CouponValidationStatus, "idle" | "validating" | "applied">;
  message: string;
  code: string;
  statusCode: number;
} {
  const candidate = err as Partial<OrderServiceError> | null;
  const statusCode =
    typeof candidate?.statusCode === "number" ? candidate.statusCode : 500;
  const code =
    typeof candidate?.code === "string" && candidate.code.trim()
      ? candidate.code.trim().toUpperCase()
      : statusCode === 409
      ? "COUPON_UNAVAILABLE"
      : statusCode === 400
      ? "INVALID_COUPON"
      : "SERVER_ERROR";
  const subcode = extractCouponErrorSubcode(err);

  if (statusCode === 401 || code === "UNAUTHORIZED") {
    return {
      status: "error",
      code: "UNAUTHORIZED",
      statusCode: 401,
      message:
        "Phiên đăng nhập đã hết hạn (401 UNAUTHORIZED). Vui lòng đăng nhập lại để áp dụng mã ưu đãi.",
    };
  }

  if (
    code === "COUPON_UNAVAILABLE" ||
    statusCode === 409 ||
    subcode === "COUPON_UNAVAILABLE" ||
    subcode === "USAGE_LIMIT_EXCEEDED"
  ) {
    return {
      status: "usage_limit_exceeded",
      code: "COUPON_UNAVAILABLE",
      statusCode: statusCode || 409,
      message:
        "Mã ưu đãi đã hết lượt sử dụng hoặc bạn đã dùng hết số lượt cho phép.",
    };
  }

  if (
    code === "COUPON_EXPIRED" ||
    subcode === "EXPIRED" ||
    subcode === "COUPON_EXPIRED"
  ) {
    return {
      status: "expired",
      code: "INVALID_COUPON",
      statusCode: statusCode || 400,
      message: "Mã ưu đãi đã hết hạn sử dụng.",
    };
  }

  if (
    code === "COUPON_NOT_ELIGIBLE" ||
    subcode === "NOT_ELIGIBLE" ||
    subcode === "COUPON_NOT_ELIGIBLE" ||
    subcode === "MIN_SUBTOTAL_NOT_MET" ||
    subcode === "COUPON_NOT_ACTIVE"
  ) {
    return {
      status: "not_eligible",
      code: "INVALID_COUPON",
      statusCode: statusCode || 400,
      message:
        "Đơn hàng chưa đủ điều kiện áp dụng hoặc mã ưu đãi chưa đến thời gian có hiệu lực.",
    };
  }

  if (code === "INVALID_COUPON") {
    // Fallback generic INVALID_COUPON khi backend chỉ trả về code = INVALID_COUPON mà không có subcode/reason cấu trúc ổn định
    return {
      status: "invalid",
      code: "INVALID_COUPON",
      statusCode: statusCode || 400,
      message:
        "Mã ưu đãi không hợp lệ, đã hết hạn hoặc đơn hàng chưa đủ điều kiện áp dụng.",
    };
  }

  if (code === "VALIDATION_ERROR") {
    return {
      status: "invalid",
      code: "VALIDATION_ERROR",
      statusCode: statusCode || 400,
      message: "Mã ưu đãi không hợp lệ (tối đa 30 ký tự, không để trống).",
    };
  }

  if (code === "INVALID_CART") {
    return {
      status: "error",
      code: "INVALID_CART",
      statusCode: statusCode || 400,
      message:
        "Giỏ hàng có sản phẩm hoặc topping không còn hợp lệ. Vui lòng kiểm tra lại giỏ hàng.",
    };
  }

  return {
    status: "error",
    code: code || "NETWORK_ERROR",
    statusCode: statusCode || 503,
    message:
      "Không thể kết nối tới máy chủ để kiểm tra mã ưu đãi. Giỏ hàng của bạn vẫn được giữ nguyên, vui lòng thử lại.",
  };
}

/**
 * Gọi API `POST /coupons/preview` tới Backend thật để kiểm tra tính hợp lệ của Coupon
 * và nhận giá trị giảm giá chính thức (`subtotalVnd`, `discountVnd`, `totalVnd`) từ Server (P2-21 & P2-22).
 * - KHÔNG tạo Order, KHÔNG giữ chỗ tồn kho, KHÔNG xóa giỏ hàng khi lỗi.
 * - Hỗ trợ `AbortSignal` để hủy request đang pending khi giỏ hàng/coupon/user thay đổi.
 */
export async function previewCouponApi(
  rawPayload: CouponPreviewRequestDto,
  tokenOverride?: string | null,
  options?: { signal?: AbortSignal }
): Promise<CouponPreviewResponseDto> {
  if (options?.signal?.aborted) {
    throw createOrderError(
      "Yêu cầu kiểm tra mã ưu đãi đã bị hủy.",
      499,
      "ABORTED",
      undefined,
      false
    );
  }

  const candidateToken = tokenOverride || getStoredToken();
  if (!candidateToken) {
    clearStoredSession();
    throw createOrderError(
      "Vui lòng đăng nhập để kiểm tra và áp dụng mã ưu đãi.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  try {
    validateJwtToken(candidateToken);
  } catch {
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  if (!rawPayload || typeof rawPayload !== "object") {
    throw createOrderError(
      "Dữ liệu kiểm tra mã ưu đãi không hợp lệ.",
      400,
      "VALIDATION_ERROR",
      undefined,
      false
    );
  }

  const rawCode =
    typeof rawPayload.couponCode === "string"
      ? rawPayload.couponCode.trim().toUpperCase()
      : "";

  if (
    rawCode.length < MIN_COUPON_LENGTH ||
    rawCode.length > MAX_COUPON_LENGTH
  ) {
    throw createOrderError(
      `Mã ưu đãi phải từ ${MIN_COUPON_LENGTH} đến ${MAX_COUPON_LENGTH} ký tự.`,
      400,
      "VALIDATION_ERROR",
      undefined,
      false
    );
  }

  const orderValidation = validateCreateOrderPayload({
    items: rawPayload.items,
    couponCode: rawCode,
  });
  if (!orderValidation.isValid || !orderValidation.payload) {
    throw (
      orderValidation.error ||
      createOrderError(
        "Dữ liệu giỏ hàng hoặc mã ưu đãi không hợp lệ.",
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      )
    );
  }

  const sanitizedPreviewPayload: CouponPreviewRequestDto = {
    couponCode: rawCode,
    items: orderValidation.payload.items,
  };

  const endpoint =
    typeof window !== "undefined"
      ? "/api/backend/coupons/preview"
      : `${API_BASE_URL}/coupons/preview`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${candidateToken.trim()}`,
      },
      body: JSON.stringify(sanitizedPreviewPayload),
      cache: "no-store",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  } catch (err: unknown) {
    if (
      options?.signal?.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw createOrderError(
        "Yêu cầu kiểm tra mã ưu đãi đã bị hủy.",
        499,
        "ABORTED",
        undefined,
        false
      );
    }
    throw createOrderError(
      "Lỗi kết nối mạng khi kiểm tra mã ưu đãi. Vui lòng thử lại.",
      503,
      "NETWORK_ERROR",
      undefined,
      false
    );
  }

  if (options?.signal?.aborted) {
    throw createOrderError(
      "Yêu cầu kiểm tra mã ưu đãi đã bị hủy.",
      499,
      "ABORTED",
      undefined,
      false
    );
  }

  if (response.status === 200) {
    let rawData: unknown;
    try {
      rawData = await response.json();
    } catch {
      throw createOrderError(
        "Phản hồi từ máy chủ không đúng định dạng JSON.",
        502,
        "SERVER_ERROR",
        undefined,
        false
      );
    }
    return validateCouponPreviewResponseData(rawData);
  }

  const errorData = await response.json().catch(() => null);

  if (response.status === 401 || errorData?.code === "UNAUTHORIZED") {
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.",
      401,
      "UNAUTHORIZED",
      errorData?.details,
      false
    );
  }

  const resolvedCode: OrderErrorCode | string =
    typeof errorData?.code === "string" && errorData.code.trim()
      ? errorData.code.trim()
      : response.status === 409
      ? "COUPON_UNAVAILABLE"
      : response.status === 400
      ? "INVALID_COUPON"
      : "SERVER_ERROR";

  const rawMessage = Array.isArray(errorData?.message)
    ? errorData.message.join(", ")
    : typeof errorData?.message === "string" && errorData.message.trim()
    ? errorData.message.trim()
    : `Không thể áp dụng mã ưu đãi (HTTP ${response.status}).`;

  const structuredDetails =
    errorData?.details !== undefined
      ? errorData.details
      : errorData?.reason || errorData?.subcode
      ? { reason: errorData.reason, subcode: errorData.subcode }
      : undefined;

  throw createOrderError(
    rawMessage,
    response.status,
    resolvedCode,
    structuredDetails,
    false
  );
}

// ============================================================================
// ORDER HISTORY SERVICE (`GET /orders/me` — SPRINT 3 SCRUM-64)
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md §4 (`GET /orders/me`) & §9
// - backend/src/orders/orders.controller.ts & orders.service.ts
// - backend/src/orders/dto/get-my-orders-query.dto.ts
// - backend/src/orders/dto/get-my-orders-response.dto.ts
// ============================================================================

export const MIN_MY_ORDERS_PAGE = 1;
export const MIN_MY_ORDERS_LIMIT = 1;
export const MAX_MY_ORDERS_LIMIT = 100;

export const VALID_ORDER_STATUSES: readonly OrderStatus[] = [
  "PENDING",
  "PAYMENT_FAILED",
  "PAID",
  "PREPARING",
  "READY",
  "COMPLETED",
  "CANCELLED",
] as const;

export const VALID_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "SUCCESS",
  "FAILED",
  "PENDING",
] as const;

export const VALID_PAYMENT_METHODS: readonly PaymentMethod[] = [
  "CARD",
  "WALLET",
  "VNPAY",
  "ZERO_AMOUNT",
] as const;

export const VALID_PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  "MOCK",
  "VNPAY",
  "ZERO_AMOUNT",
] as const;

export const VALID_PAYMENT_RESOLUTIONS: readonly PaymentResolution[] = [
  "PROCESSING",
  "RECONCILING",
  "PAYMENT_ACCEPTED",
  "FAILED",
  "FINANCIAL_EXCEPTION",
  "REQUIRES_REVIEW",
] as const;

/**
 * Kiểm tra tham số truy vấn `page` và `limit` cho `GET /orders/me`
 * (API Contract v3.0 §4.1 & `backend/src/orders/orders.service.ts`):
 * - Hoặc KHÔNG truyền cả `page` lẫn `limit` (trả về toàn bộ lịch sử đơn hàng của user).
 * - Hoặc truyền ĐỒNG THỜI cả `page` (số nguyên dương >= 1) và `limit` (số nguyên từ 1 đến 100).
 * - Nếu chỉ truyền 1 trong 2 tham số hoặc giá trị ngoài khoảng hợp lệ -> trả về `400 VALIDATION_ERROR`.
 */
export function validateMyOrdersQuery(query?: GetMyOrdersQueryParams): {
  isValid: boolean;
  hasPagination: boolean;
  page: number | null;
  limit: number | null;
  queryString: string;
  error?: OrderServiceError;
} {
  if (!query || (query.page === undefined && query.limit === undefined)) {
    return {
      isValid: true,
      hasPagination: false,
      page: null,
      limit: null,
      queryString: "",
    };
  }

  const hasPage = query.page !== undefined;
  const hasLimit = query.limit !== undefined;

  if (hasPage !== hasLimit) {
    return {
      isValid: false,
      hasPagination: false,
      page: null,
      limit: null,
      queryString: "",
      error: createOrderError(
        "Tham số phân trang page và limit phải được gửi cùng nhau hoặc cùng bỏ trống.",
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      ),
    };
  }

  const page = query.page as number;
  const limit = query.limit as number;

  if (
    typeof page !== "number" ||
    !Number.isFinite(page) ||
    !Number.isSafeInteger(page) ||
    page < MIN_MY_ORDERS_PAGE
  ) {
    return {
      isValid: false,
      hasPagination: false,
      page: null,
      limit: null,
      queryString: "",
      error: createOrderError(
        `Tham số page phải là số nguyên lớn hơn hoặc bằng ${MIN_MY_ORDERS_PAGE}.`,
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      ),
    };
  }

  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    !Number.isSafeInteger(limit) ||
    limit < MIN_MY_ORDERS_LIMIT ||
    limit > MAX_MY_ORDERS_LIMIT
  ) {
    return {
      isValid: false,
      hasPagination: false,
      page: null,
      limit: null,
      queryString: "",
      error: createOrderError(
        `Tham số limit phải là số nguyên trong khoảng từ ${MIN_MY_ORDERS_LIMIT} đến ${MAX_MY_ORDERS_LIMIT}.`,
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      ),
    };
  }

  return {
    isValid: true,
    hasPagination: true,
    page,
    limit,
    queryString: `?page=${page}&limit=${limit}`,
  };
}

/**
 * Kiểm tra chặt chẽ `OrderPaymentSummaryDto | null` trong `GET /orders/me` (API Contract v3.0 §4.2).
 * Lưu ý: `GET /orders/me` là truy vấn chỉ đọc (idempotent), nên `isOutcomeUncertain = false`.
 */
export function validateOrderPaymentSummaryData(
  raw: unknown,
  orderIdx = 0
): OrderPaymentSummaryDto | null {
  if (raw === null) {
    return null;
  }

  if (!raw || typeof raw !== "object") {
    throw createOrderError(
      `Dữ liệu thanh toán (payment) của đơn hàng thứ ${orderIdx + 1} không hợp lệ (phải là object hoặc null).`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const payment = raw as Record<string, unknown>;

  if (typeof payment.id !== "string" || !isValidUuid(payment.id.trim())) {
    throw createOrderError(
      `Mã giao dịch thanh toán (payment.id) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof payment.status !== "string" ||
    !VALID_PAYMENT_STATUSES.includes(payment.status as PaymentStatus)
  ) {
    throw createOrderError(
      `Trạng thái giao dịch (payment.status) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  let provider: PaymentProvider | undefined = undefined;
  if ("provider" in payment && payment.provider !== undefined) {
    if (
      typeof payment.provider !== "string" ||
      !VALID_PAYMENT_PROVIDERS.includes(payment.provider as PaymentProvider)
    ) {
      throw createOrderError(
        `Trường payment.provider của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    provider = payment.provider as PaymentProvider;
  }

  if (!("method" in payment) || payment.method === undefined) {
    throw createOrderError(
      `Thiếu trường payment.method của đơn hàng thứ ${orderIdx + 1}.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (provider === "VNPAY" || provider === "ZERO_AMOUNT") {
    if (
      payment.method !== null &&
      (typeof payment.method !== "string" ||
        !VALID_PAYMENT_METHODS.includes(payment.method as PaymentMethod))
    ) {
      throw createOrderError(
        `Phương thức thanh toán (payment.method) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
  } else {
    if (
      typeof payment.method !== "string" ||
      !VALID_PAYMENT_METHODS.includes(payment.method as PaymentMethod)
    ) {
      throw createOrderError(
        `Phương thức thanh toán (payment.method) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
  }

  if (
    payment.methodLast4 !== null &&
    (typeof payment.methodLast4 !== "string" ||
      !/^\d{4}$/.test(payment.methodLast4.trim()))
  ) {
    throw createOrderError(
      `Trường payment.methodLast4 của đơn hàng thứ ${orderIdx + 1} phải là 4 chữ số hoặc null.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof payment.amountVnd !== "number" ||
    !Number.isSafeInteger(payment.amountVnd) ||
    payment.amountVnd < 0
  ) {
    throw createOrderError(
      `Số tiền thanh toán (payment.amountVnd) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    payment.mockReference !== null &&
    (typeof payment.mockReference !== "string" || !payment.mockReference.trim())
  ) {
    throw createOrderError(
      `Mã tham chiếu giao dịch (payment.mockReference) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    payment.failureReason !== null &&
    (typeof payment.failureReason !== "string" || !payment.failureReason.trim())
  ) {
    throw createOrderError(
      `Lý do thất bại (payment.failureReason) của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  let resolution: PaymentResolution | undefined = undefined;
  if ("resolution" in payment && payment.resolution !== undefined) {
    if (
      typeof payment.resolution !== "string" ||
      !VALID_PAYMENT_RESOLUTIONS.includes(payment.resolution as PaymentResolution)
    ) {
      throw createOrderError(
        `Trường payment.resolution của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    resolution = payment.resolution as PaymentResolution;
  }

  let requiresReview: boolean | undefined = undefined;
  if ("requiresReview" in payment && payment.requiresReview !== undefined) {
    if (typeof payment.requiresReview !== "boolean") {
      throw createOrderError(
        `Trường payment.requiresReview của đơn hàng thứ ${orderIdx + 1} phải là boolean.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    requiresReview = payment.requiresReview;
  }

  let canRetry: boolean | undefined = undefined;
  if ("canRetry" in payment && payment.canRetry !== undefined) {
    if (typeof payment.canRetry !== "boolean") {
      throw createOrderError(
        `Trường payment.canRetry của đơn hàng thứ ${orderIdx + 1} phải là boolean.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    canRetry = payment.canRetry;
  }

  if (
    typeof payment.createdAt !== "string" ||
    !isValidIsoUtcString(payment.createdAt)
  ) {
    throw createOrderError(
      `Thời gian giao dịch (payment.createdAt) của đơn hàng thứ ${orderIdx + 1} không đúng chuẩn ISO 8601.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  return {
    id: payment.id.trim(),
    status: payment.status as PaymentStatus,
    ...(provider !== undefined ? { provider } : {}),
    method: (payment.method as PaymentMethod | null),
    methodLast4:
      typeof payment.methodLast4 === "string"
        ? payment.methodLast4.trim()
        : null,
    amountVnd: payment.amountVnd,
    mockReference:
      typeof payment.mockReference === "string"
        ? payment.mockReference.trim()
        : null,
    failureReason:
      typeof payment.failureReason === "string"
        ? payment.failureReason.trim()
        : null,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(requiresReview !== undefined ? { requiresReview } : {}),
    ...(canRetry !== undefined ? { canRetry } : {}),
    createdAt: payment.createdAt.trim(),
  };
}

/**
 * Kiểm tra chặt chẽ từng phần tử `OrderHistoryItemDto` trong `GET /orders/me`
 * (API Contract v3.0 §4.2 & ERD invariants).
 */
export function validateOrderHistoryItemData(
  raw: unknown,
  orderIdx = 0
): OrderHistoryItemDto {
  if (!raw || typeof raw !== "object") {
    throw createOrderError(
      `Dữ liệu đơn hàng thứ ${orderIdx + 1} trong danh sách lịch sử không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.id !== "string" || !isValidUuid(record.id.trim())) {
    throw createOrderError(
      `Mã đơn hàng (id) ở vị trí thứ ${orderIdx + 1} không đúng định dạng UUID.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.status !== "string" ||
    !VALID_ORDER_STATUSES.includes(record.status as OrderStatus)
  ) {
    throw createOrderError(
      `Trạng thái đơn hàng (status) ở vị trí thứ ${orderIdx + 1} không thuộc danh mục hợp lệ của API Contract v3.0.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.createdAt !== "string" ||
    !isValidIsoUtcString(record.createdAt)
  ) {
    throw createOrderError(
      `Thời gian tạo đơn (createdAt) ở đơn hàng thứ ${orderIdx + 1} không đúng chuẩn ISO 8601.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.expiresAt !== "string" ||
    !isValidIsoUtcString(record.expiresAt)
  ) {
    throw createOrderError(
      `Thời gian hết hạn giữ chỗ (expiresAt) ở đơn hàng thứ ${orderIdx + 1} bị thiếu hoặc không đúng chuẩn ISO 8601.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.subtotalVnd !== "number" ||
    !Number.isSafeInteger(record.subtotalVnd) ||
    record.subtotalVnd < 0 ||
    typeof record.discountVnd !== "number" ||
    !Number.isSafeInteger(record.discountVnd) ||
    record.discountVnd < 0 ||
    typeof record.totalVnd !== "number" ||
    !Number.isSafeInteger(record.totalVnd) ||
    record.totalVnd < 0 ||
    record.discountVnd > record.subtotalVnd ||
    record.totalVnd !== record.subtotalVnd - record.discountVnd
  ) {
    throw createOrderError(
      `Dữ liệu tổng tiền (subtotalVnd, discountVnd, totalVnd) ở đơn hàng thứ ${orderIdx + 1} không hợp lệ hoặc vi phạm bất biến totalVnd = subtotalVnd - discountVnd.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    record.couponCode !== null &&
    (typeof record.couponCode !== "string" || !record.couponCode.trim())
  ) {
    throw createOrderError(
      `Trường couponCode ở đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (
    typeof record.pointsEarned !== "number" ||
    !Number.isSafeInteger(record.pointsEarned) ||
    record.pointsEarned < 0
  ) {
    throw createOrderError(
      `Điểm tích lũy (pointsEarned) ở đơn hàng thứ ${orderIdx + 1} phải là số nguyên không âm.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw createOrderError(
      `Danh sách món (items) ở đơn hàng thứ ${orderIdx + 1} bị rỗng hoặc không hợp lệ.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const validatedItems: OrderItemSnapshotDto[] = record.items.map(
    (rawItem: unknown, idx: number) => {
      if (!rawItem || typeof rawItem !== "object") {
        throw createOrderError(
          `Dữ liệu dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      const item = rawItem as Record<string, unknown>;

      if (typeof item.id !== "string" || !isValidUuid(item.id.trim())) {
        throw createOrderError(
          `Mã dòng món (id) thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.productId !== "string" ||
        !isValidUuid(item.productId.trim())
      ) {
        throw createOrderError(
          `Mã sản phẩm (productId) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (typeof item.productName !== "string" || !item.productName.trim()) {
        throw createOrderError(
          `Tên sản phẩm (productName) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.size !== "string" ||
        !VALID_DRINK_SIZES.includes(item.size as DrinkSize)
      ) {
        throw createOrderError(
          `Kích cỡ (size) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.sizeMultiplierPercent !== "number" ||
        !Number.isSafeInteger(item.sizeMultiplierPercent) ||
        item.sizeMultiplierPercent <= 0
      ) {
        throw createOrderError(
          `Hệ số kích cỡ (sizeMultiplierPercent) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.basePriceVnd !== "number" ||
        !Number.isSafeInteger(item.basePriceVnd) ||
        item.basePriceVnd < 0
      ) {
        throw createOrderError(
          `Giá gốc (basePriceVnd) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.quantity !== "number" ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < MIN_ORDER_QUANTITY ||
        item.quantity > MAX_ORDER_QUANTITY
      ) {
        throw createOrderError(
          `Số lượng (quantity) ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (
        typeof item.unitPriceVnd !== "number" ||
        !Number.isSafeInteger(item.unitPriceVnd) ||
        item.unitPriceVnd < 0 ||
        typeof item.lineTotalVnd !== "number" ||
        !Number.isSafeInteger(item.lineTotalVnd) ||
        item.lineTotalVnd < 0 ||
        item.lineTotalVnd !== item.unitPriceVnd * item.quantity
      ) {
        throw createOrderError(
          `Đơn giá hoặc thành tiền ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ (yêu cầu lineTotalVnd = unitPriceVnd * quantity).`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      if (!Array.isArray(item.toppings)) {
        throw createOrderError(
          `Danh sách toppings ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không phải mảng.`,
          500,
          "INTERNAL_ERROR",
          undefined,
          false
        );
      }

      const validatedToppings: OrderToppingSnapshotDto[] = item.toppings.map(
        (rawTop: unknown, topIdx: number) => {
          if (!rawTop || typeof rawTop !== "object") {
            throw createOrderError(
              `Topping thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
              500,
              "INTERNAL_ERROR",
              undefined,
              false
            );
          }

          const top = rawTop as Record<string, unknown>;
          if (typeof top.id !== "string" || !isValidUuid(top.id.trim())) {
            throw createOrderError(
              `Mã topping (id) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
              500,
              "INTERNAL_ERROR",
              undefined,
              false
            );
          }

          if (typeof top.name !== "string" || !top.name.trim()) {
            throw createOrderError(
              `Tên topping (name) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
              500,
              "INTERNAL_ERROR",
              undefined,
              false
            );
          }

          if (
            typeof top.priceVnd !== "number" ||
            !Number.isSafeInteger(top.priceVnd) ||
            top.priceVnd < 0
          ) {
            throw createOrderError(
              `Giá topping (priceVnd) thứ ${topIdx + 1} ở dòng món thứ ${idx + 1} của đơn hàng thứ ${orderIdx + 1} không hợp lệ.`,
              500,
              "INTERNAL_ERROR",
              undefined,
              false
            );
          }

          return {
            id: top.id.trim(),
            name: top.name.trim(),
            priceVnd: top.priceVnd,
          };
        }
      );

      return {
        id: item.id.trim(),
        productId: item.productId.trim(),
        productName: item.productName.trim(),
        size: item.size as DrinkSize,
        sizeMultiplierPercent: item.sizeMultiplierPercent,
        basePriceVnd: item.basePriceVnd,
        quantity: item.quantity,
        unitPriceVnd: item.unitPriceVnd,
        lineTotalVnd: item.lineTotalVnd,
        toppings: validatedToppings,
      };
    }
  );

  const computedItemsSubtotal = validatedItems.reduce(
    (sum, item) => sum + item.lineTotalVnd,
    0
  );
  if (computedItemsSubtotal !== record.subtotalVnd) {
    throw createOrderError(
      `Tổng thành tiền các dòng món (lineTotalVnd) không khớp với subtotalVnd của đơn hàng thứ ${orderIdx + 1}.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  let hasFinancialException: boolean | undefined = undefined;
  if ("hasFinancialException" in record && record.hasFinancialException !== undefined) {
    if (typeof record.hasFinancialException !== "boolean") {
      throw createOrderError(
        `Trường hasFinancialException ở đơn hàng thứ ${orderIdx + 1} phải là boolean.`,
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    hasFinancialException = record.hasFinancialException;
  }

  const validatedPayment = validateOrderPaymentSummaryData(
    record.payment,
    orderIdx
  );

  if (
    validatedPayment !== null &&
    validatedPayment.amountVnd !== record.totalVnd
  ) {
    throw createOrderError(
      `Số tiền thanh toán (payment.amountVnd) không khớp với totalVnd của đơn hàng thứ ${orderIdx + 1}.`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  return {
    id: record.id.trim(),
    status: record.status as OrderStatus,
    createdAt: record.createdAt.trim(),
    expiresAt: record.expiresAt.trim(),
    subtotalVnd: record.subtotalVnd,
    discountVnd: record.discountVnd,
    totalVnd: record.totalVnd,
    couponCode:
      typeof record.couponCode === "string" ? record.couponCode.trim() : null,
    pointsEarned: record.pointsEarned,
    ...(hasFinancialException !== undefined ? { hasFinancialException } : {}),
    items: validatedItems,
    payment: validatedPayment,
  };
}

/**
 * Kiểm tra chặt chẽ `meta` trong `GET /orders/me` (API Contract v3.0 §4.1 & §4.2):
 * - Chế độ không phân trang: `page === null`, `limit === null`, `totalPages === null`, `total === itemsLength`.
 * - Chế độ phân trang: `page >= 1`, `1 <= limit <= 100`, `total >= 0`, `totalPages === (total === 0 ? 0 : Math.ceil(total / limit))`.
 */
export function validateMyOrdersMetaData(
  raw: unknown,
  itemsLength: number
): OrderHistoryMetaDto {
  if (!raw || typeof raw !== "object") {
    throw createOrderError(
      "Thiếu hoặc sai định dạng siêu dữ liệu phân trang (meta) trong phản hồi GET /orders/me.",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const meta = raw as Record<string, unknown>;

  if (
    typeof meta.total !== "number" ||
    !Number.isSafeInteger(meta.total) ||
    meta.total < 0
  ) {
    throw createOrderError(
      "Trường meta.total trong phản hồi GET /orders/me phải là số nguyên không âm.",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const isUnpaginated =
    meta.page === null && meta.limit === null && meta.totalPages === null;

  if (isUnpaginated) {
    if (meta.total !== itemsLength) {
      throw createOrderError(
        "Trường meta.total không khớp với số lượng phần tử items trong chế độ không phân trang.",
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    return {
      page: null,
      limit: null,
      total: meta.total,
      totalPages: null,
    };
  }

  if (
    typeof meta.page !== "number" ||
    !Number.isSafeInteger(meta.page) ||
    meta.page < MIN_MY_ORDERS_PAGE ||
    typeof meta.limit !== "number" ||
    !Number.isSafeInteger(meta.limit) ||
    meta.limit < MIN_MY_ORDERS_LIMIT ||
    meta.limit > MAX_MY_ORDERS_LIMIT ||
    typeof meta.totalPages !== "number" ||
    !Number.isSafeInteger(meta.totalPages) ||
    meta.totalPages < 0
  ) {
    throw createOrderError(
      "Siêu dữ liệu phân trang (meta.page, meta.limit, meta.totalPages) trong phản hồi GET /orders/me không hợp lệ.",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const expectedTotalPages =
    meta.total === 0 ? 0 : Math.ceil(meta.total / meta.limit);
  if (meta.totalPages !== expectedTotalPages) {
    throw createOrderError(
      "Trường meta.totalPages trong phản hồi GET /orders/me không khớp công thức ceil(total / limit).",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  return {
    page: meta.page,
    limit: meta.limit,
    total: meta.total,
    totalPages: meta.totalPages,
  };
}

/**
 * Kiểm tra toàn bộ phản hồi `GetMyOrdersResponseDto` từ `GET /orders/me` (API Contract v3.0 §4.2).
 * Tuyệt đối không tự điền giá trị mặc định che giấu dữ liệu sai từ máy chủ.
 */
export function validateMyOrdersResponseData(
  data: unknown
): GetMyOrdersResponseDto {
  if (!data || typeof data !== "object") {
    throw createOrderError(
      "Phản hồi lịch sử đơn hàng từ máy chủ không hợp lệ hoặc không thể đọc dữ liệu.",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const record = data as Record<string, unknown>;

  if (!Array.isArray(record.items)) {
    throw createOrderError(
      "Phản hồi lịch sử đơn hàng từ máy chủ không chứa mảng items hợp lệ.",
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  const validatedItems = record.items.map((rawOrder, idx) =>
    validateOrderHistoryItemData(rawOrder, idx)
  );
  const validatedMeta = validateMyOrdersMetaData(
    record.meta,
    validatedItems.length
  );

  return {
    items: validatedItems,
    meta: validatedMeta,
  };
}

/**
 * Tạo dữ liệu phản hồi `GetMyOrdersResponseDto` từ Mock Data (hỗ trợ cả phân trang và không phân trang)
 * để dùng cho kiểm thử hoặc khi chạy chế độ `?state=mock`.
 */
export function buildMockMyOrdersResponse(
  query?: GetMyOrdersQueryParams
): GetMyOrdersResponseDto {
  const validation = validateMyOrdersQuery(query);
  if (!validation.isValid) {
    throw (
      validation.error ||
      createOrderError(
        "Tham số phân trang không hợp lệ.",
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      )
    );
  }

  const allItems = MOCK_MY_ORDERS_RESPONSE.items;
  if (
    !validation.hasPagination ||
    validation.page === null ||
    validation.limit === null
  ) {
    return {
      items: allItems,
      meta: {
        page: null,
        limit: null,
        total: allItems.length,
        totalPages: null,
      },
    };
  }

  const total = allItems.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / validation.limit);
  const startIdx = (validation.page - 1) * validation.limit;
  const pagedItems = allItems.slice(startIdx, startIdx + validation.limit);

  return {
    items: pagedItems,
    meta: {
      page: validation.page,
      limit: validation.limit,
      total,
      totalPages,
    },
  };
}

/**
 * Gọi API `GET /orders/me` tới Backend thật để tải danh sách lịch sử đơn hàng của người dùng hiện tại (SCRUM-64).
 * Tuân thủ nghiêm ngặt API Contract v3.0 §4 & §9:
 * - Bắt buộc có JWT `Authorization: Bearer <accessToken>` hợp lệ.
 * - Khi gặp `401 UNAUTHORIZED` (token thiếu, hết hạn hoặc bị từ chối bởi Backend): xóa phiên đăng nhập (`clearStoredSession()`) nhưng BẢO LƯU GIỎ HÀNG (`brewlite_cart_v1`).
 * - Hỗ trợ cả chế độ không phân trang (`GET /orders/me`) và có phân trang (`GET /orders/me?page=X&limit=Y`).
 * - Chỉ chấp nhận đúng HTTP `200 OK` và kiểm tra toàn diện cấu trúc `GetMyOrdersResponseDto`.
 * - Vì `GET /orders/me` là truy vấn chỉ đọc (idempotent), `isOutcomeUncertain` luôn là `false` và người dùng có thể bấm "Thử lại" an toàn khi gặp lỗi mạng / 5xx.
 */
export async function getMyOrdersApi(options?: {
  query?: GetMyOrdersQueryParams;
  tokenOverride?: string | null;
  signal?: AbortSignal;
  useMockData?: boolean;
}): Promise<GetMyOrdersResponseDto> {
  // 1. Kiểm tra tham số phân trang (nếu có) trước khi gọi mạng
  const queryValidation = validateMyOrdersQuery(options?.query);
  if (!queryValidation.isValid) {
    throw (
      queryValidation.error ||
      createOrderError(
        "Tham số truy vấn lịch sử đơn hàng không hợp lệ.",
        400,
        "VALIDATION_ERROR",
        undefined,
        false
      )
    );
  }

  // Hỗ trợ chế độ xem dữ liệu mẫu tường minh (?state=mock hoặc test unit)
  // Hỗ trợ chế độ xem dữ liệu mẫu tường minh (?state=mock hoặc test unit)
  // Tuyệt đối chặn trong môi trường production, bảo vệ dữ liệu thực và API Contract
  if (options?.useMockData) {
    if (process.env.NODE_ENV === "production") {
      throw createOrderError(
        "Chế độ dữ liệu mẫu (mock data) không được phép trong môi trường production.",
        403,
        "FORBIDDEN",
        undefined,
        false
      );
    }
    return buildMockMyOrdersResponse(options?.query);
  }

  // 2. Kiểm tra JWT token hợp lệ và chưa hết hạn trước khi gửi request
  const candidateToken = options?.tokenOverride ?? getStoredToken();
  if (!candidateToken || !candidateToken.trim()) {
    clearStoredSession();
    throw createOrderError(
      "Vui lòng đăng nhập để xem lịch sử đơn hàng của bạn.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  try {
    validateJwtToken(candidateToken);
  } catch {
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại để xem lịch sử đơn hàng.",
      401,
      "UNAUTHORIZED",
      undefined,
      false
    );
  }

  const isBrowser = typeof window !== "undefined";
  const pathWithQuery = `/orders/me${queryValidation.queryString}`;
  const primaryUrl = isBrowser
    ? `/api/backend${pathWithQuery}`
    : `${API_BASE_URL}${pathWithQuery}`;
  const fallbackUrl = isBrowser
    ? `${API_BASE_URL}${pathWithQuery}`
    : `/api/backend${pathWithQuery}`;

  const requestInit: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${candidateToken.trim()}`,
    },
    cache: "no-store",
    signal: options?.signal,
  };

  let response: Response;
  try {
    response = await fetch(primaryUrl, requestInit);
  } catch (primaryErr) {
    if (options?.signal?.aborted) {
      throw primaryErr;
    }
    try {
      response = await fetch(fallbackUrl, requestInit);
    } catch (fallbackErr) {
      if (options?.signal?.aborted) {
        throw fallbackErr;
      }
      throw createOrderError(
        "Không thể kết nối đến máy chủ để tải lịch sử đơn hàng (GET /orders/me). Vui lòng kiểm tra kết nối mạng và thử lại.",
        503,
        "NETWORK_ERROR",
        undefined,
        false
      );
    }
  }

  // 3. Xử lý HTTP 200 OK theo đúng API Contract v3.0 §4.2
  if (response.status === 200) {
    let rawData: unknown;
    try {
      rawData = await response.json();
    } catch {
      throw createOrderError(
        "Máy chủ phản hồi HTTP 200 OK nhưng dữ liệu JSON lịch sử đơn hàng không hợp lệ.",
        500,
        "INTERNAL_ERROR",
        undefined,
        false
      );
    }
    return validateMyOrdersResponseData(rawData);
  }

  // Nếu máy chủ trả về một mã 2xx khác 200 (ví dụ 204 No Content), từ chối vì sai hợp đồng API Contract v3.0 §4.2
  if (response.status >= 200 && response.status < 300) {
    throw createOrderError(
      `Phản hồi từ máy chủ không đúng hợp đồng GET /orders/me (nhận HTTP ${response.status}, yêu cầu HTTP 200 OK).`,
      500,
      "INTERNAL_ERROR",
      undefined,
      false
    );
  }

  // 4. Xử lý các mã lỗi HTTP từ Backend (400, 401, 500)
  const errorData = await response.json().catch(() => null);

  if (response.status === 401 || errorData?.code === "UNAUTHORIZED") {
    // Xóa phiên đăng nhập đã hết hạn nhưng BẢO LƯU GIỎ HÀNG (`brewlite_cart_v1`)
    clearStoredSession();
    throw createOrderError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại để xem lịch sử đơn hàng.",
      401,
      "UNAUTHORIZED",
      errorData?.details,
      false
    );
  }

  const is5xx = response.status >= 500 && response.status <= 599;
  const resolvedCode: OrderErrorCode | string =
    typeof errorData?.code === "string" && errorData.code.trim()
      ? errorData.code.trim()
      : response.status === 400
      ? "VALIDATION_ERROR"
      : is5xx
      ? "INTERNAL_ERROR"
      : "SERVER_ERROR";

  const rawMessage = Array.isArray(errorData?.message)
    ? errorData.message.join(", ")
    : typeof errorData?.message === "string" && errorData.message.trim()
    ? errorData.message.trim()
    : is5xx
    ? "Máy chủ đang gặp sự cố khi truy xuất lịch sử đơn hàng. Vui lòng thử tải lại sau giây lát."
    : `Không thể tải lịch sử đơn hàng (HTTP ${response.status}).`;

  throw createOrderError(
    rawMessage,
    response.status,
    resolvedCode,
    errorData?.details,
    false
  );
}

export type OrderHistoryFilterTab =
  | "all"
  | "PENDING"
  | "PAID_GROUP"
  | "PAYMENT_FAILED"
  | "CANCELLED";

export interface OrderStatusPresentationMeta {
  status: OrderStatus;
  label: string;
  shortLabel: string;
  filterGroup: Exclude<OrderHistoryFilterTab, "all">;
  icon: string;
  badgeClassName: string;
  cardClassName: string;
  reservationNote: string;
}

/**
 * Ánh xạ trạng thái đơn hàng (`OrderStatus`) sang nhãn hiển thị, màu sắc chuẩn Stitch
 * và ghi chú quy tắc nghiệp vụ giữ chỗ tồn kho / mã giảm giá theo API Contract v3.0 §4.2 & §9.
 */
export function getOrderStatusPresentation(
  status: OrderStatus
): OrderStatusPresentationMeta {
  switch (status) {
    case "PAID":
      return {
        status,
        label: "Đã thanh toán (PAID)",
        shortLabel: "Đã thanh toán",
        filterGroup: "PAID_GROUP",
        icon: "check_circle",
        badgeClassName: "bg-[#E8F5E9] text-[#1B5E20] border-[#A5D6A7]",
        cardClassName:
          "bg-surface-container-lowest border-transparent hover:border-outline-variant",
        reservationNote:
          "Thanh toán thành công • Đã khấu trừ tồn kho & xác nhận mã giảm giá (CONFIRMED).",
      };
    case "PREPARING":
      return {
        status,
        label: "Đang pha chế (PREPARING)",
        shortLabel: "Đang pha chế",
        filterGroup: "PAID_GROUP",
        icon: "coffee_maker",
        badgeClassName: "bg-[#E8F5E9] text-[#1B5E20] border-[#A5D6A7]",
        cardClassName:
          "bg-surface-container-lowest border-transparent hover:border-outline-variant",
        reservationNote:
          "Quầy Barista đang chuẩn bị đồ uống của bạn theo công thức đã chọn.",
      };
    case "READY":
      return {
        status,
        label: "Sẵn sàng nhận món (READY)",
        shortLabel: "Sẵn sàng",
        filterGroup: "PAID_GROUP",
        icon: "notifications_active",
        badgeClassName: "bg-[#E8F5E9] text-[#1B5E20] border-[#A5D6A7]",
        cardClassName:
          "bg-surface-container-lowest border-transparent hover:border-outline-variant",
        reservationNote:
          "Đồ uống đã hoàn tất tại quầy • Sẵn sàng phục vụ hoặc giao hàng.",
      };
    case "COMPLETED":
      return {
        status,
        label: "Hoàn tất (COMPLETED)",
        shortLabel: "Hoàn tất",
        filterGroup: "PAID_GROUP",
        icon: "verified",
        badgeClassName: "bg-[#E8F5E9] text-[#1B5E20] border-[#A5D6A7]",
        cardClassName:
          "bg-surface-container-lowest border-transparent hover:border-outline-variant",
        reservationNote:
          "Đơn hàng đã phục vụ hoàn tất • Điểm tích lũy thành viên đã được cộng vào tài khoản.",
      };
    case "PENDING":
      return {
        status,
        label: "Chờ xử lý (PENDING)",
        shortLabel: "Chờ xử lý",
        filterGroup: "PENDING",
        icon: "schedule",
        badgeClassName:
          "bg-tertiary-fixed text-on-tertiary-fixed border-tertiary-fixed-dim",
        cardClassName:
          "bg-surface-container-lowest border-tertiary-fixed-dim hover:border-tertiary",
        reservationNote:
          "Đang giữ chỗ tồn kho & mã giảm giá (HELD) trong 15 phút chờ thanh toán.",
      };
    case "PAYMENT_FAILED":
      return {
        status,
        label: "Thanh toán thất bại (PAYMENT_FAILED)",
        shortLabel: "Thất bại",
        filterGroup: "PAYMENT_FAILED",
        icon: "error",
        badgeClassName:
          "bg-error-container text-on-error-container border-error/20",
        cardClassName:
          "bg-surface-container-lowest border-error/25 hover:border-error/50",
        reservationNote:
          "Giao dịch gần nhất bị từ chối • Tồn kho & mã giảm giá vẫn được giữ (HELD) cho tới khi đơn hết hạn hoặc bị hủy.",
      };
    case "CANCELLED":
    default:
      return {
        status: "CANCELLED",
        label: "Đã hủy (CANCELLED)",
        shortLabel: "Đã hủy",
        filterGroup: "CANCELLED",
        icon: "cancel",
        badgeClassName:
          "bg-surface-container-highest text-on-surface-variant border-outline-variant",
        cardClassName:
          "bg-surface-container-low/80 border-transparent hover:border-outline-variant opacity-85 hover:opacity-100",
        reservationNote:
          "Đơn hàng đã hủy • Đã hoàn trả tồn kho & giải phóng lượt dùng mã giảm giá (RELEASED).",
      };
  }
}

/**
 * Đếm số lượng đơn hàng theo từng tab bộ lọc trên màn hình Lịch sử đơn hàng (SCRUM-64).
 */
export function computeOrderStatusCounts(orders: OrderHistoryItemDto[]): {
  all: number;
  PENDING: number;
  PAID_GROUP: number;
  PAYMENT_FAILED: number;
  CANCELLED: number;
} {
  const counts = {
    all: orders.length,
    PENDING: 0,
    PAID_GROUP: 0,
    PAYMENT_FAILED: 0,
    CANCELLED: 0,
  };

  for (const order of orders) {
    const group = getOrderStatusPresentation(order.status).filterGroup;
    counts[group] += 1;
  }

  return counts;
}

/**
 * Lọc danh sách đơn hàng theo tab trạng thái và từ khóa tìm kiếm (mã đơn UUID, tên món, tên topping, mã coupon).
 */
export function filterAndSearchOrders(
  orders: OrderHistoryItemDto[],
  statusFilter: OrderHistoryFilterTab,
  searchQuery: string
): OrderHistoryItemDto[] {
  const normalizedQuery = (searchQuery || "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "");

  return orders.filter((order) => {
    if (statusFilter !== "all") {
      const group = getOrderStatusPresentation(order.status).filterGroup;
      if (group !== statusFilter) {
        return false;
      }
    }

    if (!normalizedQuery) {
      return true;
    }

    const idMatches = order.id.toLowerCase().includes(normalizedQuery);
    const couponMatches = order.couponCode
      ? order.couponCode.toLowerCase().includes(normalizedQuery)
      : false;
    const itemMatches = order.items.some(
      (item) =>
        item.productName.toLowerCase().includes(normalizedQuery) ||
        item.toppings.some((t) =>
          t.name.toLowerCase().includes(normalizedQuery)
        )
    );
    const refMatches = order.payment?.mockReference
      ? order.payment.mockReference.toLowerCase().includes(normalizedQuery)
      : false;

    return idMatches || couponMatches || itemMatches || refMatches;
  });
}

/**
 * Định dạng chuỗi ISO 8601 sang định dạng hiển thị tiếng Việt `HH:mm - DD/MM/YYYY`.
 */
export function formatOrderTimestampVi(isoString: string): string {
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) {
    return isoString;
  }
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${hours}:${minutes} - ${day}/${month}/${year}`;
}
