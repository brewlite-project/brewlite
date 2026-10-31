import type {
  AuthMeResponseDto,
  CreateOrderResponseDto,
  CreatePaymentRequestDto,
  GetMyOrdersResponseDto,
  MyOrderDto,
  MyOrdersMetaDto,
  MyOrderPaymentSummaryDto,
  OrderItemSnapshotDto,
  OrderStatus,
  PaymentErrorCode,
  PaymentMethod,
  PaymentResponseDto,
  PaymentSubmissionErrorState,
} from "@/mock-data";
import { API_BASE_URL, isValidUuid } from "./api.service";
import {
  clearStoredSession,
  getStoredToken,
  isTokenExpired,
} from "./auth.service";

// ============================================================================
// PAYMENT SERVICE — SPRINT 3 (SCRUM-67 / API CONTRACT v3.0 MỤC 3, 4, 8 & 9)
// Kết nối 100% dữ liệu thật với Backend API:
// - POST /payments (Header: Authorization: Bearer <JWT>, Idempotency-Key: <8..64 ký tự>)
// - GET /orders/me (Tải Order & Payment snapshots thật từ PostgreSQL)
// - GET /auth/me (Tải thông tin khách hàng & điểm tích lũy thật từ PostgreSQL)
//
// Nguyên tắc bắt buộc (API Contract v3.0):
// 1. Header `Authorization: Bearer <JWT>` & `Idempotency-Key: <8..64 ký tự>` (required).
// 2. Payload chỉ gồm `{ orderId, method, paymentDetails }` (CARD: `{ cardNumber: 16 chữ số }`,
//    WALLET: `{ phoneNumber: 10 chữ số }`). Tuyệt đối không gửi `userId`, `amount`, `status`, `pointsEarned`, `role`.
// 3. HTTP 200 trả về cho cả SUCCESS và FAILED từ Backend kèm header `Idempotency-Replayed: true|false`.
// 4. Khi `PAYMENT_IN_PROGRESS` (409) hoặc lỗi mạng/timeout: cho phép retry CÙNG `Idempotency-Key`.
// 5. Khi `FAILED` (`paymentStatus: "FAILED"`, `orderStatus: "PAYMENT_FAILED"`):
//    KHÔNG xóa Cart; lần thử thanh toán mới phải tạo `Idempotency-Key` mới.
// 6. Chỉ xóa Cart sau khi `paymentStatus === "SUCCESS"` (`orderStatus === "PAID"`).
// ============================================================================

export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;
export const CARD_NUMBER_REGEX = /^[0-9]{16}$/;
export const WALLET_PHONE_REGEX = /^[0-9]{10}$/;

/**
 * Kiểm tra chuỗi ngày/giờ có đúng chuẩn ISO 8601 UTC (bắt buộc phân cách 'T' và kết thúc bằng 'Z') theo API Contract v3.0.
 * Ngăn chặn việc chấp nhận các chuỗi parse được bằng Date.parse() nhưng sai chuẩn như "2026-10-29 10:00:00", "10/29/2026",
 * "Thu, 29 Oct 2026 10:00:00 GMT", hoặc chuỗi có offset không phải UTC như "+07:00".
 */
export function isValidIsoUtcString(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  if (trimmed !== val) return false;
  const ISO_UTC_REGEX =
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/;
  if (!ISO_UTC_REGEX.test(val)) return false;
  return Number.isFinite(Date.parse(val));
}

/**
 * Điều hướng endpoint Backend qua Next.js rewrite proxy (`/api/backend/...`) khi chạy trên trình duyệt (client-side)
 * để tránh lỗi CORS giữa frontend (cổng 3000) và backend (cổng 3001), đồng bộ với auth.service và order.service.
 */
export function resolveBackendEndpoint(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return typeof window !== "undefined"
    ? `/api/backend${normalizedPath}`
    : `${API_BASE_URL}${normalizedPath}`;
}

export interface PaymentServiceError extends Error {
  statusCode: number;
  code: PaymentErrorCode | string;
  canRetrySameKey: boolean;
  shouldGenerateNewKey: boolean;
  idempotencyKey: string;
}

function createPaymentError(
  message: string,
  statusCode: number,
  code: PaymentErrorCode | string,
  idempotencyKey: string,
  options?: { canRetrySameKey?: boolean; shouldGenerateNewKey?: boolean }
): PaymentServiceError {
  const err = new Error(message) as PaymentServiceError;
  err.statusCode = statusCode;
  err.code = code;
  err.idempotencyKey = idempotencyKey;
  err.canRetrySameKey =
    options?.canRetrySameKey ??
    (code === "PAYMENT_IN_PROGRESS" ||
      code === "NETWORK_ERROR" ||
      statusCode >= 500);
  err.shouldGenerateNewKey =
    options?.shouldGenerateNewKey ?? code === "IDEMPOTENCY_KEY_CONFLICT";
  return err;
}

/**
 * Sinh `Idempotency-Key` hợp lệ (8..64 ký tự) cho mỗi lần thử thanh toán mới (API Contract v3.0 Mục 3.1, 3.2 & 9).
 */
export function generateIdempotencyKey(prefix = "idem"): string {
  const cleanPrefix =
    prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "idem";
  const randomPartA = Math.random().toString(36).substring(2, 10);
  const randomPartB = Math.random().toString(36).substring(2, 10);
  const timePart = Date.now().toString(36);
  const candidate = `${cleanPrefix}-${timePart}-${randomPartA}${randomPartB}`;
  return candidate.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

/**
 * Kiểm tra `Idempotency-Key` tuân thủ độ dài 8..64 ký tự (API Contract v3.0 Mục 3.1 & `IdempotencyKeyPipe`).
 */
export function validateIdempotencyKey(key: unknown): {
  isValid: boolean;
  normalizedKey: string;
  errorMessage?: string;
} {
  if (typeof key !== "string") {
    return {
      isValid: false,
      normalizedKey: "",
      errorMessage: "Idempotency-Key bắt buộc phải là chuỗi ký tự (8–64 ký tự).",
    };
  }
  if (
    key.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return {
      isValid: false,
      normalizedKey: key,
      errorMessage: `Idempotency-Key phải có độ dài từ ${MIN_IDEMPOTENCY_KEY_LENGTH} đến ${MAX_IDEMPOTENCY_KEY_LENGTH} ký tự (hiện tại: ${key.length} ký tự).`,
    };
  }
  return {
    isValid: true,
    normalizedKey: key,
  };
}

/**
 * Xây dựng và chuẩn hóa payload `CreatePaymentRequestDto` đúng 100% API Contract v3.0 Mục 3.1:
 * - Chỉ giữ lại `orderId` (lowercase UUID), `method` ("CARD" | "WALLET"), và `paymentDetails`.
 * - Loại bỏ tuyệt đối mọi trường phía Client (`userId`, `amount`, `amountVnd`, `status`, `pointsEarned`, `role`, v.v.).
 * - Đảm bảo `paymentDetails` chỉ chứa duy nhất `cardNumber` (khi `method === "CARD"`) hoặc `phoneNumber` (khi `method === "WALLET"`).
 */
export function buildCreatePaymentPayload(input: {
  orderId: string;
  method: PaymentMethod;
  cardNumber?: string;
  phoneNumber?: string;
}): CreatePaymentRequestDto {
  const normalizedOrderId =
    typeof input.orderId === "string" ? input.orderId.trim().toLowerCase() : "";

  if (input.method === "CARD") {
    const cleanCard =
      typeof input.cardNumber === "string" ? input.cardNumber.trim() : "";
    return {
      orderId: normalizedOrderId,
      method: "CARD",
      paymentDetails: {
        cardNumber: cleanCard,
      },
    };
  }

  const cleanPhone =
    typeof input.phoneNumber === "string" ? input.phoneNumber.trim() : "";
  return {
    orderId: normalizedOrderId,
    method: "WALLET",
    paymentDetails: {
      phoneNumber: cleanPhone,
    },
  };
}

/**
 * Kiểm tra tính hợp lệ của `CreatePaymentRequestDto` theo đúng `CreatePaymentPipe` ở Backend và API Contract v3.0 Mục 3.1.
 */
export function validateCreatePaymentPayload(
  rawPayload: unknown,
  idempotencyKey = ""
): {
  isValid: boolean;
  payload?: CreatePaymentRequestDto;
  error?: PaymentServiceError;
} {
  if (
    !rawPayload ||
    typeof rawPayload !== "object" ||
    Array.isArray(rawPayload)
  ) {
    return {
      isValid: false,
      error: createPaymentError(
        "Dữ liệu thanh toán không hợp lệ (body phải là object).",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  const record = rawPayload as Record<string, unknown>;
  const rawOrderId =
    typeof record.orderId === "string"
      ? record.orderId.trim().toLowerCase()
      : "";

  if (!rawOrderId || !isValidUuid(rawOrderId)) {
    return {
      isValid: false,
      error: createPaymentError(
        "Mã đơn hàng (orderId) phải là UUID hợp lệ.",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  if (record.method !== "CARD" && record.method !== "WALLET") {
    return {
      isValid: false,
      error: createPaymentError(
        "Phương thức thanh toán (method) chỉ chấp nhận CARD hoặc WALLET.",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  const details = record.paymentDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {
      isValid: false,
      error: createPaymentError(
        "Thông tin chi tiết thanh toán (paymentDetails) bắt buộc phải là object.",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  const detailsRecord = details as Record<string, unknown>;

  if (record.method === "CARD") {
    if ("phoneNumber" in detailsRecord) {
      return {
        isValid: false,
        error: createPaymentError(
          "Khi chọn phương thức CARD, paymentDetails chỉ được chứa cardNumber (không được gửi phoneNumber).",
          400,
          "VALIDATION_ERROR",
          idempotencyKey,
          { canRetrySameKey: false }
        ),
      };
    }

    const cardNumber =
      typeof detailsRecord.cardNumber === "string"
        ? detailsRecord.cardNumber.trim()
        : "";
    if (!CARD_NUMBER_REGEX.test(cardNumber)) {
      return {
        isValid: false,
        error: createPaymentError(
          "Số thẻ thanh toán (cardNumber) bắt buộc phải gồm đúng 16 chữ số (0–9).",
          400,
          "VALIDATION_ERROR",
          idempotencyKey,
          { canRetrySameKey: false }
        ),
      };
    }

    return {
      isValid: true,
      payload: {
        orderId: rawOrderId,
        method: "CARD",
        paymentDetails: { cardNumber },
      },
    };
  }

  if ("cardNumber" in detailsRecord) {
    return {
      isValid: false,
      error: createPaymentError(
        "Khi chọn phương thức WALLET, paymentDetails chỉ được chứa phoneNumber (không được gửi cardNumber).",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  const phoneNumber =
    typeof detailsRecord.phoneNumber === "string"
      ? detailsRecord.phoneNumber.trim()
      : "";
  if (!WALLET_PHONE_REGEX.test(phoneNumber)) {
    return {
      isValid: false,
      error: createPaymentError(
        "Số điện thoại ví điện tử (phoneNumber) bắt buộc phải gồm đúng 10 chữ số (0–9).",
        400,
        "VALIDATION_ERROR",
        idempotencyKey,
        { canRetrySameKey: false }
      ),
    };
  }

  return {
    isValid: true,
    payload: {
      orderId: rawOrderId,
      method: "WALLET",
      paymentDetails: { phoneNumber },
    },
  };
}

export interface PaymentResponseValidationContext {
  expectedOrderId?: string | null;
  expectedMethod?: PaymentMethod | null;
  expectedMethodLast4?: string | null;
  expectedAmountVnd?: number | null;
}

/**
 * Kiểm tra trạng thái đơn hàng có được phép thanh toán theo API Contract v3.0 §3.2 hay không:
 * Chỉ cho phép `PENDING` hoặc `PAYMENT_FAILED`. Các trạng thái `PAID`, `CANCELLED`, `EXPIRED`... đều bị chặn.
 */
export function isOrderPayableStatus(
  status: unknown
): status is "PENDING" | "PAYMENT_FAILED" {
  return status === "PENDING" || status === "PAYMENT_FAILED";
}

/**
 * Kiểm tra đối tượng Order có hợp lệ và đang ở trạng thái cho phép thanh toán (`PENDING` / `PAYMENT_FAILED`) hay không.
 */
export function isOrderExpired(
  order:
    | {
        expiresAt?: string | null;
        createdAt?: string | null;
        status?: string | null;
      }
    | null
    | undefined,
  referenceNowMs: number = Date.now()
): boolean {
  if (!order || typeof order !== "object") return true;
  if (order.status === "EXPIRED") return true;

  if (typeof order.expiresAt === "string") {
    const expiresMs = Date.parse(order.expiresAt);
    if (Number.isFinite(expiresMs)) {
      return referenceNowMs >= expiresMs;
    }
  }

  return false;
}

/**
 * Kiểm tra đối tượng Order có hợp lệ và đang ở trạng thái cho phép thanh toán (`PENDING` / `PAYMENT_FAILED`) hay không.
 * Điều kiện:
 * 1. Order ID hợp lệ UUID v4.
 * 2. Trạng thái order là PENDING hoặc PAYMENT_FAILED.
 * 3. Chưa quá hạn expiresAt (hoặc createdAt + 15 phút).
 * 4. Tổng tiền totalVnd là số nguyên an toàn >= 0 (Cho phép 0 VND theo API Contract v3.0 Mục 3.2).
 */
export function isOrderPayable(
  order:
    | (Pick<CreateOrderResponseDto, "id" | "status" | "totalVnd"> &
        Partial<Pick<MyOrderDto, "expiresAt" | "createdAt">>)
    | null
    | undefined,
  overrideStatus?: OrderStatus | string | null,
  referenceNowMs: number = Date.now()
): boolean {
  if (!order || typeof order !== "object") return false;
  if (typeof order.id !== "string" || !isValidUuid(order.id.trim())) {
    return false;
  }
  const effectiveStatus = overrideStatus ?? order.status;
  if (!isOrderPayableStatus(effectiveStatus)) {
    return false;
  }
  // 1. Kiểm tra hết hạn: Order đã hết hạn expiresAt không được phép thanh toán
  if (isOrderExpired(order, referenceNowMs)) {
    return false;
  }
  // 2. Kiểm tra số tiền: Cho phép 0 VND (API Contract v3.0: Total = 0 VND vẫn đi qua Mock Payment)
  // Chỉ từ chối giá trị âm hoặc không phải safe integer
  if (
    typeof order.totalVnd !== "number" ||
    !Number.isFinite(order.totalVnd) ||
    !Number.isSafeInteger(order.totalVnd) ||
    order.totalVnd < 0
  ) {
    return false;
  }
  return true;
}

/**
 * Kiểm tra cấu trúc và tính toàn vẹn dữ liệu phản hồi `PaymentResponseDto` từ `POST /payments` (API Contract v3.0 Mục 3.3 & Mục 9).
 * Siết chặt:
 * - `paymentId` và `orderId` phải là UUID hợp lệ.
 * - Nếu truyền `expected.expectedOrderId`, `orderId` phản hồi phải khớp với đơn hàng đang thanh toán.
 * - Nếu truyền `expected.expectedAmountVnd`, `amountVnd` phản hồi phải khớp chính xác với `order.totalVnd`.
 * - Nếu truyền `expected.expectedMethod` / `expectedMethodLast4`, phải khớp với phương thức vừa gửi.
 * - Khi `paymentStatus === "SUCCESS"`: `orderStatus` phải là `"PAID"`, `failureReason` phải là `null`, và `pointsEarned === Math.floor(amountVnd / 10000)`.
 * - Khi `paymentStatus === "FAILED"`: `orderStatus` phải là `"PAYMENT_FAILED"`, `failureReason` phải là `"PAYMENT_DECLINED"`, và `pointsEarned === 0`.
 */
export function validatePaymentResponseData(
  raw: unknown,
  idempotencyKey = "",
  expected?: PaymentResponseValidationContext
): PaymentResponseDto {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createPaymentError(
      "Phản hồi từ máy chủ thanh toán không đúng định dạng object.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  const r = raw as Record<string, unknown>;
  const paymentId =
    typeof r.paymentId === "string" ? r.paymentId.trim().toLowerCase() : "";
  const orderId =
    typeof r.orderId === "string" ? r.orderId.trim().toLowerCase() : "";
  const paymentStatus = r.paymentStatus;
  const orderStatus = r.orderStatus;
  const rawAmountVnd = r.amountVnd;
  const method = r.method;
  const methodLast4 =
    typeof r.methodLast4 === "string" ? r.methodLast4.trim() : "";
  const mockReference =
    typeof r.mockReference === "string" ? r.mockReference.trim() : "";
  const rawPointsEarned = r.pointsEarned;
  const failureReason = r.failureReason;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt.trim() : "";

  if (!paymentId || !isValidUuid(paymentId)) {
    throw createPaymentError(
      "Phản hồi thanh toán thiếu hoặc sai định dạng UUID của paymentId.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (!orderId || !isValidUuid(orderId)) {
    throw createPaymentError(
      "Phản hồi thanh toán thiếu hoặc sai định dạng UUID của orderId.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    typeof expected?.expectedOrderId === "string" &&
    expected.expectedOrderId.trim()
  ) {
    const normalizedExpectedOrderId = expected.expectedOrderId
      .trim()
      .toLowerCase();
    if (orderId !== normalizedExpectedOrderId) {
      throw createPaymentError(
        `Phản hồi thanh toán có orderId (${orderId}) không khớp với đơn hàng đang thanh toán (${normalizedExpectedOrderId}).`,
        502,
        "INTERNAL_ERROR",
        idempotencyKey,
        { canRetrySameKey: true }
      );
    }
  }

  if (paymentStatus !== "SUCCESS" && paymentStatus !== "FAILED") {
    throw createPaymentError(
      `Trạng thái paymentStatus không hợp lệ: ${String(paymentStatus)}.`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (orderStatus !== "PAID" && orderStatus !== "PAYMENT_FAILED") {
    throw createPaymentError(
      `Trạng thái orderStatus không hợp lệ: ${String(orderStatus)}.`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    (paymentStatus === "SUCCESS" && orderStatus !== "PAID") ||
    (paymentStatus === "FAILED" && orderStatus !== "PAYMENT_FAILED")
  ) {
    throw createPaymentError(
      "Cặp trạng thái paymentStatus và orderStatus trong phản hồi không đồng nhất.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (method !== "CARD" && method !== "WALLET") {
    throw createPaymentError(
      `Phương thức method trong phản hồi không hợp lệ: ${String(method)}.`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    expected?.expectedMethod &&
    method !== expected.expectedMethod
  ) {
    throw createPaymentError(
      `Phương thức thanh toán trong phản hồi (${method}) không khớp với yêu cầu đã gửi (${expected.expectedMethod}).`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (!/^[0-9]{4}$/.test(methodLast4)) {
    throw createPaymentError(
      "Trường methodLast4 phải gồm đúng 4 chữ số.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    typeof expected?.expectedMethodLast4 === "string" &&
    expected.expectedMethodLast4.trim() &&
    methodLast4 !== expected.expectedMethodLast4.trim()
  ) {
    throw createPaymentError(
      `Trường methodLast4 trong phản hồi (${methodLast4}) không khớp với 4 chữ số cuối đã gửi (${expected.expectedMethodLast4.trim()}).`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    typeof rawAmountVnd !== "number" ||
    !Number.isFinite(rawAmountVnd) ||
    !Number.isSafeInteger(rawAmountVnd) ||
    rawAmountVnd < 0
  ) {
    throw createPaymentError(
      "Số tiền amountVnd trong phản hồi không hợp lệ.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }
  const amountVnd = rawAmountVnd;

  if (
    typeof expected?.expectedAmountVnd === "number" &&
    Number.isSafeInteger(expected.expectedAmountVnd) &&
    amountVnd !== expected.expectedAmountVnd
  ) {
    throw createPaymentError(
      `Số tiền thanh toán phản hồi (${amountVnd}) không khớp với tổng tiền đơn hàng (${expected.expectedAmountVnd}).`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (
    typeof rawPointsEarned !== "number" ||
    !Number.isFinite(rawPointsEarned) ||
    !Number.isSafeInteger(rawPointsEarned) ||
    rawPointsEarned < 0
  ) {
    throw createPaymentError(
      "Điểm thưởng pointsEarned trong phản hồi không hợp lệ.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }
  const pointsEarned = rawPointsEarned;

  if (failureReason !== null && failureReason !== "PAYMENT_DECLINED") {
    throw createPaymentError(
      `Trường failureReason không hợp lệ: ${String(failureReason)}.`,
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  if (paymentStatus === "SUCCESS") {
    if (failureReason !== null) {
      throw createPaymentError(
        "Phản hồi SUCCESS không hợp lệ vì có failureReason khác null.",
        502,
        "INTERNAL_ERROR",
        idempotencyKey,
        { canRetrySameKey: true }
      );
    }
    const expectedPoints = Math.floor(amountVnd / 10000);
    if (pointsEarned !== expectedPoints) {
      throw createPaymentError(
        `Điểm thưởng pointsEarned (${pointsEarned}) không khớp công thức floor(amountVnd / 10000) (${expectedPoints}).`,
        502,
        "INTERNAL_ERROR",
        idempotencyKey,
        { canRetrySameKey: true }
      );
    }
  } else {
    if (failureReason !== "PAYMENT_DECLINED") {
      throw createPaymentError(
        "Phản hồi FAILED bắt buộc phải có failureReason = PAYMENT_DECLINED.",
        502,
        "INTERNAL_ERROR",
        idempotencyKey,
        { canRetrySameKey: true }
      );
    }
    if (pointsEarned !== 0) {
      throw createPaymentError(
        "Phản hồi FAILED bắt buộc phải có pointsEarned = 0.",
        502,
        "INTERNAL_ERROR",
        idempotencyKey,
        { canRetrySameKey: true }
      );
    }
  }

  if (!mockReference || typeof createdAt !== "string" || !isValidIsoUtcString(createdAt)) {
    throw createPaymentError(
      "Phản hồi thanh toán thiếu mockReference hoặc createdAt không phải ngày ISO 8601 UTC hợp lệ.",
      502,
      "INTERNAL_ERROR",
      idempotencyKey,
      { canRetrySameKey: true }
    );
  }

  return {
    paymentId,
    orderId,
    paymentStatus,
    orderStatus,
    amountVnd,
    method,
    methodLast4,
    mockReference,
    pointsEarned,
    failureReason,
    createdAt,
  };
}

/**
 * Chuyển đổi lỗi khi gọi `POST /payments` sang `PaymentSubmissionErrorState` có thông điệp tiếng Việt rõ ràng
 * theo bảng mã lỗi API Contract v3.0 Mục 3.4.
 */
export function toPaymentSubmissionErrorState(
  err: unknown,
  fallbackIdempotencyKey = ""
): PaymentSubmissionErrorState {
  const payErr = err as Partial<PaymentServiceError>;
  const statusCode =
    typeof payErr?.statusCode === "number" ? payErr.statusCode : 500;
  const code =
    typeof payErr?.code === "string" && payErr.code.trim()
      ? payErr.code.trim()
      : "INTERNAL_ERROR";
  const idempotencyKey =
    typeof payErr?.idempotencyKey === "string" && payErr.idempotencyKey
      ? payErr.idempotencyKey
      : fallbackIdempotencyKey;

  const canRetrySameKey =
    typeof payErr?.canRetrySameKey === "boolean"
      ? payErr.canRetrySameKey
      : code === "PAYMENT_IN_PROGRESS" ||
        code === "NETWORK_ERROR" ||
        statusCode >= 500;

  const shouldGenerateNewKey =
    typeof payErr?.shouldGenerateNewKey === "boolean"
      ? payErr.shouldGenerateNewKey
      : code === "IDEMPOTENCY_KEY_CONFLICT";

  const defaultMessage = (): string => {
    switch (code) {
      case "VALIDATION_ERROR":
        return "Thông tin thanh toán hoặc Idempotency-Key không hợp lệ (400 VALIDATION_ERROR).";
      case "UNAUTHORIZED":
        return "Phiên đăng nhập thiếu hoặc đã hết hạn (401 UNAUTHORIZED). Vui lòng đăng nhập lại.";
      case "NOT_FOUND":
        return "Đơn hàng không tồn tại hoặc không thuộc tài khoản của bạn (404 NOT_FOUND).";
      case "INVALID_TRANSITION":
        return "Trạng thái đơn hàng hiện tại không cho phép thanh toán mới, đã hết hạn 15 phút hoặc đã được thanh toán thành công trước đó (409 INVALID_TRANSITION).";
      case "IDEMPOTENCY_KEY_CONFLICT":
        return "Khóa Idempotency-Key đã được dùng với thông tin thanh toán khác (409 IDEMPOTENCY_KEY_CONFLICT). Hệ thống đã tạo khóa mới để bạn thử lại.";
      case "PAYMENT_IN_PROGRESS":
        return "Giao dịch với cùng Idempotency-Key đang được xử lý trên máy chủ (409 PAYMENT_IN_PROGRESS). Bạn có thể bấm thử lại với CÙNG khóa này.";
      case "NETWORK_ERROR":
        return "Kết nối mạng đến máy chủ thanh toán bị gián đoạn. Bạn có thể bấm thử lại an toàn với CÙNG Idempotency-Key để tránh thanh toán trùng.";
      default:
        return "Máy chủ gặp sự cố ngoài dự kiến khi xử lý thanh toán (500 INTERNAL_ERROR). Bạn có thể thử lại với cùng Idempotency-Key.";
    }
  };

  const message =
    typeof payErr?.message === "string" && payErr.message.trim()
      ? payErr.message.trim()
      : defaultMessage();

  return {
    statusCode,
    code,
    message,
    canRetrySameKey,
    shouldGenerateNewKey,
    idempotencyKey,
  };
}

export interface SubmitPaymentApiResult {
  response: PaymentResponseDto;
  replayed: boolean;
  idempotencyKey: string;
}

/**
 * Gọi trực tiếp API thật `POST /payments` trên Backend theo đúng API Contract v3.0 Mục 3:
 * - Gửi header `Authorization: Bearer <accessToken>` & `Idempotency-Key: <8..64 chars>`.
 * - Body chỉ chứa `{ orderId, method, paymentDetails }`.
 * - Không sử dụng dữ liệu giả (mock fallback).
 */
export async function submitPaymentApi(
  rawPayload: CreatePaymentRequestDto,
  idempotencyKey: string,
  options?: {
    accessToken?: string | null;
    expectedOrderId?: string | null;
    expectedAmountVnd?: number | null;
  }
): Promise<SubmitPaymentApiResult> {
  const keyValidation = validateIdempotencyKey(idempotencyKey);
  if (!keyValidation.isValid) {
    throw createPaymentError(
      keyValidation.errorMessage || "Idempotency-Key không hợp lệ.",
      400,
      "VALIDATION_ERROR",
      idempotencyKey,
      { canRetrySameKey: false }
    );
  }

  const payloadValidation = validateCreatePaymentPayload(
    rawPayload,
    keyValidation.normalizedKey
  );
  if (!payloadValidation.isValid || !payloadValidation.payload) {
    throw payloadValidation.error!;
  }

  const cleanPayload = payloadValidation.payload;
  const cleanKey = keyValidation.normalizedKey;

  if (
    typeof options?.expectedOrderId === "string" &&
    options.expectedOrderId.trim() &&
    cleanPayload.orderId !== options.expectedOrderId.trim().toLowerCase()
  ) {
    throw createPaymentError(
      "orderId trong payload không khớp với đơn hàng đang được chọn thanh toán.",
      400,
      "VALIDATION_ERROR",
      cleanKey,
      { canRetrySameKey: false }
    );
  }

  const token = options?.accessToken ?? getStoredToken();
  if (!token || isTokenExpired(token)) {
    clearStoredSession();
    throw createPaymentError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại để thanh toán.",
      401,
      "UNAUTHORIZED",
      cleanKey,
      { canRetrySameKey: false }
    );
  }

  let res: Response;
  try {
    res = await fetch(resolveBackendEndpoint("/payments"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": cleanKey,
      },
      body: JSON.stringify(cleanPayload),
    });
  } catch {
    throw createPaymentError(
      "Không thể kết nối tới máy chủ thanh toán (POST /payments). Vui lòng thử lại với cùng Idempotency-Key.",
      0,
      "NETWORK_ERROR",
      cleanKey,
      { canRetrySameKey: true }
    );
  }

  if (res.status === 401) {
    clearStoredSession();
    throw createPaymentError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ (401 UNAUTHORIZED).",
      401,
      "UNAUTHORIZED",
      cleanKey,
      { canRetrySameKey: false }
    );
  }

  let bodyData: unknown = null;
  try {
    bodyData = await res.json();
  } catch {
    throw createPaymentError(
      `Phản hồi từ máy chủ không phải JSON hợp lệ (HTTP ${res.status}).`,
      res.status || 502,
      "INTERNAL_ERROR",
      cleanKey,
      { canRetrySameKey: true }
    );
  }

  if (!res.ok) {
    const errRecord =
      bodyData && typeof bodyData === "object"
        ? (bodyData as Record<string, unknown>)
        : {};
    const errCode =
      typeof errRecord.code === "string" && errRecord.code.trim()
        ? errRecord.code.trim()
        : res.status === 400
        ? "VALIDATION_ERROR"
        : res.status === 404
        ? "NOT_FOUND"
        : res.status === 409
        ? "INVALID_TRANSITION"
        : "INTERNAL_ERROR";

    const rawMsg = errRecord.message;
    const formattedMsg = Array.isArray(rawMsg)
      ? rawMsg.join("; ")
      : typeof rawMsg === "string" && rawMsg.trim()
      ? rawMsg.trim()
      : undefined;

    const mappedState = toPaymentSubmissionErrorState(
      {
        statusCode: res.status,
        code: errCode,
        message: formattedMsg,
        idempotencyKey: cleanKey,
      },
      cleanKey
    );

    throw createPaymentError(
      mappedState.message,
      mappedState.statusCode,
      mappedState.code,
      cleanKey,
      {
        canRetrySameKey: mappedState.canRetrySameKey,
        shouldGenerateNewKey: mappedState.shouldGenerateNewKey,
      }
    );
  }

  const expectedMethodLast4 =
    "cardNumber" in cleanPayload.paymentDetails
      ? cleanPayload.paymentDetails.cardNumber.slice(-4)
      : cleanPayload.paymentDetails.phoneNumber.slice(-4);

  // API Contract v3.0 Mục 3.3 & Mục 9: Kiểm tra toàn vẹn response & đối chiếu với đơn hàng đang thanh toán
  const validatedResponse = validatePaymentResponseData(bodyData, cleanKey, {
    expectedOrderId: options?.expectedOrderId ?? cleanPayload.orderId,
    expectedMethod: cleanPayload.method,
    expectedMethodLast4,
    expectedAmountVnd: options?.expectedAmountVnd,
  });
  const replayedHeader = res.headers.get("Idempotency-Replayed");
  const replayed = replayedHeader === "true";

  return {
    response: validatedResponse,
    replayed,
    idempotencyKey: cleanKey,
  };
}

/**
 * Gọi API thật `GET /orders/me` để lấy danh sách đơn hàng của khách hàng đang đăng nhập (API Contract v3.0 Mục 4).
 * Dùng để tải đúng đơn hàng cần thanh toán (theo `orderId` hoặc đơn `PENDING` / `PAYMENT_FAILED` hiện tại)
 * và hiển thị lại Confirmation từ dữ liệu đã lưu trên Server mà không gọi lại `POST /payments`.
 */
/**
 * Runtime validation cho từng OrderItemSnapshot từ `GET /orders/me`:
 */
function validateOrderItemSnapshot(raw: unknown): OrderItemSnapshotDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return null;
  if (typeof o.productId !== "string" || !isValidUuid(o.productId)) return null;
  if (typeof o.productName !== "string" || !o.productName.trim()) return null;
  if (typeof o.size !== "string" || !["S", "M", "L", "ONE_SIZE"].includes(o.size)) return null;
  if (
    typeof o.quantity !== "number" ||
    !Number.isSafeInteger(o.quantity) ||
    o.quantity < 1
  ) {
    return null;
  }
  if (
    typeof o.unitPriceVnd !== "number" ||
    !Number.isSafeInteger(o.unitPriceVnd) ||
    o.unitPriceVnd < 0
  ) {
    return null;
  }
  if (
    typeof o.lineTotalVnd !== "number" ||
    !Number.isSafeInteger(o.lineTotalVnd) ||
    o.lineTotalVnd < 0
  ) {
    return null;
  }

  const toppings = Array.isArray(o.toppings)
    ? o.toppings
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
        .map((t) => ({
          id: String(t.id || ""),
          name: String(t.name || ""),
          priceVnd: typeof t.priceVnd === "number" && t.priceVnd >= 0 ? t.priceVnd : 0,
        }))
    : [];

  return {
    id: o.id.trim(),
    productId: o.productId.trim(),
    productName: o.productName.trim(),
    size: o.size as OrderItemSnapshotDto["size"],
    sizeMultiplierPercent:
      typeof o.sizeMultiplierPercent === "number" ? o.sizeMultiplierPercent : 100,
    basePriceVnd:
      typeof o.basePriceVnd === "number" && o.basePriceVnd >= 0 ? o.basePriceVnd : 0,
    quantity: o.quantity,
    unitPriceVnd: o.unitPriceVnd,
    lineTotalVnd: o.lineTotalVnd,
    toppings,
  };
}

/**
 * Runtime validation cho PaymentSnapshot từ `GET /orders/me`:
 * - Không bao giờ tự mặc định/coerce trường sai sang `"CARD"`, `null` hoặc giá trị khác.
 * - Mọi trường bắt buộc phải tồn tại, đúng kiểu, đúng enum và đúng quy tắc nullable của API Contract v3.0 §4.2.
 */
export function validatePaymentSnapshot(raw: unknown): MyOrderPaymentSummaryDto | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !isValidUuid(p.id.trim())) return null;
  if (p.status !== "SUCCESS" && p.status !== "FAILED") return null;
  if (p.method !== "CARD" && p.method !== "WALLET" && p.method !== "VNPAY" && p.method !== "ZERO_AMOUNT") return null;

  if (!("methodLast4" in p) || p.methodLast4 === undefined) return null;
  if (
    p.methodLast4 !== null &&
    (typeof p.methodLast4 !== "string" || !/^[0-9]{4}$/.test(p.methodLast4))
  ) {
    return null;
  }

  if (
    typeof p.amountVnd !== "number" ||
    !Number.isSafeInteger(p.amountVnd) ||
    p.amountVnd < 0
  ) {
    return null;
  }

  if (!("mockReference" in p) || p.mockReference === undefined) return null;
  if (
    p.mockReference !== null &&
    (typeof p.mockReference !== "string" || !p.mockReference.trim())
  ) {
    return null;
  }

  if (!("failureReason" in p) || p.failureReason === undefined) return null;
  if (p.failureReason !== null && p.failureReason !== "PAYMENT_DECLINED") {
    return null;
  }

  if (typeof p.createdAt !== "string" || !isValidIsoUtcString(p.createdAt)) return null;
  const createdAtMs = Date.parse(p.createdAt);

  return {
    id: p.id.trim(),
    status: p.status,
    method: p.method,
    methodLast4: p.methodLast4,
    amountVnd: p.amountVnd,
    mockReference: typeof p.mockReference === "string" ? p.mockReference.trim() : null,
    failureReason: p.failureReason,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/**
 * Runtime validation cho từng Order từ `GET /orders/me`:
 */
export function validateMyOrderSnapshot(raw: unknown): MyOrderDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string" || !isValidUuid(o.id)) return null;

  const validStatuses = [
    "PENDING",
    "PAYMENT_FAILED",
    "PAID",
    "PREPARING",
    "READY",
    "COMPLETED",
    "CANCELLED",
  ];
  if (typeof o.status !== "string" || !validStatuses.includes(o.status)) return null;

  if (typeof o.createdAt !== "string" || !isValidIsoUtcString(o.createdAt)) return null;
  const createdMs = Date.parse(o.createdAt);

  if (typeof o.expiresAt !== "string" || !isValidIsoUtcString(o.expiresAt)) return null;
  const expiresMs = Date.parse(o.expiresAt);
  const expiresAtIso = new Date(expiresMs).toISOString();

  if (
    typeof o.subtotalVnd !== "number" ||
    !Number.isSafeInteger(o.subtotalVnd) ||
    o.subtotalVnd < 0 ||
    typeof o.discountVnd !== "number" ||
    !Number.isSafeInteger(o.discountVnd) ||
    o.discountVnd < 0 ||
    typeof o.totalVnd !== "number" ||
    !Number.isSafeInteger(o.totalVnd) ||
    o.totalVnd < 0
  ) {
    return null;
  }

  if (!Array.isArray(o.items)) return null;
  const validItems: OrderItemSnapshotDto[] = [];
  for (const it of o.items) {
    const validIt = validateOrderItemSnapshot(it);
    if (!validIt) return null;
    validItems.push(validIt);
  }

  if (!("payment" in o) || o.payment === undefined) {
    return null;
  }

  let payment: MyOrderPaymentSummaryDto | null = null;
  if (o.payment !== null) {
    payment = validatePaymentSnapshot(o.payment);
    if (!payment) return null;
  }

  return {
    id: o.id.trim(),
    status: o.status as OrderStatus,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: expiresAtIso,
    subtotalVnd: o.subtotalVnd,
    discountVnd: o.discountVnd,
    totalVnd: o.totalVnd,
    couponCode: typeof o.couponCode === "string" && o.couponCode.trim() ? o.couponCode.trim() : null,
    pointsEarned: typeof o.pointsEarned === "number" && o.pointsEarned >= 0 ? o.pointsEarned : 0,
    items: validItems,
    payment,
  };
}

/**
 * Runtime validation cho toàn bộ phản hồi `GET /orders/me`:
 * Đảm bảo phản hồi 200 nhưng malformed (ví dụ items bị null, id sai UUID, totals âm/NaN)
 * sẽ bị phát hiện và báo lỗi ngay, không làm trang web crash hoặc sử dụng dữ liệu sai.
 */
export function validateMyOrdersResponse(raw: unknown): GetMyOrdersResponseDto {
  if (!raw || typeof raw !== "object") {
    throw createPaymentError(
      "Phản hồi GET /orders/me không phải là một đối tượng JSON hợp lệ.",
      502,
      "INTERNAL_ERROR",
      "",
      { canRetrySameKey: false }
    );
  }

  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.items)) {
    throw createPaymentError(
      "Phản hồi GET /orders/me thiếu danh sách items hoặc items không phải là mảng.",
      502,
      "INTERNAL_ERROR",
      "",
      { canRetrySameKey: false }
    );
  }

  const validatedOrders: MyOrderDto[] = [];
  for (const rawOrder of root.items) {
    const validated = validateMyOrderSnapshot(rawOrder);
    if (!validated) {
      throw createPaymentError(
        "Phản hồi GET /orders/me chứa dữ liệu đơn hàng bị sai lệch hoặc thiếu trường bắt buộc (malformed order snapshot).",
        502,
        "INTERNAL_ERROR",
        "",
        { canRetrySameKey: false }
      );
    }
    validatedOrders.push(validated);
  }

  const rawMeta =
    root.meta && typeof root.meta === "object"
      ? (root.meta as Record<string, unknown>)
      : null;

  const meta: MyOrdersMetaDto = rawMeta
    ? {
        page: typeof rawMeta.page === "number" ? rawMeta.page : null,
        limit: typeof rawMeta.limit === "number" ? rawMeta.limit : null,
        total:
          typeof rawMeta.total === "number"
            ? rawMeta.total
            : validatedOrders.length,
        totalPages:
          typeof rawMeta.totalPages === "number" ? rawMeta.totalPages : null,
      }
    : {
        page: null,
        limit: null,
        total: validatedOrders.length,
        totalPages: null,
      };

  return {
    items: validatedOrders,
    meta,
  };
}

export async function fetchMyOrdersApi(
  accessToken?: string | null
): Promise<GetMyOrdersResponseDto> {
  const token = accessToken ?? getStoredToken();
  if (!token || isTokenExpired(token)) {
    clearStoredSession();
    throw createPaymentError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ (401 UNAUTHORIZED).",
      401,
      "UNAUTHORIZED",
      "",
      { canRetrySameKey: false }
    );
  }

  let res: Response;
  try {
    res = await fetch(resolveBackendEndpoint("/orders/me"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw createPaymentError(
      "Không thể kết nối tới máy chủ để tải danh sách đơn hàng (GET /orders/me).",
      0,
      "NETWORK_ERROR",
      "",
      { canRetrySameKey: false }
    );
  }

  if (res.status === 401) {
    clearStoredSession();
    throw createPaymentError(
      "Phiên đăng nhập đã hết hạn hoặc không hợp lệ (401 UNAUTHORIZED).",
      401,
      "UNAUTHORIZED",
      "",
      { canRetrySameKey: false }
    );
  }

  if (!res.ok) {
    throw createPaymentError(
      `Không thể tải dữ liệu đơn hàng từ máy chủ (HTTP ${res.status}).`,
      res.status,
      "INTERNAL_ERROR",
      "",
      { canRetrySameKey: false }
    );
  }

  let rawData: unknown;
  try {
    rawData = await res.json();
  } catch {
    throw createPaymentError(
      "Phản hồi danh sách đơn hàng từ máy chủ không phải JSON hợp lệ.",
      502,
      "INTERNAL_ERROR",
      "",
      { canRetrySameKey: false }
    );
  }

  return validateMyOrdersResponse(rawData);
}

/**
 * Tìm đơn hàng mục tiêu từ kết quả `GET /orders/me`:
 * - Nếu có `targetOrderId`: tìm đúng Order có `id === targetOrderId`.
 * - Nếu không truyền `targetOrderId`: ưu tiên lấy Order đang active (`PENDING` hoặc `PAYMENT_FAILED`).
 */
export function selectTargetOrderFromMyOrders(
  orders: MyOrderDto[],
  targetOrderId?: string | null
): MyOrderDto | null {
  if (!Array.isArray(orders) || orders.length === 0) return null;

  const normalizedTarget =
    typeof targetOrderId === "string" ? targetOrderId.trim().toLowerCase() : "";

  if (normalizedTarget) {
    const matched = orders.find(
      (o) => o.id && o.id.trim().toLowerCase() === normalizedTarget
    );
    if (matched) return matched;
  }

  // Ưu tiên đơn hàng đang chờ thanh toán (PENDING hoặc PAYMENT_FAILED)
  const activePayable = orders.find(
    (o) => o.status === "PENDING" || o.status === "PAYMENT_FAILED"
  );
  if (activePayable) return activePayable;

  return null;
}

/**
 * Lấy thông tin hồ sơ & điểm tích lũy hiện tại từ `GET /auth/me` (API Contract v3.0 Mục 8).
 */
export async function fetchAuthMeProfile(
  accessToken?: string | null
): Promise<AuthMeResponseDto | null> {
  const token = accessToken ?? getStoredToken();
  if (!token) return null;

  try {
    const res = await fetch(resolveBackendEndpoint("/auth/me"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (
      typeof data?.id === "string" &&
      typeof data?.email === "string" &&
      typeof data?.loyaltyPoints === "number"
    ) {
      return {
        id: data.id,
        email: data.email,
        fullName: typeof data.fullName === "string" ? data.fullName : null,
        loyaltyPoints: data.loyaltyPoints,
      };
    }
    return null;
  } catch {
    return null;
  }
}
