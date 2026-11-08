"use client";

import React, { Suspense } from "react";
import Link from "next/link";
import AuthCard from "@/components/AuthCard";

function RegisterContent() {
  return (
    <div className="min-h-screen bg-background font-body-md text-on-surface flex flex-col justify-between selection:bg-primary-fixed selection:text-on-primary-fixed">
      {/* Header */}
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
            BrewLite{" "}
            <span className="text-primary font-normal text-title-md">
              Coffee
            </span>
          </span>
        </Link>
      </header>

      {/* Main Container */}
      <main className="flex-1 w-full max-w-[680px] mx-auto px-gutter py-space-lg flex flex-col justify-center">
        <div className="flex flex-col w-full items-center justify-center py-space-sm sm:py-space-md">
          {/* Back to Menu Quick Link */}
          <div className="w-full max-w-md mb-space-md flex items-center justify-between">
            <Link
              className="inline-flex items-center gap-space-xs text-on-surface-variant hover:text-primary transition-colors font-label-md text-label-md group"
              href="/"
            >
              <span className="material-symbols-outlined text-[18px] transition-transform group-hover:-translate-x-1">
                arrow_back
              </span>
              <span>Quay lại Thực đơn</span>
            </Link>
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary/70 font-semibold">
              Artisanal Roast
            </span>
          </div>

          {/* Main Auth Card with initialMode="register" */}
          <AuthCard initialMode="register" redirectUrl="/" />

          {/* Trust and Artisanal Micro-note */}
          <div className="mt-space-md text-center max-w-xs text-on-surface-variant/70 font-body-sm text-body-sm flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-[16px] text-primary">
              verified_user
            </span>
            <span>Bảo mật dữ liệu thành viên theo tiêu chuẩn BrewLite</span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full py-space-lg text-center font-body-sm text-body-sm text-on-surface-variant">
        <p className="max-w-md mx-auto leading-relaxed">
          © 2025 BrewLite Specialty Coffee. Nghệ thuật rang xay & thưởng thức cà
          phê thủ công.
        </p>
      </footer>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <RegisterContent />
    </Suspense>
  );
}
