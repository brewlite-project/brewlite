"use client";

import React, { useState } from "react";
import { VnPayRedirectingView } from "@/components/VnPayRedirectingView";
import { VnPayProcessingView } from "@/components/VnPayProcessingView";
import { VnPaySuccessView } from "@/components/VnPaySuccessView";
import { VnPayFailedRetryView } from "@/components/VnPayFailedRetryView";
import { ZeroPaymentBypassView } from "@/components/ZeroPaymentBypassView";
import type { OrderConfirmationData } from "@/services/order-confirmation.service";

const samplePaidOrder: OrderConfirmationData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  status: "PAID",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  subtotalVnd: 118000,
  discountVnd: 20000,
  totalVnd: 98000,
  couponCode: "BREW20K",
  pointsEarned: 10,
  items: [
    {
      id: "it-1",
      productId: "prod-1",
      productName: "Caramel Cloud Cold Brew",
      size: "M",
      sizeMultiplierPercent: 120,
      basePriceVnd: 45000,
      quantity: 1,
      unitPriceVnd: 54000,
      lineTotalVnd: 54000,
      toppings: [],
    },
    {
      id: "it-2",
      productId: "prod-2",
      productName: "Artisanal Iced Oat Latte",
      size: "L",
      sizeMultiplierPercent: 140,
      basePriceVnd: 45000,
      quantity: 1,
      unitPriceVnd: 64000,
      lineTotalVnd: 64000,
      toppings: [],
    },
  ],
  payment: {
    id: "pay-vnpay-01",
    status: "SUCCESS",
    method: "VNPAY",
    methodLast4: null,
    amountVnd: 98000,
    mockReference: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
  },
};

const sampleFailedOrder: OrderConfirmationData = {
  ...samplePaidOrder,
  status: "PAYMENT_FAILED",
  payment: {
    id: "pay-vnpay-failed",
    status: "FAILED",
    method: "VNPAY",
    methodLast4: null,
    amountVnd: 98000,
    mockReference: null,
    failureReason: "PAYMENT_DECLINED",
    createdAt: new Date().toISOString(),
  },
};

const sampleZeroOrder: OrderConfirmationData = {
  ...samplePaidOrder,
  subtotalVnd: 55000,
  discountVnd: 55000,
  totalVnd: 0,
  couponCode: "FREE100",
  pointsEarned: 0, // Invariant ERD: đơn 0đ không tích điểm
  payment: {
    id: "pay-zero-01",
    status: "SUCCESS",
    method: "ZERO_AMOUNT",
    methodLast4: null,
    amountVnd: 0,
    mockReference: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
  },
};

export default function VnPayPreviewPage() {
  const [activeTab, setActiveTab] = useState<
    "redirecting" | "processing" | "success" | "failed" | "zero"
  >("redirecting");

  return (
    <div className="min-h-screen bg-background">
      {/* Tab Switcher Floating Bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-surface-container-highest/95 backdrop-blur-md p-1.5 rounded-full shadow-2xl border border-outline-variant flex items-center gap-1">
        <button
          onClick={() => setActiveTab("redirecting")}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
            activeTab === "redirecting"
              ? "bg-primary text-on-primary shadow-sm"
              : "text-on-surface hover:bg-surface-container-high"
          }`}
        >
          1. Chuyển hướng
        </button>
        <button
          onClick={() => setActiveTab("processing")}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
            activeTab === "processing"
              ? "bg-primary text-on-primary shadow-sm"
              : "text-on-surface hover:bg-surface-container-high"
          }`}
        >
          2. Đối soát IPN
        </button>
        <button
          onClick={() => setActiveTab("success")}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
            activeTab === "success"
              ? "bg-primary text-on-primary shadow-sm"
              : "text-on-surface hover:bg-surface-container-high"
          }`}
        >
          3. Thành công
        </button>
        <button
          onClick={() => setActiveTab("failed")}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
            activeTab === "failed"
              ? "bg-primary text-on-primary shadow-sm"
              : "text-on-surface hover:bg-surface-container-high"
          }`}
        >
          4. Thất bại &amp; Thử lại
        </button>
        <button
          onClick={() => setActiveTab("zero")}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
            activeTab === "zero"
              ? "bg-secondary text-on-secondary shadow-sm"
              : "text-on-surface hover:bg-surface-container-high"
          }`}
        >
          5. Đơn hàng 0đ (BR-06)
        </button>
      </div>

      {/* Screen View */}
      {activeTab === "redirecting" && (
        <VnPayRedirectingView
          order={samplePaidOrder}
          autoRedirectSeconds={10}
          onManualRedirect={() => setActiveTab("processing")}
        />
      )}

      {activeTab === "processing" && (
        <VnPayProcessingView
          order={samplePaidOrder}
          vnpTxnRef="VNP_TXN_550E8400_01"
          amountVnd={samplePaidOrder.totalVnd}
          onRefreshStatus={async () => {
            setActiveTab("success");
            return samplePaidOrder;
          }}
        />
      )}

      {activeTab === "success" && (
        <VnPaySuccessView
          order={samplePaidOrder}
          customerName="Nguyễn Hải Đăng"
          userPoints={250}
          vnpayDetails={{
            vnp_TxnRef: "VNP_TXN_550E8400_01",
            vnp_TransactionNo: "14892044",
            vnp_BankCode: "NCB / VNPAYQR",
          }}
        />
      )}

      {activeTab === "failed" && (
        <VnPayFailedRetryView
          order={sampleFailedOrder}
          vnpResponseCode="24"
          vnpTxnRef="VNP_TXN_550E8400_01"
          onRetryVnPay={() => setActiveTab("redirecting")}
          onChangePaymentMethod={() => alert("Chuyển về chọn phương thức thanh toán")}
        />
      )}

      {activeTab === "zero" && (
        <ZeroPaymentBypassView
          order={sampleZeroOrder}
          customerName="Nguyễn Hải Đăng"
        />
      )}
    </div>
  );
}
