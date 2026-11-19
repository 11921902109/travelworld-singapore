"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { GoogleSingaporeMap, type GoogleSingaporeMapMarker } from "@/components/travel/google-singapore-map";
import { TripPlaceCardContent, tripStopPeriodLabel } from "@/components/travel/trip-place-card";
import { regularOpeningHoursLabel } from "@/lib/travel/planning-hours";
import { sharedPreviewMap, type SharedMapData } from "@/lib/travel/shared-map-data";
import type { SharedTripSnapshot } from "@/lib/travel/shared-trip";
import type { DemoTrip, TravelMode } from "@/lib/travel/types";
import "./shared-trip-viewer.css";

const modeLabels: Record<TravelMode, string> = { walk: "步行", transit: "公共交通", taxi: "出租车", drive: "驾车", bicycle: "骑行" };
const markerKinds: Record<SharedTripSnapshot["days"][number]["stops"][number]["kind"], GoogleSingaporeMapMarker["kind"]> = {
  hotel: "hotel", sight: "attraction", food: "food", other: "transport", buffer: "activity",
};

function readableLink(value?: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
  } catch {
    return undefined;
  }
}

export function SharedTripViewer({ snapshot, shareId, previewTrip }: {
  snapshot: SharedTripSnapshot;
  shareId?: string;
  previewTrip?: DemoTrip;
}) {
  const [dayIndex, setDayIndex] = useState(0);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [mapEnabled, setMapEnabled] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mapState, setMapState] = useState<{ index: number; data?: SharedMapData; error?: string }>();
  const panelId = useId();
  const index = Math.min(dayIndex, snapshot.days.length - 1);
  const day = snapshot.days[index];
  const transfer = index === snapshot.days.length - 1 ? snapshot.departureTransfer : undefined;
  const localMap = useMemo(() => previewTrip && sharedPreviewMap(snapshot, previewTrip, index), [snapshot, previewTrip, index]);
  const currentMap = localMap || (mapState?.index === index ? mapState.data : undefined);
  const currentError = !localMap && mapState?.index === index ? mapState.error : undefined;

  useEffect(() => {
    if (!shareId || !mapEnabled) return;
    const controller = new AbortController();
    fetch(`/api/travel/share/${encodeURIComponent(shareId)}/map?day=${index}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("当前地图暂时无法加载。");
        const data = await response.json() as SharedMapData;
        if (!controller.signal.aborted) setMapState({ index, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setMapState({ index, error: "当前地图暂时无法加载。" });
      });
    return () => controller.abort();
  }, [shareId, index, mapEnabled, retry]);

  const placesById = new Map(currentMap?.places.map((place) => [place.id, place]));
  const mapStops = transfer ? [...day.stops, transfer.fromHotel, transfer.toAirport] : day.stops;
  const markers = mapStops.flatMap((stop, i): GoogleSingaporeMapMarker[] => {
    const position = placesById.get(stop.id)?.position;
    return position ? [{ id: stop.id, position, title: stop.name, kind: markerKinds[stop.kind], color: day.color, label: i + 1 }] : [];
  });
  const canShowMap = mapStops.some((stop) => stop.placeId || stop.location);
  const Title = shareId ? "h1" : "h2";

  return (
    <section className="tw-share-viewer" aria-label="只读行程">
      <header className="tw-share-heading">
        <small>TRAVELWORLD · 只读行程</small>
        <Title>{snapshot.title}</Title>
        <p>{snapshot.destination} · {snapshot.dateRange} · {snapshot.people} 人 · {snapshot.pace}</p>
        <p className="tw-share-scope">{snapshot.includeAccommodation ? "此版本包含住宿信息。" : "此版本已隐藏住宿信息及相关路线。"}</p>
        {Boolean(snapshot.accommodationSegments?.length) && <p>住宿安排 · {snapshot.accommodationSegments?.map((segment) =>
          `${snapshot.days.find((item) => item.id === segment.startDayId)?.label || "旅程"} 起 ${segment.name}`).join("；")}</p>}
        {Boolean(snapshot.warnings?.length) && <details className="tw-share-notes">
          <summary>行程提醒</summary>
          <ul>{snapshot.warnings?.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
        </details>}
      </header>
      <nav className="tw-share-day-nav" aria-label="选择行程日期">
        {snapshot.days.map((item, i) => (
          <button key={item.id} type="button" aria-pressed={i === index} aria-controls={panelId}
            onClick={() => {
              if (i === index) return;
              setDayIndex(i);
              setSelectedStopId(null);
              setMapState(undefined);
            }}>
            <strong>{item.label}</strong><small>{item.date}</small>
          </button>
        ))}
      </nav>
      <div className="tw-share-day-content" id={panelId}>
        <header><h3>{day.theme}</h3><p>{day.summary}</p></header>
        <div className="tw-share-day-grid">
          <section className="tw-share-map-panel" aria-label="本日地图">
            <h4>本日地图</h4>
            {markers.length > 0 ? (
              <>
                <GoogleSingaporeMap className="tw-share-map" markers={markers} routeSegments={currentMap?.segments}
                  routeColor={day.color} selectedMarkerId={selectedStopId} onMarkerSelect={setSelectedStopId} />
                <p>Google 地图与路线为查看时的参考，计划停留与交通时长以分享行程为准。</p>
              </>
            ) : (
              <div className="tw-share-map-empty">
                <p role="status">{currentError || (currentMap ? "当前没有可显示的地图地点。" : !canShowMap ? "此日可以浏览地点清单。" :
                  mapEnabled && shareId ? "正在加载地图与路线…" : "查看当天的地图标记和路线。")}</p>
                {canShowMap && shareId && (!mapEnabled || currentError || currentMap) && (
                  <button type="button" className="tw-share-secondary" onClick={() => {
                    setMapState(undefined);
                    setMapEnabled(true);
                    setRetry((value) => value + 1);
                  }}>{mapEnabled ? "重试地图" : "加载当天地图"}</button>
                )}
              </div>
            )}
          </section>
          <section className="tw-share-places" aria-label="本日地点">
            <h4>本日地点</h4>
            {day.returnBy && <p className="tw-share-boundary">{day.terminalKind === "airport" ? "到达机场截止" : "本日结束目标"} {day.returnBy}</p>}
            {day.overtimeAcceptance && <p className="tw-share-boundary">分享者已确认超出返店目标 {day.overtimeAcceptance.minutes} 分钟。</p>}
            <ol>
              {day.stops.map((stop, i) => {
                const leg = day.legs.find((item) => item.to === stop.id);
                const details = placesById.get(stop.id);
                const mapsUrl = readableLink(details?.googleMapsUri);
                const expanded = selectedStopId === stop.id;
                return (
                  <li key={stop.id}>
                    {leg && <p className="tw-share-leg">{modeLabels[leg.mode]} · {leg.minutes} 分钟{leg.distance ? ` · ${leg.distance}` : ""}{leg.timeSource === "user" ? " · 自定时长" : ""}</p>}
                    <article className="tw-share-place" data-selected={expanded || undefined}>
                      <TripPlaceCardContent name={stop.name} categoryLabel={stop.categoryLabel}
                        period={tripStopPeriodLabel(stop.time, stop.kind, i === 0, i === day.stops.length - 1)}
                        area={stop.area} duration={stop.duration} description={stop.description}
                        openingLabel={details?.openingHours ? regularOpeningHoursLabel(details.openingHours, day.date) || undefined : undefined}
                        warning={stop.warning} aiAdvice={stop.aiAdvice} />
                      {(stop.placeId || stop.location) && (
                        <button type="button" className="tw-share-secondary" aria-expanded={expanded}
                          onClick={() => {
                            setSelectedStopId(expanded ? null : stop.id);
                            if (!expanded && shareId) setMapEnabled(true);
                          }}>{expanded ? "收起地点详情" : "查看地点详情"}</button>
                      )}
                      {expanded && (
                        <div className="tw-share-place-details">
                          {details?.address && <p>{details.address}</p>}
                          {details && !stop.placeId && <p>手动坐标 · {details.position.lat}, {details.position.lng}</p>}
                          {mapsUrl && <a href={mapsUrl} target="_blank" rel="noreferrer">在 Google Maps 查看</a>}
                          {!details && <p>{currentMap || currentError ? "当前地点详情不可用。" : "地点详情随当天地图加载。"}</p>}
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
            {transfer && <aside className="tw-share-transfer">
              <strong>次日离境 · {transfer.date}</strong>
              <p>{transfer.fromHotel.name} → {transfer.toAirport.name}</p>
              {transfer.leg && <p>{modeLabels[transfer.leg.mode]} · {transfer.leg.minutes} 分钟</p>}
              <p>航班 {transfer.departureAt.replace("T", " ")} · 到机场截止 {transfer.airportCutoffAt.replace("T", " ")}</p>
              {transfer.leaveHotelAt && <p>预计离开住宿 {transfer.leaveHotelAt.replace("T", " ")}</p>}
              {transfer.note && <p>{transfer.note}</p>}
            </aside>}
          </section>
        </div>
      </div>
    </section>
  );
}
