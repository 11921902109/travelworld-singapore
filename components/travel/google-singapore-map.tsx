"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import styles from "./google-singapore-map.module.css";

export type GoogleSingaporeMapPoint = {
  lat: number;
  lng: number;
};

export type GoogleSingaporeMapMarkerKind =
  | "hotel"
  | "attraction"
  | "food"
  | "activity"
  | "transport";

export type GoogleSingaporeMapMarker = {
  id: string;
  position?: GoogleSingaporeMapPoint;
  lat?: number;
  lng?: number;
  placeId?: string;
  title: string;
  label?: string | number;
  kind?: GoogleSingaporeMapMarkerKind;
  color?: string;
};

export type GoogleSingaporeMapProps = {
  markers: readonly GoogleSingaporeMapMarker[];
  route?: readonly GoogleSingaporeMapPoint[];
  selectedMarkerId?: string | null;
  onMarkerSelect?: (markerId: string) => void;
  center?: GoogleSingaporeMapPoint;
  zoom?: number;
  routeColor?: string;
  autoFit?: boolean;
  panToSelected?: boolean;
  mapId?: string;
  configEndpoint?: string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

type ListenerHandle = { remove: () => void };

type MapInstance = {
  fitBounds: (bounds: BoundsInstance, padding?: number) => void;
  panTo: (point: GoogleSingaporeMapPoint) => void;
  setCenter: (point: GoogleSingaporeMapPoint) => void;
  setZoom: (zoom: number) => void;
};

type MarkerInstance = {
  addListener: (eventName: string, handler: () => void) => ListenerHandle;
  setIcon: (icon: Record<string, unknown>) => void;
  setLabel: (label: Record<string, unknown>) => void;
  setMap: (map: MapInstance | null) => void;
  setPosition: (point: GoogleSingaporeMapPoint) => void;
  setTitle: (title: string) => void;
  setZIndex: (zIndex: number) => void;
};

type PolylineInstance = {
  setMap: (map: MapInstance | null) => void;
  setOptions: (options: Record<string, unknown>) => void;
  setPath: (path: readonly GoogleSingaporeMapPoint[]) => void;
};

type BoundsInstance = {
  extend: (point: GoogleSingaporeMapPoint) => BoundsInstance;
  isEmpty: () => boolean;
};

type GoogleMapsApi = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Marker: new (options: Record<string, unknown>) => MarkerInstance;
  Polyline: new (options: Record<string, unknown>) => PolylineInstance;
  LatLngBounds: new () => BoundsInstance;
  SymbolPath: { CIRCLE: unknown };
  event: { clearInstanceListeners: (instance: object) => void };
};

type GoogleRoot = { maps: GoogleMapsApi };

declare global {
  interface Window {
    google?: GoogleRoot;
  }
}

type MapConfigResponse = {
  browserKey?: string;
  key?: string;
  mapId?: string;
  error?: string;
};

type LoadState = "config" | "script" | "ready" | "missing-key" | "error";

type LiveMarker = {
  instance: MarkerInstance;
  listener: ListenerHandle;
};

type ResolvedMarker = GoogleSingaporeMapMarker & {
  position: GoogleSingaporeMapPoint;
};

const SINGAPORE_CENTER: GoogleSingaporeMapPoint = { lat: 1.3521, lng: 103.8198 };
const GOOGLE_MAPS_SCRIPT_ID = "travelworld-google-maps-script";
const GOOGLE_MAPS_SCRIPT_SELECTOR = "script[data-travelworld-google-maps]";

let googleMapsPromise: Promise<GoogleMapsApi> | null = null;

function loadGoogleMaps(browserKey: string): Promise<GoogleMapsApi> {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise<GoogleMapsApi>((resolve, reject) => {
    const handleLoaded = () => {
      if (window.google?.maps?.Map) {
        resolve(window.google.maps);
        return;
      }
      reject(new Error("Google Maps 脚本已加载，但地图对象不可用。"));
    };

    const handleError = () => reject(new Error("Google Maps 脚本加载失败。"));

    let existing =
      document.querySelector<HTMLScriptElement>(GOOGLE_MAPS_SCRIPT_SELECTOR) ??
      document.querySelector<HTMLScriptElement>('script[src^="https://maps.googleapis.com/maps/api/js"]');

    if (existing?.dataset.travelworldGoogleMapsState === "error") {
      existing.remove();
      existing = null;
    }

    if (existing) {
      existing.addEventListener("load", handleLoaded, { once: true });
      existing.addEventListener("error", handleError, { once: true });
      return;
    }

    const params = new URLSearchParams({
      key: browserKey,
      v: "weekly",
      loading: "async",
      language: "zh-CN",
      region: "SG",
    });
    const script = document.createElement("script");
    script.id = GOOGLE_MAPS_SCRIPT_ID;
    script.dataset.travelworldGoogleMaps = "true";
    script.dataset.travelworldGoogleMapsState = "loading";
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.dataset.travelworldGoogleMapsState = "loaded";
      handleLoaded();
    }, { once: true });
    script.addEventListener("error", () => {
      script.dataset.travelworldGoogleMapsState = "error";
      handleError();
    }, { once: true });
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    googleMapsPromise = null;
    throw error;
  });

  return googleMapsPromise;
}

function isPoint(point: GoogleSingaporeMapPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

function resolveMarker(marker: GoogleSingaporeMapMarker): ResolvedMarker | null {
  const position = marker.position ?? { lat: marker.lat ?? Number.NaN, lng: marker.lng ?? Number.NaN };
  return isPoint(position) ? { ...marker, position } : null;
}

function markerColor(marker: GoogleSingaporeMapMarker): string {
  if (marker.color) return marker.color;
  if (marker.kind === "hotel") return "#17352e";
  if (marker.kind === "food") return "#d68132";
  if (marker.kind === "transport") return "#4776a8";
  if (marker.kind === "activity") return "#8265a9";
  return "#f26444";
}

function markerLabel(marker: GoogleSingaporeMapMarker): string {
  if (marker.label !== undefined) return String(marker.label).slice(0, 3);
  if (marker.kind === "hotel") return "H";
  return "•";
}

function markerIcon(api: GoogleMapsApi, marker: GoogleSingaporeMapMarker, selected: boolean) {
  return {
    path: api.SymbolPath.CIRCLE,
    fillColor: markerColor(marker),
    fillOpacity: 1,
    strokeColor: selected ? "#ffffff" : "#fffdf8",
    strokeOpacity: 1,
    strokeWeight: selected ? 4 : 2,
    scale: selected ? 15 : 12,
  };
}

function stateCopy(state: LoadState, detail: string) {
  if (state === "config") return { title: "正在读取地图配置", text: "即将加载新加坡真实地图。" };
  if (state === "script") return { title: "正在加载 Google Maps", text: "地图和路线数据正在准备中。" };
  if (state === "missing-key") {
    return { title: "地图密钥尚未配置", text: detail || "请在站点环境变量中配置浏览器地图密钥。" };
  }
  return { title: "地图暂时无法加载", text: detail || "请稍后重试。" };
}

export function GoogleSingaporeMap({
  markers,
  route = [],
  selectedMarkerId = null,
  onMarkerSelect,
  center = SINGAPORE_CENTER,
  zoom = 12,
  routeColor = "#f26444",
  autoFit = true,
  panToSelected = true,
  mapId,
  configEndpoint = "/api/map-config",
  className,
  style,
  ariaLabel = "新加坡旅行路线地图",
}: GoogleSingaporeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const polylineRef = useRef<PolylineInstance | null>(null);
  const markersRef = useRef<Map<string, LiveMarker>>(new Map());
  const onMarkerSelectRef = useRef(onMarkerSelect);
  const fitSignatureRef = useRef("");
  const [api, setApi] = useState<GoogleMapsApi | null>(null);
  const [configuredMapId, setConfiguredMapId] = useState<string | undefined>();
  const [loadState, setLoadState] = useState<LoadState>("config");
  const [detail, setDetail] = useState("");
  const [retryCount, setRetryCount] = useState(0);

  const validMarkers = useMemo(
    () => markers.map(resolveMarker).filter((marker): marker is ResolvedMarker => marker !== null),
    [markers],
  );
  const validRoute = useMemo(() => route.filter(isPoint), [route]);

  useEffect(() => {
    onMarkerSelectRef.current = onMarkerSelect;
  }, [onMarkerSelect]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function prepareMap() {
      setLoadState("config");
      setDetail("");

      try {
        const response = await fetch(configEndpoint, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const config = (await response.json().catch(() => ({}))) as MapConfigResponse;

        if (!response.ok) {
          if (!active) return;
          setDetail(config.error || `地图配置请求失败（${response.status}）。`);
          setLoadState(response.status === 503 ? "missing-key" : "error");
          return;
        }

        const browserKey = config.browserKey || config.key;
        if (!browserKey) {
          if (!active) return;
          setDetail(config.error || "服务端没有返回浏览器地图密钥。反向代理密钥不会被发送到浏览器。" );
          setLoadState("missing-key");
          return;
        }

        if (!active) return;
        setConfiguredMapId(config.mapId);
        setLoadState("script");
        const loadedApi = await loadGoogleMaps(browserKey);
        if (!active) return;
        setApi(loadedApi);
        if (mapRef.current) setLoadState("ready");
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setDetail(error instanceof Error ? error.message : "未知地图加载错误。");
        setLoadState("error");
      }
    }

    void prepareMap();
    return () => {
      active = false;
      controller.abort();
    };
  }, [configEndpoint, retryCount]);

  useEffect(() => {
    if (!api || !containerRef.current) return;

    const options: Record<string, unknown> = {
      center: SINGAPORE_CENTER,
      zoom: 12,
      minZoom: 10,
      restriction: {
        latLngBounds: { north: 1.57, south: 1.15, west: 103.58, east: 104.12 },
        strictBounds: false,
      },
      mapTypeControl: false,
      fullscreenControl: false,
      streetViewControl: false,
      clickableIcons: false,
      gestureHandling: "greedy",
      backgroundColor: "#e8eee9",
    };
    const resolvedMapId = mapId || configuredMapId;
    if (resolvedMapId) options.mapId = resolvedMapId;

    const map = new api.Map(containerRef.current, options);
    const liveMarkers = markersRef.current;
    mapRef.current = map;
    setLoadState("ready");

    return () => {
      liveMarkers.forEach(({ instance, listener }) => {
        listener.remove();
        instance.setMap(null);
      });
      liveMarkers.clear();
      polylineRef.current?.setMap(null);
      polylineRef.current = null;
      api.event.clearInstanceListeners(map);
      mapRef.current = null;
    };
  }, [api, configuredMapId, mapId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setCenter(isPoint(center) ? center : SINGAPORE_CENTER);
    map.setZoom(zoom);
  }, [center, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!api || !map) return;

    const currentIds = new Set(validMarkers.map((marker) => marker.id));
    markersRef.current.forEach((liveMarker, markerId) => {
      if (currentIds.has(markerId)) return;
      liveMarker.listener.remove();
      liveMarker.instance.setMap(null);
      markersRef.current.delete(markerId);
    });

    validMarkers.forEach((marker, index) => {
      const selected = marker.id === selectedMarkerId;
      let liveMarker = markersRef.current.get(marker.id);

      if (!liveMarker) {
        const instance = new api.Marker({ map, position: marker.position, title: marker.title });
        const listener = instance.addListener("click", () => onMarkerSelectRef.current?.(marker.id));
        liveMarker = { instance, listener };
        markersRef.current.set(marker.id, liveMarker);
      }

      liveMarker.instance.setMap(map);
      liveMarker.instance.setPosition(marker.position);
      liveMarker.instance.setTitle(marker.title);
      liveMarker.instance.setIcon(markerIcon(api, marker, selected));
      liveMarker.instance.setLabel({
        text: markerLabel(marker),
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: selected ? "12px" : "11px",
        fontWeight: "800",
      });
      liveMarker.instance.setZIndex(selected ? 1000 : 100 + index);
    });

    if (validRoute.length >= 2) {
      if (!polylineRef.current) {
        polylineRef.current = new api.Polyline({
          map,
          geodesic: true,
          clickable: false,
          strokeOpacity: 0.92,
        });
      }
      polylineRef.current.setMap(map);
      polylineRef.current.setPath(validRoute);
      polylineRef.current.setOptions({ strokeColor: routeColor, strokeWeight: 5 });
    } else {
      polylineRef.current?.setMap(null);
    }

    const fitSignature = JSON.stringify({
      markers: validMarkers.map(({ id, position }) => [id, position.lat, position.lng]),
      route: validRoute.map((point) => [point.lat, point.lng]),
    });
    if (autoFit && fitSignature !== fitSignatureRef.current) {
      const bounds = new api.LatLngBounds();
      validMarkers.forEach((marker) => bounds.extend(marker.position));
      validRoute.forEach((point) => bounds.extend(point));
      if (!bounds.isEmpty()) map.fitBounds(bounds, 54);
      fitSignatureRef.current = fitSignature;
    }
  }, [api, autoFit, configuredMapId, mapId, routeColor, selectedMarkerId, validMarkers, validRoute]);

  useEffect(() => {
    if (!panToSelected || !selectedMarkerId || !mapRef.current) return;
    const selected = validMarkers.find((marker) => marker.id === selectedMarkerId);
    if (selected) mapRef.current.panTo(selected.position);
  }, [panToSelected, selectedMarkerId, validMarkers]);

  const copy = stateCopy(loadState, detail);
  const rootClassName = [styles.root, className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} style={style} aria-label={ariaLabel} aria-busy={loadState !== "ready"}>
      <div ref={containerRef} className={styles.canvas} />

      {loadState !== "ready" ? (
        <div className={styles.status} role={loadState === "error" ? "alert" : "status"}>
          <div className={styles.statusCard}>
            {loadState === "config" || loadState === "script" ? <span className={styles.spinner} aria-hidden="true" /> : null}
            <p className={styles.statusTitle}>{copy.title}</p>
            <p className={styles.statusText}>{copy.text}</p>
            {loadState === "error" || loadState === "missing-key" ? (
              <button type="button" className={styles.retry} onClick={() => setRetryCount((count) => count + 1)}>
                重新加载
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
