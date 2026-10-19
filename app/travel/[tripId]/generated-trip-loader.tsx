"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useState } from "react";
import { ArrowLeft, MapPinned, RefreshCcw } from "lucide-react";
import { TravelLogo } from "@/components/travel/travel-logo";
import { liveTripStorageKey, type StoredLiveTrip } from "@/lib/travel/trip-storage";
import type { DemoTrip } from "@/lib/travel/types";
import { TripWorkspaceClient } from "./trip-workspace-client";

function validTrip(value: unknown, tripId: string): value is StoredLiveTrip {
  if (!value || typeof value !== "object") return false;
  const stored = value as { trip?: Partial<DemoTrip> };
  return Boolean(
    stored.trip?.id === tripId &&
    stored.trip.destination === "新加坡" &&
    Array.isArray(stored.trip.days) &&
    stored.trip.days.length,
  );
}
export function GeneratedTripLoader({ tripId }: { tripId: string }) {
  const [storedTrip, setStoredTrip] = useState<StoredLiveTrip | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(liveTripStorageKey(tripId));
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (!validTrip(parsed, tripId)) {
          setMissing(true);
          return;
        }
        setStoredTrip({ ...parsed, trip: { ...parsed.trip, source: "live" } });
      } catch {
        setMissing(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tripId]);

  if (storedTrip) return <TripWorkspaceClient trip={storedTrip.trip} storedTrip={storedTrip} />;

  return (
    <main className="tw-trip-loader">
      <TravelLogo />
      <div className="tw-trip-loader-card" role={missing ? "alert" : "status"}>
        {missing ? <MapPinned size={28} /> : <span className="tw-loader-orbit"><RefreshCcw size={24} /></span>}
        <h1>{missing ? "这份行程不在当前设备上" : "正在打开真实地图行程"}</h1>
        <p>{missing ? "Singapore Intelligence v1 暂时把生成结果保存在本机浏览器。请回到规划页重新生成；跨设备保存和分享将在后续版本加入。" : "正在读取 Google Places 与 Routes 生成的候选行程。"}</p>
        {missing ? <a href="/travel/new"><ArrowLeft size={16} />返回规划页</a> : null}
      </div>
    </main>
  );
}

