"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import HeroBanner from "@/components/HeroBanner";
import CategoryFilterBar from "@/components/CategoryFilterBar";
import ProductCard from "@/components/ProductCard";
import ProductSkeletonGrid from "@/components/ProductSkeletonGrid";
import ProductEmptyState from "@/components/ProductEmptyState";
import ProductErrorState from "@/components/ProductErrorState";

import {
  MOCK_CATEGORIES,
  MOCK_HERO_BANNER,
  MOCK_PRICE_FILTER_OPTIONS,
  MOCK_SITE_CONFIG,
  MOCK_SORT_OPTIONS,
  type CategoryId,
  type CategoryOption,
  type HeroBannerData,
  type ProductListItem,
  type SelectOption,
  type SiteConfigData,
} from "@/mock-data";
import { fetchCatalogData } from "@/services/api.service";
import { useCart } from "@/context/CartContext";

export default function HomePage() {
  const { openCart, totalQuantity } = useCart();
  // ==========================================================================
  // PHẦN 1: QUẢN LÝ STATE & TẢI DỮ LIỆU TỪ API (GET /products)
  // ==========================================================================
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);

  const [categories, setCategories] =
    useState<CategoryOption[]>(MOCK_CATEGORIES);
  const [sortOptions, setSortOptions] =
    useState<SelectOption[]>(MOCK_SORT_OPTIONS);
  const [priceFilterOptions, setPriceFilterOptions] = useState<SelectOption[]>(
    MOCK_PRICE_FILTER_OPTIONS
  );
  const [heroBanner, setHeroBanner] =
    useState<HeroBannerData>(MOCK_HERO_BANNER);
  const [siteConfig, setSiteConfig] =
    useState<SiteConfigData>(MOCK_SITE_CONFIG);

  const [activeCategory, setActiveCategory] = useState<CategoryId>("all");
  const [sortBy, setSortBy] = useState("popular");
  const [priceRange, setPriceRange] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Thông báo toast khi tương tác với nút "Thêm vào giỏ", ô "Giỏ hàng" hoặc các chức năng chưa cập nhật
  const [toastMessage, setToastMessage] = useState(
    "Mục giỏ hàng hiện đang trong quá trình xây dựng"
  );
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let isCancelled = false;

    // Hỗ trợ Tester kiểm thử nhanh qua query param (?state=empty | ?state=error | ?state=loading)
    const searchParams =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const stateParam = searchParams?.get("state")?.toLowerCase();

    if (stateParam === "loading") {
      return () => {
        isCancelled = true;
      };
    }

    fetchCatalogData({
      forceEmpty: stateParam === "empty",
      forceError: stateParam === "error",
    })
      .then((catalogRes) => {
        if (isCancelled) return;
        setProducts(catalogRes.products);
        setCategories(catalogRes.categories);
        setSortOptions(catalogRes.sortOptions);
        setPriceFilterOptions(catalogRes.priceFilterOptions);
        setHeroBanner(catalogRes.heroBanner);
        setSiteConfig(catalogRes.siteConfig);
        setErrorMessage(null);
        setErrorCode(null);
        setErrorTitle(null);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        setProducts([]);
        setCategories(
          MOCK_CATEGORIES.map((cat) =>
            cat.id === "all" ? { ...cat, label: "Tất cả (0)" } : cat
          )
        );
        setSiteConfig((prev) => ({
          ...prev,
          totalCatalogCount: 0,
        }));
        const customMsg =
          err instanceof Error && err.message
            ? err.message
            : "Hệ thống kết nối đến quầy bar chi nhánh Saigon Center đang bị gián đoạn hoặc đường truyền không ổn định. Dữ liệu thực đơn và giá món chưa thể cập nhật theo thời gian thực.";
        const status =
          typeof (err as { statusCode?: unknown })?.statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : null;
        const title =
          typeof (err as { errorTitle?: unknown })?.errorTitle === "string"
            ? (err as { errorTitle: string }).errorTitle
            : null;
        setErrorMessage(customMsg);
        setErrorCode(status);
        setErrorTitle(title);
      })
      .finally(() => {
        if (isCancelled) return;
        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [reloadKey]);

  const handleRetryLoad = () => {
    setActiveCategory("all");
    setSortBy("popular");
    setPriceRange("all");
    setSearchQuery("");
    setIsLoading(true);
    setErrorMessage(null);
    setErrorCode(null);
    setErrorTitle(null);
    setProducts([]);
    setReloadKey((prev) => prev + 1);
  };

  const showToastNotice = (message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
    }, 3000);
  };

  const handleCartClick = () => {
    openCart();
  };

  const handleFeatureNotice = (featureLabel: string) => {
    showToastNotice(
      `Chức năng "${featureLabel}" đang hoàn thiện và sẽ ra mắt ở Sprint tiếp theo.`
    );
  };

  const handleAddToCart = () => {
    handleCartClick();
  };

  const handleDismissToast = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastVisible(false);
  };

  // Lọc và sắp xếp danh sách sản phẩm theo đúng chuẩn API Contract v2.1 (`basePriceVnd`, `name`, `id`, `isAvailable`, `category`)
  const filteredProducts = useMemo(() => {
    let list = [...products];

    if (activeCategory !== "all") {
      list = list.filter((p) => {
        const catCode =
          typeof p.category === "object" && p.category !== null
            ? p.category.code
            : p.category;
        return catCode === activeCategory;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description && p.description.toLowerCase().includes(q))
      );
    }

    if (priceRange === "under-45") {
      list = list.filter((p) => p.basePriceVnd < 45000);
    } else if (priceRange === "45-60") {
      list = list.filter(
        (p) => p.basePriceVnd >= 45000 && p.basePriceVnd <= 60000
      );
    } else if (priceRange === "above-60") {
      list = list.filter((p) => p.basePriceVnd > 60000);
    }

    if (sortBy === "price-asc") {
      list.sort(
        (a, b) =>
          a.basePriceVnd - b.basePriceVnd ||
          a.name.localeCompare(b.name, "vi") ||
          a.id.localeCompare(b.id)
      );
    } else if (sortBy === "price-desc") {
      list.sort(
        (a, b) =>
          b.basePriceVnd - a.basePriceVnd ||
          a.name.localeCompare(b.name, "vi") ||
          a.id.localeCompare(b.id)
      );
    } else if (sortBy === "newest") {
      list.sort(
        (a, b) =>
          (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) ||
          (b.badge === "Mới" ? 1 : 0) - (a.badge === "Mới" ? 1 : 0) ||
          a.name.localeCompare(b.name, "vi") ||
          a.id.localeCompare(b.id)
      );
    } else {
      // Mặc định theo API Contract v2.1 Mục 3.4 & BR-017: sắp xếp theo `name` ASC, sau đó `id` ASC
      list.sort(
        (a, b) =>
          a.name.localeCompare(b.name, "vi") || a.id.localeCompare(b.id)
      );
    }

    return list;
  }, [products, activeCategory, searchQuery, priceRange, sortBy]);

  // ==========================================================================
  // PHẦN 2: HIỂN THỊ GIAO DIỆN (UI RENDERING)
  // ==========================================================================
  return (
    <div className="min-h-screen flex flex-col bg-background font-body-md text-on-surface">
      <Header
        onCartClick={handleCartClick}
        onFeatureNotice={handleFeatureNotice}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeNav="thuc-don"
        siteConfig={siteConfig}
      />

      <main className="w-full pt-20 bg-background min-h-screen flex-1">
        <div className="flex flex-col w-full">
          {/* Thanh trạng thái đồng bộ thời gian thực — CHỈ hiển thị khi đang loading chưa nhận dữ liệu */}
          {isLoading && (
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
          )}

          <HeroBanner data={heroBanner} />

          <CategoryFilterBar
            categories={categories}
            sortOptions={sortOptions}
            priceFilterOptions={priceFilterOptions}
            activeCategory={activeCategory}
            onSelectCategory={setActiveCategory}
            sortBy={sortBy}
            onSortChange={setSortBy}
            priceRange={priceRange}
            onPriceRangeChange={setPriceRange}
          />

          <section className="max-w-[1320px] mx-auto px-margin w-full py-space-xl">
            <div className="flex items-center justify-between mb-space-lg">
              <div className="flex items-baseline gap-space-sm flex-wrap">
                <h2 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">
                  Thực Đơn Chọn Lọc
                </h2>
                {isLoading ? (
                  <span
                    id="state-counter"
                    className="bg-surface-container px-2.5 py-0.5 rounded-md text-primary font-body-sm text-body-sm font-medium"
                  >
                    8 thẻ mẫu vị trí
                  </span>
                ) : (
                  <span className="font-body-sm text-body-sm text-on-surface-variant">
                    {filteredProducts.length} trên tổng số{" "}
                    {siteConfig.totalCatalogCount} công thức đặc trưng
                  </span>
                )}
              </div>

              {isLoading ? (
                <div className="flex items-center gap-1.5 text-tertiary font-body-sm text-body-sm">
                  <span className="material-symbols-outlined text-[16px] animate-spin">
                    sync
                  </span>
                  <span>Tự động làm mới khi có dữ liệu</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-on-surface-variant font-body-sm text-body-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-secondary-container" />
                  {siteConfig.deliveryHighlight}
                </div>
              )}
            </div>

            {/* 1. TRẠNG THÁI LOADING (SKELETON SHIMMER) — Chỉ hiển thị khi đang tải chưa nhận dữ liệu */}
            {isLoading && <ProductSkeletonGrid />}

            {/* 2. TRẠNG THÁI LỖI KẾT NỐI (ERROR STATE — API Contract v2.1 Mục 5) */}
            {!isLoading && errorMessage && (
              <ProductErrorState
                onRetry={handleRetryLoad}
                errorMessage={errorMessage}
                errorCode={errorCode}
                errorTitle={errorTitle || undefined}
                hotline={siteConfig.hotline}
              />
            )}

            {/* 3. TRẠNG THÁI EMPTY STATE (Mảng dữ liệu rỗng items: [] khi GET /products trả về 200 OK — API Contract v2.1 Mục 3.4) */}
            {!isLoading && !errorMessage && filteredProducts.length === 0 && (
              <ProductEmptyState
                onReloadMenu={handleRetryLoad}
                hotline={siteConfig.hotline}
              />
            )}

            {/* 4. DANH SÁCH THẺ SẢN PHẨM (PRODUCT GRID) — Hiển thị khi đã nhận dữ liệu */}
            {!isLoading && !errorMessage && filteredProducts.length > 0 && (
              <div className="grid grid-cols-12 gap-gutter" id="menu-grid">
                {filteredProducts.map((product) => (
                  <div
                    key={product.id}
                    className="col-span-12 sm:col-span-6 lg:col-span-3"
                  >
                    <ProductCard
                      product={product}
                      onAddToCart={handleAddToCart}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Toast thông báo chức năng đang trong quá trình xây dựng */}
      <div
        role="status"
        aria-live="polite"
        className={`fixed bottom-6 right-6 z-50 bg-on-surface text-surface-container-lowest px-4 py-3 rounded-xl shadow-xl flex items-center gap-3 transition-all duration-300 ${
          toastVisible
            ? "translate-y-0 opacity-100"
            : "translate-y-8 opacity-0 pointer-events-none"
        }`}
      >
        <span className="material-symbols-outlined text-[20px] text-secondary-fixed">
          info
        </span>
        <span className="font-title-sm text-title-sm text-surface-container-lowest">
          {toastMessage}
        </span>
        <button
          type="button"
          onClick={handleDismissToast}
          aria-label="Đóng thông báo"
          className="ml-2 p-1 rounded-lg text-surface-variant hover:text-surface-container-lowest transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      <Footer siteConfig={siteConfig} />
    </div>
  );
}
