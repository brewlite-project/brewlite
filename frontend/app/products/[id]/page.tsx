"use client";

import React, { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCart } from "@/context/CartContext";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductDetailModal from "@/components/ProductDetailModal";
import {
  fetchCatalogData,
  fetchProductDetailById,
  getCatalogData,
  type ProductDetailLookupResult,
} from "@/services/api.service";
import type {
  CategoryOption,
  ProductListItem,
  SiteConfigData,
} from "@/mock-data";

interface ProductDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function ProductDetailPage({ params }: ProductDetailPageProps) {
  // Lấy ID sản phẩm từ đường dẫn URL (/products/[id])
  const { id } = use(params);
  const router = useRouter();
  const { openCart, totalQuantity } = useCart();

  // Dữ liệu danh mục và sản phẩm cho lớp nền mờ phía sau
  const initialCatalog = useMemo(() => getCatalogData(), []);
  const [catalogProducts, setCatalogProducts] = useState<ProductListItem[]>(
    initialCatalog.products
  );
  const [categories, setCategories] = useState<CategoryOption[]>(
    initialCatalog.categories
  );
  const [siteConfig, setSiteConfig] = useState<SiteConfigData>(
    initialCatalog.siteConfig
  );

  // State quản lý gọi API Backend thật GET /products/:id (SCRUM-32)
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lookupResult, setLookupResult] =
    useState<ProductDetailLookupResult | null>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);

  // State hiển thị thông báo (Toast) khi bấm "Thêm vào giỏ hàng" hoặc bấm vào ô "Giỏ hàng"
  const [toastVisible, setToastVisible] = useState<boolean>(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let isCancelled = false;
    const abortController = new AbortController();

    // 1. Tải catalog dữ liệu cho phần nền mờ
    fetchCatalogData()
      .then((res) => {
        if (isCancelled) return;
        setCatalogProducts(res.products);
        setCategories(res.categories);
        setSiteConfig(res.siteConfig);
      })
      .catch(() => {
        // Fallback đã có initialCatalog
      });

    // 2. Gọi API GET /products/:id thật đến Backend
    setIsLoading(true);
    fetchProductDetailById(id, abortController.signal)
      .then((res) => {
        if (isCancelled) return;
        setLookupResult(res);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        setLookupResult({
          status: 500,
          message:
            err instanceof Error && err.message
              ? err.message
              : "Không thể kết nối đến máy chủ Backend (cổng 3001).",
          error: "Internal Server Error",
        });
      })
      .finally(() => {
        if (isCancelled) return;
        setIsLoading(false);
      });

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [id, reloadKey]);

  // Hàm đóng cửa sổ chi tiết và điều hướng quay lại trang Product Gallery (/)
  const handleCloseModal = () => {
    router.push("/");
  };

  // Thử lại khi gặp lỗi kết nối
  const handleRetry = () => {
    setReloadKey((k) => k + 1);
  };

  // Hàm hiển thị thông báo: "Mục giỏ hàng hiện đang trong quá trình xây dựng"
  const showCartUnderConstructionNotice = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
    }, 3000);
  };

  // Hàm đóng thông báo (Toast) thủ công
  const handleDismissToast = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastVisible(false);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background font-body-md text-on-surface antialiased">
      {/* Thanh Header điều hướng trên cùng */}
      <Header
        cartCount={totalQuantity}
        onCartClick={openCart}
        activeNav="thuc-don"
        siteConfig={siteConfig}
      />

      <main className="w-full pt-20 bg-background min-h-screen flex-1">
        <div className="flex flex-col w-full relative">
          {/* Lớp nền trang Thực đơn được làm mờ phía dưới Modal */}
          <div className="w-full max-w-[1320px] mx-auto px-margin py-space-lg opacity-90 pointer-events-none select-none">
            <div className="flex items-center justify-between mb-space-lg">
              <div className="flex gap-space-sm flex-wrap">
                {categories.map((cat, index) => (
                  <span
                    key={cat.id}
                    className={`px-space-md py-2 rounded-full font-label-md text-label-md ${
                      index === 0
                        ? "bg-on-surface text-surface"
                        : "bg-surface-container-low text-on-surface-variant"
                    }`}
                  >
                    {cat.label}
                  </span>
                ))}
              </div>
              <div className="font-body-md text-body-md text-outline">
                Đang hiển thị {catalogProducts.length} sản phẩm
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-gutter">
              {catalogProducts.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="bg-surface-container-lowest p-space-md rounded-xl shadow-sm flex flex-col gap-space-sm"
                >
                  <div className="h-48 w-full bg-surface-container-high rounded-lg overflow-hidden">
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      className="w-full h-full object-cover opacity-60"
                    />
                  </div>
                  <div className="h-6 w-3/4 bg-surface-container-high rounded" />
                  <div className="h-4 w-1/2 bg-surface-container-high rounded" />
                </div>
              ))}
            </div>
          </div>

          {/* Hiển thị Trạng thái Đang tải, Hộp thoại Chi tiết (200 OK) hoặc Báo lỗi (400, 404, 500) */}
          {isLoading ? (
            <div
              data-testid="product-detail-loading"
              className="fixed inset-x-0 top-20 bottom-0 z-40 flex items-center justify-center p-2 sm:p-3 bg-on-surface/50 backdrop-blur-md"
            >
              <div className="w-full max-w-md bg-surface-container-lowest rounded-xl shadow-2xl p-space-xl text-center flex flex-col items-center gap-space-md">
                <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
                <h3 className="font-title-md text-title-md text-on-surface font-semibold">
                  Đang tải thông tin sản phẩm...
                </h3>
                <p className="font-body-sm text-body-sm text-outline">
                  Vui lòng chờ trong giây lát trong khi chúng tôi chuẩn bị thực đơn.
                </p>
              </div>
            </div>
          ) : lookupResult?.status === 200 ? (
            <ProductDetailModal
              product={lookupResult.data}
              onClose={handleCloseModal}
              onAddToCart={() => { openCart(); router.push("/"); }}
            />
          ) : (
            <div
              data-testid="product-detail-error"
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-on-surface/50 backdrop-blur-md"
            >
              <div className="w-full max-w-md bg-surface-container-lowest rounded-xl shadow-2xl p-space-xl text-center flex flex-col items-center gap-space-md">
                <div className="w-14 h-14 rounded-full bg-error-container text-on-error-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-[28px]">
                    {lookupResult?.status === 400
                      ? "warning"
                      : lookupResult?.status === 404
                      ? "search_off"
                      : "cloud_off"}
                  </span>
                </div>
                <span className="px-3 py-1 rounded-full bg-surface-container text-outline font-label-md text-label-md">
                  HTTP {lookupResult?.status || 500} • {lookupResult?.error || "Error"}
                </span>
                <h2 className="font-headline-md text-headline-md text-on-surface font-bold">
                  {lookupResult?.status === 400
                    ? "Mã sản phẩm không hợp lệ"
                    : lookupResult?.status === 404
                    ? "Không tìm thấy sản phẩm"
                    : "Lỗi kết nối máy chủ"}
                </h2>
                <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                  {lookupResult?.message ||
                    (lookupResult?.status === 400
                      ? "Định dạng Product ID trên đường dẫn không phải là UUID hợp lệ (400 Bad Request)."
                      : lookupResult?.status === 404
                      ? "Sản phẩm bạn đang tìm không tồn tại hoặc đã ngừng phục vụ (404 Not Found)."
                      : "Không thể kết nối đến máy chủ. Vui lòng kiểm tra lại dịch vụ Backend.")}
                </p>
                <div className="flex items-center gap-3 mt-2">
                  {lookupResult?.status === 500 && (
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="px-5 py-2.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface font-title-sm text-title-sm transition-colors cursor-pointer flex items-center gap-1.5"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        refresh
                      </span>
                      Thử lại
                    </button>
                  )}
                  <Link
                    href="/"
                    className="px-6 py-2.5 rounded-lg bg-primary hover:bg-secondary text-on-primary font-title-sm text-title-sm shadow-md transition-colors inline-flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      arrow_back
                    </span>
                    Quay lại Thực đơn
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Hộp thông báo nổi (Toast) khi nhấn "Thêm vào giỏ hàng" hoặc ô "Giỏ hàng" */}
      <div
        role="status"
        aria-live="polite"
        className={`fixed bottom-6 right-6 z-[60] bg-on-surface text-surface-container-lowest px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 transition-all duration-300 ${
          toastVisible
            ? "translate-y-0 opacity-100"
            : "translate-y-8 opacity-0 pointer-events-none"
        }`}
      >
        <span className="material-symbols-outlined text-[20px] text-secondary-fixed">
          info
        </span>
        <span className="font-title-sm text-title-sm text-surface-container-lowest">
          Mục giỏ hàng hiện đang trong quá trình xây dựng
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
