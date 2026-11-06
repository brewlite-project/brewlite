"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AuthUser,
  LoginRequestDto,
  RegisterRequestDto,
  RegisterResponseDto,
} from "@/mock-data";
import {
  clearStoredSession,
  getStoredToken,
  getStoredUser,
  isTokenExpired,
  loginApi,
  registerApi,
  resolveUserFromLogin,
  setStoredSession,
} from "@/services/auth.service";

// ============================================================================
// AUTH CONTEXT — SPRINT 2 & 3 (SCRUM-41 & SCRUM-43)
// Quản lý trạng thái xác thực người dùng trên toàn Frontend Next.js
// Tuân thủ API Contract v2.1 & v3.0:
// - Giữ nguyên giỏ hàng (Cart) khi chuyển đổi đăng nhập / đăng xuất / 401
// - Quản lý token Bearer và thông tin AuthUser an toàn (không chứa passwordHash)
// - Tự động kiểm tra token hết hạn khi reload trang và trước khi Checkout
// - Hỗ trợ tự động quay lại bước Checkout (resumeCheckout) sau khi đăng nhập
// ============================================================================

export const PENDING_CHECKOUT_STORAGE_KEY = "brewlite_pending_checkout_v1";

export interface OpenAuthModalOptions {
  resumeCheckout?: boolean;
  reasonMessage?: string;
}

export interface AuthContextType {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (dto: LoginRequestDto) => Promise<void>;
  register: (dto: RegisterRequestDto) => Promise<RegisterResponseDto>;
  logout: () => void;
  /** Kiểm tra đồng bộ token hiện tại còn hạn và hợp lệ không; nếu hết hạn tự động dọn session (giữ Cart) */
  verifySession: () => boolean;
  /** Xử lý khi gặp 401 UNAUTHORIZED lúc Checkout: xóa phiên hết hạn, giữ Cart và mở modal Login */
  handleUnauthorizedCheckout: (reasonMessage?: string) => void;

  // Trạng thái điều hướng tiếp tục Checkout sau khi Login thành công
  pendingCheckout: boolean;
  setPendingCheckout: (pending: boolean) => void;

  // Trạng thái modal Auth bật nhanh
  isAuthModalOpen: boolean;
  authModalMode: "login" | "register";
  authModalMessage: string | null;
  openAuthModal: (
    mode?: "login" | "register",
    options?: OpenAuthModalOptions
  ) => void;
  closeAuthModal: () => void;
  /** Generation số phiên xác thực, tăng đồng bộ tại thời điểm auth transition thực sự (login/logout/verifySession) */
  authGeneration?: number;
}

export const AuthContext = createContext<AuthContextType | undefined>(
  undefined
);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authGeneration, setAuthGeneration] = useState<number>(0);

  // Điều khiển popup Modal nếu người dùng click từ Header hoặc Checkout
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [authModalMode, setAuthModalMode] = useState<"login" | "register">(
    "login"
  );
  const [authModalMessage, setAuthModalMessage] = useState<string | null>(null);
  const [pendingCheckout, setPendingCheckoutState] = useState<boolean>(false);

  const setPendingCheckout = useCallback((pending: boolean) => {
    setPendingCheckoutState(pending);
    if (typeof window !== "undefined") {
      try {
        if (pending) {
          sessionStorage.setItem(PENDING_CHECKOUT_STORAGE_KEY, "1");
        } else {
          sessionStorage.removeItem(PENDING_CHECKOUT_STORAGE_KEY);
        }
      } catch {
        // Bỏ qua lỗi sessionStorage
      }
    }
  }, []);

  // Khôi phục phiên đăng nhập khi tải trang & kiểm tra token hết hạn / không hợp lệ
  useEffect(() => {
    try {
      const savedToken = getStoredToken();
      const savedUser = getStoredUser();
      if (savedToken && savedUser) {
        if (isTokenExpired(savedToken)) {
          // Token hết hạn hoặc không hợp lệ: Xóa phiên đăng nhập nhưng BẢO LƯU GIỎ HÀNG
          clearStoredSession();
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setAccessToken(null);
          setUser(null);
        } else {
          setAccessToken(savedToken);
          setUser(savedUser);
        }
      } else {
        clearStoredSession();
        setAccessToken(null);
        setUser(null);
      }

      if (
        typeof window !== "undefined" &&
        sessionStorage.getItem(PENDING_CHECKOUT_STORAGE_KEY) === "1"
      ) {
        setPendingCheckoutState(true);
      }
    } catch {
      clearStoredSession();
      setAccessToken(null);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const verifySession = useCallback((): boolean => {
    try {
      const currentToken = getStoredToken();
      const currentUser = getStoredUser();
      if (!currentToken || !currentUser || isTokenExpired(currentToken)) {
        clearStoredSession();
        setAccessToken(null);
        setUser(null);
        setAuthGeneration((g) => g + 1);
        return false;
      }
      setAccessToken(currentToken);
      setUser(currentUser);
      return true;
    } catch {
      clearStoredSession();
      setAccessToken(null);
      setUser(null);
      setAuthGeneration((g) => g + 1);
      return false;
    }
  }, []);

  const login = useCallback(async (dto: LoginRequestDto): Promise<void> => {
    const res = await loginApi(dto);
    // Validate JWT (cấu trúc 3 phần, sub chuỗi không rỗng, exp chưa hết hạn).
    // Nếu token không hợp lệ, resolveUserFromLogin sẽ ném lỗi.
    // Lỗi ném ra TRƯỚC KHI lưu session -> không lưu token hoặc thiết lập trạng thái đăng nhập.
    const resolvedUser = resolveUserFromLogin(dto.email, res.accessToken);
    setAccessToken(res.accessToken);
    setUser(resolvedUser);
    setStoredSession(res.accessToken, resolvedUser);
    setAuthModalMessage(null);
    setAuthGeneration((g) => g + 1);
  }, []);

  const register = useCallback(
    async (dto: RegisterRequestDto): Promise<RegisterResponseDto> => {
      // Theo API Contract v2.1: Register thành công KHÔNG tự động đăng nhập
      return await registerApi(dto);
    },
    []
  );

  const logout = useCallback((): void => {
    // Đăng xuất: Xóa auth session nhưng BẢO LƯU GIỎ HÀNG
    clearStoredSession();
    setAccessToken(null);
    setUser(null);
    setPendingCheckout(false);
    setAuthModalMessage(null);
    setAuthGeneration((g) => g + 1);
  }, [setPendingCheckout]);

  const openAuthModal = useCallback(
    (
      mode: "login" | "register" = "login",
      options?: OpenAuthModalOptions
    ) => {
      setAuthModalMode(mode);
      if (options?.resumeCheckout !== undefined) {
        setPendingCheckout(options.resumeCheckout);
      }
      setAuthModalMessage(options?.reasonMessage ?? null);
      setIsAuthModalOpen(true);
    },
    [setPendingCheckout]
  );

  const closeAuthModal = useCallback(() => {
    setIsAuthModalOpen(false);
    setAuthModalMessage(null);
  }, []);

  const handleUnauthorizedCheckout = useCallback(
    (reasonMessage?: string) => {
      clearStoredSession();
      setAccessToken(null);
      setUser(null);
      setPendingCheckout(true);
      setAuthModalMode("login");
      setAuthModalMessage(
        reasonMessage ||
          "Phiên đăng nhập đã hết hạn hoặc bạn chưa đăng nhập. Vui lòng đăng nhập để tiếp tục đặt hàng (giỏ hàng của bạn được giữ nguyên)."
      );
      setIsAuthModalOpen(true);
      setAuthGeneration((g) => g + 1);
    },
    [setPendingCheckout]
  );

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      accessToken,
      isAuthenticated: Boolean(
        accessToken && user && !isTokenExpired(accessToken)
      ),
      isLoading,
      login,
      register,
      logout,
      verifySession,
      handleUnauthorizedCheckout,
      pendingCheckout,
      setPendingCheckout,
      isAuthModalOpen,
      authModalMode,
      authModalMessage,
      openAuthModal,
      closeAuthModal,
      authGeneration,
    }),
    [
      user,
      accessToken,
      isLoading,
      login,
      register,
      logout,
      verifySession,
      handleUnauthorizedCheckout,
      pendingCheckout,
      setPendingCheckout,
      isAuthModalOpen,
      authModalMode,
      authModalMessage,
      openAuthModal,
      closeAuthModal,
      authGeneration,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
