"use client";

import { Building2, Hotel, LocateFixed, Minus, Plus } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { TripDay, TripStop } from "@/lib/travel/types";

function routePath(stops: TripStop[]) {
  if (!stops.length) return "";
  return stops.map((stop, index) => `${index === 0 ? "M" : "L"} ${stop.x} ${stop.y}`).join(" ");
}

export function SingaporeMap({
  day,
  selectedStopId,
  onSelectStop,
}: {
  day: TripDay;
  selectedStopId: string;
  onSelectStop: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);

  return (
    <section className="tw-map" aria-label={`${day.label} 新加坡行程示意地图`}>
      <div className="tw-map-toolbar" aria-label="地图工具">
        <button type="button" aria-label="放大地图" disabled={zoom >= 1.3} onClick={() => setZoom((value) => Math.min(1.3, value + 0.1))}><Plus size={17} /></button>
        <button type="button" aria-label="缩小地图" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.1))}><Minus size={17} /></button>
        <button type="button" aria-label="显示全部行程" onClick={() => setZoom(1)}><LocateFixed size={17} /></button>
      </div>

      <div className="tw-map-caption">
        <span className="tw-live-dot" />
        <div><strong>新加坡示意地图</strong><small>地点与时间为产品样例，不是实时导航</small></div>
      </div>

      <div className="tw-map-canvas" style={{ "--map-scale": zoom } as CSSProperties}>
        <svg className="tw-map-art" viewBox="0 0 100 100" role="img" aria-label="新加坡区域示意图">
          <defs>
            <pattern id="tw-grid" width="7" height="7" patternUnits="userSpaceOnUse">
              <path d="M 7 0 L 0 0 0 7" fill="none" className="tw-map-grid-line" />
            </pattern>
          </defs>
          <rect width="100" height="100" className="tw-map-water" />
          <path className="tw-map-island" d="M7 38 C12 25 23 18 35 19 C45 12 61 17 70 24 C80 23 94 29 96 39 C93 50 82 57 73 64 C63 72 50 74 40 72 C31 76 20 71 15 63 C10 56 5 48 7 38Z" />
          <path className="tw-map-sentosa" d="M20 79 C27 75 39 76 46 81 C42 89 28 92 19 87 C17 84 18 81 20 79Z" />
          <path className="tw-map-river" d="M18 49 C31 47 39 51 48 55 C58 59 64 58 77 54" />
          <path className="tw-map-road" d="M15 35 C30 36 39 42 50 46 C62 51 74 48 91 41" />
          <path className="tw-map-road" d="M31 21 C35 34 42 44 48 55 C53 65 59 70 68 72" />
          <path className="tw-map-road tw-map-road--minor" d="M19 59 C33 55 47 56 60 62 C69 66 80 60 87 53" />
          <rect width="100" height="100" fill="url(#tw-grid)" opacity="0.42" />
          <text x="21" y="27" className="tw-map-area-label">TANGLIN</text>
          <text x="39" y="31" className="tw-map-area-label">BUGIS</text>
          <text x="61" y="50" className="tw-map-area-label">MARINA BAY</text>
          <text x="24" y="86" className="tw-map-area-label">SENTOSA</text>
          <text x="82" y="32" className="tw-map-area-label">CHANGI</text>
          <path className="tw-map-route-shadow" d={routePath(day.stops)} />
          <path className="tw-map-route" style={{ stroke: day.color }} d={routePath(day.stops)} />
        </svg>

        {day.stops.map((stop, index) => (
          <button
            key={stop.id}
            type="button"
            className={`tw-map-pin ${selectedStopId === stop.id ? "is-selected" : ""} ${stop.kind === "hotel" ? "is-hotel" : ""}`}
            style={{ left: `${stop.x}%`, top: `${stop.y}%`, "--pin-color": day.color } as CSSProperties}
            onClick={() => onSelectStop(stop.id)}
            aria-label={`${stop.time} ${stop.name}`}
            aria-pressed={selectedStopId === stop.id}
          >
            <span>{stop.kind === "hotel" ? <Hotel size={15} /> : index}</span>
          </button>
        ))}

        <div className="tw-map-landmark tw-map-landmark--bay" aria-hidden="true"><Building2 size={15} /><span>海湾</span></div>
      </div>

      <div className="tw-map-legend" aria-label="地图图例">
        <span><i className="is-hotel" />酒店锚点</span>
        <span><i style={{ background: day.color }} />{day.label} 路线</span>
        <span><i className="is-estimate" />预计路段</span>
      </div>
    </section>
  );
}
