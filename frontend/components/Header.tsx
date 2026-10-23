"use client";

import React from "react";
import Link from "next/link";
import {
  MOCK_SITE_CONFIG,
  MOCK_USER_PROFILE,
  type SiteConfigData,
  type UserProfile,
} from "@/mock-data";

interface HeaderProps {
  cartCount?: number;
  onCartClick?: () => void;
  onFeatureNotice?: (featureLabel: string) => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  activeNav?: "thuc-don" | "khuyen-mai" | "lich-su-don-hang" | "ve-brewlite";
  userProfile?: UserProfile;
  siteConfig?: SiteConfigData;
}

export default function Header({
  cartCount = 0,
  onCartClick,
  onFeatureNotice,
  searchQuery = "",
  onSearchChange,
  activeNav = "thuc-don",
  userProfile = MOCK_USER_PROFILE,
  siteConfig = MOCK_SITE_CONFIG,
}: HeaderProps) {
  const handleNotice = (label: string) => {
    if (onFeatureNotice) {
      onFeatureNotice(label);
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 w-full z-50 bg-surface/90 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="h-20 max-w-[1320px] mx-auto px-margin flex items-center justify-between gap-gutter">
        <div className="flex items-center gap-space-lg flex-shrink-0">
          <Link className="flex items-center gap-space-sm" href="/">
            <img
              alt={`${siteConfig.brandName} Logo`}
              className="h-8 w-auto object-contain"
              src={siteConfig.logoUrl}
            />
            <span className="font-headline-md text-headline-md text-primary tracking-tight">
              {siteConfig.brandName}
            </span>
          </Link>
          <button
            onClick={() => handleNotice("Chọn chi nhánh")}
            className="hidden xl:flex items-center gap-space-xs px-space-sm py-1.5 rounded-full bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-primary text-[18px]">
              location_on
            </span>
            <span className="font-label-md text-label-md">
              {siteConfig.selectedBranch}
            </span>
            <span className="material-symbols-outlined text-[16px]">
              expand_more
            </span>
          </button>
        </div>

        <div className="hidden lg:flex items-center flex-1 max-w-sm mx-space-sm">
          <div className="relative w-full">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-outline">
              <span className="material-symbols-outlined text-[20px]">
                search
              </span>
            </span>
            <input
              className="w-full pl-10 pr-4 py-2 bg-surface-container-lowest text-on-surface placeholder:text-outline text-body-sm font-body-sm rounded-full focus:outline-none focus:ring-1 focus:ring-primary shadow-[0_1px_4px_rgba(44,32,24,0.04)] transition-all"
              placeholder={siteConfig.searchPlaceholder}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange?.(e.target.value)}
            />
          </div>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          <Link
            className={`px-3 py-2 font-label-lg text-label-lg rounded-lg transition-colors ${
              activeNav === "thuc-don"
                ? "bg-primary text-on-primary shadow-sm font-semibold"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            }`}
            href="/"
          >
            Thực đơn
          </Link>
          <button
            type="button"
            onClick={() => handleNotice("Khuyến mãi")}
            className={`px-3 py-2 font-label-lg text-label-lg rounded-lg transition-colors cursor-pointer ${
              activeNav === "khuyen-mai"
                ? "bg-primary text-on-primary shadow-sm font-semibold"
                : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            }`}
          >
            Khuyến mãi
          </button>
          <button
            type="button"
            onClick={() => handleNotice("Lịch sử đơn hàng")}
            className="px-3 py-2 font-label-lg text-label-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface rounded-lg transition-colors cursor-pointer"
          >
            Lịch sử đơn hàng
          </button>
          <a
            className="px-3 py-2 font-label-lg text-label-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface rounded-lg transition-colors"
            href="#footer"
          >
            Về BrewLite
          </a>
        </nav>

        <div className="flex items-center gap-space-md flex-shrink-0">
          <button
            id="header-cart-btn"
            onClick={() => {
              if (onCartClick) {
                onCartClick();
              } else {
                handleNotice("Giỏ hàng");
              }
            }}
            className="relative flex items-center gap-space-xs px-3.5 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container-high text-on-surface transition-all cursor-pointer"
            type="button"
          >
            <span className="material-symbols-outlined text-[22px] text-primary">
              shopping_bag
            </span>
            <span className="font-label-md text-label-md hidden sm:inline">
              Giỏ hàng
            </span>
            <span className="flex items-center justify-center px-2 py-0.5 rounded-full bg-primary text-on-primary font-label-md text-[11px] leading-tight">
              {cartCount} món
            </span>
          </button>

          <Link
            href="/login"
            title="Đăng nhập / Đăng ký tài khoản"
            className="flex items-center gap-space-sm pl-2 group cursor-pointer"
          >
            <img
              alt="Profile"
              className="w-8 h-8 rounded-full object-cover shadow-[0_1px_4px_rgba(0,0,0,0.1)] ring-1 ring-surface-variant group-hover:ring-primary transition-all"
              src={userProfile.avatarUrl}
            />
            <div className="hidden sm:flex flex-col text-left">
              <span className="font-title-sm text-title-sm text-on-surface leading-tight group-hover:text-primary transition-colors">
                {userProfile.fullName}
              </span>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="font-label-md text-[11px] text-primary font-bold bg-primary-fixed/60 px-1.5 py-0.2 rounded">
                  {userProfile.tierName}
                </span>
                <span className="font-label-md text-[11px] text-tertiary font-semibold">
                  💎 {userProfile.points} điểm
                </span>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </header>
  );
}
