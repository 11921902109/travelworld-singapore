import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SharedTripViewer } from "@/components/travel/shared-trip-viewer";
import { TravelLogo } from "@/components/travel/travel-logo";
import { readSharedTrip } from "@/lib/travel/shared-trip-store";
import "./share.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "分享的旅行行程｜travelworld",
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

export default async function SharedTripPage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  const shared = await readSharedTrip(shareId);
  if (!shared) notFound();

  return (
    <main className="tw-shared-trip">
      <header className="tw-shared-nav">
        <Link href="/travel" aria-label="返回 travelworld 首页"><TravelLogo compact /></Link>
        <Link href="/travel/new" className="tw-shared-plan-link">开始我的旅行 →</Link>
      </header>
      <div className="tw-shared-content">
        <SharedTripViewer key={shareId} snapshot={shared.snapshot} shareId={shareId} />
        <footer className="tw-shared-footer">
          链接有效至 {new Date(shared.expiresAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Singapore" })}（新加坡时间）
        </footer>
      </div>
    </main>
  );
}
