"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BedDouble,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Compass,
  ExternalLink,
  Hotel,
  Landmark,
  MapPin,
  Route,
  Sparkles,
  Ticket,
  Utensils,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  GoogleSingaporeMap,
  type GoogleSingaporeMapMarker,
  type GoogleSingaporeMapPoint,
} from "@/components/travel/google-singapore-map";
import { TravelLogo } from "@/components/travel/travel-logo";
import type { DemoTrip, TravelCommerce, TripDay, TripStop } from "@/lib/travel/types";

type StepId = "case-intent" | "case-anchor" | "case-live-routes" | "case-segments" | "case-details" | "case-revision";
type RouteLoadState = "idle" | "loading" | "ready" | "error";
type CommerceLoadState = "idle" | "loading" | "ready" | "error";

type CaseCommerceEntry = {
  placeId: string | null;
  name: string;
  address: string | null;
  commerce: TravelCommerce;
};

type CaseCommerceSnapshot = {
  fixedQuery: {
    itineraryStartDate: string;
    itineraryEndDate: string;
    hotelCheckInDate: string;
    hotelCheckOutDate: string;
    poiVisitDate: string;
    travelers: number;
  };
  queriedAt: string;
  expiresAt: string;
  hotel: CaseCommerceEntry;
  poi: CaseCommerceEntry;
};

type DayEditorial = {
  title: string;
  routeLabel: string;
  copy: string;
  image: string;
  imageAlt: string;
  credit: string;
  creditUrl: string;
  creditLicense: string;
  capability: string;
};

const dayEditorial: Record<string, DayEditorial> = {
  "day-1": {
    title: "从酒店出发，让城市先亮起来。",
    routeLabel: "Bugis → Civic District → Marina Bay",
    copy: "酒店先成为当天的出发与返回锚点；建筑、花园与夜景随后才被放进同一条可回店的路线。",
    image: "/travel-case/day-1-haji-lane.jpg",
    imageAlt: "新加坡哈芝巷的彩绘街区与行人",
    credit: "Moheen Reeyad",
    creditUrl: "https://commons.wikimedia.org/wiki/File:Haji_Lane,_Kampong_Glam_(02).jpg",
    creditLicense: "CC BY-SA 4.0",
    capability: "酒店锚点 · 每段路线可核对",
  },
  "day-2": {
    title: "把街区体验放回可步行的尺度。",
    routeLabel: "Bugis → Kampong Glam → Bugis",
    copy: "建筑、巷弄与慢行优先。餐饮作为路线中的体验出现，但不会被伪造成带飞猪报价的商品。",
    image: "/travel-case/day-2-marina-skyline.jpg",
    imageAlt: "新加坡滨海湾与城市天际线",
    credit: "Diego Delso",
    creditUrl: "https://commons.wikimedia.org/wiki/File:Skyline,_Singapur,_2023-08-18,_DD_21.jpg",
    creditLicense: "CC BY-SA 4.0",
    capability: "真实地点详情 · 餐饮价格边界清晰",
  },
  "day-3": {
    title: "花园与艺术，也必须留得出返店余量。",
    routeLabel: "Bugis → Tanglin → Bugis",
    copy: "每一段交通、每次停留和最后一程回店都来自同一次路线计算，而不是先写好一个看似合理的时刻表。",
    image: "/travel-case/day-3-national-gallery.jpg",
    imageAlt: "新加坡国家美术馆周边的城市景观",
    credit: "cattan2011",
    creditUrl: "https://commons.wikimedia.org/wiki/File:National_gallery_Singapore,_Singapore.jpg",
    creditLicense: "CC BY 2.0",
    capability: "Google Routes · 实时校准时间",
  },
  "day-4": {
    title: "最后一天收束行程，而不是牺牲边界。",
    routeLabel: "Bugis → Southern Ridges → Marina Bay → Bugis",
    copy: "四天在同一套酒店、地点与时间约束下闭环；换住宿时，只从生效日期起改变后续的出发与返回位置。",
    image: "/travel-case/day-4-marina-evening.jpg",
    imageAlt: "傍晚的新加坡滨海湾天际线和海滨步道",
    credit: "Nicolas Lannuzel",
    creditUrl: "https://commons.wikimedia.org/wiki/File:Skyline_from_marina_Bay,_evening_(16490072161).jpg",
    creditLicense: "CC BY-SA 2.0",
    capability: "四日闭环 · 21:00 返店受保护",
  },
};

const steps: Array<{ id: StepId; number: string; label: string }> = [
  { id: "case-intent", number: "01", label: "旅行条件" },
  { id: "case-anchor", number: "02", label: "住宿锚点" },
  { id: "case-live-routes", number: "03", label: "四日路线" },
  { id: "case-segments", number: "04", label: "分段住宿" },
  { id: "case-details", number: "05", label: "查看详情" },
  { id: "case-revision", number: "06", label: "动态改动" },
];

function decodeGooglePolyline(encoded: string): GoogleSingaporeMapPoint[] {
  const points: GoogleSingaporeMapPoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: latitude / 1e5, lng: longitude / 1e5 });
  }
  return points;
}

function pointFromStop(stop: TripStop): GoogleSingaporeMapPoint | null {
  const point = stop.location ?? (stop.lat !== undefined && stop.lng !== undefined ? { lat: stop.lat, lng: stop.lng } : null);
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
}

function routePoints(day: TripDay): GoogleSingaporeMapPoint[] {
  const points = day.legs.flatMap((leg) => leg.encodedPolyline ? decodeGooglePolyline(leg.encodedPolyline) : []);
  return points.filter((point, index, array) => index === 0 || point.lat !== array[index - 1].lat || point.lng !== array[index - 1].lng);
}

function markerKind(stop: TripStop): GoogleSingaporeMapMarker["kind"] {
  if (stop.kind === "hotel") return "hotel";
  if (stop.kind === "food") return "food";
  if (stop.kind === "buffer") return "activity";
  return "attraction";
}

function stopIcon(stop: TripStop): LucideIcon {
  if (stop.kind === "hotel") return Hotel;
  if (stop.kind === "food") return Utensils;
  if (stop.kind === "buffer") return Clock3;
  return Landmark;
}

function mapMarkers(day: TripDay): GoogleSingaporeMapMarker[] {
  return day.stops.flatMap((stop, index) => {
    const position = pointFromStop(stop);
    if (!position) return [];
    return [{
      id: stop.id,
      position,
      title: stop.name,
      label: stop.kind === "hotel" ? "H" : index,
      kind: markerKind(stop),
      color: stop.kind === "hotel" ? "#17352e" : day.color,
    }];
  });
}

function readableError(payload: unknown) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return "路线暂时无法计算。你仍可继续浏览案例中的条件与能力说明。";
}

function DataMark({ children, tone = "default" }: { children: string; tone?: "default" | "light" }) {
  return <p className={`tw-case-v3-data-mark tw-case-v3-data-mark--${tone}`}><CheckCircle2 size={14} />{children}</p>;
}

function IntentChapter() {
  return (
    <section className="tw-case-v3-chapter tw-case-v3-intent" id="case-intent" data-case-step>
      <div className="tw-case-v3-chapter-head">
        <p><Sparkles size={16} /> 01 · TRAVEL CONDITIONS</p>
        <h2>一句旅行愿望，<br />先变成一组约束。</h2>
        <span>图里的多次追问不是多个页面，而是一件事的连续发生：先识别已知条件，再持续追问未完整的条件，直到可以安全地去查酒店和路线。</span>
      </div>

      <div className="tw-case-v3-intent-film">
        <article className="tw-case-v3-message tw-case-v3-message--ai">
          <span><Sparkles size={15} /> travelworld intelligence</span>
          <p>先告诉我准确的出行日期、同行人数、住宿区域或酒店、每日出发与回店时间，以及旅行节奏。信息齐全后，才会查酒店、地点和路线。</p>
        </article>
        <article className="tw-case-v3-message tw-case-v3-message--user">
          <span>你</span>
          <p>我和伴侣两位成人，每天 09:30 出发、21:00 回酒店，节奏轻松，喜欢建筑、美食和夜景。</p>
        </article>
        <article className="tw-case-v3-condition-state is-partial">
          <header><span>INTENT CONFIDENCE</span><b>55%</b></header>
          <i><em /></i>
          <p>还需要：准确出行日期（含年份）和住宿区域或意向酒店。</p>
          <div className="tw-case-v3-condition-grid">
            <span><MapPin size={18} /><b>目的地</b><small>新加坡 · 已识别</small></span>
            <span><CalendarDays size={18} /><b>日期与时长</b><small>待补充</small></span>
            <span><Hotel size={18} /><b>住宿锚点</b><small>待补充</small></span>
            <span><Clock3 size={18} /><b>每日时段</b><small>09:30 — 21:00</small></span>
          </div>
        </article>
        <article className="tw-case-v3-message tw-case-v3-message--user is-small">
          <span>你</span>
          <p>2026 年 12 月 20 日至 23 日去新加坡，住 Bugis 附近。</p>
        </article>
        <article className="tw-case-v3-condition-state is-complete">
          <header><span>INTENT CONFIDENCE</span><b>100%</b></header>
          <i><em /></i>
          <p>旅行条件完整。下一步只展示可验证的酒店候选，再确认每日草案。</p>
          <div className="tw-case-v3-condition-grid">
            <span><CalendarDays size={18} /><b>12/20 — 12/23</b><small>4 个旅行日</small></span>
            <span><Hotel size={18} /><b>Bugis 附近</b><small>住宿区域</small></span>
            <span><Compass size={18} /><b>2 位成人 · 轻松</b><small>同行与节奏</small></span>
            <span><Clock3 size={18} /><b>09:30 — 21:00</b><small>严格时间边界</small></span>
          </div>
        </article>
        <article className="tw-case-v3-outline-card">
          <header><span>DAILY OUTLINE · 每日草案</span><b>条件完整后生成</b></header>
          {[
            ["DAY 01", "滨海城市初印象", "Civic District · Marina Bay"],
            ["DAY 02", "街区建筑与慢行", "Kampong Glam · Bugis"],
            ["DAY 03", "花园与兰花", "Tanglin · Botanic Gardens"],
            ["DAY 04", "南部步道与海湾收束", "Mount Faber · Marina Bay"],
          ].map(([day, title, meta]) => <div key={day}><span>{day}</span><b>{title}</b><small>{meta}</small><Check size={15} /></div>)}
        </article>
      </div>
      <DataMark>百炼负责结构化理解与持续追问；路线与地点查询在条件完整且用户确认后才发生。</DataMark>
    </section>
  );
}

function AnchorChapter() {
  return (
    <section className="tw-case-v3-chapter tw-case-v3-anchor" id="case-anchor" data-case-step>
      <div className="tw-case-v3-chapter-head">
        <p><Hotel size={16} /> 02 · HOTEL ANCHOR</p>
        <h2>酒店不是一个停留点，<br />而是路线的重力中心。</h2>
        <span>用户先在 Google Places 识别的候选中选择具体酒店；只有选定后，它才成为每一天的出发与返回锚点。</span>
      </div>
      <div className="tw-case-v3-anchor-stage">
        <div className="tw-case-v3-anchor-lock" aria-hidden="true"><Hotel size={27} /><i /><span>ANCHOR<br />LOCKED</span></div>
        <div className="tw-case-v3-hotel-list">
          <header><span>CONFIRM ACCOMMODATION · 住宿确认</span><b>选择全程的出发与返回酒店</b><small>Google Places 负责酒店实体与位置；飞猪价格只在有日期、人数后按需请求。</small></header>
          <article className="is-selected">
            <i><Hotel size={20} /></i><div><b>Village Hotel Bugis</b><small>390 Victoria Street, Singapore</small><em><CheckCircle2 size={13} />Google Places 已验证</em></div><span><strong>全程锚点</strong><ChevronRight size={16} /></span>
          </article>
          <article><i><Hotel size={20} /></i><div><b>新加坡武吉士美居酒店</b><small>122 Middle Road, Singapore</small><em>Google Places 候选</em></div><span>比较候选</span></article>
          <article><i><Hotel size={20} /></i><div><b>ibis budget Singapore Bugis</b><small>33 Middle Road, Singapore</small><em>Google Places 候选</em></div><span>比较候选</span></article>
        </div>
        <aside className="tw-case-v3-price-rule"><CircleDollarSign size={20} /><span><b>价格不在页面加载时伪造</b><small>选择酒店后，才以出行日期与同行人数向飞猪查询实际可用报价和预订链接。</small></span></aside>
      </div>
      <DataMark>锚点确认后，Google Routes 才会计算「酒店 → 地点 → 酒店」；后续换酒店会从生效日期开始重算。</DataMark>
    </section>
  );
}

function RouteTimeline({ day }: { day: TripDay }) {
  return (
    <ol className="tw-case-v3-route-timeline" aria-label={`${day.label} 的 Google Routes 时间轴`}>
      {day.stops.map((stop, index) => {
        const Icon = stopIcon(stop);
        const returnStop = index === day.stops.length - 1 && stop.kind === "hotel";
        return <li key={stop.id} className={stop.kind === "hotel" ? "is-hotel" : stop.kind === "buffer" ? "is-buffer" : ""}>
          <time>{stop.time}<small>{stop.endTime !== stop.time ? stop.endTime : ""}</small></time>
          <i><Icon size={15} /></i>
          <span><b>{stop.name}</b><small>{stop.categoryLabel || stop.duration}{returnStop ? " · 返回酒店" : ""}</small></span>
        </li>;
      })}
    </ol>
  );
}

function RouteMapStage({ trip, activeDayIndex, status, error }: {
  trip?: DemoTrip;
  activeDayIndex: number;
  status: RouteLoadState;
  error: string | null;
}) {
  const day = trip?.days[activeDayIndex];
  const editorial = day ? dayEditorial[day.id] : undefined;
  const markers = useMemo(() => day ? mapMarkers(day) : [], [day]);
  const route = useMemo(() => day ? routePoints(day) : [], [day]);

  return (
    <aside className="tw-case-v3-map-stage" aria-live="polite">
      <header>
        <span><i /> {status === "ready" ? "GOOGLE ROUTES · 已实时计算" : status === "error" ? "GOOGLE ROUTES · 暂不可用" : "GOOGLE ROUTES · 准备计算"}</span>
        <b>{day ? `${day.label.toUpperCase()} · ${day.date}` : "4 DAYS · SINGAPORE"}</b>
      </header>
      <div className="tw-case-v3-map-stage-body">
        <div className="tw-case-v3-live-map">
          {status === "ready" && day ? <GoogleSingaporeMap
            markers={markers}
            route={route}
            routeColor={day.color}
            className="tw-case-v3-google-map"
            ariaLabel={`${day.label} 的 Google Maps 真实路线`}
          /> : <div className="tw-case-v3-map-loading">
            <span className={status === "loading" ? "is-loading" : ""}><Route size={28} /></span>
            <b>{status === "loading" ? "正在重新计算四日真实路线" : status === "error" ? "真实路线暂不可用" : "滚动到路线窗后加载"}</b>
            <small>{status === "error" ? error : "地点、交通分钟数和返店时间将来自同一份 Google Routes 结果。"}</small>
          </div>}
          {day ? <div className="tw-case-v3-map-overlay"><span><MapPin size={14} /> {editorial?.routeLabel}</span><small>{day.returnBy ? `${day.returnBy} 前回酒店` : "返店时间校验中"}</small></div> : null}
        </div>
        <div className="tw-case-v3-live-timeline">
          {day ? <RouteTimeline day={day} /> : <div className="tw-case-v3-timeline-placeholder"><Clock3 size={22} /><span>路线就绪后，时间轴将与地图同步出现。</span></div>}
        </div>
      </div>
      <footer><CheckCircle2 size={14} />{status === "ready" ? "地图、路线与时间轴来自同一份运行时结果；Google Maps 归因保留在地图中。" : "公开案例不会使用其他设备本地保存的行程数据。"}</footer>
    </aside>
  );
}

function RoutesChapter({
  activeDayIndex,
  trip,
  status,
  error,
}: {
  activeDayIndex: number;
  trip?: DemoTrip;
  status: RouteLoadState;
  error: string | null;
}) {
  const activeDay = trip?.days[activeDayIndex];
  return (
    <section className="tw-case-v3-routes" id="case-live-routes" data-case-step>
      <div className="tw-case-v3-routes-head">
        <p><Route size={16} /> 03 · ROUTE RIBBON / 四日行旅窗</p>
        <h2>地图不是插图，<br />它和时间一起发生。</h2>
        <span>滚动右侧四天故事时，左侧的真实地图、路线与时间轴同步推进。路线只在进入此处后请求一次，并使用同一份结果展示所有时间。</span>
      </div>
      <div className="tw-case-v3-route-grid">
        <nav className="tw-case-v3-route-rail" aria-label="四日路线">
          {(trip?.days ?? [1, 2, 3, 4].map((value) => typeof value === "number" ? { id: `day-${value}`, label: `Day ${value}`, theme: "路线准备中" } : value)).map((day, index) => <span key={day.id} className={index === activeDayIndex ? "is-active" : ""}><b>0{index + 1}</b><i /><small>{day.label}</small><em>{day.theme}</em></span>)}
        </nav>
        <RouteMapStage trip={trip} activeDayIndex={activeDayIndex} status={status} error={error} />
        <div className="tw-case-v3-day-scenes">
          {["day-1", "day-2", "day-3", "day-4"].map((id, index) => {
            const editorial = dayEditorial[id];
            const liveDay = trip?.days[index];
            return <article data-case-day={index} key={id} className={`tw-case-v3-day-scene ${index === activeDayIndex ? "is-active" : ""}`}>
              <figure>
                <img src={editorial.image} alt={editorial.imageAlt} loading={index === 0 ? "eager" : "lazy"} />
                <div />
                <figcaption><a href={editorial.creditUrl} target="_blank" rel="noreferrer">图：{editorial.credit} · {editorial.creditLicense}<ExternalLink size={12} /></a></figcaption>
              </figure>
              <div>
                <p>DAY 0{index + 1} <span>·</span> {liveDay?.date ?? `12/2${index}`}</p>
                <h3>{editorial.title}</h3>
                <small>{editorial.routeLabel}</small>
                <p>{editorial.copy}</p>
                <b><CheckCircle2 size={15} />{liveDay?.summary ?? editorial.capability}</b>
                {activeDay?.id === id && status === "ready" ? <em><Route size={14} />当前地图正在显示这一天</em> : null}
              </div>
            </article>;
          })}
        </div>
      </div>
    </section>
  );
}

function SegmentsChapter() {
  return (
    <section className="tw-case-v3-capability tw-case-v3-segments" id="case-segments" data-case-step>
      <div className="tw-case-v3-capability-copy">
        <p><BedDouble size={16} /> 04 · STAY SEGMENT</p>
        <h2>换酒店，<br />只从正确的那天开始。</h2>
        <span>“分段住宿”不是把一间酒店塞进时间轴。它是一个有生效日期的路由条件：换酒店当天由上一晚酒店出发，在新酒店结束；后续日期才围绕新锚点安排。</span>
      </div>
      <div className="tw-case-v3-segment-board">
        <header><span>设置分段住宿 <em>功能示意</em></span><small>从指定日期开始入住新酒店</small><i>DAY 02</i></header>
        <div className="tw-case-v3-segment-flow">
          <article><b>DAY 01</b><Hotel size={22} /><strong>Village Hotel Bugis</strong><small>出发 · 返回</small></article>
          <span><ChevronRight size={20} /></span>
          <article className="is-change"><b>DAY 02 — DAY 04</b><Hotel size={22} /><strong>ibis budget Singapore Bugis</strong><small>从 Day 2 生效的住宿锚点</small></article>
        </div>
        <footer><CheckCircle2 size={16} /><span><b>路由影响范围清楚可见</b><small>Day 1 不被倒改；Day 2 从上一晚酒店出发，并在新酒店结束。确认后会重算 Day 2 起路线；上方实况地图仍展示本案例当前的全程酒店锚点。</small></span></footer>
      </div>
    </section>
  );
}

function CaseCommerceFooter({
  kind,
  snapshot,
  state,
}: {
  kind: "hotel" | "poi";
  snapshot?: CaseCommerceSnapshot;
  state: CommerceLoadState;
}) {
  const entry = kind === "hotel" ? snapshot?.hotel : snapshot?.poi;
  const commerce = entry?.commerce;
  const price = commerce?.price;
  const bookingUrl = commerce?.bookingUrl;
  const isAvailable = commerce?.status === "available" && Boolean(price && bookingUrl);
  const queryLabel = snapshot
    ? kind === "hotel"
      ? `${snapshot.fixedQuery.hotelCheckInDate.slice(5).replace("-", "/")} 入住 · ${snapshot.fixedQuery.hotelCheckOutDate.slice(5).replace("-", "/")} 离店 · ${snapshot.fixedQuery.travelers} 位成人`
      : `${snapshot.fixedQuery.poiVisitDate.slice(5).replace("-", "/")} 到访 · ${snapshot.fixedQuery.travelers} 位成人`
    : kind === "hotel"
      ? "固定 12/20 入住 · 12/24 离店 · 2 位成人"
      : "固定 12/20 到访 · 2 位成人";
  const title = isAvailable && price
    ? `${kind === "hotel" ? "飞猪价格参考" : "飞猪景点商品"} · ${price.display}${price.unit ? ` · ${price.unit}` : ""}`
    : state === "error"
      ? "飞猪报价暂时不可用"
      : state === "ready"
        ? "暂未取得可靠飞猪报价"
        : "正在核验飞猪报价";
  const note = isAvailable
    ? `${queryLabel} · 以飞猪预订页的实时库存与价格为准`
    : commerce?.note || (state === "error" ? "案例地点仍保留 Google Places 信息。" : `${queryLabel} · 仅在取得真实价格与链接后展示。`);

  return (
    <footer>
      <span>
        {kind === "hotel" ? <CircleDollarSign size={17} /> : <Ticket size={17} />}
        <b>{title}</b>
        <small>{note}</small>
      </span>
      {isAvailable && bookingUrl ? (
        <a href={bookingUrl} target="_blank" rel="noreferrer" aria-label={`在飞猪查看 ${entry?.name || (kind === "hotel" ? "案例酒店" : "案例景点")} 的详情`}>
          在飞猪查看详情 <ExternalLink size={13} />
        </a>
      ) : (
        <span className="tw-case-v3-commerce-disabled" aria-live="polite">
          {state === "loading" || state === "idle" ? "查询中" : "暂无链接"}
        </span>
      )}
    </footer>
  );
}

function DetailsChapter({
  commerce,
  commerceState,
}: {
  commerce?: CaseCommerceSnapshot;
  commerceState: CommerceLoadState;
}) {
  return (
    <section className="tw-case-v3-capability tw-case-v3-details" id="case-details" data-case-step>
      <div className="tw-case-v3-capability-copy">
        <p><MapPin size={16} /> 05 · PLACE DETAILS</p>
        <h2>每个地点，<br />都能看见它从哪里来。</h2>
        <span>酒店与景点有类别、说明、地址、营业信息与按需查询的商品/价格状态。餐厅只保留真实地点信息，不调用飞猪，也不制造餐饮价格。</span>
      </div>
      <div className="tw-case-v3-details-stack">
        <article className="tw-case-v3-detail-card is-hotel">
          <header><span>GOOGLE PLACE · 地点详情</span><i aria-hidden="true">×</i></header>
          <h3>Village Hotel Bugis</h3>
          <div className="tw-case-v3-detail-pills"><span>酒店</span><span>Google Places 已验证</span></div>
          <p>当天路线的出发酒店，也是行程结束后的返回锚点。案例固定以 12 月 20 日至 23 日的四日行程展示。</p>
          <small>390 Victoria Street, Singapore</small>
          <CaseCommerceFooter kind="hotel" snapshot={commerce} state={commerceState} />
        </article>
        <article className="tw-case-v3-detail-card is-poi">
          <header><span>GOOGLE PLACE · 地点详情</span><i aria-hidden="true">×</i></header>
          <h3>新加坡国家美术馆</h3>
          <div className="tw-case-v3-detail-pills"><span>建筑与艺术</span><span>营业信息按当前地点返回</span></div>
          <p>建筑与艺术体验的真实参观点；案例会以 Day 1 的固定到访日期向飞猪核验可展示的门票或预订信息。</p>
          <small>1 St Andrew&apos;s Rd, Singapore</small>
          <CaseCommerceFooter kind="poi" snapshot={commerce} state={commerceState} />
        </article>
        <article className="tw-case-v3-food-boundary"><Utensils size={19} /><span><b>餐厅的边界是透明的</b><small>飞猪数据范围覆盖酒店、景点、航班与火车，不包含餐厅和餐饮团购套餐；因此餐厅只展示 Google Places 的真实地点详情。</small></span></article>
      </div>
    </section>
  );
}

function RevisionChapter() {
  return (
    <section className="tw-case-v3-capability tw-case-v3-revision" id="case-revision" data-case-step>
      <div className="tw-case-v3-capability-copy">
        <p><Workflow size={16} /> 06 · LOCAL REVISION</p>
        <h2>一句修改，<br />只改变应该改变的部分。</h2>
        <span>百炼先理解一条自然语言中的多个动作，再在最新 Day 1 上批量执行、重新计算路线与时间；已确认的住宿锚点与 21:00 返店仍被保护。</span>
      </div>
      <div className="tw-case-v3-revision-board">
        <div className="tw-case-v3-command"><Sparkles size={18} /><span>“把自由活动安排成更多建筑与夜景活动，重新规划一下。”</span><ChevronRight size={18} /></div>
        <div className="tw-case-v3-revision-flow">
          <article><small>01 · 百炼智能体</small><b>理解多个动作</b><p>去除餐饮检索意图；保留建筑、夜景和当前区域；识别“重新规划”作用于当前选中的旅行日。</p></article>
          <span><ChevronRight size={20} /></span>
          <article><small>02 · Google Places / Routes</small><b>补入真实可到达地点</b><p>在自由活动时间内加入地点，重新计算受影响的路线与时刻。</p></article>
          <span><ChevronRight size={20} /></span>
          <article className="is-guarded"><small>03 · 约束保护</small><b>21:00 仍返酒店</b><p>旧路线淡出，新路线绘制；酒店锚点、其他天和返店边界不被误改。</p></article>
        </div>
        <div className="tw-case-v3-revision-ribbon" aria-hidden="true"><i /><b>旧路线</b><em /><strong>新路线</strong><span><Hotel size={15} />21:00</span></div>
      </div>
    </section>
  );
}

export function SingaporeCaseStudyClient() {
  const pageRef = useRef<HTMLElement>(null);
  const commerceRequestStartedRef = useRef(false);
  const [activeStep, setActiveStep] = useState<StepId>("case-intent");
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [routeStageSeen, setRouteStageSeen] = useState(false);
  const [routeState, setRouteState] = useState<RouteLoadState>("idle");
  const [caseTrip, setCaseTrip] = useState<DemoTrip>();
  const [routeError, setRouteError] = useState<string | null>(null);
  const [detailsStageSeen, setDetailsStageSeen] = useState(false);
  const [commerceState, setCommerceState] = useState<CommerceLoadState>("idle");
  const [caseCommerce, setCaseCommerce] = useState<CaseCommerceSnapshot>();

  const scrollToStep = useCallback((id: StepId, updateHash = true) => {
    const root = pageRef.current;
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    if (!root || !target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetTop = root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 86;
    root.scrollTo({ top: Math.max(0, targetTop), behavior: reducedMotion ? "auto" : "smooth" });
    if (updateHash && window.location.hash !== `#${id}`) window.history.pushState(null, "", `#${id}`);
  }, []);

  const handleStepJump = (event: MouseEvent<HTMLAnchorElement>, id: StepId) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    scrollToStep(id);
  };

  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const scrollToHash = () => {
      const hash = window.location.hash.slice(1);
      const target: StepId = hash === "case-walkthrough"
        ? "case-intent"
        : steps.some((step) => step.id === hash) ? hash as StepId : "case-intent";
      window.requestAnimationFrame(() => scrollToStep(target, false));
    };
    let firstFrame = window.requestAnimationFrame(() => { firstFrame = window.requestAnimationFrame(scrollToHash); });
    const settleHash = window.setTimeout(scrollToHash, 180);
    const onHashChange = () => window.requestAnimationFrame(scrollToHash);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);

    const sectionObserver = new IntersectionObserver((entries) => {
      const closest = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (closest) setActiveStep(closest.target.id as StepId);
    }, { root, threshold: [0.18, 0.42, 0.72], rootMargin: "-18% 0px -48%" });
    root.querySelectorAll<HTMLElement>("[data-case-step]").forEach((element) => sectionObserver.observe(element));

    const routeElement = root.querySelector<HTMLElement>("#case-live-routes");
    const routeObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRouteStageSeen(true);
    }, { root, threshold: 0.08 });
    if (routeElement) routeObserver.observe(routeElement);

    const detailsElement = root.querySelector<HTMLElement>("#case-details");
    const detailsObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setDetailsStageSeen(true);
    }, { root, threshold: 0.08 });
    if (detailsElement) detailsObserver.observe(detailsElement);

    const dayObserver = new IntersectionObserver((entries) => {
      const closest = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const index = Number(closest?.target.getAttribute("data-case-day"));
      if (Number.isInteger(index) && index >= 0 && index < 4) setActiveDayIndex(index);
    }, { root, threshold: [0.25, 0.58], rootMargin: "-20% 0px -28%" });
    root.querySelectorAll<HTMLElement>("[data-case-day]").forEach((element) => dayObserver.observe(element));

    return () => {
      sectionObserver.disconnect();
      routeObserver.disconnect();
      detailsObserver.disconnect();
      dayObserver.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.clearTimeout(settleHash);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, [scrollToStep]);

  useEffect(() => {
    if (!routeStageSeen || routeState !== "idle") return;
    const controller = new AbortController();
    async function loadCaseRoute() {
      setRouteState("loading");
      setRouteError(null);
      try {
        const response = await fetch("/api/travel/singapore/case", {
          method: "POST",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as { trip?: DemoTrip; error?: { message?: string } };
        if (!response.ok || !payload.trip) throw new Error(readableError(payload));
        setCaseTrip(payload.trip);
        setRouteState("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRouteError(error instanceof Error ? error.message : "路线暂时无法计算。");
        setRouteState("error");
      }
    }
    void loadCaseRoute();
    return () => controller.abort();
  // Deliberately key this request only to visibility. Including routeState here
  // would re-run the effect immediately after `loading` is set, aborting the
  // request that this effect just started.
  }, [routeStageSeen]);

  useEffect(() => {
    if (!detailsStageSeen || commerceRequestStartedRef.current) return;
    commerceRequestStartedRef.current = true;
    const controller = new AbortController();
    async function loadCaseCommerce() {
      setCommerceState("loading");
      try {
        const response = await fetch("/api/travel/singapore/case-commerce", {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as CaseCommerceSnapshot & { error?: string };
        if (!response.ok || !payload.hotel?.commerce || !payload.poi?.commerce || !payload.fixedQuery) {
          throw new Error(payload.error || "案例飞猪价格暂时无法查询。");
        }
        setCaseCommerce(payload);
        setCommerceState("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCommerceState("error");
      }
    }
    void loadCaseCommerce();
    return () => controller.abort();
  // This request is deliberately made once only after the details panel enters
  // view, so scrolling within the case does not open repeat FlyAI sessions.
  }, [detailsStageSeen]);

  return (
    <main className="tw-case-page tw-case-v3-page" ref={pageRef}>
      <header className="tw-case-nav tw-case-v3-nav">
        <a className="tw-case-back" href="/travel" aria-label="返回 travelworld 首页"><ArrowLeft size={19} /></a>
        <TravelLogo />
        <div><span className="tw-case-nav-label">真实案例导览</span><a className="tw-case-nav-action" href="/travel/new">开始我的旅行 <ArrowRight size={15} /></a></div>
      </header>

      <section className="tw-case-v3-hero">
        <div className="tw-case-v3-hero-orbit tw-case-v3-hero-orbit--one" aria-hidden="true" />
        <div className="tw-case-v3-hero-orbit tw-case-v3-hero-orbit--two" aria-hidden="true" />
        <p><Sparkles size={16} /> SINGAPORE CASE · 4 DAYS · REAL ROUTE</p>
        <h1>看一段旅行，<br /><span>如何真的走得通。</span></h1>
        <strong>不是“生成一份攻略”，而是让意图、酒店、地点、路线、价格边界与每一次修改，都回到一条能走完的时间线上。</strong>
        <div className="tw-case-v3-hero-facts"><span><CalendarDays size={16} />12/20 — 12/23</span><span><Compass size={16} />2 位成人 · 轻松</span><span><Clock3 size={16} />09:30 — 21:00</span></div>
        <a href="#case-intent" onClick={(event) => handleStepJump(event, "case-intent")}>进入行旅窗 <ArrowRight size={16} /></a>
        <small>滚动即时间线 · 进入路线章节后才计算真实 Google Routes</small>
      </section>

      <nav className="tw-case-v3-chapter-nav" aria-label="案例章节">
        {steps.map((step) => <a key={step.id} href={`#${step.id}`} onClick={(event) => handleStepJump(event, step.id)} aria-current={activeStep === step.id ? "step" : undefined}><span>{step.number}</span>{step.label}</a>)}
      </nav>

      <IntentChapter />
      <AnchorChapter />
      <RoutesChapter activeDayIndex={activeDayIndex} trip={caseTrip} status={routeState} error={routeError} />
      <SegmentsChapter />
      <DetailsChapter commerce={caseCommerce} commerceState={commerceState} />
      <RevisionChapter />

      <section className="tw-case-v3-close">
        <div><p><Sparkles size={16} /> YOUR TURN</p><h2><span>下一段走得通的旅行，</span><span>从你的条件开始。</span></h2><span>每个地点有来源、每段路线有时间、每次改动有影响范围。</span></div>
        <a className="tw-button" href="/travel/new">开始我的旅行 <ArrowRight size={18} /></a>
      </section>
    </main>
  );
}
