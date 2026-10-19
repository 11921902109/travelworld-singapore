import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "travelworld｜把想去的地方，变成走得通的旅程",
  description: "用自然语言规划新加坡旅行，并将酒店、真实地点、交通与时间转成可交互的地图行程。",
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
