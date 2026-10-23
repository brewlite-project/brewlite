import {
  AUTH_VALIDATION_RULES,
  MOCK_CATEGORIES,
  MOCK_HERO_BANNER,
  MOCK_PRICE_FILTER_OPTIONS,
  MOCK_PRODUCT_DETAILS,
  MOCK_PRODUCTS_RESPONSE,
  MOCK_REGISTERED_USERS,
  MOCK_SITE_CONFIG,
  MOCK_SORT_OPTIONS,
  type AuthApiErrorResponse,
  type CategoryOption,
  type DrinkSize,
  type HeroBannerData,
  type LoginRequestDto,
  type LoginResponseDto,
  type MockRegisteredUser,
  type ProductDetail,
  type ProductListItem,
  type ProductListResponse,
  type RegisterRequestDto,
  type RegisterResponseDto,
  type SelectOption,
  type SiteConfigData,
  type ToppingOption,
} from "@/mock-data";

// ============================================================================
// BREWLITE SERVICE & BUSINESS RULES — SPRINT 1 & SPRINT 2
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v1.0.md (Mục 2, 3, 4, 5)
// - docs/api/BrewLite_API_Contract_v2.0.md (Mục 3, 4, 5, 6, 7, 8)
// - docs/api/BrewLite_API_Contract_v2.1.md (Mục 2.5, 5.2, 5.3, 6, 7, 9.2)
// - database/schema.dbml
// ============================================================================

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const FALLBACK_DRINK_IMAGE = "/file.svg";

/** Độ trễ mô phỏng quá trình tải dữ liệu từ máy chủ (~420ms theo thiết kế Stitch) */
export const SIMULATED_LOADING_DELAY_MS = 420;

/**
 * Business Rules theo API Contract Mục 4.4 / 4.5 & database/schema.dbml:
 * - Size mặc định trên Frontend là S (100%)
 * - Mỗi ly chọn tối đa 3 loại Topping khác nhau; mỗi loại chỉ chọn 1 lần
 * - Số lượng mỗi dòng sản phẩm: 1 <= quantity <= 10
 */
export const DEFAULT_DRINK_SIZE: DrinkSize = "S";
export const MAX_TOPPINGS_PER_ITEM = 3;
export const MIN_ORDER_QUANTITY = 1;
export const MAX_ORDER_QUANTITY = 10;

/**
 * Định dạng số nguyên VND sang chuỗi hiển thị trên UI (API Contract Mục 2.1)
 */
export function formatVnd(amountVnd: number): string {
  return `${Math.round(amountVnd).toLocaleString("vi-VN")} đ`;
}

/**
 * Kiểm tra định dạng UUID hợp lệ (tương thích với ParseUUIDPipe của NestJS — Mục 5.5)
 */
export function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id.trim()
  );
}

/**
 * Công thức tính giá theo Size (API Contract Mục 4.6):
 * sizePriceVnd = round_half_up(basePriceVnd * multiplierPercent / 100)
 */
export function calculateSizePriceVnd(
  basePriceVnd: number,
  multiplierPercent: number
): number {
  if (!Number.isSafeInteger(basePriceVnd) || basePriceVnd < 0) {
    return 0;
  }
  return Math.floor((basePriceVnd * multiplierPercent + 50) / 100);
}

/**
 * Chênh lệch giá của Size đang chọn so với giá cơ bản Size S (100%)
 */
export function calculateSizeExtraVnd(
  basePriceVnd: number,
  multiplierPercent: number
): number {
  return Math.max(
    0,
    calculateSizePriceVnd(basePriceVnd, multiplierPercent) - basePriceVnd
  );
}

/**
 * Công thức tính đơn giá 1 ly (API Contract Mục 4.6):
 * unitPriceVnd = round_half_up(basePriceVnd * multiplierPercent / 100) + sum(topping.priceVnd)
 * Lưu ý: Topping có giá cố định, không nhân hệ số Size.
 */
export function calculateUnitPriceVnd(
  basePriceVnd: number,
  multiplierPercent: number,
  selectedToppings: Pick<ToppingOption, "priceVnd">[]
): number {
  const sizePrice = calculateSizePriceVnd(basePriceVnd, multiplierPercent);
  const toppingSum = selectedToppings.reduce(
    (sum, item) =>
      sum + (Number.isSafeInteger(item.priceVnd) ? item.priceVnd : 0),
    0
  );
  return sizePrice + toppingSum;
}

/**
 * Công thức tính thành tiền theo số lượng (API Contract Mục 4.6):
 * lineTotalVnd = unitPriceVnd * quantity
 */
export function calculateLineTotalVnd(
  unitPriceVnd: number,
  quantity: number
): number {
  const clampedQty = Math.max(
    MIN_ORDER_QUANTITY,
    Math.min(MAX_ORDER_QUANTITY, Math.trunc(quantity))
  );
  return unitPriceVnd * clampedQty;
}

/**
 * Sắp xếp danh sách sản phẩm theo đúng quy tắc BR-017 & API Contract Mục 3.5:
 * Theo `name` tăng dần (A -> Z), nếu trùng tên thì theo `id` tăng dần.
 */
export function sortProductsByContract(
  items: ProductListItem[]
): ProductListItem[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, "vi");
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

function waitDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Lấy danh sách đồ uống từ Mock Data cho giao diện Menu (`GET /products`)
 * Hỗ trợ các trạng thái Loading, Empty và Error cho Tester
 */
export async function getProducts(options?: {
  delayMs?: number;
  forceEmpty?: boolean;
  forceError?: boolean;
}): Promise<ProductListResponse> {
  const delayMs = options?.delayMs ?? SIMULATED_LOADING_DELAY_MS;
  if (delayMs > 0) {
    await waitDelay(delayMs);
  }
  if (options?.forceError) {
    throw new Error("Internal server error");
  }
  if (options?.forceEmpty) {
    return { items: [] };
  }
  return {
    items: sortProductsByContract(MOCK_PRODUCTS_RESPONSE.items),
  };
}

/**
 * Lấy chi tiết đồ uống từ Mock Data theo ID (`GET /products/:id`)
 */
export async function getProductById(
  id: string
): Promise<ProductDetail | null> {
  const trimmedId = (id || "").trim();
  if (!isValidUuid(trimmedId)) {
    return null;
  }
  return MOCK_PRODUCT_DETAILS[trimmedId] ?? null;
}

export type ProductDetailLookupResult =
  | {
      status: 200;
      data: ProductDetail;
    }
  | {
      status: 400;
      message: string;
      error: "Bad Request";
    }
  | {
      status: 404;
      message: string;
      error: "Not Found";
    };

/**
 * Tra cứu chi tiết sản phẩm theo chuẩn HTTP status của API Contract Mục 4 & Mục 5:
 * - 400 Bad Request: ID không đúng định dạng UUID (`Validation failed (uuid is expected)`)
 * - 404 Not Found: ID đúng UUID nhưng không tồn tại (`Product not found`)
 * - 200 OK: Trả về `ProductDetail` đầy đủ (`sizes`, `toppings`, `isAvailable`, ...)
 */
export function lookupProductDetailById(id: string): ProductDetailLookupResult {
  const trimmedId = (id || "").trim();
  if (!isValidUuid(trimmedId)) {
    return {
      status: 400,
      message: "Validation failed (uuid is expected)",
      error: "Bad Request",
    };
  }
  const detail = MOCK_PRODUCT_DETAILS[trimmedId];
  if (!detail) {
    return {
      status: 404,
      message: "Product not found",
      error: "Not Found",
    };
  }
  return {
    status: 200,
    data: detail,
  };
}

/**
 * Lấy dữ liệu cấu hình và danh sách sản phẩm từ Mock Data cho trang Thực đơn
 */
export function getCatalogData(): {
  products: ProductListItem[];
  categories: CategoryOption[];
  sortOptions: SelectOption[];
  priceFilterOptions: SelectOption[];
  heroBanner: HeroBannerData;
  siteConfig: SiteConfigData;
} {
  const sortedItems = sortProductsByContract(MOCK_PRODUCTS_RESPONSE.items);
  return {
    products: sortedItems,
    categories: MOCK_CATEGORIES.map((cat) =>
      cat.id === "all" ? { ...cat, label: `Tất cả (${sortedItems.length})` } : cat
    ),
    sortOptions: MOCK_SORT_OPTIONS,
    priceFilterOptions: MOCK_PRICE_FILTER_OPTIONS,
    heroBanner: MOCK_HERO_BANNER,
    siteConfig: {
      ...MOCK_SITE_CONFIG,
      totalCatalogCount: sortedItems.length,
    },
  };
}

/**
 * Tải dữ liệu trang Thực đơn bất đồng bộ (`GET /products`)
 */
export async function fetchCatalogData(options?: {
  delayMs?: number;
  forceEmpty?: boolean;
  forceError?: boolean;
}): Promise<{
  products: ProductListItem[];
  categories: CategoryOption[];
  sortOptions: SelectOption[];
  priceFilterOptions: SelectOption[];
  heroBanner: HeroBannerData;
  siteConfig: SiteConfigData;
}> {
  const productListResponse = await getProducts(options);
  const items = productListResponse.items;
  return {
    products: items,
    categories: MOCK_CATEGORIES.map((cat) =>
      cat.id === "all" ? { ...cat, label: `Tất cả (${items.length})` } : cat
    ),
    sortOptions: MOCK_SORT_OPTIONS,
    priceFilterOptions: MOCK_PRICE_FILTER_OPTIONS,
    heroBanner: MOCK_HERO_BANNER,
    siteConfig: {
      ...MOCK_SITE_CONFIG,
      totalCatalogCount: items.length,
    },
  };
}

// ============================================================================
// AUTHENTICATION BUSINESS RULES & MOCK SERVICE — SPRINT 2 (SCRUM-41)
// Đối chiếu chuẩn 100% với `docs/api/BrewLite_API_Contract_v2.1.md`:
// - Mục 2.5: JWT TTL 3600s, `tokenType: "Bearer"`, `sub = User UUID`
// - Mục 5.2 & 5.3: `VALIDATION_ERROR` (400), `EMAIL_ALREADY_EXISTS` (409), `INVALID_CREDENTIALS` (401)
// - Mục 6 (`POST /auth/register`):
//   + `email`: bắt buộc, định dạng email hợp lệ, trim/lowercase, max 255
//   + `password`: bắt buộc, tối thiểu 8 ký tự, KHÔNG trim/normalize trước khi hash
//   + `fullName`: không bắt buộc, max 255
//   + Không tự động login hoặc phát JWT sau khi Register (trả 201 `{ id, email, fullName }`)
// - Mục 7 (`POST /auth/login`):
//   + `email`: chuẩn hóa trim/lowercase
//   + `password`: bắt buộc, non-empty, KHÔNG trim/normalize trước khi verify
//   + Không tiết lộ email có tồn tại hay không (email sai và password sai trả cùng 401 `INVALID_CREDENTIALS`)
//   + Giữ nguyên Cart khi đăng nhập thành công hoặc thất bại
// ============================================================================

export const AUTH_TOKEN_STORAGE_KEY = "brewlite_access_token";
export const AUTH_USER_STORAGE_KEY = "brewlite_auth_user";

// Bộ nhớ tạm trong phiên cho danh sách khách hàng đăng ký (khởi tạo từ MOCK_REGISTERED_USERS)
const sessionRegisteredUsers: MockRegisteredUser[] = [
  ...MOCK_REGISTERED_USERS,
];

/**
 * Chuẩn hóa email theo API Contract v2.1 Mục 6.2 & 7.2: `trim().toLowerCase()`
 */
export function normalizeAuthEmail(rawEmail: string): string {
  return (rawEmail || "").trim().toLowerCase();
}

/**
 * Kiểm tra định dạng email hợp lệ và độ dài tối đa 255 ký tự (API Contract v2.1 Mục 6.2)
 */
export function isValidAuthEmail(normalizedEmail: string): boolean {
  if (
    !normalizedEmail ||
    normalizedEmail.length > AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH
  ) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
}

/**
 * Tạo chuỗi JWT mô phỏng theo chuẩn `header.payload.signature` chứa `sub = userId` và `exp` (+3600s)
 */
function createMockJwtToken(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + AUTH_VALIDATION_RULES.JWT_EXPIRES_IN_SECONDS;
  const encodeBase64Url = (obj: Record<string, unknown>) =>
    typeof window !== "undefined"
      ? window
          .btoa(JSON.stringify(obj))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
      : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

  const header = encodeBase64Url({ alg: "HS256", typ: "JWT" });
  const payload = encodeBase64Url({
    sub: userId,
    iat: issuedAt,
    exp: expiresAt,
  });
  return `${header}.${payload}.brewlite-mock-signature`;
}

export type AuthRegisterResult =
  | {
      ok: true;
      statusCode: 201;
      requestPayload: RegisterRequestDto;
      data: RegisterResponseDto;
    }
  | {
      ok: false;
      errorResponse: AuthApiErrorResponse;
    };

export type AuthLoginResult =
  | {
      ok: true;
      statusCode: 200;
      requestPayload: LoginRequestDto;
      data: LoginResponseDto;
      user: RegisterResponseDto;
    }
  | {
      ok: false;
      errorResponse: AuthApiErrorResponse;
    };

/**
 * Xử lý nghiệp vụ Đăng ký khách hàng (`POST /auth/register` — API Contract v2.1 Mục 6):
 * - Validate `email` (trim/lowercase, hợp lệ, <= 255 ký tự)
 * - Validate `password` (tối thiểu 8 ký tự, KHÔNG trim/normalize)
 * - Validate `fullName` (optional, <= 255 ký tự)
 * - Kiểm tra trùng email (`409 EMAIL_ALREADY_EXISTS`)
 * - Trả về `201 Created` với `{ id, email, fullName }`; tuyệt đối KHÔNG phát JWT / KHÔNG tự động login
 */
export async function submitRegisterMock(
  input: RegisterRequestDto
): Promise<AuthRegisterResult> {
  await waitDelay(300);

  const normalizedEmail = normalizeAuthEmail(input.email);
  // Theo API Contract v2.1 Mục 6.2: KHÔNG trim/normalize password trước khi hash
  const rawPassword = typeof input.password === "string" ? input.password : "";
  const trimmedFullName =
    typeof input.fullName === "string" ? input.fullName.trim() : "";

  const validationErrors: string[] = [];

  if (!normalizedEmail) {
    validationErrors.push("Email là bắt buộc.");
  } else if (normalizedEmail.length > AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH) {
    validationErrors.push(
      `Email không được vượt quá ${AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH} ký tự.`
    );
  } else if (!isValidAuthEmail(normalizedEmail)) {
    validationErrors.push(
      "Định dạng email không hợp lệ (ví dụ: customer@example.com)."
    );
  }

  if (!rawPassword) {
    validationErrors.push("Mật khẩu là bắt buộc.");
  } else if (rawPassword.length < AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH) {
    validationErrors.push(
      `Mật khẩu phải có tối thiểu ${AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH} ký tự (theo API Contract v2.1 Mục 6.2).`
    );
  }

  if (trimmedFullName.length > AUTH_VALIDATION_RULES.FULL_NAME_MAX_LENGTH) {
    validationErrors.push(
      `Họ và tên không được vượt quá ${AUTH_VALIDATION_RULES.FULL_NAME_MAX_LENGTH} ký tự.`
    );
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      errorResponse: {
        statusCode: 400,
        message: validationErrors,
        error: "Bad Request",
        code: "VALIDATION_ERROR",
      },
    };
  }

  // Kiểm tra email đã tồn tại trong DB / Mock (409 EMAIL_ALREADY_EXISTS — Mục 6.4)
  const existingUser = sessionRegisteredUsers.find(
    (u) => normalizeAuthEmail(u.email) === normalizedEmail
  );
  if (existingUser) {
    return {
      ok: false,
      errorResponse: {
        statusCode: 409,
        message: "Email này đã được đăng ký. Vui lòng sử dụng email khác hoặc chuyển sang Đăng nhập.",
        error: "Conflict",
        code: "EMAIL_ALREADY_EXISTS",
      },
    };
  }

  // Chỉ đóng gói đúng 3 trường được phép trong Request Body (không gửi role, loyaltyPoints, passwordHash)
  const sanitizedRequestPayload: RegisterRequestDto = {
    email: normalizedEmail,
    password: rawPassword,
    ...(trimmedFullName ? { fullName: trimmedFullName } : {}),
  };

  const newUserId = `550e8400-e29b-41d4-a716-${String(
    446655440000 + sessionRegisteredUsers.length + 1
  ).slice(-12)}`;

  const createdUser: MockRegisteredUser = {
    id: newUserId,
    email: normalizedEmail,
    password: rawPassword,
    fullName: trimmedFullName || null,
  };

  sessionRegisteredUsers.push(createdUser);

  // Response 201 Created: chỉ trả `id`, `email`, `fullName` (Mục 6.3)
  return {
    ok: true,
    statusCode: 201,
    requestPayload: sanitizedRequestPayload,
    data: {
      id: createdUser.id,
      email: createdUser.email,
      fullName: createdUser.fullName,
    },
  };
}

/**
 * Xử lý nghiệp vụ Đăng nhập (`POST /auth/login` — API Contract v2.1 Mục 7):
 * - Chuẩn hóa `email` (`trim().toLowerCase()`)
 * - Kiểm tra `password` required, non-empty (KHÔNG trim/normalize password trước khi verify)
 * - Bảo mật: Email không tồn tại và password sai trả CÙNG status `401`, code `INVALID_CREDENTIALS` và message
 * - Thành công trả `200 OK` với `{ accessToken, tokenType: "Bearer", expiresIn: 3600 }`
 * - Lưu token mà KHÔNG xóa giỏ hàng (Cart)
 */
export async function submitLoginMock(
  input: LoginRequestDto
): Promise<AuthLoginResult> {
  await waitDelay(300);

  const normalizedEmail = normalizeAuthEmail(input.email);
  // Theo API Contract v2.1 Mục 7.2: KHÔNG trim/normalize password trước khi verify
  const rawPassword = typeof input.password === "string" ? input.password : "";

  const validationErrors: string[] = [];

  if (!normalizedEmail) {
    validationErrors.push("Vui lòng nhập email tài khoản.");
  } else if (normalizedEmail.length > AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH) {
    validationErrors.push(
      `Email không được vượt quá ${AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH} ký tự.`
    );
  } else if (!isValidAuthEmail(normalizedEmail)) {
    validationErrors.push(
      "Định dạng email không hợp lệ (ví dụ: customer@example.com)."
    );
  }

  if (rawPassword.length === 0) {
    validationErrors.push("Vui lòng nhập mật khẩu.");
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      errorResponse: {
        statusCode: 400,
        message: validationErrors,
        error: "Bad Request",
        code: "VALIDATION_ERROR",
      },
    };
  }

  const matchedUser = sessionRegisteredUsers.find(
    (u) => normalizeAuthEmail(u.email) === normalizedEmail
  );

  // Mục 7.2 & 7.4: Email không tồn tại và password sai phải trả CÙNG status/code/message
  // để không tiết lộ email có tồn tại trong hệ thống hay không
  if (!matchedUser || matchedUser.password !== rawPassword) {
    return {
      ok: false,
      errorResponse: {
        statusCode: 401,
        message: "Email hoặc mật khẩu không chính xác.",
        error: "Unauthorized",
        code: "INVALID_CREDENTIALS",
      },
    };
  }

  const loginResponse: LoginResponseDto = {
    accessToken: createMockJwtToken(matchedUser.id),
    tokenType: "Bearer",
    expiresIn: AUTH_VALIDATION_RULES.JWT_EXPIRES_IN_SECONDS,
  };

  // Mục 7.5: Lưu token vào storage mà không chạm vào hay làm mất dữ liệu Giỏ hàng (Cart)
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        AUTH_TOKEN_STORAGE_KEY,
        loginResponse.accessToken
      );
      window.localStorage.setItem(
        AUTH_USER_STORAGE_KEY,
        JSON.stringify({
          id: matchedUser.id,
          email: matchedUser.email,
          fullName: matchedUser.fullName,
        })
      );
    } catch {
      // Bỏ qua nếu trình duyệt chặn localStorage
    }
  }

  return {
    ok: true,
    statusCode: 200,
    requestPayload: {
      email: normalizedEmail,
      password: rawPassword,
    },
    data: loginResponse,
    user: {
      id: matchedUser.id,
      email: matchedUser.email,
      fullName: matchedUser.fullName,
    },
  };
}

/**
 * Lấy danh sách các tài khoản mẫu hiện có trong phiên để hỗ trợ Tester kiểm thử nhanh trên UI
 */
export function getMockRegisteredUsers(): MockRegisteredUser[] {
  return [...sessionRegisteredUsers];
}
