import type {
  DatabaseUser,
  LoginRequestDto,
  LoginResponseDto,
  RegisterRequestDto,
  RegisterResponseDto,
} from "./types";

// ============================================================================
// MOCK DATA USER BREWLITE — CHỈ DÙNG CHO PHÁT TRIỂN GIAO DIỆN (UI PREVIEW)
// Lưu ý: Dữ liệu mock KHÔNG ĐƯỢC XEM là tài khoản đã xác thực thật.
// Tuyệt đối không lưu plaintext mật khẩu vào LocalStorage.
// ============================================================================

/**
 * Hash Argon2id tham chiếu dùng trong mock preview.
 * (Không sử dụng để xác thực tài khoản thật).
 */
export const MOCK_ARGON2ID_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$mG7PSvxFcBnes/A6uf4Bxg$jN4wfxF0HsF54rHgyOd7a8Jce4+8xpTe/FuALxO+iJ4";

/**
 * Danh sách người dùng mẫu chỉ phục vụ kiểm thử UI (Design Preview)
 */
export const MOCK_DATABASE_USERS: DatabaseUser[] = [
  {
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "customer@example.com",
    passwordHash: MOCK_ARGON2ID_PASSWORD_HASH,
    fullName: "Nguyễn Văn A",
    loyaltyPoints: 120,
    createdAt: "2026-10-21T15:30:59.000Z",
    updatedAt: "2026-10-23T13:00:00.000Z",
    password_hash: MOCK_ARGON2ID_PASSWORD_HASH,
    full_name: "Nguyễn Văn A",
    loyalty_points: 120,
    created_at: "2026-10-21T15:30:59.000Z",
    updated_at: "2026-10-23T13:00:00.000Z",
  },
  {
    id: "a2000000-0000-4000-8000-000000000001",
    email: "huong.nguyen@brewlite.vn",
    passwordHash: MOCK_ARGON2ID_PASSWORD_HASH,
    fullName: "Nguyễn Thị Hương",
    loyaltyPoints: 240,
    createdAt: "2026-10-22T08:15:00.000Z",
    updatedAt: "2026-10-24T09:20:00.000Z",
    password_hash: MOCK_ARGON2ID_PASSWORD_HASH,
    full_name: "Nguyễn Thị Hương",
    loyalty_points: 240,
    created_at: "2026-10-22T08:15:00.000Z",
    updated_at: "2026-10-24T09:20:00.000Z",
  },
  {
    id: "a2000000-0000-4000-8000-000000000002",
    email: "dung.tran@brewlite.vn",
    passwordHash: MOCK_ARGON2ID_PASSWORD_HASH,
    fullName: "Trần Quốc Dũng",
    loyaltyPoints: 50,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-24T11:45:00.000Z",
    password_hash: MOCK_ARGON2ID_PASSWORD_HASH,
    full_name: "Trần Quốc Dũng",
    loyalty_points: 50,
    created_at: "2026-10-22T10:00:00.000Z",
    updated_at: "2026-10-24T11:45:00.000Z",
  },
  {
    id: "a2000000-0000-4000-8000-000000000003",
    email: "minh.le@brewlite.vn",
    passwordHash: MOCK_ARGON2ID_PASSWORD_HASH,
    fullName: null,
    loyaltyPoints: 0,
    createdAt: "2026-10-24T02:00:00.000Z",
    updatedAt: "2026-10-24T02:00:00.000Z",
    password_hash: MOCK_ARGON2ID_PASSWORD_HASH,
    full_name: null,
    loyalty_points: 0,
    created_at: "2026-10-24T02:00:00.000Z",
    updated_at: "2026-10-24T02:00:00.000Z",
  },
];

/**
 * Tìm kiếm người dùng mock theo email (phục vụ test UI thuần túy)
 */
export function findMockUserByEmail(email: string): DatabaseUser | undefined {
  const normalizedEmail = email.trim().toLowerCase();
  return MOCK_DATABASE_USERS.find(
    (u) => u.email.trim().toLowerCase() === normalizedEmail
  );
}

/**
 * Tạo token JWT giả lập cho Mock UI Mode
 */
export function generateMockJwt(userId: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  );
  const signature = btoa("mock_signature_for_brewlite_dev");
  return `${header}.${payload}.${signature}`;
}

/**
 * Mock Login phục vụ riêng biệt khi kích hoạt Mock Mode (NEXT_PUBLIC_AUTH_MODE=mock)
 */
export async function mockLogin(dto: LoginRequestDto): Promise<LoginResponseDto> {
  const normalizedEmail = dto.email.trim().toLowerCase();
  const user = findMockUserByEmail(normalizedEmail);

  if (!user || dto.password !== "Password123") {
    const error: Error & {
      statusCode?: number;
      code?: string;
      error?: string;
    } = new Error("Invalid email or password");
    error.statusCode = 401;
    error.code = "INVALID_CREDENTIALS";
    error.error = "Unauthorized";
    throw error;
  }

  return {
    accessToken: generateMockJwt(user.id),
    tokenType: "Bearer",
    expiresIn: 3600,
  };
}

/**
 * Mock Register phục vụ riêng biệt khi kích hoạt Mock Mode
 */
export async function mockRegister(
  dto: RegisterRequestDto
): Promise<RegisterResponseDto> {
  const normalizedEmail = dto.email.trim().toLowerCase();

  const existing = findMockUserByEmail(normalizedEmail);
  if (existing) {
    const error: Error & {
      statusCode?: number;
      code?: string;
      error?: string;
    } = new Error("Email already exists");
    error.statusCode = 409;
    error.code = "EMAIL_ALREADY_EXISTS";
    error.error = "Conflict";
    throw error;
  }

  const newId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    id: newId,
    email: normalizedEmail,
    fullName: dto.fullName?.trim() || null,
  };
}
