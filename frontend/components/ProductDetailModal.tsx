"use client";

import React, { useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import type {
  DrinkSize,
  ProductDetail,
  ProductSizeOption,
  ToppingOption,
} from "@/mock-data";
import {
  calculateLineTotalVnd,
  calculateSizeExtraVnd,
  calculateSizePriceVnd,
  calculateUnitPriceVnd,
  DEFAULT_DRINK_SIZE,
  FALLBACK_DRINK_IMAGE,
  formatVnd,
  MAX_ORDER_QUANTITY,
  MAX_TOPPINGS_PER_ITEM,
  MIN_ORDER_QUANTITY,
} from "@/services/api.service";

// ============================================================================
// KIỂU DỮ LIỆU ĐẦU RA KHI NHẤN "THÊM VÀO GIỎ HÀNG"
// ============================================================================
export interface AddToCartSelectionPayload {
  productId: string;
  productName: string;
  size: DrinkSize;
  sizeMultiplierPercent: number;
  toppingIds: string[];
  toppings: ToppingOption[];
  quantity: number;
  basePriceVnd: number;
  unitPriceVnd: number;
  lineTotalVnd: number;
  note: string;
}

export interface ProductDetailModalProps {
  /** Dữ liệu chi tiết sản phẩm theo chuẩn `GET /products/:id` từ mock-data chung */
  product: ProductDetail;
  /** Sự kiện đóng cửa sổ chi tiết (quay về Product Gallery) */
  onClose?: () => void;
  /** Sự kiện khi nhấn nút "Thêm vào giỏ hàng" */
  onAddToCart?: (payload: AddToCartSelectionPayload) => void;
}

// Mô tả dung tích hiển thị kèm theo từng Size S / M / L
const SIZE_VOLUME_LABELS: Record<DrinkSize, string> = {
  S: "Tiêu chuẩn (350ml)",
  M: "Vừa (480ml)",
  L: "Lớn (650ml)",
  ONE_SIZE: "Tiêu chuẩn (500ml)",
};

export default function ProductDetailModal(props: ProductDetailModalProps) {
  // Dùng key={props.product.id} để tự động reset toàn bộ lựa chọn khi đổi sang sản phẩm khác
  return <ProductDetailModalContent key={props.product.id} {...props} />;
}

function ProductDetailModalContent({
  // Lấy hàm addToCart từ CartContext

  product,
  onClose,
  onAddToCart,
}: ProductDetailModalProps) {
  // ==========================================================================
  // PHẦN 1: QUẢN LÝ STATE (SIZE, TOPPING, SỐ LƯỢNG, GHI CHÚ)
  // ==========================================================================
  const { addToCart } = useCart();

  // State lưu kích cỡ đang chọn — Mặc định là Size S (100%) theo Business Rule
  const initialSize: DrinkSize = useMemo(() => {
    if (product.sizePolicy === "ONE_SIZE") return "ONE_SIZE";
    const found = product.sizes.find((s) => s.size === DEFAULT_DRINK_SIZE);
    return found ? found.size : product.sizes[0]?.size || DEFAULT_DRINK_SIZE;
  }, [product.sizePolicy, product.sizes]);

  const [selectedSize, setSelectedSize] = useState<DrinkSize>(initialSize);

  // State lưu danh sách ID các topping đã tích chọn (tối đa 3 món)
  const isBakery =
    (typeof product.category === "object" && product.category?.code === "bakery") ||
    product.sizePolicy === "ONE_SIZE";

  const [selectedToppingIds, setSelectedToppingIds] = useState<string[]>([]);

  // State lưu số lượng ly (số nguyên từ 1 đến 10)
  const [quantity, setQuantity] = useState<number>(MIN_ORDER_QUANTITY);

  // State lưu chuỗi hiển thị trong ô input số lượng để người dùng có thể xóa và gõ trực tiếp
  const [qtyInput, setQtyInput] = useState<string>(String(MIN_ORDER_QUANTITY));

  // State lưu nội dung ghi chú pha chế (tối đa 100 ký tự)
  const [note, setNote] = useState<string>("");

  // State lưu thông báo cảnh báo khi chọn quá 3 topping hoặc nhập quá số lượng
  const [toppingWarning, setToppingWarning] = useState<string | null>(null);
  const [quantityWarning, setQuantityWarning] = useState<string | null>(null);

  // ==========================================================================
  // PHẦN 2: TÍNH TOÁN GIÁ TIỀN THEO CÔNG THỨC API CONTRACT (MỤC 4.5 / 4.6)
  // ==========================================================================

  // Lấy thông tin object Size đang chọn (S=100%, M=120%, L=140%)
  const activeSizeOption: ProductSizeOption = useMemo(() => {
    return (
      product.sizes.find((s) => s.size === selectedSize) ??
      product.sizes[0] ?? { size: "S", multiplierPercent: 100 }
    );
  }, [product.sizes, selectedSize]);

  // Lấy danh sách các object Topping tương ứng với các ID đã chọn
  const selectedToppings: ToppingOption[] = useMemo(() => {
    return product.toppings.filter((t) => selectedToppingIds.includes(t.id));
  }, [product.toppings, selectedToppingIds]);

  // Giá sản phẩm sau khi nhân hệ số Size: round_half_up(basePriceVnd * multiplierPercent / 100)
  const sizeAdjustedPriceVnd = useMemo(
    () =>
      calculateSizePriceVnd(
        product.basePriceVnd,
        activeSizeOption.multiplierPercent
      ),
    [product.basePriceVnd, activeSizeOption.multiplierPercent]
  );

  // Đơn giá 1 ly = Giá theo Size + Tổng tiền các Topping đã chọn (Topping giá cố định)
  const unitPriceVnd = useMemo(
    () =>
      calculateUnitPriceVnd(
        product.basePriceVnd,
        activeSizeOption.multiplierPercent,
        selectedToppings
      ),
    [product.basePriceVnd, activeSizeOption.multiplierPercent, selectedToppings]
  );

  // Tổng tiền tạm tính = Đơn giá 1 ly * Số lượng
  const lineTotalVnd = useMemo(
    () => calculateLineTotalVnd(unitPriceVnd, quantity),
    [unitPriceVnd, quantity]
  );

  // ==========================================================================
  // PHẦN 3: CÁC HÀM XỬ LÝ SỰ KIỆN TƯƠNG TÁC CỦA NGƯỜI DÙNG
  // ==========================================================================

  // Xử lý chọn / bỏ chọn Topping (Giới hạn tối đa 3 loại topping khác nhau)
  const handleToggleTopping = (toppingId: string) => {
    if (!product.isAvailable) return;
    setToppingWarning(null);

    setSelectedToppingIds((prev) => {
      if (prev.includes(toppingId)) {
        return prev.filter((id) => id !== toppingId);
      }
      if (prev.length >= MAX_TOPPINGS_PER_ITEM) {
        setToppingWarning(
          `Mỗi ly chỉ được chọn tối đa ${MAX_TOPPINGS_PER_ITEM} loại topping khác nhau.`
        );
        return prev;
      }
      return [...prev, toppingId];
    });
  };

  // Xử lý nhấn nút giảm số lượng (-)
  const handleDecreaseQty = () => {
    if (!product.isAvailable) return;
    setQuantityWarning(null);
    setQuantity((prev) => {
      const next = Math.max(MIN_ORDER_QUANTITY, prev - 1);
      setQtyInput(String(next));
      return next;
    });
  };

  // Xử lý nhấn nút tăng số lượng (+)
  const handleIncreaseQty = () => {
    if (!product.isAvailable) return;
    if (quantity >= MAX_ORDER_QUANTITY) {
      setQuantityWarning(
        `Số lượng tối đa cho mỗi dòng sản phẩm là ${MAX_ORDER_QUANTITY} ly.`
      );
      return;
    }
    setQuantityWarning(null);
    setQuantity((prev) => {
      const next = Math.min(MAX_ORDER_QUANTITY, prev + 1);
      setQtyInput(String(next));
      return next;
    });
  };

  // Xử lý khi người dùng gõ trực tiếp số lượng vào ô hiển thị
  const handleQtyInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!product.isAvailable) return;
    const digitsOnly = e.target.value.replace(/\D/g, "");

    if (digitsOnly === "") {
      setQtyInput("");
      setQuantityWarning(null);
      return;
    }

    const parsed = parseInt(digitsOnly, 10);
    if (Number.isNaN(parsed) || parsed < MIN_ORDER_QUANTITY) {
      setQtyInput(String(MIN_ORDER_QUANTITY));
      setQuantity(MIN_ORDER_QUANTITY);
      setQuantityWarning(null);
      return;
    }

    if (parsed > MAX_ORDER_QUANTITY) {
      setQtyInput(String(MAX_ORDER_QUANTITY));
      setQuantity(MAX_ORDER_QUANTITY);
      setQuantityWarning(
        `Số lượng tối đa cho mỗi dòng sản phẩm là ${MAX_ORDER_QUANTITY} ly.`
      );
      return;
    }

    setQuantityWarning(null);
    setQtyInput(String(parsed));
    setQuantity(parsed);
  };

  // Chuẩn hóa lại ô số lượng khi người dùng click ra ngoài (blur) mà để trống
  const handleQtyInputBlur = () => {
    const parsed = parseInt(qtyInput, 10);
    if (Number.isNaN(parsed) || parsed < MIN_ORDER_QUANTITY) {
      setQuantity(MIN_ORDER_QUANTITY);
      setQtyInput(String(MIN_ORDER_QUANTITY));
    } else if (parsed > MAX_ORDER_QUANTITY) {
      setQuantity(MAX_ORDER_QUANTITY);
      setQtyInput(String(MAX_ORDER_QUANTITY));
    } else {
      setQuantity(parsed);
      setQtyInput(String(parsed));
    }
  };

  // Xử lý khi nhấn nút "Thêm vào giỏ hàng"
  const handleSubmitAddToCart = () => {
    if (!product.isAvailable) return;

    const result = addToCart({
      productId: product.id,
      productName: product.name,
      imageUrl: product.imageUrl,
      size: activeSizeOption.size,
      sizeMultiplierPercent: activeSizeOption.multiplierPercent,
      basePriceVnd: product.basePriceVnd,
      toppings: selectedToppings,
      toppingIds: selectedToppings.map((t) => t.id),
      quantity,
      note: note.trim(),
      sizePolicy: product.sizePolicy,
    });

    if (result.success) {
      onAddToCart?.({
      productId: product.id,
      productName: product.name,
      size: activeSizeOption.size,
      sizeMultiplierPercent: activeSizeOption.multiplierPercent,
      toppingIds: selectedToppings.map((t) => t.id),
      toppings: selectedToppings,
      quantity,
      basePriceVnd: product.basePriceVnd,
      unitPriceVnd,
      lineTotalVnd,
      note: note.trim(),
      });
    }
  };

  // ==========================================================================
  // PHẦN 4: GIAO DIỆN HIỂN THỊ CHI TIẾT SẢN PHẨM (THEO THIẾT KẾ STITCH)
  // ==========================================================================
  return (
    // Đây là lớp nền mờ (Backdrop Overlay) bao phủ phía dưới Header, canh giữa hộp thoại chi tiết sản phẩm
    <div
      className="fixed inset-x-0 top-20 bottom-0 z-40 flex items-center justify-center p-2 sm:p-3 bg-on-surface/50 backdrop-blur-md transition-opacity duration-300"
      id="product-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose?.();
        }
      }}
    >
      {/* Đây là khung hộp thoại chính của trang Chi tiết sản phẩm (vừa khít 100% màn hình chuẩn không cần thu nhỏ 75%) */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-detail-title"
        className="relative w-full max-w-[760px] max-h-[calc(100vh-5.75rem)] bg-surface-container-lowest rounded-xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Đây là nút Đóng (X) ở góc trên bên phải để quay lại trang Product Gallery */}
        <button
          aria-label="Đóng cửa sổ và quay lại thực đơn"
          onClick={onClose}
          className="absolute top-2.5 right-2.5 z-20 w-8 h-8 rounded-full bg-surface-container-low hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface flex items-center justify-center transition-colors shadow-sm focus:outline-none cursor-pointer"
          type="button"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>

        {/* Bố cục lưới 12 cột: Cột trái (5 cột) + Cột phải (7 cột) */}
        <div className="grid grid-cols-12 flex-1 overflow-y-auto">
          {/* ================================================================
              CỘT BÊN TRÁI (5 CỘT): HÌNH ẢNH SẢN PHẨM, NHÃN NỔI BẬT & HỒ SƠ HƯƠNG VỊ
             ================================================================ */}
          <div className="col-span-12 md:col-span-5 bg-surface-container-low p-3.5 flex flex-col justify-between">
            <div className="flex flex-col gap-2.5">
              {/* Đây là khung chứa Hình ảnh chính của sản phẩm */}
              <div className="relative w-full h-[195px] rounded-lg overflow-hidden shadow-sm bg-surface-container">
                {/* Đây là hình ảnh sản phẩm (có tự động chuyển sang ảnh dự phòng nếu lỗi link ảnh) */}
                <img
                  className={`w-full h-full object-cover ${
                    !product.isAvailable ? "filter grayscale-[40%]" : ""
                  }`}
                  alt={product.imageAlt || product.name}
                  src={product.imageUrl}
                  onError={(e) => {
                    const target = e.currentTarget;
                    if (!target.src.endsWith(FALLBACK_DRINK_IMAGE)) {
                      target.src = FALLBACK_DRINK_IMAGE;
                    }
                  }}
                />

                {/* Đây là cụm Nhãn (Badges) đè lên góc trái trên của ảnh: "Bán chạy nhất" / "Mới" & vùng nguyên liệu */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 items-start z-10">
                  {product.badge && (
                    <span className="px-2 py-0.5 rounded-full bg-primary text-on-primary font-label-md text-[10.5px] shadow-sm flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        local_fire_department
                      </span>
                      {product.badge === "Best Seller"
                        ? "Bán chạy nhất"
                        : product.badge}
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded-full bg-surface-container-lowest/90 backdrop-blur-sm text-on-surface font-label-md text-[10.5px] shadow-sm">
                    {product.originBadge || (isBakery ? "Bơ Pháp hảo hạng" : "Rang mộc Đắk Lắk")}
                  </span>
                </div>

                {/* Đây là lớp phủ báo "Tạm hết hàng" đè lên ảnh khi sản phẩm có isAvailable = false */}
                {!product.isAvailable && (
                  <div className="absolute inset-0 bg-inverse-surface/40 backdrop-blur-[2px] flex items-center justify-center">
                    <span className="px-3 py-1 rounded-full font-label-md text-[11px] bg-surface text-error font-semibold shadow-md flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">
                        remove_shopping_cart
                      </span>
                      Tạm hết hàng
                    </span>
                  </div>
                )}
              </div>

              {/* Đây là thẻ Hồ sơ hương vị (Flavor Notes) & Thông số hạt cà phê */}
              <div className="bg-surface-container-lowest p-2.5 rounded-lg shadow-sm flex flex-col gap-1">
                {/* Tiêu đề mục Hồ sơ hương vị */}
                <div className="flex items-center gap-1 text-primary">
                  <span className="material-symbols-outlined text-[15px]">
                    verified
                  </span>
                  <span className="font-label-lg text-[12.5px] font-semibold">
                    Hồ sơ hương vị (Flavor Notes)
                  </span>
                </div>

                {/* Đoạn mô tả chi tiết hương vị của sản phẩm */}
                <p className="font-body-md text-[12px] leading-snug text-on-surface-variant">
                  {product.flavorNotes || product.description || (isBakery ? "Bánh sừng bò bơ Pháp ngàn lớp thơm lừng giòn rụm bên ngoài, mềm xốp béo ngậy bên trong." : "Hương vị cà phê thơm nồng đậm đà, hậu vị ngọt sâu hòa quyện cùng sữa đặc béo ngậy.")}
                </p>

                {/* Đây là 3 ô thông số kỹ thuật của đồ uống: Độ đậm - Loại hạt - Phương pháp chế biến */}
                <div className="grid grid-cols-3 gap-1 mt-1 bg-surface-container-low rounded p-1.5 text-center">
                  {/* Ô 1: Độ đậm */}
                  <div className="flex flex-col">
                    <span className="font-body-sm text-[10px] text-outline">
                      Độ đậm
                    </span>
                    <span className="font-label-md text-[11px] text-tertiary">
                      {product.intensity || (isBakery ? "Ngọt dịu" : "4/5 • Đậm")}
                    </span>
                  </div>
                  {/* Ô 2: Loại hạt */}
                  <div className="flex flex-col">
                    <span className="font-body-sm text-[10px] text-outline">
                      Hạt
                    </span>
                    <span className="font-label-md text-[11px] text-on-surface">
                      {product.beanType || (isBakery ? "Bột mì Pháp" : "Robusta")}
                    </span>
                  </div>
                  {/* Ô 3: Phương pháp chế biến */}
                  <div className="flex flex-col">
                    <span className="font-body-sm text-[10px] text-outline">
                      Chế biến
                    </span>
                    <span className="font-label-md text-[11px] text-on-surface">
                      {product.processMethod || (isBakery ? "Nướng tươi" : "Honey")}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Đây là dòng ghi chú tiêu chuẩn canh tác bền vững ở dưới cùng cột trái */}
            <div className="flex items-center gap-1.5 pt-2 text-outline font-body-sm text-[11px]">
              <span className="material-symbols-outlined text-[15px]">eco</span>
              <span>
                {product.sustainabilityNote || (isBakery ? "Nguyên liệu cao cấp tiêu chuẩn Châu Âu" : "Hạt canh tác bền vững theo tiêu chuẩn UTZ")}
              </span>
            </div>
          </div>

          {/* ================================================================
              CỘT BÊN PHẢI (7 CỘT): TÊN SP, GIÁ, CHỌN SIZE, CHỌN TOPPING, GHI CHÚ & SỐ LƯỢNG
             ================================================================ */}
          <div className="col-span-12 md:col-span-7 p-3.5 lg:px-5 lg:py-3.5 flex flex-col justify-between bg-surface-container-lowest">
            <div className="flex flex-col gap-2 pr-0.5">
              {/* ------------------------------------------------------------
                  MỤC 1 (CỘT PHẢI): NHÃN CÔNG THỨC, TÊN SẢN PHẨM & GIÁ CƠ BẢN
                 ------------------------------------------------------------ */}
              <div className="flex flex-col gap-0.5 pr-6">
                {/* Đây là hàng nhãn phân loại công thức, cách phục vụ và trạng thái Còn hàng / Hết hàng */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-label-md text-[10.5px] text-primary bg-primary-fixed px-2 py-0.5 rounded-full">
                    {product.recipeTag || (isBakery ? "Bánh nướng thủ công" : "Công thức Độc Quyền")}
                  </span>
                  <span className="font-body-sm text-[11px] text-outline">
                    • {product.servingNote || (isBakery ? "Phục vụ ấm / nóng" : "Phục vụ lạnh")}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full font-label-md text-[10px] ${
                      product.isAvailable
                        ? "bg-secondary-fixed text-on-secondary-fixed"
                        : "bg-error-container text-on-error-container"
                    }`}
                  >
                    {product.isAvailable ? "Còn hàng" : "Hết hàng"}
                  </span>
                </div>

                {/* Đây là Tên sản phẩm */}
                <h2
                  id="product-detail-title"
                  className="font-headline-lg text-[20px] leading-tight font-bold text-on-surface"
                >
                  {product.name}
                </h2>

                {/* Đây là Giá sản phẩm (hiển thị giá theo Size đang chọn và chú thích giá gốc Size S) */}
                <div className="flex items-baseline gap-2">
                  <span className="font-price-lg text-[18px] leading-tight font-bold text-primary">
                    {formatVnd(sizeAdjustedPriceVnd)}
                  </span>
                  {activeSizeOption.multiplierPercent > 100 && (
                    <span className="font-body-sm text-[11px] text-outline">
                      (Giá gốc Size S: {formatVnd(product.basePriceVnd)})
                    </span>
                  )}
                </div>
              </div>

              {/* ------------------------------------------------------------
                  MỤC 2 (CỘT PHẢI): CHỌN KÍCH CỠ LY (SIZE S = 100%, M = 120%, L = 140%)
                 ------------------------------------------------------------ */}
              <div className="flex flex-col gap-1">
                {/* Tiêu đề mục chọn Size */}
                <div className="flex items-center justify-between">
                  <span className="font-title-sm text-[13px] font-semibold text-on-surface">
                    Chọn Kích cỡ (Size)
                  </span>
                  <span className="font-label-md text-[11px] text-primary">
                    Bắt buộc chọn 1
                  </span>
                </div>

                {/* Đây là 3 ô chọn Size: Size S, Size M, Size L */}
                <div className={`grid gap-2 ${product.sizes.length === 1 ? "grid-cols-1 max-w-[220px]" : "grid-cols-3"}`}>
                  {product.sizes.map((sizeOption) => {
                    const isSelected = selectedSize === sizeOption.size;
                    const extraPriceVnd = calculateSizeExtraVnd(
                      product.basePriceVnd,
                      sizeOption.multiplierPercent
                    );

                    return (
                      // Đây là thẻ chọn từng Size (S / M / L)
                      <label
                        key={sizeOption.size}
                        className={`relative flex flex-col items-center justify-center py-1.5 px-2 rounded-lg transition-all ${
                          !product.isAvailable
                            ? "opacity-60 cursor-not-allowed"
                            : "cursor-pointer hover:bg-surface-container"
                        } ${
                          isSelected
                            ? "bg-surface-container-high"
                            : "bg-surface-container-low"
                        }`}
                      >
                        <input
                          checked={isSelected}
                          disabled={!product.isAvailable}
                          onChange={() => setSelectedSize(sizeOption.size)}
                          className="peer sr-only"
                          name="size-selection"
                          type="radio"
                          value={sizeOption.size}
                        />
                        <div className="w-full flex flex-col items-center text-center">
                          {/* Tên Size (Size S / Size M / Size L) */}
                          <span
                            className={`font-title-sm text-[13px] font-semibold leading-tight ${
                              isSelected ? "text-primary" : "text-on-surface"
                            }`}
                          >
                            {sizeOption.size === "ONE_SIZE" ? "Tiêu chuẩn (One Size)" : `Size ${sizeOption.size}`}
                          </span>
                          {/* Dung tích & phần trăm hệ số giá (100% / 120% / 140%) */}
                          <span className="font-body-sm text-[10.5px] leading-tight text-on-surface-variant">
                            {SIZE_VOLUME_LABELS[sizeOption.size]}
                          </span>
                          {/* Số tiền cộng thêm của Size đó so với Size S */}
                          <span className="font-label-md text-[11px] text-tertiary mt-0.5">
                            {extraPriceVnd === 0
                              ? "0 đ"
                              : `+${formatVnd(extraPriceVnd)}`}
                          </span>
                        </div>
                        <div
                          className={`absolute inset-0 rounded-lg bg-primary/10 pointer-events-none transition-opacity ${
                            isSelected ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        {/* Biểu tượng dấu tích xanh/nâu khi Size đang được chọn */}
                        {isSelected && (
                          <div className="absolute top-1 right-1.5 text-primary">
                            <span className="material-symbols-outlined text-[14px]">
                              check_circle
                            </span>
                          </div>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* ------------------------------------------------------------
                  MỤC 3 (CỘT PHẢI): CHỌN TOPPING YÊU THÍCH (TỐI ĐA 3 LOẠI KHÁC NHAU)
                 ------------------------------------------------------------ */}
              <div className="flex flex-col gap-0.5">
                {/* Tiêu đề mục chọn Topping & Huy hiệu đếm số lượng topping đã chọn (X/3) */}
                <div className="flex items-center justify-between">
                  <span className="font-title-sm text-[13px] font-semibold text-on-surface">
                    Chọn Topping yêu thích
                  </span>
                  {/* Đây là huy hiệu hiển thị số lượng topping đã chọn trên tổng số tối đa 3 món */}
                  <span
                    className="font-label-md text-[10.5px] px-2 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed"
                    id="topping-counter-badge"
                  >
                    Đã chọn: {selectedToppingIds.length}/{MAX_TOPPINGS_PER_ITEM}{" "}
                    món thêm
                  </span>
                </div>
                <p className="font-body-sm text-[11px] leading-tight text-outline">
                  Tối đa {MAX_TOPPINGS_PER_ITEM} loại topping để đảm bảo hương
                  vị cân bằng nhất.
                </p>

                {/* Đây là dòng cảnh báo hiện ra nếu người dùng bấm chọn quá 3 loại topping */}
                {toppingWarning && (
                  <p
                    role="alert"
                    className="font-label-md text-[11px] text-error flex items-center gap-1"
                  >
                    <span className="material-symbols-outlined text-[13px]">
                      error
                    </span>
                    {toppingWarning}
                  </p>
                )}

                {/* Đây là danh sách các dòng lựa chọn Topping (Checkbox + Tên Topping + Giá cố định) */}
                {product.toppings.length === 0 ? (
                  <p className="font-body-sm text-[11.5px] text-outline italic py-1">
                    Sản phẩm này hiện không có topping đi kèm.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1 mt-0.5">
                    {product.toppings.map((topping) => {
                      const isChecked = selectedToppingIds.includes(topping.id);
                      return (
                        // Đây là từng hàng Topping trong danh sách
                        <label
                          key={topping.id}
                          className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-surface-container-low transition-colors group ${
                            !product.isAvailable
                              ? "opacity-60 cursor-not-allowed"
                              : "hover:bg-surface-container cursor-pointer"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {/* Ô tích chọn Topping */}
                            <input
                              checked={isChecked}
                              disabled={!product.isAvailable}
                              onChange={() => handleToggleTopping(topping.id)}
                              className="topping-cb w-3.5 h-3.5 rounded text-primary accent-primary cursor-pointer"
                              type="checkbox"
                              value={topping.priceVnd}
                            />
                            {/* Tên Topping */}
                            <span className="font-body-md text-[12.5px] text-on-surface group-hover:text-primary transition-colors">
                              {topping.name}
                            </span>
                          </div>
                          {/* Giá tiền cố định của Topping */}
                          <span className="font-label-lg text-[12.5px] font-semibold text-tertiary">
                            +{formatVnd(topping.priceVnd)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ------------------------------------------------------------
                  MỤC 4 (CỘT PHẢI): Ô NHẬP GHI CHÚ PHA CHẾ (YÊU CẦU ĐẶC BIỆT)
                 ------------------------------------------------------------ */}
              <div className="flex flex-col gap-1">
                <label
                  className="font-title-sm text-[13px] font-semibold text-on-surface flex items-center justify-between"
                  htmlFor="order-notes"
                >
                  <span>{isBakery ? "Yêu cầu đặc biệt (Ghi chú)" : "Yêu cầu đặc biệt (Ghi chú pha chế)"}</span>
                  <span className="font-body-sm text-[10.5px] font-normal text-outline">
                    Không bắt buộc
                  </span>
                </label>
                {/* Đây là ô nhập văn bản ghi chú pha chế kèm bộ đếm 0/100 ký tự */}
                <div className="relative">
                  <textarea
                    disabled={!product.isAvailable}
                    className="w-full py-1.5 pl-2.5 pr-11 bg-surface-container-low rounded-lg text-on-surface placeholder:text-outline font-body-sm text-[12px] focus:outline-none focus:bg-surface-container transition-all resize-none disabled:opacity-60"
                    id="order-notes"
                    maxLength={100}
                    placeholder={isBakery ? "" : "Ví dụ: Ít ngọt 50%, nhiều đá, để đá riêng..."}
                    rows={1}
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 100))}
                  />
                  {/* Bộ đếm số ký tự đã nhập (tối đa 100) */}
                  <span className="absolute bottom-1.5 right-2.5 text-[10px] font-body-sm text-outline">
                    {note.length}/100
                  </span>
                </div>
              </div>
            </div>

            {/* ------------------------------------------------------------
                MỤC 5 (CỘT PHẢI - DƯỚI CÙNG): CHỈNH SỐ LƯỢNG, TẠM TÍNH & NÚT THÊM VÀO GIỎ
               ------------------------------------------------------------ */}
            <div className="pt-2 mt-1.5 border-t border-surface-container bg-surface-container-lowest">
              {/* Cảnh báo khi người dùng nhập số lượng vượt quá giới hạn 10 ly */}
              {quantityWarning && (
                <p
                  role="alert"
                  className="font-label-md text-[11px] text-error flex items-center gap-1 mb-1"
                >
                  <span className="material-symbols-outlined text-[13px]">
                    info
                  </span>
                  {quantityWarning}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                {/* Đây là cụm điều chỉnh Số lượng sản phẩm (gồm nút -, ô nhập số trực tiếp, và nút +) */}
                <div className="flex flex-col gap-0.5">
                  <span className="font-body-sm text-[10px] text-outline">
                    Số lượng (1–{MAX_ORDER_QUANTITY})
                  </span>
                  <div className="flex items-center bg-surface-container-low rounded-lg p-0.5 shadow-sm">
                    {/* Đây là nút Giảm số lượng (-) */}
                    <button
                      aria-label="Giảm số lượng"
                      disabled={
                        !product.isAvailable || quantity <= MIN_ORDER_QUANTITY
                      }
                      onClick={handleDecreaseQty}
                      className="w-7 h-7 rounded-md bg-surface-container-lowest text-on-surface flex items-center justify-center hover:bg-surface-container-high transition-colors focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      id="btn-qty-minus"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        remove
                      </span>
                    </button>

                    {/* Đây là ô hiển thị Số lượng kiêm ô nhập số trực tiếp từ bàn phím */}
                    <input
                      aria-label="Nhập số lượng sản phẩm"
                      disabled={!product.isAvailable}
                      id="qty-display"
                      type="text"
                      inputMode="numeric"
                      value={qtyInput}
                      onChange={handleQtyInputChange}
                      onBlur={handleQtyInputBlur}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                      }}
                      className="font-title-md text-[14px] text-on-surface w-9 h-7 text-center font-bold bg-transparent rounded-md focus:outline-none focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary transition-all disabled:opacity-50"
                    />

                    {/* Đây là nút Tăng số lượng (+) */}
                    <button
                      aria-label="Tăng số lượng"
                      disabled={
                        !product.isAvailable || quantity >= MAX_ORDER_QUANTITY
                      }
                      onClick={handleIncreaseQty}
                      className="w-7 h-7 rounded-md bg-surface-container-lowest text-on-surface flex items-center justify-center hover:bg-surface-container-high transition-colors focus:outline-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      id="btn-qty-plus"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        add
                      </span>
                    </button>
                  </div>
                </div>

                {/* Đây là khu vực hiển thị Tổng tiền tạm tính & Nút "Thêm vào giỏ hàng" */}
                <div className="flex-1 flex flex-col items-end">
                  {/* Dòng hiển thị công thức và Tổng tiền Tạm tính */}
                  <div className="flex items-baseline gap-1.5 mb-0.5">
                    <span className="font-body-sm text-[11px] text-on-surface-variant">
                      Tạm tính ({quantity} ly × {formatVnd(unitPriceVnd)}):
                    </span>
                    <span
                      className="font-title-md text-[14px] text-primary font-bold"
                      id="temp-total-display"
                    >
                      {formatVnd(lineTotalVnd)}
                    </span>
                  </div>

                  {/* Đây là Nút bấm chính "Thêm vào giỏ hàng" (Tự động khóa lại nếu sản phẩm tạm hết hàng) */}
                  <button
                    disabled={!product.isAvailable}
                    onClick={handleSubmitAddToCart}
                    className={`w-full flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg font-title-sm text-[13.5px] font-semibold shadow-md transition-all focus:outline-none ${
                      product.isAvailable
                        ? "bg-primary hover:bg-secondary text-on-primary active:scale-[0.99] cursor-pointer"
                        : "bg-surface-container-high text-outline cursor-not-allowed"
                    }`}
                    id="btn-add-cart"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      {product.isAvailable
                        ? "shopping_bag"
                        : "remove_shopping_cart"}
                    </span>
                    <span id="cta-button-text">
                      {product.isAvailable
                        ? `Thêm vào giỏ hàng • ${formatVnd(lineTotalVnd)}`
                        : "Sản phẩm tạm hết hàng"}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
