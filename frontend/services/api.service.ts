import {
  MOCK_CATEGORIES,
  MOCK_HERO_BANNER,
  MOCK_PRICE_FILTER_OPTIONS,
  MOCK_PRODUCT_DETAILS,
  MOCK_PRODUCTS_RESPONSE,
  MOCK_SITE_CONFIG,
  MOCK_SORT_OPTIONS,
  type CategoryOption,
  type DrinkSize,
  type HeroBannerData,
  type ProductDetail,
  type ProductListItem,
  type ProductListResponse,
  type SelectOption,
  type SiteConfigData,
  type ToppingOption,
} from "@/mock-data";

// ============================================================================
// BREWLITE SERVICE & BUSINESS RULES — SPRINT 2 (PRODUCT CATALOG & MENU)
// Đối chiếu chuẩn 100% với:
// - docs/api/BrewLite_API_Contract_v2.1.md (Mục 2, 3, 4, 5)
// - backend/prisma/seed.ts
// - database/schema.dbml
// ============================================================================

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const FALLBACK_DRINK_IMAGE = "/images/product-placeholder.svg";

/** Độ trễ mô phỏng quá trình tải dữ liệu từ máy chủ nếu cần (~420ms theo thiết kế Stitch) */
export const SIMULATED_LOADING_DELAY_MS = 420;

/**
 * Business Rules theo API Contract v2.1 Mục 4.4 & database/schema.dbml:
 * - Size mặc định trên Frontend là S (100%) hoặc ONE_SIZE (100%)
 * - Mỗi ly chọn tối đa 3 loại Topping khác nhau; mỗi loại chỉ chọn 1 lần
 * - Số lượng mỗi dòng sản phẩm: 1 <= quantity <= 10
 */
export const DEFAULT_DRINK_SIZE: DrinkSize = "S";
export const MAX_TOPPINGS_PER_ITEM = 3;
export const MIN_ORDER_QUANTITY = 1;
export const MAX_ORDER_QUANTITY = 10;

/**
 * Định dạng số nguyên VND sang chuỗi hiển thị trên UI (API Contract Mục 2.3)
 */
export function formatVnd(amountVnd: number): string {
  return `${Math.round(amountVnd).toLocaleString("vi-VN")}\u00A0₫`;
}

/**
 * Kiểm tra định dạng UUID hợp lệ (tương thích với ParseUUIDPipe của NestJS — Mục 4.2 / 5.1)
 */
export function isValidUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id.trim()
  );
}

/**
 * Công thức tính giá theo Size (API Contract Mục 4.5):
 * sizePriceVnd = floor(basePriceVnd * multiplierPercent / 100)
 */
export function calculateSizePriceVnd(
  basePriceVnd: number,
  multiplierPercent: number
): number {
  if (!Number.isSafeInteger(basePriceVnd) || basePriceVnd < 0) {
    return 0;
  }
  return Math.floor((basePriceVnd * multiplierPercent) / 100);
}

/**
 * Chênh lệch giá của Size đang chọn so với giá cơ bản Size S (100%)
 */
export function calculateSizeExtraVnd(
  basePriceVnd: number,
  multiplierPercent: number
): number {
  return Math.max(
    0,
    calculateSizePriceVnd(basePriceVnd, multiplierPercent) - basePriceVnd
  );
}

/**
 * Công thức tính đơn giá 1 ly (API Contract Mục 4.5):
 * unitPriceVnd = floor(basePriceVnd * multiplierPercent / 100) + sum(topping.priceVnd)
 * Lưu ý: Topping có giá cố định, không nhân hệ số Size.
 */
export function calculateUnitPriceVnd(
  basePriceVnd: number,
  multiplierPercent: number,
  selectedToppings: Pick<ToppingOption, "priceVnd">[]
): number {
  const sizePrice = calculateSizePriceVnd(basePriceVnd, multiplierPercent);
  const toppingSum = selectedToppings.reduce(
    (sum, item) => sum + (Number.isSafeInteger(item.priceVnd) ? item.priceVnd : 0),
    0
  );
  return sizePrice + toppingSum;
}

/**
 * Công thức tính thành tiền theo số lượng (API Contract Mục 4.5):
 * lineTotalVnd = unitPriceVnd * quantity
 */
export function calculateLineTotalVnd(
  unitPriceVnd: number,
  quantity: number
): number {
  const clampedQty = Math.max(
    MIN_ORDER_QUANTITY,
    Math.min(MAX_ORDER_QUANTITY, Math.trunc(quantity))
  );
  return unitPriceVnd * clampedQty;
}

/**
 * Sắp xếp danh sách sản phẩm theo đúng quy tắc BR-017 & API Contract Mục 3.4:
 * Theo `name` tăng dần (A -> Z), nếu trùng tên thì theo `id` tăng dần.
 */
export function sortProductsByContract(
  items: ProductListItem[]
): ProductListItem[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, "vi");
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

function waitDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Lấy danh sách đồ uống từ API Backend (`GET /products`)
 * Tuân thủ API Contract v2.1 Mục 3.
 *
 * Lưu ý quan trọng:
 * - Khi chạy trên trình duyệt (client), ưu tiên gọi qua Next.js Rewrite Proxy `/api/backend/products`
 *   để triệt tiêu hoàn toàn lỗi CORS do khác cổng giữa Frontend (3000) và Backend (3001) mà không cần can thiệp Backend.
 * - Nếu API trả HTTP 200 nhưng items không phải mảng, ném lỗi để chuyển sang Error State thay vì coi là danh sách rỗng.
 * - Danh sách rỗng hợp lệ khi items là mảng rỗng `[]`.
 */
export async function getProducts(options?: {
  delayMs?: number;
  forceEmpty?: boolean;
  forceError?: boolean;
}): Promise<ProductListResponse> {
  if (options?.forceError) {
    const err = new Error("Lỗi máy chủ nội bộ (Internal Server Error)");
    (err as { statusCode?: number }).statusCode = 500;
    (err as { errorTitle?: string }).errorTitle = "INTERNAL_SERVER_ERROR";
    throw err;
  }
  if (options?.forceEmpty) {
    return { items: [] };
  }
  if (options?.delayMs && options.delayMs > 0) {
    await waitDelay(options.delayMs);
  }

  const isBrowser = typeof window !== "undefined";
  const primaryUrl = isBrowser ? "/api/backend/products" : `${API_BASE_URL}/products`;
  const fallbackUrl = isBrowser ? `${API_BASE_URL}/products` : "/api/backend/products";

  let response: Response;
  try {
    response = await fetch(primaryUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (primaryErr) {
    try {
      response = await fetch(fallbackUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
      });
    } catch {
      throw primaryErr;
    }
  }

  if (!response.ok) {
    let errorDetail = `Lỗi yêu cầu API: HTTP ${response.status} ${response.statusText}`;
    let statusCode: number = response.status;
    let errorTitle: string | undefined = undefined;
    try {
      const errorJson = await response.json();
      if (typeof errorJson?.statusCode === "number") {
        statusCode = errorJson.statusCode;
      }
      if (typeof errorJson?.error === "string") {
        errorTitle = errorJson.error;
      }
      if (errorJson?.message) {
        errorDetail = Array.isArray(errorJson.message)
          ? errorJson.message.join(", ")
          : String(errorJson.message);
      }
    } catch {
      // Bỏ qua lỗi parse JSON nếu response không phải JSON
    }
    const err = new Error(errorDetail);
    (err as { statusCode?: number }).statusCode = statusCode;
    if (errorTitle) {
      (err as { errorTitle?: string }).errorTitle = errorTitle;
    }
    throw err;
  }

  const data: ProductListResponse = await response.json();

  // Điểm 1: Nếu API trả HTTP 200 nhưng items không phải mảng, ném lỗi chuyển sang Error State thay vì coi là danh sách rỗng
  if (!data || !Array.isArray(data.items)) {
    throw new Error(
      "Dữ liệu danh sách sản phẩm không hợp lệ: phản hồi từ máy chủ không chứa mảng 'items'."
    );
  }

  return {
    items: sortProductsByContract(data.items),
  };
}

export type ProductDetailLookupResult =
  | {
      status: 200;
      data: ProductDetail;
    }
  | {
      status: 400;
      message: string;
      error: "Bad Request";
    }
  | {
      status: 404;
      message: string;
      error: "Not Found";
    }
  | {
      status: 500;
      message: string;
      error: "Internal Server Error";
    };

/**
 * Gọi thực tế API Backend `GET /products/:id` (SCRUM-32: Integrate Product Detail API)
 * - Tuân thủ API Contract v2.1 Mục 4.
 * - Gọi request tới `${API_BASE_URL}/products/:id` (tự động fallback qua Next.js rewrite `/api/backend/products/:id` nếu gặp chặn CORS trên client)
 * - Xử lý đầy đủ các mã trạng thái HTTP: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error & lỗi mạng.
 */
export async function fetchProductDetailById(
  id: string,
  signal?: AbortSignal
): Promise<ProductDetailLookupResult> {
  const trimmedId = (id || "").trim();

  // Kiểm tra nhanh định dạng UUID trước để trả về 400 theo chuẩn
  if (!isValidUuid(trimmedId)) {
    return {
      status: 400,
      message: "Validation failed (uuid is expected)",
      error: "Bad Request",
    };
  }

  const isBrowser = typeof window !== "undefined";
  const encodedId = encodeURIComponent(trimmedId);
  const primaryUrl = isBrowser
    ? `/api/backend/products/${encodedId}`
    : `${API_BASE_URL}/products/${encodedId}`;
  const fallbackUrl = isBrowser
    ? `${API_BASE_URL}/products/${encodedId}`
    : `/api/backend/products/${encodedId}`;

  let response: Response;
  try {
    response = await fetch(primaryUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      signal,
    });
  } catch (primaryErr) {
    if (signal?.aborted) throw primaryErr;
    try {
      response = await fetch(fallbackUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        signal,
      });
    } catch (fallbackErr) {
      if (signal?.aborted) throw fallbackErr;
      return {
        status: 500,
        message:
          "Không thể kết nối đến máy chủ Backend (GET /products/:id). Vui lòng kiểm tra lại dịch vụ Backend.",
        error: "Internal Server Error",
      };
    }
  }

  if (response.status === 400) {
    const errorJson = await response.json().catch(() => null);
    return {
      status: 400,
      message:
        typeof errorJson?.message === "string"
          ? errorJson.message
          : "Validation failed (uuid is expected)",
      error: "Bad Request",
    };
  }

  if (response.status === 404) {
    const errorJson = await response.json().catch(() => null);
    return {
      status: 404,
      message:
        typeof errorJson?.message === "string"
          ? errorJson.message
          : "Product not found",
      error: "Not Found",
    };
  }

  if (!response.ok) {
    const errorJson = await response.json().catch(() => null);
    return {
      status: 500,
      message:
        typeof errorJson?.message === "string"
          ? errorJson.message
          : `Lỗi máy chủ khi tải chi tiết sản phẩm (HTTP ${response.status}).`,
      error: "Internal Server Error",
    };
  }

  const apiData = (await response.json()) as ProductDetail;

  // Lấy thêm metadata phụ trợ nếu có trong mock data (flavorNotes, originBadge, v.v.)
  const uiMeta = MOCK_PRODUCT_DETAILS[apiData.id];

  return {
    status: 200,
    data: {
      ...uiMeta,
      ...apiData,
      id: apiData.id,
      name: apiData.name,
      imageUrl: apiData.imageUrl || uiMeta?.imageUrl || FALLBACK_DRINK_IMAGE,
      basePriceVnd: Number(apiData.basePriceVnd),
      isAvailable: Boolean(apiData.isAvailable),
      sizePolicy:
        apiData.sizePolicy ||
        (apiData.sizes?.length === 1 && apiData.sizes[0]?.size === "ONE_SIZE"
          ? "ONE_SIZE"
          : "STANDARD"),
      sizes: Array.isArray(apiData.sizes)
        ? apiData.sizes.map((s) => ({
            size: s.size,
            multiplierPercent: Number(s.multiplierPercent),
          }))
        : [],
      toppings: Array.isArray(apiData.toppings)
        ? apiData.toppings.map((t) => ({
            id: t.id,
            code: t.code,
            name: t.name,
            priceVnd: Number(t.priceVnd),
            isAvailable: t.isAvailable !== false,
          }))
        : [],
    },
  };
}

/**
 * Lấy chi tiết đồ uống theo ID (`GET /products/:id`)
 * Kết nối API Backend thật và trả về ProductDetail nếu thành công (200 OK)
 */
export async function getProductById(
  id: string
): Promise<ProductDetail | null> {
  const result = await fetchProductDetailById(id);
  return result.status === 200 ? result.data : null;
}

/**
 * Tra cứu chi tiết sản phẩm từ Mock Data (giữ lại hỗ trợ fallback / test offline)
 */
export function lookupProductDetailById(id: string): ProductDetailLookupResult {
  const trimmedId = (id || "").trim();
  if (!isValidUuid(trimmedId)) {
    return {
      status: 400,
      message: "Validation failed (uuid is expected)",
      error: "Bad Request",
    };
  }
  const detail = MOCK_PRODUCT_DETAILS[trimmedId];
  if (!detail) {
    return {
      status: 404,
      message: "Product not found",
      error: "Not Found",
    };
  }
  return {
    status: 200,
    data: detail,
  };
}

/**
 * Lấy dữ liệu cấu hình và danh sách sản phẩm mẫu cho trang Thực đơn
 */
export function getCatalogData(): {
  products: ProductListItem[];
  categories: CategoryOption[];
  sortOptions: SelectOption[];
  priceFilterOptions: SelectOption[];
  heroBanner: HeroBannerData;
  siteConfig: SiteConfigData;
} {
  const sortedItems = sortProductsByContract(MOCK_PRODUCTS_RESPONSE.items);
  const categoryCounts = sortedItems.reduce<Record<string, number>>((acc, item) => {
    const code =
      typeof item.category === "object" && item.category !== null
        ? item.category.code
        : (item.category as string);
    if (code) {
      acc[code] = (acc[code] || 0) + 1;
    }
    return acc;
  }, {});

  return {
    products: sortedItems,
    categories: MOCK_CATEGORIES.map((cat) => {
      if (cat.id === "all") {
        return { ...cat, label: `Tất cả (${sortedItems.length})` };
      }
      const count = categoryCounts[cat.id] ?? 0;
      return {
        ...cat,
        label: `${cat.label.replace(/\s*\(\d+\)/, "")} (${count})`,
      };
    }),
    sortOptions: MOCK_SORT_OPTIONS,
    priceFilterOptions: MOCK_PRICE_FILTER_OPTIONS,
    heroBanner: MOCK_HERO_BANNER,
    siteConfig: {
      ...MOCK_SITE_CONFIG,
      totalCatalogCount: sortedItems.length,
    },
  };
}

/**
 * Tải dữ liệu trang Thực đơn bất đồng bộ kết nối API thật (`GET /products`)
 */
export async function fetchCatalogData(options?: {
  delayMs?: number;
  forceEmpty?: boolean;
  forceError?: boolean;
}): Promise<{
  products: ProductListItem[];
  categories: CategoryOption[];
  sortOptions: SelectOption[];
  priceFilterOptions: SelectOption[];
  heroBanner: HeroBannerData;
  siteConfig: SiteConfigData;
}> {
  const productListResponse = await getProducts(options);
  const items = productListResponse.items;

  // Tính số lượng món theo từng danh mục
  const categoryCounts = items.reduce<Record<string, number>>((acc, item) => {
    const code =
      typeof item.category === "object" && item.category !== null
        ? item.category.code
        : (item.category as string);
    if (code) {
      acc[code] = (acc[code] || 0) + 1;
    }
    return acc;
  }, {});

  const dynamicCategories: CategoryOption[] = MOCK_CATEGORIES.map((cat) => {
    if (cat.id === "all") {
      return { ...cat, label: `Tất cả (${items.length})` };
    }
    const count = categoryCounts[cat.id] ?? 0;
    return {
      ...cat,
      label: `${cat.label.replace(/\s*\(\d+\)/, "")} (${count})`,
    };
  });

  return {
    products: items,
    categories: dynamicCategories,
    sortOptions: MOCK_SORT_OPTIONS,
    priceFilterOptions: MOCK_PRICE_FILTER_OPTIONS,
    heroBanner: MOCK_HERO_BANNER,
    siteConfig: {
      ...MOCK_SITE_CONFIG,
      totalCatalogCount: items.length,
    },
  };
}
