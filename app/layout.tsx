import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Travelworld 新加坡",
  description: "用自然语言表达旅行愿望，分阶段规划新加坡行程。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
