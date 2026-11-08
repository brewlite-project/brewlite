import {
  type AuthUser,
  type LoginRequestDto,
  type LoginResponseDto,
  type RegisterRequestDto,
  type RegisterResponseDto,
  findMockUserByEmail,
  mockLogin,
  mockRegister,
} from "@/mock-data";
import { API_BASE_URL } from "./api.service";

// ============================================================================
// AUTH SERVICE — SPRINT 2 & 3 (SCRUM-41, SCRUM-43, SCRUM-44)
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v2.1.md (Mục 5, 6, 7)
// - Backend Auth Controller & Service
// - Tuyệt đối không lưu passwordHash trên client / localStorage
// - Tách bạch hoàn toàn Real Authentication (mặc định) và Mock Mode
// ============================================================================

export const TOKEN_STORAGE_KEY = "brewlite_auth_token_v1";
export const USER_STORAGE_KEY = "brewlite_auth_user_v1";
export const ACTIVE_ORDER_SESSION_KEY = "brewlite_active_order_v1";

/**
 * Cấu hình chế độ xác thực:
 * - "real" (mặc định): Kết nối trực tiếp đến Backend API thật.
 * - "mock": Chỉ dùng khi biến môi trường NEXT_PUBLIC_AUTH_MODE=mock để test UI cô lập.
 */
export const AUTH_MODE: "real" | "mock" =
  process.env.NEXT_PUBLIC_AUTH_MODE === "mock" ? "mock" : "real";

export interface DecodedJwtPayload {
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  [key: string]: unknown;
}

export interface ValidatedJwtPayload {
  sub: string;
  exp: number;
  iat?: number;
  [key: string]: unknown;
}

/**
 * Giải mã phần payload của JWT phía client.
 * Lưu ý: Client KHÔNG xác thực chữ ký mật mã (Backend chịu trách nhiệm xác thực chữ ký).
 */
export function decodeJwtPayload(token: string): DecodedJwtPayload | null {
  try {
    if (typeof token !== "string") return null;
    const parts = token.trim().split(".");
    if (parts.length !== 3) return null;
    const base64Url = parts[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

/**
 * Validate cấu trúc và thông tin JWT trước khi thiết lập session:
 * 1. Cấu trúc JWT hợp lệ (chuỗi không rỗng, đúng 3 phần header.payload.signature, payload parse được JSON)
 * 2. sub là chuỗi không rỗng (bỏ logic tạo User ID dự phòng bằng Date.now())
 * 3. exp là số hợp lệ và chưa hết hạn
 *
 * Lưu ý: Giữ nguyên nguyên tắc Backend chịu trách nhiệm xác thực chữ ký JWT.
 */
export function validateJwtToken(token: string): ValidatedJwtPayload {
  if (typeof token !== "string" || !token.trim()) {
    const error: Error & { code?: string } = new Error(
      "Mã xác thực (JWT) không hợp lệ: token trống."
    );
    error.code = "INVALID_TOKEN";
    throw error;
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    const error: Error & { code?: string } = new Error(
      "Mã xác thực (JWT) có định dạng không hợp lệ."
    );
    error.code = "INVALID_TOKEN_FORMAT";
    throw error;
  }

  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") {
    const error: Error & { code?: string } = new Error(
      "Không thể giải mã dữ liệu mã xác thực (JWT)."
    );
    error.code = "INVALID_TOKEN_PAYLOAD";
    throw error;
  }

  // 1. sub là chuỗi không rỗng (bỏ logic tạo User ID dự phòng bằng Date.now())
  if (typeof payload.sub !== "string" || !payload.sub.trim()) {
    const error: Error & { code?: string } = new Error(
      "Mã xác thực (JWT) không hợp lệ: thiếu thông tin định danh người dùng (sub)."
    );
    error.code = "MISSING_TOKEN_SUB";
    throw error;
  }

  // 2. exp là số và chưa hết hạn
  if (typeof payload.exp !== "number" || isNaN(payload.exp)) {
    const error: Error & { code?: string } = new Error(
      "Mã xác thực (JWT) không hợp lệ: thiếu thời gian hết hạn (exp)."
    );
    error.code = "MISSING_TOKEN_EXP";
    throw error;
  }

  if (payload.exp * 1000 <= Date.now()) {
    const error: Error & { code?: string } = new Error(
      "Mã xác thực (JWT) đã hết hạn. Vui lòng đăng nhập lại."
    );
    error.code = "TOKEN_EXPIRED";
    throw error;
  }

  return {
    ...payload,
    sub: payload.sub.trim(),
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
  };
}

/**
 * Kiểm tra xem JWT access token đã hết hạn hoặc không hợp lệ chưa
 */
export function isTokenExpired(token: string): boolean {
  try {
    validateJwtToken(token);
    return false;
  } catch {
    return true;
  }
}

/**
 * Validation cơ bản cho email theo API Contract v2.1:
 * - Bắt buộc, không được để trống
 * - Tối đa 255 ký tự
 * - Chuẩn hoá email: trim và lowercase
 */
export function validateEmail(email: string): { isValid: boolean; error?: string } {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return { isValid: false, error: "Vui lòng nhập địa chỉ email." };
  }
  if (normalized.length > 255) {
    return { isValid: false, error: "Email không được vượt quá 255 ký tự." };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalized)) {
    return {
      isValid: false,
      error: "Định dạng email không hợp lệ (ví dụ: yourname@domain.com).",
    };
  }
  return { isValid: true };
}

/**
 * Validation cơ bản cho mật khẩu theo API Contract v2.1 Mục 6.2:
 * - Bắt buộc, không được để trống
 * - Tối thiểu 8 ký tự
 */
export function validatePassword(password: string): { isValid: boolean; error?: string } {
  if (!password) {
    return { isValid: false, error: "Vui lòng nhập mật khẩu." };
  }
  if (password.length < 8) {
    return { isValid: false, error: "Mật khẩu phải có tối thiểu 8 ký tự." };
  }
  return { isValid: true };
}

/**
 * Validation cho họ tên theo API Contract v2.1 Mục 6.2:
 * - Không bắt buộc
 * - Tối đa 255 ký tự
 */
export function validateFullName(fullName?: string): { isValid: boolean; error?: string } {
  if (!fullName) return { isValid: true };
  if (fullName.trim().length > 255) {
    return { isValid: false, error: "Họ và tên không được vượt quá 255 ký tự." };
  }
  return { isValid: true };
}

/**
 * Trích xuất token lưu trong localStorage (có kiểm tra hạn)
 */
export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) return null;
    if (isTokenExpired(token)) {
      clearStoredSession();
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * Trích xuất thông tin User đang đăng nhập từ localStorage.
 * An toàn tuyệt đối: Chỉ chứa id, email, fullName. Không có passwordHash.
 */
export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    // Đảm bảo không có passwordHash
    return {
      id: parsed.id,
      email: parsed.email,
      fullName: parsed.fullName ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Lưu token và thông tin User an toàn sau khi đăng nhập thành công.
 * Nếu trong sessionStorage đang có snapshot đơn hàng PENDING của một user khác,
 * xóa ngay để tránh lộ mã đơn và tổng tiền giữa hai tài khoản dùng chung tab (SCRUM-44).
 */
export function setStoredSession(token: string, user: AuthUser): void {
  if (typeof window === "undefined") return;
  try {
    const normalizedUserId = (user.id || "").trim().toLowerCase();
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    const safeUser: AuthUser = {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? null,
    };
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(safeUser));

    if (typeof sessionStorage !== "undefined") {
      const rawActiveOrder = sessionStorage.getItem(ACTIVE_ORDER_SESSION_KEY);
      if (rawActiveOrder) {
        try {
          const parsed = JSON.parse(rawActiveOrder) as Record<string, unknown>;
          const storedOwnerId =
            typeof parsed?.ownerUserId === "string"
              ? parsed.ownerUserId.trim().toLowerCase()
              : "";
          if (!storedOwnerId || storedOwnerId !== normalizedUserId) {
            sessionStorage.removeItem(ACTIVE_ORDER_SESSION_KEY);
          }
        } catch {
          sessionStorage.removeItem(ACTIVE_ORDER_SESSION_KEY);
        }
      }
    }
  } catch {
    // Bỏ qua lỗi lưu session
  }
}

/**
 * Đăng xuất / xóa phiên đăng nhập hết hạn hoặc 401:
 * - Xóa JWT token và thông tin AuthUser trong localStorage.
 * - Xóa snapshot đơn hàng PENDING trong sessionStorage (`brewlite_active_order_v1`) vì đơn hàng gắn với tài khoản.
 * - TUYỆT ĐỐI BẢO LƯU GIỎ HÀNG (Cart `brewlite_cart_v1`) theo API Contract v2.1 Mục 7.5 & 9.2!
 */
export function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // Bỏ qua lỗi xóa localStorage
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(ACTIVE_ORDER_SESSION_KEY);
    }
  } catch {
    // Bỏ qua lỗi xóa sessionStorage
  }
}

/**
 * Gửi yêu cầu Đăng ký (Register)
 * - Mặc định Real Mode: Gửi trực tiếp đến Backend API `/auth/register`.
 * - Khi Backend gặp lỗi / không khả dụng: Ném lỗi rõ ràng, KHÔNG tự động đăng nhập giả.
 */
export async function registerApi(dto: RegisterRequestDto): Promise<RegisterResponseDto> {
  const normalizedDto: RegisterRequestDto = {
    email: dto.email.trim().toLowerCase(),
    password: dto.password,
    fullName: dto.fullName?.trim() || undefined,
  };

  // Nếu explicitly bật Mock Mode qua biến môi trường
  if (AUTH_MODE === "mock") {
    return mockRegister(normalizedDto);
  }

  const endpoint =
    typeof window !== "undefined"
      ? "/api/backend/auth/register"
      : `${API_BASE_URL}/auth/register`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedDto),
    });
  } catch {
    // Lỗi mạng hoặc Backend chưa chạy trong Real Mode: Báo lỗi thật sự, không giả lập thành công!
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Không thể kết nối đến máy chủ Backend. Vui lòng kiểm tra lại dịch vụ."
    );
    err.statusCode = 503;
    err.code = "NETWORK_ERROR";
    throw err;
  }

  if (res.ok) {
    return (await res.json()) as RegisterResponseDto;
  }

  const errorData = await res.json().catch(() => null);
  const is5xx = res.status >= 500 && res.status <= 599;

  let defaultRegisterMessage = "Đăng ký không thành công.";
  if (res.status === 409) {
    defaultRegisterMessage = "Địa chỉ email đã được sử dụng.";
  } else if (is5xx) {
    defaultRegisterMessage = "Máy chủ đang gặp sự cố. Vui lòng thử lại sau.";
  } else if (res.status === 400) {
    defaultRegisterMessage = "Thông tin đăng ký không hợp lệ.";
  }

  const rawRegisterMessage = Array.isArray(errorData?.message)
    ? errorData.message.join(", ")
    : typeof errorData?.message === "string"
    ? errorData.message
    : null;

  const err: Error & { statusCode?: number; code?: string; details?: unknown } =
    new Error(rawRegisterMessage || defaultRegisterMessage);
  err.statusCode = res.status;
  err.code =
    errorData?.code ||
    (res.status === 409
      ? "EMAIL_ALREADY_EXISTS"
      : res.status === 400
      ? "VALIDATION_ERROR"
      : is5xx
      ? "SERVER_ERROR"
      : "UNKNOWN_ERROR");
  err.details = errorData;
  throw err;
}

/**
 * Gửi yêu cầu Đăng nhập (Login)
 * - Mặc định Real Mode: Gửi trực tiếp đến Backend API `/auth/login`.
 * - Nhận JWT token thật từ backend và verify qua Argon2id.
 * - Khi Backend gặp lỗi / không khả dụng: Ném lỗi rõ ràng, KHÔNG tự động đăng nhập giả.
 */
export async function loginApi(dto: LoginRequestDto): Promise<LoginResponseDto> {
  const normalizedDto: LoginRequestDto = {
    email: dto.email.trim().toLowerCase(),
    password: dto.password,
  };

  if (AUTH_MODE === "mock") {
    return mockLogin(normalizedDto);
  }

  const endpoint =
    typeof window !== "undefined"
      ? "/api/backend/auth/login"
      : `${API_BASE_URL}/auth/login`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedDto),
    });
  } catch {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Không thể kết nối đến máy chủ Backend. Vui lòng kiểm tra lại dịch vụ."
    );
    err.statusCode = 503;
    err.code = "NETWORK_ERROR";
    throw err;
  }

  if (res.ok) {
    return (await res.json()) as LoginResponseDto;
  }

  const errorData = await res.json().catch(() => null);
  const is5xx = res.status >= 500 && res.status <= 599;

  let defaultLoginMessage = "Không thể đăng nhập. Vui lòng thử lại.";
  if (res.status === 401) {
    defaultLoginMessage = "Email hoặc mật khẩu không chính xác.";
  } else if (is5xx) {
    defaultLoginMessage = "Máy chủ đang gặp sự cố. Vui lòng thử lại sau.";
  } else if (res.status === 400) {
    defaultLoginMessage = "Thông tin đăng nhập không hợp lệ.";
  }

  const rawLoginMessage = Array.isArray(errorData?.message)
    ? errorData.message.join(", ")
    : typeof errorData?.message === "string"
    ? errorData.message
    : null;

  const err: Error & { statusCode?: number; code?: string; details?: unknown } =
    new Error(rawLoginMessage || defaultLoginMessage);
  err.statusCode = res.status;
  err.code =
    errorData?.code ||
    (res.status === 401
      ? "INVALID_CREDENTIALS"
      : res.status === 400
      ? "VALIDATION_ERROR"
      : is5xx
      ? "SERVER_ERROR"
      : "UNKNOWN_ERROR");
  err.details = errorData;
  throw err;
}

/**
 * Tạo AuthUser từ thông tin đăng nhập thành công và JWT accessToken.
 * Tuyệt đối không chứa passwordHash hay dữ liệu nhạy cảm.
 *
 * Tuân thủ yêu cầu:
 * - Validate JWT trước khi tạo User: kiểm tra cấu trúc hợp lệ, sub là chuỗi không rỗng, exp chưa hết hạn.
 * - Bỏ logic tạo User ID dự phòng bằng Date.now() khi token thiếu sub (ném lỗi nếu thiếu).
 * - Bỏ hoàn toàn danh sách hardcode tên Customer theo email.
 * - Trong Real Mode: fullName là null (chưa có API Profile, không coi tên lưu trong localStorage là dữ liệu chính thức từ Backend).
 */
export function resolveUserFromLogin(
  email: string,
  accessToken: string
): AuthUser {
  const normalized = email.trim().toLowerCase();

  // Validate JWT nghiêm ngặt theo yêu cầu:
  // - Cấu trúc hợp lệ (3 phần ngăn cách bởi dấu chấm, payload parse được JSON)
  // - sub là chuỗi không rỗng (bỏ logic tạo User ID dự phòng bằng Date.now())
  // - exp chưa hết hạn
  // - Backend chịu trách nhiệm xác thực chữ ký JWT
  const validatedPayload = validateJwtToken(accessToken);

  // Nếu đang chạy Mock Mode: lấy từ dữ liệu mock preview nếu có
  if (AUTH_MODE === "mock") {
    const mockUser = findMockUserByEmail(normalized);
    if (mockUser) {
      return {
        id: mockUser.id,
        email: mockUser.email,
        fullName: mockUser.fullName,
      };
    }
  }

  // Real Mode:
  // Backend Login hiện chỉ trả accessToken, tokenType, expiresIn, JWT chứa sub, không có fullName.
  // fullName đặt là null; giao diện sẽ hiển thị email hoặc tên suy ra từ email qua getDisplayCustomerName().
  return {
    id: validatedPayload.sub,
    email: normalized,
    fullName: null,
  };
}

/**
 * Định dạng tên hiển thị của người dùng trên giao diện:
 * - Ưu tiên fullName nếu có (ví dụ khi Mock Mode cung cấp profile mẫu)
 * - Tạm thời hiển thị tên suy ra từ email (vd: "hoang.khanh@..." -> "Hoang Khanh", "customer@..." -> "Customer")
 * - Nếu không thể suy ra, hiển thị trực tiếp email
 * - Không coi tên lưu trong localStorage là dữ liệu chính thức từ Backend.
 */
export function getDisplayCustomerName(user: AuthUser | null): string {
  if (!user) return "Quý khách";
  if (user.fullName && user.fullName.trim()) {
    return user.fullName.trim();
  }
  const rawPrefix = (user.email || "").split("@")[0] || "";
  const words = rawPrefix
    .replace(/[._\-+]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));

  return words.length > 0 ? words.join(" ") : user.email;
}
