// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU (TYPES / INTERFACES) CHO BREWLITE FRONTEND
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v2.1.md (Mục 2, 3, 4, 5, 6, 7)
// - backend/prisma/schema.prisma & migrations
// - database/schema.dbml & live PostgreSQL `users` table
// ============================================================================

export type CategoryId =
  | "all"
  | "traditional"
  | "espresso_coldbrew"
  | "tea_macchiato"
  | "bakery"
  // Legacy aliases for backward compatibility with mock & SCRUM-32
  | "espresso"
  | "tea";

export interface CategoryOption {
  id: CategoryId;
  label: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface ProductCategory {
  code: string;
  name: string;
  isActive?: boolean;
}

/**
 * Kích cỡ đồ uống hợp lệ theo API Contract v2.1 Mục 2.3, 4.4 & BR-011:
 * - S: 100% giá gốc (Mặc định cho STANDARD)
 * - M: 120% giá gốc
 * - L: 140% giá gốc
 * - ONE_SIZE: 100% giá gốc
 */
export type DrinkSize = "S" | "M" | "L" | "ONE_SIZE";

export type ProductSizePolicy = "STANDARD" | "ONE_SIZE";

export type SizeMultiplierPercent = 100 | 120 | 140;

/**
 * 1 phần tử đồ uống trả về từ `GET /products` (API Contract v2.1 Mục 3.3)
 */
export interface ProductListItem {
  /** UUID v4 của sản phẩm */
  id: string;
  /** Tên hiển thị của đồ uống */
  name: string;
  /** Đường dẫn ảnh sản phẩm (API Contract Mục 2.3 & 3.3) */
  imageUrl: string;
  /** Giá gốc ứng với Size S / ONE_SIZE (100%), số nguyên VND */
  basePriceVnd: number;
  /** true = còn hàng và danh mục đang hoạt động, false = hết hàng hoặc ngừng kinh doanh */
  isAvailable: boolean;

  /** Danh mục đồ uống: hỗ trợ object {code, name} từ API v2.1 và string mã danh mục từ mock */
  category?: ProductCategory | CategoryId | string;
  /** Mô tả chi tiết (nullable theo API Contract v2.1) */
  description?: string | null;
  /** Điểm đánh giá (hỗ trợ number/null theo v2.1 và string từ mock) */
  rating?: number | string | null;
  /** Badge sản phẩm mới */
  isNew?: boolean;
  /** Badge bán chạy */
  isBestseller?: boolean;

  // Các trường UI bổ trợ (tương thích với mock-data và SCRUM-32)
  reviews?: string;
  badge?: "Best Seller" | "Mới" | string;
  imageAlt?: string;
  originBadge?: string;
  recipeTag?: string;
  servingNote?: string;
  flavorNotes?: string;
  intensity?: string;
  beanType?: string;
  processMethod?: string;
  sustainabilityNote?: string;
}

/** Alias tương thích cho các component gọi ProductItem */
export type ProductItem = ProductListItem;

/**
 * Response 200 OK của `GET /products` (API Contract v2.1 Mục 3.3)
 */
export interface ProductListResponse {
  items: ProductListItem[];
}

/**
 * Cấu hình kích cỡ trong `GET /products/:id` (API Contract v2.1 Mục 4.3)
 */
export interface ProductSizeOption {
  size: DrinkSize;
  multiplierPercent: number;
}

/**
 * Cấu hình topping trong `GET /products/:id` và seed.ts (API Contract v2.1 Mục 4.3)
 */
export interface ToppingOption {
  id: string;
  code?: string;
  name: string;
  priceVnd: number;
  isAvailable?: boolean;
}

/**
 * Response 200 OK của `GET /products/:id` (API Contract v2.1 Mục 4.3)
 */
export interface ProductDetail extends ProductListItem {
  sizePolicy?: ProductSizePolicy;
  sizes: ProductSizeOption[];
  toppings: ToppingOption[];
}

/**
 * Cấu trúc lỗi HTTP chuẩn NestJS & API Contract v2.1 Mục 5.1 & 5.2
 */
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error?: string;
  code?: string;
}

// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU USER & AUTH (SPRINT 2 — SCRUM-41)
// Khớp 100% với Database table `users`, schema.prisma & API Contract v2.1:
// 1. id: UUID (PK, NOT NULL)
// 2. email: VARCHAR(255) (UNIQUE, lowercase + trim, NOT NULL)
// 3. passwordHash / password_hash: VARCHAR(255) (Argon2id hash, NOT NULL)
// 4. fullName / full_name: VARCHAR(255) (Nullable)
// 5. loyaltyPoints / loyalty_points: INTEGER (DEFAULT 0, CHECK >= 0, NOT NULL)
// 6. createdAt / created_at: TIMESTAMPTZ (DEFAULT CURRENT_TIMESTAMP, NOT NULL)
// 7. updatedAt / updated_at: TIMESTAMPTZ (DEFAULT CURRENT_TIMESTAMP, NOT NULL)
// ============================================================================

export interface DatabaseUser {
  /** UUID v4 của người dùng (Khoá chính, NOT NULL) */
  id: string;
  /** Địa chỉ email đăng nhập (Duy nhất, đã chuẩn hoá lowercase và trim, NOT NULL) */
  email: string;
  /** Chuỗi hash mật khẩu theo thuật toán Argon2id (không lưu plaintext, NOT NULL) */
  passwordHash: string;
  /** Tên đầy đủ hiển thị (tuỳ chọn, NULLABLE) */
  fullName: string | null;
  /** Điểm tích luỹ thành viên (mặc định 0, CHECK >= 0, NOT NULL) */
  loyaltyPoints: number;
  /** Thời điểm tạo tài khoản (ISO 8601 string, DEFAULT NOW()) */
  createdAt: string;
  /** Thời điểm cập nhật tài khoản gần nhất (ISO 8601 string, DEFAULT NOW()) */
  updatedAt: string;

  // Thuộc tính ánh xạ trực tiếp theo tên cột SQL snake_case trong database PostgreSQL
  password_hash?: string;
  full_name?: string | null;
  loyalty_points?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Thông tin User an toàn trong Client State / AuthContext / LocalStorage.
 * TUYỆT ĐỐI KHÔNG chứa passwordHash hay password_hash trên Client.
 */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
}

/** Payload gửi lên khi đăng ký (API Contract v2.1 Mục 6.2) */
export interface RegisterRequestDto {
  email: string;
  password: string;
  fullName?: string;
}

/** Response trả về khi đăng ký thành công HTTP 201 (API Contract v2.1 Mục 6.3) */
export interface RegisterResponseDto {
  id: string;
  email: string;
  fullName: string | null;
}

/** Payload gửi lên khi đăng nhập (API Contract v2.1 Mục 7.2) */
export interface LoginRequestDto {
  email: string;
  password: string;
}

/** Response trả về khi đăng nhập thành công HTTP 200 (API Contract v2.1 Mục 7.3) */
export interface LoginResponseDto {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

/** Mã lỗi định danh theo API Contract v2.1 Mục 5.3 */
export type AuthErrorCode =
  | "VALIDATION_ERROR"
  | "EMAIL_ALREADY_EXISTS"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED";

export interface AuthErrorResponse extends ApiErrorResponse {
  code: AuthErrorCode | string;
}

// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU ORDER & CHECKOUT (SPRINT 2 & 3 — SCRUM-43 & SCRUM-44)
// Khớp 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md & Appendix A (v2.1 Mục 5.3, 8, 9)
// - database/schema.dbml & backend/prisma/schema.prisma
// - backend/src/orders/dto/create-order.dto.ts & create-order-response.dto.ts
// ============================================================================

export type OrderStatus =
  | "PENDING"
  | "PAYMENT_FAILED"
  | "PAID"
  | "PREPARING"
  | "READY"
  | "COMPLETED"
  | "CANCELLED";

/**
 * Từng dòng món trong payload gửi lên `POST /orders` (API Contract v2.1 Mục 8.2 & 9.3)
 * TUYỆT ĐỐI KHÔNG chứa userId, status, price, unitPriceVnd, lineTotalVnd, subtotalVnd, discountVnd, totalVnd
 */
export interface CreateOrderItemDto {
  productId: string;
  size: DrinkSize;
  toppingIds: string[];
  quantity: number;
}

/**
 * Payload gửi lên `POST /orders` (API Contract v2.1 Mục 8.2 & 9.3)
 */
export interface CreateOrderRequestDto {
  items: CreateOrderItemDto[];
  couponCode?: string;
}

/**
 * Snapshot Topping trong OrderItem trả về từ `POST /orders` (API Contract v2.1 Mục 8.6)
 */
export interface OrderToppingSnapshotDto {
  id: string;
  name: string;
  priceVnd: number;
}

/**
 * Snapshot từng dòng OrderItem trả về từ `POST /orders` (API Contract v2.1 Mục 8.6)
 */
export interface OrderItemSnapshotDto {
  id: string;
  productId: string;
  productName: string;
  size: DrinkSize;
  sizeMultiplierPercent: number;
  basePriceVnd: number;
  quantity: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  toppings: OrderToppingSnapshotDto[];
}

/**
 * Response 201 Created của `POST /orders` (API Contract v2.1 Mục 8.6 & v3.0)
 */
export interface CreateOrderResponseDto {
  id: string;
  status: OrderStatus;
  items: OrderItemSnapshotDto[];
  couponCode: string | null;
  subtotalVnd: number;
  discountVnd: number;
  totalVnd: number;
  createdAt: string;
}

/**
 * Các lý do chi tiết của lỗi `INVALID_CART` (API Contract v2.1 Mục 8.3.1 & 8.7)
 */
export type InvalidCartReason =
  | "DUPLICATE_CONFIGURATION"
  | "DUPLICATE_TOPPING"
  | "PRODUCT_NOT_FOUND"
  | "TOPPING_NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "INVALID_SIZE"
  | "TOPPING_NOT_ALLOWED"
  | "TOPPING_UNAVAILABLE"
  | "TOO_MANY_TOPPINGS"
  | "INVALID_PRICE_DATA";

export interface InvalidCartDetail {
  productId?: string;
  itemIndex?: number;
  reason: InvalidCartReason | string;
}

export interface InsufficientStockDetail {
  productId: string;
  requestedQuantity: number;
  availableQuantity: number;
}

export type OrderErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CART"
  | "INVALID_COUPON"
  | "COUPON_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INSUFFICIENT_STOCK"
  | "PENDING_ORDER_EXISTS"
  | "SERVER_ERROR"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface OrderApiErrorResponse extends ApiErrorResponse {
  code: OrderErrorCode | string;
  details?: InvalidCartDetail[] | InsufficientStockDetail[] | unknown;
}

/**
 * Cấu trúc trạng thái lỗi đã chuẩn hóa khi tích hợp Cart với Order flow (SCRUM-44)
 */
export interface OrderSubmissionErrorState {
  statusCode: number;
  code: OrderErrorCode | string;
  message: string;
  isOutcomeUncertain: boolean;
  detailLines: string[];
  details?: InvalidCartDetail[] | InsufficientStockDetail[] | unknown;
}

// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU ORDER HISTORY (`GET /orders/me` — SPRINT 3 SCRUM-64)
// Khớp 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md §4 (`GET /orders/me`) & §9
// - backend/src/orders/dto/get-my-orders-query.dto.ts
// - backend/src/orders/dto/get-my-orders-response.dto.ts
// - database/schema.dbml (`orders`, `order_items`, `order_item_toppings`, `payments`)
// ============================================================================

// PaymentMethod & PaymentStatus are defined above

/**
 * Thông tin tóm tắt giao dịch thanh toán gắn với Order trong `GET /orders/me`
 * (API Contract v3.0 §4.2 — `OrderPaymentSummaryDto`)
 * TUYỆT ĐỐI KHÔNG chứa dữ liệu nhạy cảm (số thẻ đầy đủ, CVV, PIN); chỉ hiển thị `methodLast4` và `mockReference`.
 */
export interface OrderPaymentSummaryDto {
  id: string;
  status: PaymentStatus;
  method: PaymentMethod;
  methodLast4: string | null;
  amountVnd: number;
  mockReference: string | null;
  failureReason: string | null;
  createdAt: string;
}

/**
 * Từng phần tử đơn hàng trong danh sách `GET /orders/me`
 * (API Contract v3.0 §4.2 — `MyOrderItemDto`)
 */
export interface OrderHistoryItemDto {
  id: string;
  status: OrderStatus;
  createdAt: string;
  /** Thời điểm hết hạn giữ chỗ 15 phút (ISO 8601 string, NOT NULL theo ERD & API Contract v3.0 §4.2) */
  expiresAt: string;
  subtotalVnd: number;
  discountVnd: number;
  totalVnd: number;
  couponCode: string | null;
  /** Điểm tích lũy đã ghi nhận trên Order (số nguyên >= 0; = 0 với đơn chưa thanh toán) */
  pointsEarned: number;
  items: OrderItemSnapshotDto[];
  payment: OrderPaymentSummaryDto | null;
}

export type MyOrderItemDto = OrderHistoryItemDto;

/**
 * Siêu dữ liệu phân trang của `GET /orders/me` (API Contract v3.0 §4.1 & §4.2)
 * - Khi không truyền `page` & `limit`: `{ page: null, limit: null, total: N, totalPages: null }`
 * - Khi truyền đủ cả `page` & `limit`: `{ page, limit, total, totalPages: ceil(total/limit) }` (`0` nếu `total === 0`)
 */
export interface OrderHistoryMetaDto {
  page: number | null;
  limit: number | null;
  total: number;
  totalPages: number | null;
}

/**
 * Tham số truy vấn `GET /orders/me` (API Contract v3.0 §4.1)
 * Quy tắc: Hoặc truyền CẢ HAI `page` (>= 1) và `limit` (1..100), hoặc KHÔNG truyền tham số nào.
 */
export interface GetMyOrdersQueryParams {
  page?: number;
  limit?: number;
}

/**
 * Response 200 OK của `GET /orders/me` (API Contract v3.0 §4.2)
 */
export interface GetMyOrdersResponseDto {
  items: OrderHistoryItemDto[];
  meta: OrderHistoryMetaDto;
}

export interface UserProfile {
  id: string;
  fullName: string;
  memberCode: string;
  memberSince: string;
  tierName: string;
  tierBadge: string;
  nextTierName: string;
  points: number;
  nextTierPoints: number;
  savedThisMonth: number;
  avatarUrl: string;
  nextTierPerksSummary: string;
  equivalentRewardHint: string;
}

export interface HeroBannerData {
  seasonBadge: string;
  roastSubtitle: string;
  headlineLine1: string;
  headlineHighlight: string;
  description: string;
  featuredLabel: string;
  featuredDrinkName: string;
  featuredPromoText: string;
}

export interface BranchInfo {
  id: string;
  name: string;
  address: string;
}

export interface QuickLink {
  label: string;
  href: string;
}

export interface SiteConfigData {
  brandName: string;
  logoUrl: string;
  selectedBranch: string;
  searchPlaceholder: string;
  hotline: string;
  brandStory: string;
  copyright: string;
  tagline: string;
  deliveryHighlight: string;
  totalCatalogCount: number;
  branches: BranchInfo[];
  quickLinks: QuickLink[];
}


// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU PAYMENT & PROFILE (SPRINT 3 — SCRUM-67 / API CONTRACT v3.0)
// Khớp 100% với:
// - docs/api/BrewLite_API_Contract_v3.0.md (Mục 3: POST /payments, Mục 8: GET /auth/me, Mục 9)
// - backend/src/payments/dto/create-payment.dto.ts & payment-response.dto.ts
// ============================================================================

export type PaymentMethod = "CARD" | "WALLET" | "VNPAY" | "ZERO_AMOUNT";

export type PaymentStatus = "SUCCESS" | "FAILED";

export type PaymentOrderStatus = "PAID" | "PAYMENT_FAILED";

export type PaymentFailureReason = "PAYMENT_DECLINED" | null;

/** Thông tin chi tiết khi method = "CARD" (chỉ gồm cardNumber đúng 16 chữ số) */
export interface CardPaymentDetailsDto {
  cardNumber: string;
}

/** Thông tin chi tiết khi method = "WALLET" (chỉ gồm phoneNumber đúng 10 chữ số) */
export interface WalletPaymentDetailsDto {
  phoneNumber: string;
}

/**
 * Payload gửi lên `POST /payments` (API Contract v3.0 Mục 3.1)
 * Header bắt buộc: `Authorization: Bearer <JWT>` & `Idempotency-Key: <8..64 ký tự>`
 * TUYỆT ĐỐI KHÔNG gửi userId, amount, amountVnd, status, paymentStatus, orderStatus, pointsEarned, role
 */
export type CreatePaymentRequestDto =
  | {
      orderId: string;
      method: "CARD";
      paymentDetails: CardPaymentDetailsDto;
    }
  | {
      orderId: string;
      method: "WALLET";
      paymentDetails: WalletPaymentDetailsDto;
    };

/**
 * Response HTTP 200 của `POST /payments` cho cả Mock SUCCESS và Mock FAILED (API Contract v3.0 Mục 3.3)
 */
export interface PaymentResponseDto {
  paymentId: string;
  orderId: string;
  paymentStatus: PaymentStatus;
  orderStatus: PaymentOrderStatus;
  amountVnd: number;
  method: PaymentMethod;
  methodLast4: string;
  mockReference: string;
  pointsEarned: number;
  failureReason: PaymentFailureReason;
  createdAt: string;
}

/**
 * Mã lỗi HTTP của `POST /payments` theo API Contract v3.0 Mục 3.4
 */
export type PaymentErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "PAYMENT_IN_PROGRESS"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface PaymentApiErrorResponse extends ApiErrorResponse {
  code: PaymentErrorCode | string;
}

/**
 * Cấu trúc trạng thái lỗi khi gọi `POST /payments` trên Payment UI (API Contract v3.0 Mục 3.2, 3.4 & 9)
 */
export interface PaymentSubmissionErrorState {
  statusCode: number;
  code: PaymentErrorCode | string;
  message: string;
  /** true khi gặp 409 PAYMENT_IN_PROGRESS hoặc timeout/network error — được phép retry CÙNG Idempotency-Key */
  canRetrySameKey: boolean;
  /** true khi gặp 409 IDEMPOTENCY_KEY_CONFLICT — cần tạo Idempotency-Key mới cho lần thử mới */
  shouldGenerateNewKey: boolean;
  idempotencyKey: string;
}

/**
 * Response HTTP 200 của `GET /auth/me` (API Contract v3.0 Mục 8)
 */
export interface AuthMeResponseDto {
  id: string;
  email: string;
  fullName: string | null;
  loyaltyPoints: number;
}


/**
 * Snapshot Payment đại diện trên từng Order trong `GET /orders/me` (API Contract v3.0 Mục 4.2)
 */
export type MyOrderPaymentSummaryDto = OrderPaymentSummaryDto;

/**
 * Từng Order trả về trong danh sách `GET /orders/me` (API Contract v3.0 Mục 4.2)
 */
export type MyOrderDto = OrderHistoryItemDto;

export type MyOrdersMetaDto = OrderHistoryMetaDto;
