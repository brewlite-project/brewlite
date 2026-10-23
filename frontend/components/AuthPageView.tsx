"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AUTH_VALIDATION_RULES,
  MOCK_AUTH_UI_CONFIG,
  MOCK_REGISTERED_USERS,
  type AuthErrorCode,
  type AuthMode,
} from "@/mock-data";
import {
  normalizeAuthEmail,
  submitLoginMock,
  submitRegisterMock,
} from "@/services/api.service";

export interface AuthPageViewProps {
  /** Chế độ hiển thị mặc định khi mở trang: "login" (Đăng nhập) hoặc "register" (Đăng ký) */
  initialMode?: AuthMode;
}

interface AuthAlertBannerState {
  type: "error" | "info";
  statusCode?: number;
  errorCode?: AuthErrorCode;
  title: string;
  messages: string[];
}

export default function AuthPageView({
  initialMode = "login",
}: AuthPageViewProps) {
  const router = useRouter();

  // ==========================================================================
  // PHẦN 1: QUẢN LÝ STATE GIAO DIỆN ĐĂNG NHẬP & ĐĂNG KÝ (THEO API CONTRACT v2.1)
  // ==========================================================================

  // Chế độ tab hiện tại: "login" (Đăng nhập) hoặc "register" (Đăng ký)
  const [authMode, setAuthMode] = useState<AuthMode>(initialMode);

  // State cho Form Đăng nhập (`POST /auth/login` — chỉ gồm email + password)
  const [loginEmail, setLoginEmail] = useState<string>("");
  const [loginPassword, setLoginPassword] = useState<string>("");
  const [showLoginPassword, setShowLoginPassword] = useState<boolean>(false);

  // State cho Form Đăng ký (`POST /auth/register` — gồm fullName [optional], email [required], password [required >= 8 ký tự])
  const [registerFullName, setRegisterFullName] = useState<string>("");
  const [registerEmail, setRegisterEmail] = useState<string>("");
  const [registerPassword, setRegisterPassword] = useState<string>("");
  const [showRegisterPassword, setShowRegisterPassword] =
    useState<boolean>(false);

  // State trạng thái đang xử lý gửi form & khung thông báo lỗi (#auth-alert)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [alertState, setAlertState] = useState<AuthAlertBannerState | null>(
    null
  );

  // ==========================================================================
  // PHẦN 2: CÁC HÀM XỬ LÝ NGHIỆP VỤ (CHUẨN HÓA EMAIL, SWITCH TAB, SUBMIT FORM)
  // ==========================================================================

  // Chuyển đổi qua lại giữa Tab "Đăng nhập" và Tab "Đăng ký"
  const switchAuthMode = (nextMode: AuthMode) => {
    setAuthMode(nextMode);
    setAlertState(null);
  };

  // Tự động chuẩn hóa email (trim + lowercase) ngay khi người dùng nhập (API Contract v2.1 Mục 6.2 & 7.2)
  const handleLoginEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLoginEmail(
      normalizeAuthEmail(e.target.value).slice(
        0,
        AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH
      )
    );
  };

  const handleRegisterEmailChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setRegisterEmail(
      normalizeAuthEmail(e.target.value).slice(
        0,
        AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH
      )
    );
  };

  // Xử lý khi nhấn nút "Đăng nhập" (`POST /auth/login` — API Contract v2.1 Mục 7)
  const handleLoginSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setAlertState(null);

    try {
      const result = await submitLoginMock({
        email: loginEmail,
        // Tuyệt đối KHÔNG trim/normalize password trước khi verify (Mục 7.2)
        password: loginPassword,
      });

      if (!result.ok) {
        const msgList = Array.isArray(result.errorResponse.message)
          ? result.errorResponse.message
          : [result.errorResponse.message];

        setAlertState({
          type: "error",
          statusCode: result.errorResponse.statusCode,
          errorCode: result.errorResponse.code,
          title:
            result.errorResponse.code === "INVALID_CREDENTIALS"
              ? "Đăng nhập không thành công"
              : "Dữ liệu đăng nhập chưa hợp lệ",
          messages: msgList,
        });
        return;
      }

      // Khi đăng nhập thành công: không hiển thị thông báo và thoát ngay khỏi trang login về Thực đơn ("/")
      setLoginEmail("");
      setLoginPassword("");
      router.push("/");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Xử lý khi nhấn nút "Đăng ký tài khoản" (`POST /auth/register` — API Contract v2.1 Mục 6)
  const handleRegisterSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setAlertState(null);

    try {
      const result = await submitRegisterMock({
        email: registerEmail,
        // Tuyệt đối KHÔNG trim/normalize password trước khi hash (Mục 6.2)
        password: registerPassword,
        fullName: registerFullName,
      });

      if (!result.ok) {
        const msgList = Array.isArray(result.errorResponse.message)
          ? result.errorResponse.message
          : [result.errorResponse.message];

        setAlertState({
          type: "error",
          statusCode: result.errorResponse.statusCode,
          errorCode: result.errorResponse.code,
          title:
            result.errorResponse.code === "EMAIL_ALREADY_EXISTS"
              ? "Email đã tồn tại trong hệ thống"
              : "Dữ liệu đăng ký chưa hợp lệ",
          messages: msgList,
        });
        return;
      }

      // Khi đăng ký thành công (201 Created, không auto-login theo Mục 6.1):
      // Không hiển thị thông báo, xóa trắng toàn bộ khung nhập liệu và tự động chuyển sang trang Đăng nhập
      setRegisterFullName("");
      setRegisterEmail("");
      setRegisterPassword("");
      setShowRegisterPassword(false);

      setLoginEmail("");
      setLoginPassword("");
      setShowLoginPassword(false);

      setAlertState(null);
      setAuthMode("login");
      router.push("/login");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Xử lý khi nhấn nút "Tiếp tục với Google" (ngoài phạm vi Sprint 2 API Contract v2.1)
  const handleGoogleAuthClick = () => {
    setAlertState({
      type: "info",
      title: "Tính năng Đăng nhập bằng Google đang phát triển",
      messages: [
        "Trong phạm vi Sprint 2 (API Contract v2.1), hệ thống xác thực qua Email & Mật khẩu chuẩn Argon2id (`POST /auth/login` & `POST /auth/register`).",
      ],
    });
  };

  // Điền nhanh tài khoản mẫu để Tester kiểm thử thuận tiện
  const handleQuickFillDemoAccount = (email: string, password: string) => {
    setAuthMode("login");
    setLoginEmail(email);
    setLoginPassword(password);
    setAlertState(null);
  };

  // ==========================================================================
  // PHẦN 3: GIAO DIỆN HIỂN THỊ (ĐÚNG 100% THIẾT KẾ STITCH `1aaf555dc415488d9e3e88efa40304a0`)
  // ==========================================================================
  return (
    <div className="min-h-screen bg-background font-body-md text-on-surface flex flex-col justify-between selection:bg-primary-fixed selection:text-on-primary-fixed">
      {/* Đây là thanh Header tối giản ở trên cùng chứa Logo BrewLite Coffee */}
      <header className="w-full pt-space-xl pb-space-md flex justify-center">
        <Link
          className="inline-flex items-center gap-space-sm group focus:outline-none"
          href="/"
        >
          <span className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-on-primary shadow-sm transition-transform group-hover:scale-105">
            <span className="material-symbols-outlined text-[22px]">
              coffee
            </span>
          </span>
          <span className="font-headline-md text-headline-md text-on-surface tracking-tight font-bold">
            {MOCK_AUTH_UI_CONFIG.brandTitle}{" "}
            <span className="text-primary font-normal text-title-md">
              {MOCK_AUTH_UI_CONFIG.brandHighlight}
            </span>
          </span>
        </Link>
      </header>

      {/* Đây là khu vực nội dung chính nằm giữa màn hình */}
      <main className="flex-1 w-full max-w-[680px] mx-auto px-gutter py-space-lg flex flex-col justify-center">
        <div className="flex flex-col w-full items-center justify-center py-space-sm sm:py-space-md">
          {/* Đây là thanh điều hướng nhanh "Quay lại Thực đơn" và nhãn "Artisanal Roast" phía trên khung thẻ */}
          <div className="w-full max-w-md mb-space-md flex items-center justify-between">
            <Link
              className="inline-flex items-center gap-space-xs text-on-surface-variant hover:text-primary transition-colors font-label-md text-label-md group"
              href="/"
            >
              <span className="material-symbols-outlined text-[18px] transition-transform group-hover:-translate-x-1">
                arrow_back
              </span>
              <span>{MOCK_AUTH_UI_CONFIG.backToMenuLabel}</span>
            </Link>
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary/70">
              {MOCK_AUTH_UI_CONFIG.roastBadge}
            </span>
          </div>

          {/* Đây là Khung Thẻ Chính (Main Auth Card Container) chứa Form Đăng nhập & Đăng ký */}
          <div className="w-full max-w-md bg-surface-container-lowest rounded-xl shadow-xl shadow-primary/5 p-space-lg sm:p-space-xl relative overflow-hidden">
            {/* Hiệu ứng ánh sáng nền ấm áp (Ambient Warm Espresso Accent Glow) theo thiết kế Stitch */}
            <div className="absolute -top-12 -right-12 w-40 h-40 bg-secondary-container/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-16 -left-12 w-44 h-44 bg-primary-fixed-dim/25 rounded-full blur-3xl pointer-events-none" />

            {/* Đây là phần Tiêu đề & Biểu tượng giới thiệu ở đầu thẻ Auth */}
            <div className="relative z-10 flex flex-col items-center text-center mb-space-lg">
              <div className="w-12 h-12 rounded-xl bg-surface-container-high flex items-center justify-center text-primary mb-space-sm shadow-sm">
                <span className="material-symbols-outlined text-[26px]">
                  local_cafe
                </span>
              </div>
              <h1
                className="font-headline-md text-headline-md text-on-surface tracking-tight"
                id="auth-heading"
              >
                {authMode === "login"
                  ? MOCK_AUTH_UI_CONFIG.loginHeading
                  : MOCK_AUTH_UI_CONFIG.registerHeading}
              </h1>
              <p
                className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-[320px]"
                id="auth-subheading"
              >
                {authMode === "login"
                  ? MOCK_AUTH_UI_CONFIG.loginSubheading
                  : MOCK_AUTH_UI_CONFIG.registerSubheading}
              </p>
            </div>

            {/* Đây là Thanh Chuyển Đổi Tab (View Switcher Tab): "Đăng nhập" và "Đăng ký" */}
            <div
              role="tablist"
              aria-label="Chuyển đổi giữa Đăng nhập và Đăng ký"
              className="relative z-10 grid grid-cols-2 p-1 bg-surface-container rounded-lg mb-space-lg"
            >
              {/* Nút chọn Tab Đăng nhập */}
              <button
                role="tab"
                aria-selected={authMode === "login"}
                id="tab-login"
                type="button"
                onClick={() => switchAuthMode("login")}
                className={`py-2 rounded-md font-label-lg text-label-lg transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
                  authMode === "login"
                    ? "bg-surface-container-lowest text-on-surface shadow-sm font-bold"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    authMode === "login" ? "text-primary" : ""
                  }`}
                >
                  login
                </span>
                <span>Đăng nhập</span>
              </button>

              {/* Nút chọn Tab Đăng ký */}
              <button
                role="tab"
                aria-selected={authMode === "register"}
                id="tab-register"
                type="button"
                onClick={() => switchAuthMode("register")}
                className={`py-2 rounded-md font-label-lg text-label-lg transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
                  authMode === "register"
                    ? "bg-surface-container-lowest text-on-surface shadow-sm font-bold"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    authMode === "register" ? "text-primary" : ""
                  }`}
                >
                  person_add
                </span>
                <span>Đăng ký</span>
              </button>
            </div>

            {/* ==============================================================
                BIỂU MẪU 1: FORM ĐĂNG NHẬP (`POST /auth/login` — MỤC 7 API CONTRACT v2.1)
                Chỉ gồm: Email tài khoản (bắt buộc) + Mật khẩu (bắt buộc)
               ============================================================== */}
            {authMode === "login" ? (
              <form
                noValidate
                className="relative z-10 flex flex-col gap-space-md"
                id="form-login"
                onSubmit={handleLoginSubmit}
              >
                {/* Đây là ô nhập Email tài khoản (Bắt buộc, tự động trim & lowercase, tối đa 255 ký tự) */}
                <div className="flex flex-col gap-1.5">
                  <label
                    className="font-label-md text-label-md text-on-surface flex items-center justify-between"
                    htmlFor="login-email"
                  >
                    <span>
                      Email tài khoản <span className="text-error">*</span>
                    </span>
                    <span className="font-body-sm text-body-sm text-outline">
                      Bắt buộc
                    </span>
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
                      mail
                    </span>
                    <input
                      id="login-email"
                      name="email"
                      type="email"
                      required
                      maxLength={AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH}
                      autoComplete="email"
                      value={loginEmail}
                      onChange={handleLoginEmailChange}
                      placeholder="vd: huong.nguyen@brewlite.vn"
                      className="w-full pl-11 pr-4 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
                    />
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-1 mt-0.5">
                    <span className="material-symbols-outlined text-[14px] text-primary">
                      info
                    </span>
                    <span>
                      Định dạng chuẩn: yourname@domain.com (tự động chuẩn hóa)
                    </span>
                  </p>
                </div>

                {/* Đây là ô nhập Mật khẩu đăng nhập kèm nút Ẩn/Hiện mật khẩu */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      className="font-label-md text-label-md text-on-surface"
                      htmlFor="login-password"
                    >
                      Mật khẩu <span className="text-error">*</span>
                    </label>
                  </div>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
                      lock
                    </span>
                    <input
                      id="login-password"
                      name="password"
                      type={showLoginPassword ? "text" : "password"}
                      required
                      autoComplete="current-password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full pl-11 pr-12 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
                    />
                    {/* Nút Ẩn/Hiện mật khẩu */}
                    <button
                      aria-label={
                        showLoginPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"
                      }
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                      className="absolute right-3.5 text-outline hover:text-on-surface focus:outline-none flex items-center justify-center p-1 rounded transition-colors cursor-pointer"
                      type="button"
                    >
                      <span
                        className="material-symbols-outlined text-[20px]"
                        id="login-pw-icon"
                      >
                        {showLoginPassword ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Đây là Nút bấm chính: "Đăng nhập" */}
                <button
                  disabled={isSubmitting}
                  id="login-submit-btn"
                  type="submit"
                  className="mt-space-sm w-full py-3.5 px-6 rounded-lg bg-primary hover:bg-secondary text-on-primary font-title-sm text-title-sm shadow-md shadow-primary/20 hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span>
                    {isSubmitting ? "Đang xác thực..." : "Đăng nhập"}
                  </span>
                  <span className="material-symbols-outlined text-[20px] transition-transform group-hover:translate-x-1">
                    {isSubmitting ? "progress_activity" : "arrow_forward"}
                  </span>
                </button>

                {/* Đường kẻ phân cách "HOẶC" */}
                <div className="relative flex items-center justify-center my-1">
                  <div className="w-full border-t border-outline-variant/50" />
                  <span className="px-3 bg-surface-container-lowest text-on-surface-variant font-label-md text-label-md uppercase tracking-wider whitespace-nowrap">
                    Hoặc
                  </span>
                </div>

                {/* Nút "Tiếp tục với Google" theo thiết kế Stitch */}
                <button
                  type="button"
                  onClick={handleGoogleAuthClick}
                  className="w-full py-3 px-4 rounded-lg bg-surface-container-lowest hover:bg-surface-container-low border border-outline-variant text-on-surface font-title-sm text-title-sm shadow-sm transition-all duration-200 flex items-center justify-center gap-3 cursor-pointer group focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span className="font-label-lg text-label-lg text-on-surface">
                    Tiếp tục với Google
                  </span>
                </button>

                {/* Dòng gợi ý chuyển sang Tab Đăng ký ở cuối Form Đăng nhập */}
                <div className="text-center pt-space-xs">
                  <p className="font-body-md text-body-md text-on-surface-variant">
                    Chưa có tài khoản?
                    <button
                      onClick={() => switchAuthMode("register")}
                      className="font-label-md text-label-md text-primary hover:underline hover:text-secondary font-bold inline-block ml-1 cursor-pointer"
                      type="button"
                    >
                      Đăng ký ngay
                    </button>
                  </p>
                </div>
              </form>
            ) : (
              /* ==============================================================
                 BIỂU MẪU 2: FORM ĐĂNG KÝ (`POST /auth/register` — MỤC 6 API CONTRACT v2.1)
                 Gồm: Họ và tên (Không bắt buộc, max 255) + Email (Bắt buộc, max 255) + Mật khẩu (Bắt buộc, >= 8 ký tự)
                 ============================================================== */
              <form
                noValidate
                className="relative z-10 flex flex-col gap-space-md"
                id="form-register"
                onSubmit={handleRegisterSubmit}
              >
                {/* Đây là ô nhập Họ và tên (Không bắt buộc, tối đa 255 ký tự theo API Contract v2.1 Mục 6.2) */}
                <div className="flex flex-col gap-1.5">
                  <label
                    className="font-label-md text-label-md text-on-surface flex items-center justify-between"
                    htmlFor="register-fullname"
                  >
                    <span>Họ và tên</span>
                    <span className="font-body-sm text-body-sm text-outline">
                      Không bắt buộc
                    </span>
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
                      badge
                    </span>
                    <input
                      id="register-fullname"
                      name="fullName"
                      type="text"
                      maxLength={AUTH_VALIDATION_RULES.FULL_NAME_MAX_LENGTH}
                      autoComplete="name"
                      value={registerFullName}
                      onChange={(e) => setRegisterFullName(e.target.value)}
                      placeholder="vd: Trần Quốc Dũng"
                      className="w-full pl-11 pr-4 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
                    />
                  </div>
                </div>

                {/* Đây là ô nhập Email đăng ký (Bắt buộc, tự động trim & lowercase, tối đa 255 ký tự) */}
                <div className="flex flex-col gap-1.5">
                  <label
                    className="font-label-md text-label-md text-on-surface flex items-center justify-between"
                    htmlFor="register-email"
                  >
                    <span>
                      Email <span className="text-error">*</span>
                    </span>
                    <span className="font-body-sm text-body-sm text-outline">
                      Bắt buộc
                    </span>
                  </label>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
                      mail
                    </span>
                    <input
                      id="register-email"
                      name="email"
                      type="email"
                      required
                      maxLength={AUTH_VALIDATION_RULES.EMAIL_MAX_LENGTH}
                      autoComplete="email"
                      value={registerEmail}
                      onChange={handleRegisterEmailChange}
                      placeholder="vd: coffee.enthusiast@brewlite.vn"
                      className="w-full pl-11 pr-4 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
                    />
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-1 mt-0.5">
                    <span className="material-symbols-outlined text-[14px] text-primary">
                      info
                    </span>
                    <span>
                      Dùng để xác thực đơn hàng &amp; tích lũy hạt cà phê
                    </span>
                  </p>
                </div>

                {/* Đây là ô nhập Mật khẩu đăng ký (Bắt buộc, tối thiểu 8 ký tự theo API Contract v2.1 Mục 6.2) */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      className="font-label-md text-label-md text-on-surface"
                      htmlFor="register-password"
                    >
                      Mật khẩu <span className="text-error">*</span>
                    </label>
                    <span className="font-body-sm text-body-sm text-outline">
                      Tối thiểu {AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH} ký
                      tự
                    </span>
                  </div>
                  <div className="relative flex items-center">
                    <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
                      lock
                    </span>
                    <input
                      id="register-password"
                      name="password"
                      type={showRegisterPassword ? "text" : "password"}
                      required
                      minLength={AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH}
                      autoComplete="new-password"
                      value={registerPassword}
                      onChange={(e) => setRegisterPassword(e.target.value)}
                      placeholder={`Tối thiểu ${AUTH_VALIDATION_RULES.PASSWORD_MIN_LENGTH} ký tự`}
                      className="w-full pl-11 pr-12 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
                    />
                    {/* Nút Ẩn/Hiện mật khẩu đăng ký */}
                    <button
                      aria-label={
                        showRegisterPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"
                      }
                      onClick={() => setShowRegisterPassword((prev) => !prev)}
                      className="absolute right-3.5 text-outline hover:text-on-surface focus:outline-none flex items-center justify-center p-1 rounded transition-colors cursor-pointer"
                      type="button"
                    >
                      <span
                        className="material-symbols-outlined text-[20px]"
                        id="reg-pw-icon"
                      >
                        {showRegisterPassword ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Đây là Nút bấm chính: "Đăng ký tài khoản" */}
                <button
                  disabled={isSubmitting}
                  id="register-submit-btn"
                  type="submit"
                  className="mt-space-sm w-full py-3.5 px-6 rounded-lg bg-primary hover:bg-secondary text-on-primary font-title-sm text-title-sm shadow-md shadow-primary/20 hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span>
                    {isSubmitting
                      ? "Đang khởi tạo tài khoản..."
                      : "Đăng ký tài khoản"}
                  </span>
                  <span className="material-symbols-outlined text-[20px] transition-transform group-hover:scale-110">
                    {isSubmitting ? "progress_activity" : "local_cafe"}
                  </span>
                </button>

                {/* Đường kẻ phân cách "HOẶC" */}
                <div className="relative flex items-center justify-center my-1">
                  <div className="w-full border-t border-outline-variant/50" />
                  <span className="px-3 bg-surface-container-lowest text-on-surface-variant font-label-md text-label-md uppercase tracking-wider whitespace-nowrap">
                    Hoặc
                  </span>
                </div>

                {/* Nút "Tiếp tục với Google" */}
                <button
                  type="button"
                  onClick={handleGoogleAuthClick}
                  className="w-full py-3 px-4 rounded-lg bg-surface-container-lowest hover:bg-surface-container-low border border-outline-variant text-on-surface font-title-sm text-title-sm shadow-sm transition-all duration-200 flex items-center justify-center gap-3 cursor-pointer group focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span className="font-label-lg text-label-lg text-on-surface">
                    Tiếp tục với Google
                  </span>
                </button>

                {/* Dòng gợi ý chuyển sang Tab Đăng nhập ở cuối Form Đăng ký */}
                <div className="text-center pt-space-xs">
                  <p className="font-body-md text-body-md text-on-surface-variant">
                    Đã có tài khoản?
                    <button
                      onClick={() => switchAuthMode("login")}
                      className="font-label-md text-label-md text-primary hover:underline hover:text-secondary font-bold inline-block ml-1 cursor-pointer"
                      type="button"
                    >
                      Đăng nhập ngay
                    </button>
                  </p>
                </div>
              </form>
            )}

            {/* ==============================================================
                KHUNG THÔNG BÁO LỖI ĐỘNG (#auth-alert)
                Chỉ hiển thị khi có lỗi 400 / 401 / 409 hoặc thông tin tính năng
               ============================================================== */}
            {alertState && (
              <div
                role="alert"
                id="auth-alert"
                className={`relative z-10 mt-space-md p-3.5 rounded-lg text-left flex items-start gap-2.5 transition-all ${
                  alertState.type === "error"
                    ? "bg-error-container text-on-error-container"
                    : "bg-surface-container-high text-on-surface"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[20px] shrink-0 mt-0.5 ${
                    alertState.type === "error"
                      ? "text-error"
                      : "text-primary"
                  }`}
                  id="auth-alert-icon"
                >
                  {alertState.type === "error" ? "error" : "info"}
                </span>

                <div className="flex-1 flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p
                      className="font-label-md text-label-md font-bold"
                      id="auth-alert-title"
                    >
                      {alertState.title}
                    </p>
                    {alertState.statusCode && (
                      <span className="px-2 py-0.5 rounded bg-surface-container-lowest/80 text-[11px] font-label-md">
                        HTTP {alertState.statusCode}
                        {alertState.errorCode
                          ? ` • ${alertState.errorCode}`
                          : ""}
                      </span>
                    )}
                  </div>

                  {alertState.messages.map((msg, idx) => (
                    <p
                      key={idx}
                      className="font-body-sm text-body-sm"
                      id={idx === 0 ? "auth-alert-desc" : undefined}
                    >
                      {msg}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* ==============================================================
                KHUNG GỢI Ý TÀI KHOẢN MẪU TỪ MOCK DATA (HỖ TRỢ KIỂM THỬ NHANH)
               ============================================================== */}
            <div className="relative z-10 mt-space-md pt-space-md border-t border-outline-variant/40">
              <p className="font-label-md text-[11px] text-on-surface-variant mb-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px] text-primary">
                  science
                </span>
                <span>
                  Tài khoản mẫu từ Mock Data (nhấn để điền nhanh khi test):
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {MOCK_REGISTERED_USERS.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() =>
                      handleQuickFillDemoAccount(
                        account.email,
                        account.password
                      )
                    }
                    className="px-2.5 py-1 rounded-md bg-surface-container-low hover:bg-surface-container-high text-on-surface-variant hover:text-primary font-body-sm text-[11px] transition-colors cursor-pointer"
                    title={account.note}
                  >
                    {account.email}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Đây là dòng ghi chú bảo mật dữ liệu thành viên ở bên dưới thẻ Auth */}
          <div className="mt-space-md text-center max-w-xs text-on-surface-variant/70 font-body-sm text-body-sm flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-[16px] text-primary">
              verified_user
            </span>
            <span>{MOCK_AUTH_UI_CONFIG.trustNote}</span>
          </div>
        </div>
      </main>

      {/* Đây là chân trang Footer tối giản của màn hình Đăng nhập / Đăng ký */}
      <footer className="w-full py-space-lg text-center font-body-sm text-body-sm text-on-surface-variant">
        <p className="max-w-md mx-auto leading-relaxed">
          {MOCK_AUTH_UI_CONFIG.footerCopyright}
        </p>
      </footer>
    </div>
  );
}
