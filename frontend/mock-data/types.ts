// ============================================================================
// ĐỊNH NGHĨA KIỂU DỮ LIỆU (TYPES / INTERFACES) CHO BREWLITE FRONTEND
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v1.0.md (Mục 2, 3, 4, 5.1)
// - docs/api/BrewLite_API_Contract_v2.0.md (Mục 3, 4, 5, 6, 7, 8)
// - docs/api/BrewLite_API_Contract_v2.1.md (Mục 2.5, 5.2, 5.3, 6, 7, 9.2)
// ============================================================================

export type CategoryId =
  | "all"
  | "traditional"
  | "espresso"
  | "tea"
  | "bakery";

export interface CategoryOption {
  id: CategoryId;
  label: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Kích cỡ đồ uống hợp lệ theo API Contract Mục 4.2 & BR-011:
 * - S: 100% giá gốc (Mặc định)
 * - M: 120% giá gốc
 * - L: 140% giá gốc
 */
export type DrinkSize = "S" | "M" | "L";

export type SizeMultiplierPercent = 100 | 120 | 140;

/**
 * 1 phần tử đồ uống trả về từ `GET /products` (API Contract Mục 3.2 & 5.1)
 */
export interface ProductListItem {
  /** UUID v4 của sản phẩm */
  id: string;
  /** Tên hiển thị của đồ uống */
  name: string;
  /** Đường dẫn ảnh sản phẩm (API Contract Mục 3.2) */
  imageUrl: string;
  /** Giá gốc ứng với Size S (100%), số nguyên VND > 0 */
  basePriceVnd: number;
  /** `true` = còn hàng, `false` = tạm hết hàng (US-CAT-04) */
  isAvailable: boolean;

  // Các trường UI bổ trợ (optional để không bắt buộc Backend phải trả về)
  category?: CategoryId;
  rating?: string;
  reviews?: string;
  description?: string;
  badge?: "Best Seller" | "Mới";
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
 * Response 200 OK của `GET /products` (API Contract Mục 3.3 & 3.7)
 */
export interface ProductListResponse {
  items: ProductListItem[];
}

/**
 * Cấu hình kích cỡ trong `GET /products/:id` (API Contract Mục 4.2 & 5.1)
 */
export interface ProductSizeOption {
  size: DrinkSize;
  multiplierPercent: SizeMultiplierPercent;
}

/**
 * Cấu hình topping trong `GET /products/:id` (API Contract Mục 4.2 & 5.1)
 */
export interface ToppingOption {
  id: string;
  name: string;
  priceVnd: number;
  isAvailable?: boolean;
}

/**
 * Response 200 OK của `GET /products/:id` (API Contract Mục 4.2 & 4.4)
 */
export interface ProductDetail extends ProductListItem {
  sizes: ProductSizeOption[];
  toppings: ToppingOption[];
}

/**
 * Cấu trúc lỗi HTTP mặc định của NestJS (API Contract Mục 1.4 & 5.1)
 */
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error?: string;
}

// ============================================================================
// KIỂU DỮ LIỆU AUTHENTICATION (LOGIN & REGISTER) — API CONTRACT v2.1 (MỤC 5, 6, 7)
// ============================================================================

export type AuthMode = "login" | "register";

/**
 * Mã lỗi nghiệp vụ Sprint 2 cho Authentication (API Contract v2.1 Mục 5.3)
 */
export type AuthErrorCode =
  | "VALIDATION_ERROR"
  | "EMAIL_ALREADY_EXISTS"
  | "INVALID_CREDENTIALS"
  | "UNAUTHORIZED";

/**
 * Cấu trúc lỗi mở rộng Sprint 2 có trường `code` (API Contract v2.1 Mục 5.2)
 */
export interface AuthApiErrorResponse {
  statusCode: 400 | 401 | 409 | 500;
  message: string | string[];
  error: "Bad Request" | "Unauthorized" | "Conflict" | "Internal Server Error";
  code?: AuthErrorCode;
}

/**
 * Request body của `POST /auth/register` (API Contract v2.1 Mục 6.2):
 * - `email`: bắt buộc, định dạng email hợp lệ, trim/lowercase, tối đa 255 ký tự
 * - `password`: bắt buộc, tối thiểu 8 ký tự (KHÔNG trim/normalize trước khi hash)
 * - `fullName`: không bắt buộc, tối đa 255 ký tự
 * - Tuyệt đối không gửi `role`, `loyaltyPoints`, `passwordHash`
 */
export interface RegisterRequestDto {
  email: string;
  password: string;
  fullName?: string;
}

/**
 * Response 201 Created của `POST /auth/register` (API Contract v2.1 Mục 6.3):
 * - Chỉ trả `id`, `email`, `fullName`
 * - Không tự động login hoặc trả `accessToken`, `password`, `passwordHash`, `role`, `loyaltyPoints`
 */
export interface RegisterResponseDto {
  id: string;
  email: string;
  fullName: string | null;
}

/**
 * Request body của `POST /auth/login` (API Contract v2.1 Mục 7.2):
 * - `email`: bắt buộc, chuẩn hóa trim/lowercase
 * - `password`: bắt buộc, non-empty (KHÔNG trim/normalize trước khi verify)
 */
export interface LoginRequestDto {
  email: string;
  password: string;
}

/**
 * Response 200 OK của `POST /auth/login` (API Contract v2.1 Mục 7.3):
 * - `accessToken`: JWT chứa `sub = User UUID`
 * - `tokenType`: `"Bearer"`
 * - `expiresIn`: `3600` (60 phút)
 */
export interface LoginResponseDto {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: 3600;
}

/**
 * Bản ghi tài khoản mẫu trong Mock Data phục vụ kiểm thử UI Login / Register (SCRUM-41)
 */
export interface MockRegisteredUser {
  id: string;
  email: string;
  password: string;
  fullName: string | null;
  note?: string;
}

/**
 * Cấu hình nội dung giao diện trang Đăng nhập & Đăng ký theo thiết kế Stitch
 */
export interface AuthUiConfig {
  brandTitle: string;
  brandHighlight: string;
  backToMenuLabel: string;
  roastBadge: string;
  loginHeading: string;
  loginSubheading: string;
  registerHeading: string;
  registerSubheading: string;
  emailMaxLength: number;
  fullNameMaxLength: number;
  passwordMinLength: number;
  jwtExpiresInSeconds: 3600;
  trustNote: string;
  footerCopyright: string;
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
