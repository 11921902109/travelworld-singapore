import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./travel.css";

export const metadata: Metadata = {
  title: "travelworld｜把想去的地方，变成走得通的旅程",
  description: "用自然语言规划旅行，并将酒店、地点、交通与时间转成可交互的地图行程。",
};

export default function TravelLayout({ children }: { children: ReactNode }) {
  return <div className="tw-app">{children}</div>;
}
