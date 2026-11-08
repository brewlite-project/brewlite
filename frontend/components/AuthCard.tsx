"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  validateEmail,
  validateFullName,
  validatePassword,
} from "@/services/auth.service";

interface AuthCardProps {
  initialMode?: "login" | "register";
  onSuccess?: () => void;
  redirectUrl?: string;
  contextBannerMessage?: string | null;
  isModal?: boolean;
}

export default function AuthCard({
  initialMode = "login",
  onSuccess,
  redirectUrl = "/",
  contextBannerMessage = null,
}: AuthCardProps) {
  const router = useRouter();
  const { login, register } = useAuth();

  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Form states
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [fullName, setFullName] = useState<string>("");

  // Validation & alerts
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    fullName?: string;
  }>({});
  const [alert, setAlert] = useState<{
    type: "success" | "error" | "info";
    title: string;
    desc: string;
  } | null>(null);

  const switchMode = (newMode: "login" | "register") => {
    setMode(newMode);
    setFieldErrors({});
    setAlert(null);
  };

  const handleEmailChange = (val: string) => {
    // Tự động trim và lowercase theo business rule API contract
    const normalized = val.trim().toLowerCase();
    setEmail(normalized);
    if (fieldErrors.email) {
      setFieldErrors((prev) => ({ ...prev, email: undefined }));
    }
  };

  const handlePasswordChange = (val: string) => {
    // Không trim password theo rule bảo mật API contract
    setPassword(val);
    if (fieldErrors.password) {
      setFieldErrors((prev) => ({ ...prev, password: undefined }));
    }
  };

  const handleForgotPassword = () => {
    setAlert({
      type: "info",
      title: "Chức năng đang phát triển",
      desc: "Tính năng khôi phục mật khẩu đang được phát triển và sẽ sớm ra mắt trong các phiên bản tiếp theo.",
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAlert(null);

    // Validation cơ bản
    const emailValidation = validateEmail(email);
    const passwordValidation = validatePassword(password);
    const fullNameValidation =
      mode === "register" ? validateFullName(fullName) : { isValid: true };

    const errors: typeof fieldErrors = {};
    if (!emailValidation.isValid) errors.email = emailValidation.error;
    if (!passwordValidation.isValid) errors.password = passwordValidation.error;
    if (!fullNameValidation.isValid) errors.fullName = fullNameValidation.error;

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setAlert({
        type: "error",
        title: "Dữ liệu chưa hợp lệ",
        desc: Object.values(errors).filter(Boolean).join(" "),
      });
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === "login") {
        await login({ email, password });
        setAlert({
          type: "success",
          title: "Đăng nhập thành công!",
          desc: `Chào mừng quý khách (${email}) trở lại với BrewLite.`,
        });

        setTimeout(() => {
          if (onSuccess) {
            onSuccess();
          } else {
            router.push(redirectUrl);
          }
        }, 450);
      } else {
        const result = await register({
          email,
          password,
          fullName: fullName.trim() || undefined,
        });

        setAlert({
          type: "success",
          title: "Đăng ký thành công!",
          desc: `Tài khoản ${result.email} đã được tạo thành công. Vui lòng chuyển sang tab Đăng nhập để bắt đầu.`,
        });

        // Theo API contract: Register KHÔNG tự động đăng nhập. Tự động chuyển qua tab login sau 1s
        setTimeout(() => {
          switchMode("login");
          setPassword("");
        }, 1200);
      }
    } catch (err: unknown) {
      const errorObj = err as {
        statusCode?: number;
        code?: string;
        message?: string;
      };

      const statusCode = errorObj?.statusCode;
      const is5xx =
        typeof statusCode === "number" && statusCode >= 500 && statusCode <= 599;

      let title = "Đã có lỗi xảy ra";
      let desc = errorObj?.message || "Không thể xử lý yêu cầu. Vui lòng thử lại.";

      if (errorObj?.code === "NETWORK_ERROR" || statusCode === 503) {
        title = "Không thể kết nối máy chủ";
        desc = "Không thể kết nối đến máy chủ Backend. Vui lòng kiểm tra lại dịch vụ hoặc thử lại sau.";
      } else if (errorObj?.code === "SERVER_ERROR" || is5xx) {
        title = "Sự cố hệ thống";
        desc = "Hệ thống đang gặp sự cố. Vui lòng thử lại sau.";
      } else if (errorObj?.code === "INVALID_CREDENTIALS" || statusCode === 401) {
        title = "Đăng nhập thất bại";
        desc = "Email hoặc mật khẩu không chính xác. Vui lòng kiểm tra lại.";
      } else if (
        errorObj?.code === "EMAIL_ALREADY_EXISTS" ||
        errorObj?.statusCode === 409
      ) {
        title = "Email đã tồn tại";
        desc = `Địa chỉ email "${email}" đã được đăng ký tài khoản. Vui lòng chọn Đăng nhập hoặc sử dụng email khác.`;
      } else if (
        errorObj?.code === "VALIDATION_ERROR" ||
        errorObj?.statusCode === 400
      ) {
        title = "Thông tin không hợp lệ";
      } else if (
        errorObj?.code === "INVALID_TOKEN" ||
        errorObj?.code === "INVALID_TOKEN_FORMAT" ||
        errorObj?.code === "INVALID_TOKEN_PAYLOAD" ||
        errorObj?.code === "MISSING_TOKEN_SUB" ||
        errorObj?.code === "MISSING_TOKEN_EXP" ||
        errorObj?.code === "TOKEN_EXPIRED"
      ) {
        title = "Xác thực không hợp lệ";
        desc = errorObj?.message || "Mã xác thực phiên đăng nhập không hợp lệ hoặc đã hết hạn.";
      }

      setAlert({
        type: "error",
        title,
        desc,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md bg-surface-container-lowest rounded-xl shadow-xl shadow-primary/5 p-space-lg sm:p-space-xl relative overflow-hidden border border-outline-variant/30">
      {/* Ambient Warm Espresso Accent Glow (từ Stitch Design) */}
      <div className="absolute -top-12 -right-12 w-40 h-40 bg-secondary-container/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-16 -left-12 w-44 h-44 bg-primary-fixed-dim/25 rounded-full blur-3xl pointer-events-none" />

      {/* Header & Brand Intro */}
      <div className="relative z-10 flex flex-col items-center text-center mb-space-lg">
        <div className="w-12 h-12 rounded-xl bg-surface-container-high flex items-center justify-center text-primary mb-space-sm shadow-sm">
          <span className="material-symbols-outlined text-[26px]">
            local_cafe
          </span>
        </div>
        <h1 className="font-headline-md text-headline-md text-on-surface tracking-tight font-bold">
          {mode === "login" ? "Chào mừng trở lại" : "Tạo tài khoản mới"}
        </h1>
        <p className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-[320px]">
          {mode === "login"
            ? "Trải nghiệm cà phê nghệ nhân & đặc sản nguyên bản"
            : "Gia nhập cộng đồng người yêu thích gu cà phê mộc"}
        </p>
      </div>

      {/* Thông báo ngữ cảnh Checkout nếu mở từ bước Đặt hàng */}
      {contextBannerMessage && (
        <div
          id="authCheckoutNoticeBanner"
          className="relative z-10 mb-space-md p-3 rounded-lg bg-surface-container-high border border-primary/30 text-on-surface flex items-start gap-2 text-left"
        >
          <span className="material-symbols-outlined text-[18px] text-primary shrink-0 mt-0.5">
            shopping_bag_speed
          </span>
          <p className="font-body-sm text-body-sm text-on-surface-variant leading-snug">
            {contextBannerMessage}
          </p>
        </div>
      )}

      {/* View Switcher Tab (Level 1 Elevation Pills) */}
      <div className="relative z-10 grid grid-cols-2 p-1 bg-surface-container rounded-lg mb-space-lg">
        <button
          type="button"
          onClick={() => switchMode("login")}
          className={`py-2 rounded-md font-label-lg text-label-lg transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            mode === "login"
              ? "bg-surface-container-lowest text-on-surface shadow-sm font-bold"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[16px] ${
              mode === "login" ? "text-primary" : ""
            }`}
          >
            login
          </span>
          <span>Đăng nhập</span>
        </button>

        <button
          type="button"
          onClick={() => switchMode("register")}
          className={`py-2 rounded-md font-label-lg text-label-lg transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            mode === "register"
              ? "bg-surface-container-lowest text-on-surface shadow-sm font-bold"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[16px] ${
              mode === "register" ? "text-primary" : ""
            }`}
          >
            person_add
          </span>
          <span>Đăng ký</span>
        </button>
      </div>

      {/* FORM Container */}
      <form
        onSubmit={handleSubmit}
        className="relative z-10 flex flex-col gap-space-md"
        noValidate
      >
        {/* Full Name Field (Chỉ hiển thị khi Đăng ký - Optional) */}
        {mode === "register" && (
          <div className="flex flex-col gap-1.5">
            <label
              className="font-label-md text-label-md text-on-surface flex items-center justify-between"
              htmlFor="auth-fullname"
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
                id="auth-fullname"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="vd: Trần Quốc Dũng"
                maxLength={255}
                className="w-full pl-11 pr-4 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/40 transition-all placeholder:text-outline/70"
              />
            </div>
            {fieldErrors.fullName && (
              <p className="font-body-sm text-body-sm text-error mt-0.5">
                {fieldErrors.fullName}
              </p>
            )}
          </div>
        )}

        {/* Email Field */}
        <div className="flex flex-col gap-1.5">
          <label
            className="font-label-md text-label-md text-on-surface flex items-center justify-between"
            htmlFor="auth-email"
          >
            <span>
              {mode === "login" ? "Email tài khoản" : "Email"}{" "}
              <span className="text-error">*</span>
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
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
              placeholder={
                mode === "login"
                  ? "vd: huong.nguyen@brewlite.vn"
                  : "vd: customer@example.com"
              }
              maxLength={255}
              className={`w-full pl-11 pr-4 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 transition-all placeholder:text-outline/70 ${
                fieldErrors.email
                  ? "ring-2 ring-error/60 bg-error-container/20"
                  : "focus:ring-primary/40"
              }`}
            />
          </div>
          {fieldErrors.email ? (
            <p className="font-body-sm text-body-sm text-error mt-0.5">
              {fieldErrors.email}
            </p>
          ) : (
            <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-1 mt-0.5">
              <span className="material-symbols-outlined text-[14px] text-primary">
                info
              </span>
              <span>
                {mode === "login"
                  ? "Định dạng chuẩn: yourname@domain.com (tự động chuẩn hóa)"
                  : "Dùng để xác thực đơn hàng & tích lũy hạt cà phê"}
              </span>
            </p>
          )}
        </div>

        {/* Password Field with Toggle */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              className="font-label-md text-label-md text-on-surface"
              htmlFor="auth-password"
            >
              Mật khẩu <span className="text-error">*</span>
            </label>
            {mode === "login" && (
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-primary hover:text-secondary font-label-md text-body-sm hover:underline transition-colors cursor-pointer"
              >
                Quên mật khẩu?
              </button>
            )}
          </div>
          <div className="relative flex items-center">
            <span className="material-symbols-outlined absolute left-3.5 text-[20px] text-outline pointer-events-none">
              lock
            </span>
            <input
              id="auth-password"
              type={showPassword ? "text" : "password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => handlePasswordChange(e.target.value)}
              placeholder={
                mode === "login" ? "••••••••" : "Tối thiểu 8 ký tự"
              }
              className={`w-full pl-11 pr-12 py-3 bg-surface-container-low text-on-surface font-body-md text-body-md rounded-lg outline-none focus:bg-surface-container-lowest focus:ring-2 transition-all placeholder:text-outline/70 ${
                fieldErrors.password
                  ? "ring-2 ring-error/60 bg-error-container/20"
                  : "focus:ring-primary/40"
              }`}
            />
            <button
              type="button"
              aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3.5 text-outline hover:text-on-surface focus:outline-none flex items-center justify-center p-1 rounded transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">
                {showPassword ? "visibility_off" : "visibility"}
              </span>
            </button>
          </div>
          {fieldErrors.password && (
            <p className="font-body-sm text-body-sm text-error mt-0.5">
              {fieldErrors.password}
            </p>
          )}
        </div>

        {/* Primary Action Button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-space-sm w-full py-3.5 px-6 rounded-lg bg-primary hover:bg-secondary text-on-primary font-title-sm text-title-sm shadow-md shadow-primary/20 hover:shadow-lg transition-all duration-200 flex items-center justify-center gap-2 group cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-on-primary border-t-transparent rounded-full animate-spin" />
              <span>Đang xử lý...</span>
            </span>
          ) : mode === "login" ? (
            <>
              <span>Đăng nhập</span>
              <span className="material-symbols-outlined text-[20px] transition-transform group-hover:translate-x-1">
                arrow_forward
              </span>
            </>
          ) : (
            <>
              <span>Đăng ký tài khoản</span>
              <span className="material-symbols-outlined text-[20px] transition-transform group-hover:scale-110">
                local_cafe
              </span>
            </>
          )}
        </button>

        {/* Separator */}
        <div className="relative flex items-center justify-center my-1">
          <div className="w-full border-t border-outline-variant/50" />
          <span className="absolute px-3 bg-surface-container-lowest text-on-surface-variant font-label-md text-label-md uppercase tracking-wider">
            Hoặc
          </span>
        </div>

        {/* Social Google Action */}
        <button
          type="button"
          onClick={() =>
            setAlert({
              type: "info",
              title: "Tính năng đang phát triển",
              desc: "Đăng nhập bằng Google sẽ sớm được hỗ trợ trong Sprint tiếp theo.",
            })
          }
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

        {/* Bottom Switcher Prompt */}
        <div className="text-center pt-space-xs">
          <p className="font-body-md text-body-md text-on-surface-variant">
            {mode === "login" ? (
              <>
                Chưa có tài khoản?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className="font-label-md text-label-md text-primary hover:underline hover:text-secondary font-bold inline-block ml-1 cursor-pointer"
                >
                  Đăng ký ngay
                </button>
              </>
            ) : (
              <>
                Đã có tài khoản?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="font-label-md text-label-md text-primary hover:underline hover:text-secondary font-bold inline-block ml-1 cursor-pointer"
                >
                  Đăng nhập ngay
                </button>
              </>
            )}
          </p>
        </div>
      </form>

      {/* Feedback Notification Banner */}
      {alert && (
        <div
          className={`mt-space-md p-3.5 rounded-lg text-left flex items-start gap-2.5 transition-all ${
            alert.type === "error"
              ? "bg-error-container/40 text-on-error-container border border-error/20"
              : alert.type === "success"
              ? "bg-surface-container-high text-on-surface border border-primary/30"
              : "bg-surface-container-high text-on-surface border border-outline-variant/40"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] shrink-0 mt-0.5 ${
              alert.type === "error"
                ? "text-error"
                : alert.type === "success"
                ? "text-primary"
                : "text-secondary"
            }`}
          >
            {alert.type === "error"
              ? "error"
              : alert.type === "success"
              ? "check_circle"
              : "info"}
          </span>
          <div className="flex-1">
            <p className="font-label-md text-label-md font-bold">
              {alert.title}
            </p>
            <p className="font-body-sm text-body-sm mt-0.5 leading-relaxed">
              {alert.desc}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
