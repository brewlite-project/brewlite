"use client";

import React, { useCallback, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import AuthCard from "./AuthCard";

export default function AuthModal() {
  const {
    isAuthModalOpen,
    authModalMode,
    authModalMessage,
    pendingCheckout,
    setPendingCheckout,
    closeAuthModal,
  } = useAuth();

  // Nếu người dùng chủ động đóng modal mà chưa đăng nhập, hủy cờ pendingCheckout
  const handleDismissModal = useCallback(() => {
    setPendingCheckout(false);
    closeAuthModal();
  }, [setPendingCheckout, closeAuthModal]);

  // Khi đăng nhập thành công trong modal, đóng modal nhưng giữ nguyên pendingCheckout để CartDrawer chuyển sang bước Checkout
  const handleLoginSuccess = useCallback(() => {
    closeAuthModal();
  }, [closeAuthModal]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isAuthModalOpen) {
        handleDismissModal();
      }
    };
    if (isAuthModalOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAuthModalOpen, handleDismissModal]);

  if (!isAuthModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleDismissModal();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md my-8">
        {/* Nút đóng modal */}
        <button
          type="button"
          onClick={handleDismissModal}
          className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-surface-container-high/80 text-on-surface hover:bg-surface-container hover:text-primary transition-colors flex items-center justify-center cursor-pointer shadow-sm"
          aria-label="Đóng hộp thoại đăng nhập"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>

        <AuthCard
          initialMode={authModalMode}
          onSuccess={handleLoginSuccess}
          contextBannerMessage={
            authModalMessage ||
            (pendingCheckout
              ? "Vui lòng đăng nhập để tiến hành đặt hàng. Giỏ hàng của bạn được giữ nguyên."
              : null)
          }
          isModal
        />
      </div>
    </div>
  );
}
