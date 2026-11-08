import type { Metadata } from "next";
import OrderHistoryView from "@/components/OrderHistoryView";

export const metadata: Metadata = {
  title: "Lịch sử đơn hàng - BrewLite Specialty Coffee",
  description:
    "Quản lý đơn hàng, theo dõi trạng thái xử lý và kiểm tra điểm tích lũy thành viên tại BrewLite.",
};

export default function OrdersPage() {
  return <OrderHistoryView />;
}
