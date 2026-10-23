import type { AuthUiConfig, MockRegisteredUser } from "./types";

// ============================================================================
// MOCK DATA ĐĂNG NHẬP & ĐĂNG KÝ (SCRUM-41 — BUILD LOGIN / REGISTER UI)
// Tuân thủ 100% Business Rules trong `docs/api/BrewLite_API_Contract_v2.1.md`:
// - Mục 2.5: JWT TTL mặc định 60 phút (`expiresIn: 3600`), `tokenType: "Bearer"`
// - Mục 5.2 & 5.3: Mã lỗi `VALIDATION_ERROR` (400), `EMAIL_ALREADY_EXISTS` (409), `INVALID_CREDENTIALS` (401)
// - Mục 6 (`POST /auth/register`):
//   + `email`: bắt buộc, hợp lệ, trim/lowercase, tối đa 255 ký tự
//   + `password`: bắt buộc, tối thiểu 8 ký tự, KHÔNG trim/normalize
//   + `fullName`: không bắt buộc (optional), tối đa 255 ký tự
//   + Không gửi `role`, `loyaltyPoints`, `passwordHash`
//   + Không tự động login hoặc phát JWT sau khi Register (trả 201 `{ id, email, fullName }`)
// - Mục 7 (`POST /auth/login`):
//   + `email`: chuẩn hóa trim/lowercase
//   + `password`: bắt buộc, non-empty, KHÔNG trim/normalize
//   + Bảo mật: Không tiết lộ email có tồn tại hay không (email sai và password sai trả cùng 401 `INVALID_CREDENTIALS`)
//   + Giữ nguyên giỏ hàng (Cart) khi đăng nhập thành công hoặc thất bại
// ============================================================================

export const AUTH_VALIDATION_RULES = {
  EMAIL_MAX_LENGTH: 255,
  FULL_NAME_MAX_LENGTH: 255,
  PASSWORD_MIN_LENGTH: 8,
  JWT_EXPIRES_IN_SECONDS: 3600 as const,
};

export const MOCK_AUTH_UI_CONFIG: AuthUiConfig = {
  brandTitle: "BrewLite",
  brandHighlight: "Coffee",
  backToMenuLabel: "Quay lại Thực đơn",
  roastBadge: "Artisanal Roast",
  loginHeading: "Chào mừng trở lại",
  loginSubheading: "Trải nghiệm cà phê nghệ nhân & đặc sản nguyên bản",
  registerHeading: "Tạo tài khoản mới",
  registerSubheading: "Gia nhập cộng đồng người yêu thích gu cà phê mộc",
  emailMaxLength: AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH,
  fullNameMaxLength: AUTH_VALIDATION_RULES.FULL_NAME_MAX_LENGTH,
  passwordMinLength: AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH,
  jwtExpiresInSeconds: AUTH_VALIDATION_RULES.JWT_EXPIRES_IN_SECONDS,
  trustNote: "Bảo mật dữ liệu thành viên theo tiêu chuẩn BrewLite",
  footerCopyright:
    "© 2025 BrewLite Specialty Coffee. Nghệ thuật rang xay & thưởng thức cà phê thủ công.",
};

/**
 * Danh sách tài khoản mẫu dùng để kiểm thử nhanh các kịch bản:
 * - Đăng nhập thành công (`200 OK`)
 * - Đăng nhập sai mật khẩu / email không tồn tại (`401 INVALID_CREDENTIALS`)
 * - Đăng ký trùng email (`409 EMAIL_ALREADY_EXISTS`)
 * - Đăng ký tài khoản mới thành công (`201 Created`)
 */
export const MOCK_REGISTERED_USERS: MockRegisteredUser[] = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "customer@example.com",
    password: "Password123",
    fullName: "Nguyen Van A",
    note: "Tài khoản mẫu theo API Contract v2.1 (Mục 6.2 & 7.2)",
  },
  {
    id: "550e8400-e29b-41d4-a716-446655440001",
    email: "huong.nguyen@brewlite.vn",
    password: "Password123",
    fullName: "Nguyễn Thị Hương",
    note: "Tài khoản mẫu theo thiết kế Stitch",
  },
  {
    id: "550e8400-e29b-41d4-a716-446655440002",
    email: "hai.dang@brewlite.vn",
    password: "Password123",
    fullName: "Nguyễn Hải Đăng",
    note: "Tài khoản hội viên Hạng Vàng trên Header",
  },
];
