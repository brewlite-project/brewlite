import React from "react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import HeroBanner from "@/components/HeroBanner";
import ProductSkeletonGrid from "@/components/ProductSkeletonGrid";
import { MOCK_HERO_BANNER, MOCK_SITE_CONFIG } from "@/mock-data";

export default function Loading() {
  return (
    <div className="min-h-screen flex flex-col bg-background font-body-md text-on-surface">
      <Header activeNav="thuc-don" siteConfig={MOCK_SITE_CONFIG} />

      <main className="w-full pt-20 bg-background min-h-screen flex-1">
        <div className="flex flex-col w-full">
          <div
            role="status"
            aria-live="polite"
            className="w-full bg-gradient-to-r from-surface-container-low via-surface to-surface-container-low py-space-xs px-margin shadow-sm"
          >
            <div className="max-w-[1320px] mx-auto flex items-center justify-between">
              <div className="flex items-center gap-space-sm text-on-surface-variant font-body-sm text-body-sm">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
                </span>
                <span className="font-medium text-on-surface">
                  Đang đồng bộ thực đơn:
                </span>
                <span>
                  Thực đơn chi nhánh Saigon Center đang được tải xuống...
                </span>
              </div>
            </div>
          </div>

          <HeroBanner data={MOCK_HERO_BANNER} />

          <section className="max-w-[1320px] mx-auto px-margin w-full py-space-xl">
            <div className="flex items-center justify-between mb-space-lg">
              <div className="flex items-baseline gap-space-sm">
                <h2 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
                  Thực Đơn Chọn Lọc
                </h2>
                <span className="bg-surface-container px-2.5 py-0.5 rounded-md text-primary font-body-sm text-body-sm font-medium">
                  8 thẻ mẫu vị trí
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-tertiary font-body-sm text-body-sm">
                <span className="material-symbols-outlined text-[16px] animate-spin">
                  sync
                </span>
                <span>Tự động làm mới khi có dữ liệu</span>
              </div>
            </div>

            <ProductSkeletonGrid />
          </section>
        </div>
      </main>

      <Footer siteConfig={MOCK_SITE_CONFIG} />
    </div>
  );
}
