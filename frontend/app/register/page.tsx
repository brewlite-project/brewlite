import type { Metadata } from "next";
import AuthPageView from "@/components/AuthPageView";

export const metadata: Metadata = {
  title: "Đăng ký tài khoản (Register) - BrewLite",
  description: "Tạo tài khoản mới để tích điểm và nhận ưu đãi tại BrewLite Artisanal Coffee",
};

export default function RegisterPage() {
  return <AuthPageView initialMode="register" />;
}
