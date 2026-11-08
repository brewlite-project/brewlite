"use client";

import React, { useState } from "react";
import Link from "next/link";
import { formatVnd, FALLBACK_DRINK_IMAGE } from "@/services/api.service";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

interface OrderSuccessViewProps {
  order: OrderConfirmationData;
  customerName?: string | null;
  userPoints?: number;
}

export function OrderSuccessView({
  order,
  customerName: rawCustomerName,
  userPoints = 0,
}: OrderSuccessViewProps) {
  const customerName = rawCustomerName?.trim() || "Quý khách";
  const [copiedVoucher, setCopiedVoucher] = useState(false);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);

  const formattedOrderId = `#BL-${order.id.slice(0, 8).toUpperCase()}`;
  const orderTimeFormatted = new Date(order.createdAt).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const paymentMethodLabel =
    order.payment?.method === "CARD"
      ? `Card •••• ${order.payment.methodLast4 || "0001"}`
      : order.payment?.method === "WALLET"
      ? `Ví điện tử •••• ${order.payment.methodLast4 || "5678"}`
      : "Thanh toán trực tuyến";

  const handleCopyVoucher = () => {
    navigator.clipboard.writeText("THANKS15").catch(() => {});
    setCopiedVoucher(true);
    setTimeout(() => setCopiedVoucher(false), 2500);
  };

  const handleDownloadInvoice = () => {
    setDownloadingInvoice(true);
    setTimeout(() => {
      setDownloadingInvoice(false);
      alert("Đã tạo hóa đơn điện tử cho đơn hàng " + formattedOrderId);
    }, 1200);
  };

  return (
    <div className="w-full bg-background min-h-screen text-on-surface">
      {/* Top Header Section */}
      <header className="sticky top-0 left-0 right-0 w-full z-40 bg-surface/90 backdrop-blur-xl border-b border-[#EFECE6]">
        <div className="h-16 max-w-[1320px] mx-auto px-4 md:px-8 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="font-headline-md text-[22px] text-primary font-bold tracking-tight">
              BrewLite
            </span>
            <span className="hidden sm:inline-block px-2.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant text-[11px] font-medium">
              Specialty Coffee
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="text-[13px] font-semibold text-on-surface block">
                {customerName}
              </span>
              <span className="text-[11px] text-tertiary font-medium">
                ⭐ {userPoints} điểm
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Notification Banner */}
      <section className="w-full bg-surface-container-low border-b border-[#EFECE6] py-8">
        <div className="max-w-[1320px] mx-auto px-4 md:px-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-full bg-[#F0FDF4] text-[#16A34A] flex items-center justify-center flex-shrink-0 shadow-sm border border-[#DCFCE7]">
                <span className="material-symbols-outlined text-[32px]">check_circle</span>
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="font-headline-md text-2xl md:text-3xl font-bold text-on-surface">
                    {order.status === "COMPLETED"
                      ? "Đơn hàng đã hoàn thành!"
                      : order.status === "READY"
                      ? "Đồ uống đã sẵn sàng phục vụ!"
                      : "Đặt hàng & Thanh toán thành công!"}
                  </h1>
                  <span
                    id="orderStatusBadge"
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F0FDF4] text-[#16A34A] text-xs font-bold border border-[#DCFCE7]"
                  >
                    <span className="w-2 h-2 rounded-full bg-[#16A34A]"></span>
                    {order.status === "COMPLETED"
                      ? "ĐÃ HOÀN THÀNH (COMPLETED)"
                      : order.status === "READY"
                      ? "SẴN SÀNG PHỤC VỤ (READY)"
                      : order.status === "PREPARING"
                      ? "ĐANG PHA CHẾ (PREPARING)"
                      : "ĐÃ THANH TOÁN (PAID)"}
                  </span>
                </div>
                <p className="text-sm text-on-surface-variant max-w-2xl leading-relaxed">
                  {order.status === "COMPLETED" ? (
                    <>
                      Đơn hàng của bạn đã hoàn thành trọn vẹn. Cảm ơn{" "}
                      <span className="font-semibold text-on-surface">{customerName}</span> đã lựa chọn
                      BrewLite, chúc bạn thưởng thức đồ uống thật ngon miệng!
                    </>
                  ) : order.status === "READY" ? (
                    <>
                      Đồ uống của bạn đã sẵn sàng! Mời{" "}
                      <span className="font-semibold text-on-surface">{customerName}</span> đến nhận tại quầy
                      hoặc đón nhân viên giao hàng tại điểm hẹn.
                    </>
                  ) : order.status === "PREPARING" ? (
                    <>
                      Cảm ơn <span className="font-semibold text-on-surface">{customerName}</span>, đơn
                      hàng của bạn đang được Barista tại{" "}
                      <span className="text-primary font-medium">BrewLite Saigon Center</span> trực tiếp pha
                      chế thủ công.
                    </>
                  ) : (
                    <>
                      Cảm ơn <span className="font-semibold text-on-surface">{customerName}</span>, đơn
                      hàng của bạn đã được tiếp nhận thành công và đang được đưa vào hàng đợi tại quầy
                      Barista <span className="text-primary font-medium">BrewLite Saigon Center</span>.
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Quick Metadata Box */}
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 bg-surface-container-lowest p-3.5 rounded-xl shadow-sm border border-[#EFECE6] flex-shrink-0">
              <div className="px-3 border-r border-[#EFECE6]/80 last:border-0">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Mã đơn hàng
                </span>
                <span
                  id="orderCodeText"
                  className="font-mono text-sm font-bold text-primary tracking-tight"
                >
                  {formattedOrderId}
                </span>
              </div>
              <div className="px-3 border-r border-[#EFECE6]/80 last:border-0">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Thời gian
                </span>
                <span className="text-sm font-semibold text-on-surface">
                  {orderTimeFormatted} • Hôm nay
                </span>
              </div>
              <div className="px-3">
                <span className="text-[11px] text-on-surface-variant block uppercase tracking-wider">
                  Phương thức
                </span>
                <span className="text-sm font-semibold text-on-surface flex items-center gap-1">
                  <span className="material-symbols-outlined text-primary text-[18px]">
                    credit_card
                  </span>
                  {paymentMethodLabel}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Order Workspace */}
      <main className="max-w-[1320px] mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* Stepper Progress Bar */}
        <div className="w-full bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-[#EFECE6]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-6 mb-6 border-b border-[#EFECE6] gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
                <span className="material-symbols-outlined text-[24px]">timer</span>
              </div>
              <div>
                <span className="text-xs text-on-surface-variant uppercase tracking-wider block font-medium">
                  {order.status === "COMPLETED"
                    ? "Trạng thái đơn hàng"
                    : order.status === "READY"
                    ? "Thời gian phục vụ"
                    : "Thời gian giao dự kiến"}
                </span>
                <h2 className="text-lg md:text-xl font-bold text-primary">
                  {order.status === "COMPLETED" ? (
                    <>
                      Đã hoàn tất{" "}
                      <span className="text-sm text-on-surface-variant font-normal">
                        (Đã giao trọn vẹn cho khách hàng)
                      </span>
                    </>
                  ) : order.status === "READY" ? (
                    <>
                      Sẵn sàng ngay{" "}
                      <span className="text-sm text-on-surface-variant font-normal">
                        (Đồ uống đã hoàn tất tại quầy)
                      </span>
                    </>
                  ) : order.status === "PREPARING" ? (
                    <>
                      10 - 15 phút{" "}
                      <span className="text-sm text-on-surface-variant font-normal">
                        (Đang trong quá trình pha chế thủ công)
                      </span>
                    </>
                  ) : (
                    <>
                      15 - 25 phút{" "}
                      <span className="text-sm text-on-surface-variant font-normal">
                        (Đã tiếp nhận, chuẩn bị vào quầy)
                      </span>
                    </>
                  )}
                </h2>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-semibold gap-1.5">
                <span className="w-2 h-2 rounded-full bg-primary animate-ping"></span>
                Cập nhật theo thời gian thực
              </span>
            </div>
          </div>

          {/* Stepper 4 stages: Dynamic theo order.status (PAID, PREPARING, READY, COMPLETED) */}
          <div className="relative py-2">
            <div className="hidden md:block absolute top-6 left-12 right-12 h-1 bg-surface-container-high rounded-full -z-0">
              <div
                className="h-full bg-primary rounded-full transition-all duration-700"
                style={{
                  width:
                    order.status === "COMPLETED"
                      ? "100%"
                      : order.status === "READY"
                      ? "72%"
                      : order.status === "PREPARING"
                      ? "42%"
                      : "15%",
                }}
              ></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative z-10">
              {/* Step 1: Đã tiếp nhận đơn */}
              <div className="flex md:flex-col items-center md:items-center text-left md:text-center gap-3">
                <div className="w-12 h-12 rounded-full bg-[#16A34A] text-white flex items-center justify-center shadow-md flex-shrink-0">
                  <span className="material-symbols-outlined text-[22px]">check</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface">Đã tiếp nhận đơn</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {orderTimeFormatted} • Saigon Center
                  </p>
                </div>
              </div>

              {/* Step 2: Pha chế thủ công */}
              <div className="flex md:flex-col items-center md:items-center text-left md:text-center gap-3">
                {order.status === "COMPLETED" || order.status === "READY" ? (
                  <div className="w-12 h-12 rounded-full bg-[#16A34A] text-white flex items-center justify-center shadow-md flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">check</span>
                  </div>
                ) : order.status === "PREPARING" ? (
                  <div className="relative flex items-center justify-center">
                    <span className="absolute w-14 h-14 rounded-full bg-primary/20 animate-ping"></span>
                    <div className="w-12 h-12 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-md flex-shrink-0 relative">
                      <span className="material-symbols-outlined text-[24px]">coffee_maker</span>
                    </div>
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">hourglass_empty</span>
                  </div>
                )}
                <div>
                  <p
                    className={`text-sm font-bold ${
                      order.status === "PREPARING"
                        ? "text-primary"
                        : "text-on-surface"
                    }`}
                  >
                    {order.status === "COMPLETED" || order.status === "READY"
                      ? "Đã pha chế xong"
                      : order.status === "PREPARING"
                      ? "Đang pha chế thủ công"
                      : "Chờ pha chế"}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {order.status === "COMPLETED" || order.status === "READY"
                      ? "Hoàn tất bởi Master Barista"
                      : order.status === "PREPARING"
                      ? "Chiết xuất Espresso & Cold Brew"
                      : "Đang xếp hàng vào quầy"}
                  </p>
                </div>
              </div>

              {/* Step 3: Đang giao hàng / Sẵn sàng */}
              <div
                className={`flex md:flex-col items-center md:items-center text-left md:text-center gap-3 ${
                  order.status === "PAID" || order.status === "PREPARING"
                    ? "opacity-60"
                    : ""
                }`}
              >
                {order.status === "COMPLETED" ? (
                  <div className="w-12 h-12 rounded-full bg-[#16A34A] text-white flex items-center justify-center shadow-md flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">check</span>
                  </div>
                ) : order.status === "READY" ? (
                  <div className="relative flex items-center justify-center">
                    <span className="absolute w-14 h-14 rounded-full bg-primary/20 animate-ping"></span>
                    <div className="w-12 h-12 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-md flex-shrink-0 relative">
                      <span className="material-symbols-outlined text-[24px]">moped</span>
                    </div>
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">moped</span>
                  </div>
                )}
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      order.status === "READY" ? "text-primary font-bold" : "text-on-surface"
                    }`}
                  >
                    {order.status === "COMPLETED"
                      ? "Đã giao hàng"
                      : order.status === "READY"
                      ? "Sẵn sàng phục vụ"
                      : "Chờ giao hàng"}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {order.status === "COMPLETED"
                      ? "Đã giao trọn vẹn"
                      : order.status === "READY"
                      ? "Mời nhận đồ uống tại quầy"
                      : "Dự kiến sau khi pha chế"}
                  </p>
                </div>
              </div>

              {/* Step 4: Giao hàng thành công / Hoàn tất */}
              <div
                className={`flex md:flex-col items-center md:items-center text-left md:text-center gap-3 ${
                  order.status !== "COMPLETED" ? "opacity-60" : ""
                }`}
              >
                {order.status === "COMPLETED" ? (
                  <div className="w-12 h-12 rounded-full bg-[#16A34A] text-white flex items-center justify-center shadow-md flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">check</span>
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-[22px]">inventory</span>
                  </div>
                )}
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      order.status === "COMPLETED" ? "text-primary font-bold" : "text-on-surface"
                    }`}
                  >
                    {order.status === "COMPLETED" ? "Hoàn tất đơn hàng" : "Giao tận tay"}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {order.status === "COMPLETED"
                      ? "Cảm ơn bạn đã thưởng thức"
                      : "Thưởng thức trọn vị"}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Content Columns: Left (7 cols), Right (5 cols) */}
        <div className="grid grid-cols-12 gap-8 items-start">
          {/* Left Column: Barista info & Voucher thanks */}
          <div className="col-span-12 lg:col-span-7 space-y-6">
            {/* Barista & Branch info */}
            <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-[#EFECE6] space-y-4">
              <h3 className="text-base font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[22px]">store</span>
                Chi nhánh phục vụ: BrewLite Saigon Center
              </h3>
              <div className="p-4 rounded-xl bg-surface-container-low/80 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-lg">
                    TM
                  </div>
                  <div>
                    <span className="text-[11px] text-tertiary font-bold uppercase tracking-wider block">
                      Nghệ nhân Barista phụ trách
                    </span>
                    <p className="text-sm font-bold text-on-surface">Trần Minh Quân</p>
                    <p className="text-xs text-on-surface-variant">Master Barista • 5 năm kinh nghiệm</p>
                  </div>
                </div>
                <span className="px-3 py-1 rounded-full bg-surface-container-lowest text-primary text-xs font-semibold shadow-sm">
                  {order.status === "COMPLETED"
                    ? "Đã phục vụ"
                    : order.status === "READY"
                    ? "Đã sẵn sàng"
                    : order.status === "PREPARING"
                    ? "Đang chiết xuất"
                    : "Chờ tiếp nhận"}
                </span>
              </div>
            </div>

            {/* Gift Voucher Card */}
            <div className="bg-surface-container-lowest p-6 rounded-xl shadow-sm border border-[#EFECE6] flex flex-col justify-between">
              <div className="flex items-start justify-between">
                <div>
                  <span className="px-2.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed text-[11px] uppercase font-bold tracking-wider">
                    Quà tri ân
                  </span>
                  <h4 className="text-base font-bold text-on-surface mt-2">
                    Giảm 15% cho lần đặt kế tiếp
                  </h4>
                  <p className="text-xs text-on-surface-variant mt-1">
                    Áp dụng cho mọi dòng Specialty Coffee tại BrewLite
                  </p>
                </div>
                <span className="material-symbols-outlined text-secondary text-[36px]">
                  redeem
                </span>
              </div>
              <div className="mt-5 pt-3.5 border-t border-[#EFECE6] flex items-center justify-between">
                <div className="px-3.5 py-1.5 bg-surface-container-low rounded-lg font-mono text-sm text-primary tracking-widest font-bold select-all">
                  THANKS15
                </div>
                <button
                  type="button"
                  onClick={handleCopyVoucher}
                  className="text-xs font-bold text-primary hover:underline cursor-pointer"
                >
                  {copiedVoucher ? "✓ Đã sao chép" : "Sao chép mã"}
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Order Items & Financial Summary */}
          <div className="col-span-12 lg:col-span-5 space-y-6">
            <div className="bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-[#EFECE6]">
              <div className="flex items-center justify-between pb-4 border-b border-[#EFECE6]">
                <h3 className="text-base font-bold text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">
                    receipt_long
                  </span>
                  Chi tiết món đã đặt ({order.items.length} món)
                </h3>
                <span className="text-xs text-on-surface-variant">Bao gồm VAT</span>
              </div>

              {/* Items List */}
              <div className="divide-y divide-[#EFECE6]/80 py-2 max-h-80 overflow-y-auto">
                {order.items.map((item) => (
                  <div key={item.id} className="py-3 flex gap-3 items-start">
                    <div className="w-12 h-12 rounded-lg bg-surface-container overflow-hidden flex-shrink-0 flex items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={FALLBACK_DRINK_IMAGE}
                        alt={item.productName}
                        className="w-full h-full object-contain p-1"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="text-sm font-bold text-on-surface leading-snug">
                          {item.quantity}x {item.productName}
                        </h4>
                        <span className="text-sm font-bold text-primary flex-shrink-0">
                          {formatVnd(item.lineTotalVnd)}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-variant mt-0.5">
                        Size {item.size} ({item.sizeMultiplierPercent}%)
                        {item.toppings?.length > 0 &&
                          ` • Topping: ${item.toppings.map((t) => t.name).join(", ")}`}
                      </p>
                      <span className="text-[11px] text-tertiary">
                        {formatVnd(item.unitPriceVnd)} / ly
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Financial Breakdown */}
              <div className="mt-4 pt-4 border-t border-[#EFECE6] space-y-2 text-sm">
                <div className="flex justify-between text-on-surface-variant">
                  <span>Tạm tính ({order.items.reduce((s, i) => s + i.quantity, 0)} ly)</span>
                  <span id="orderSubtotalText">{formatVnd(order.subtotalVnd)}</span>
                </div>
                {order.discountVnd > 0 && (
                  <div className="flex justify-between text-[#16A34A] font-medium">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[16px]">local_offer</span>
                      Giảm giá ({order.couponCode || "VOUCHER"})
                    </span>
                    <span id="orderDiscountText">-{formatVnd(order.discountVnd)}</span>
                  </div>
                )}
                <div className="flex justify-between text-on-surface-variant">
                  <span>Phí giao hàng</span>
                  <span className="text-[#16A34A] font-medium">Miễn phí</span>
                </div>
                <div className="pt-3 border-t border-[#EFECE6] flex justify-between items-baseline">
                  <span className="font-bold text-base text-on-surface">Tổng thanh toán</span>
                  <div className="text-right">
                    <span
                      id="orderTotalText"
                      className="text-xl font-bold text-primary tracking-tight"
                    >
                      {formatVnd(order.totalVnd)}
                    </span>
                    <span className="block text-[11px] text-tertiary font-semibold">
                      +{order.pointsEarned} điểm tích lũy
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Electronic Invoice Card */}
            <div className="bg-surface-container-low p-4 rounded-xl flex items-center justify-between gap-3 border border-[#EFECE6]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  description
                </span>
                <span className="text-xs font-semibold text-on-surface">
                  Hóa đơn điện tử (VAT)
                </span>
              </div>
              <button
                type="button"
                id="btnDownloadInvoice"
                onClick={handleDownloadInvoice}
                disabled={downloadingInvoice}
                className="px-3.5 py-1.5 rounded-lg bg-surface-container-lowest hover:bg-surface-container-high text-on-surface text-xs font-semibold shadow-sm transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {downloadingInvoice ? "sync" : "download"}
                </span>
                {downloadingInvoice ? "Đang tải..." : "Tải PDF"}
              </button>
            </div>
          </div>
        </div>

        {/* Global Action CTA Bar */}
        <section className="mt-8 pt-6 border-t border-[#EFECE6] flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-on-surface-variant text-xs">
            <span className="material-symbols-outlined text-primary text-[20px]">
              headset_mic
            </span>
            <span>
              Cần hỗ trợ đơn hàng? Gọi ngay CSKH:{" "}
              <strong className="text-on-surface">1900 6868</strong>
            </span>
          </div>
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Link
              href="/"
              className="flex-1 sm:flex-initial text-center px-5 py-2.5 rounded-lg border border-[#C67C4E] text-primary hover:bg-surface-container-low text-sm font-semibold transition-colors"
            >
              Tiếp tục mua sắm
            </Link>
            <Link
              href="/orders"
              className="flex-1 sm:flex-initial text-center px-5 py-2.5 rounded-lg bg-primary hover:bg-[#70370e] text-on-primary text-sm font-semibold shadow transition-colors flex items-center justify-center gap-1.5"
            >
              <span>Xem Lịch sử Đơn hàng</span>
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
