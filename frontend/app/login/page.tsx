import type { Metadata } from "next";
import AuthPageView from "@/components/AuthPageView";

export const metadata: Metadata = {
  title: "Đăng nhập & Đăng ký (Login / Register) - BrewLite",
  description: "Đăng nhập hoặc tạo tài khoản mới tại BrewLite Artisanal Coffee",
};

export default function LoginPage() {
  return <AuthPageView initialMode="login" />;
}
