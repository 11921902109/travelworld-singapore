"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Hotel, MapPin,
  Route, Send, ShieldCheck, Sparkles, Users, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { TravelLogo } from "@/components/travel/travel-logo";
import { PlanningJourney } from "@/components/travel/planning/planning-journey";
import { PlanningHelpPanel } from "@/components/travel/planning/planning-help-panel";
import type { PlanningHelpContext } from "@/lib/travel/planning-help-questions";
import { planningPrompts } from "@/lib/travel/demo-trip";
import { cnyReferenceLabel } from "@/lib/travel/cny-price";
import type { PlanningHandoffV1 } from "@/lib/travel/planning-state";
import { liveTripStorageKey, type StoredLiveTrip } from "@/lib/travel/trip-storage";
import { getTravelVisitToken } from "@/lib/travel/visit-client";
import type {
  ConfirmedAccommodationAnchor,
  SingaporeIntentResponse,
  SingaporeOutlineDay,
  SingaporePlanResponse,
  SingaporeTravelIntent,
  TravelCommerce,
} from "@/lib/travel/types";

type Message = { id: number; role: "assistant" | "user"; text: string; error?: boolean };
type IntentIssue = {
  issueId: string;
  kind: "blocking" | "ambiguity" | "missing";
  message: string;
  suggestedQuestion?: string | null;
};
type IntentAnalysis = Pick<SingaporeIntentResponse, "missingInformation" | "ambiguities" | "blockingIssues" | "complete" | "progress"> & {
  issues: IntentIssue[] | null;
};
type IntentStatePayload = {
  stateVersion?: number;
  state?: SingaporeIntentResponse | null;
  placeDiscoveryReady?: boolean;
  placeDiscoveryIssues?: string[];
  code?: string;
  error?: string;
};
type IntentApiPayload = Partial<SingaporeIntentResponse> & IntentStatePayload;
type HandoffPayload = {
  handoff: PlanningHandoffV1 | null;
  handoffId: string | null;
  sourceIntentStateVersion: number | null;
  planningSessionReady: boolean;
  currentIntentStateVersion?: number;
  state?: SingaporeIntentResponse | null;
  issues?: string[];
  code?: string;
  error?: string;
};
type HotelCandidate = {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  rating: number | null;
  userRatingCount: number | null;
  googleMapsUri: string | null;
};
type PendingHotelSelection = {
  anchor: ConfirmedAccommodationAnchor;
  commerce: TravelCommerce | null;
};

const NEW_PLANNING_FLOW = process.env.NEXT_PUBLIC_TRAVEL_PLANNING_V2 !== "0";
const PANEL_WIDTH_KEY = "travelworld:planner-panel-width";
const initialAssistant = NEW_PLANNING_FLOW
  ? "告诉我准确的出行日期（含年份）、同行人数、每天大致出发与返回时间、旅行节奏，以及想看或想避开的内容。条件足够后，你先挑选真实地点并分配到每天，再决定航班与住宿。"
  : "先告诉我准确的出行日期（含年份、开始日和结束日）、同行人数、想住的区域或酒店、每日出发与回酒店时间，以及旅行节奏。信息补齐后，我会先展示 Google 验证的酒店候选和飞猪价格参考，选定一间后才会生成地图。";

const paceLabels: Record<string, string> = {
  relaxed: "轻松",
  balanced: "均衡",
  intensive: "紧凑",
  packed: "充实",
};

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload as { error?: string | { message?: string }; message?: string };
  if (typeof candidate.error === "string") return candidate.error;
  if (candidate.error && typeof candidate.error.message === "string") return candidate.error.message;
  return typeof candidate.message === "string" ? candidate.message : fallback;
}

function legacyIntentIssues(analysis: IntentAnalysis): IntentIssue[] {
  const seen = new Set<string>();
  return [
    ...analysis.blockingIssues.map((message) => ({ kind: "blocking" as const, message })),
    ...analysis.ambiguities.map((message) => ({ kind: "ambiguity" as const, message })),
    ...analysis.missingInformation.map((message) => ({ kind: "missing" as const, message })),
  ].flatMap((issue, index) => {
    const category = /酒店|住宿|船形|滨海湾金沙/.test(issue.message)
      ? "accommodation"
      : /日期|起止日|出行天数|1[–-]7 天/.test(issue.message)
        ? "dates"
        : issue.message.trim();
    if (seen.has(category)) return [];
    seen.add(category);
    return [{ ...issue, issueId: `legacy-${index}` }];
  });
}

function totalTravelers(intent: SingaporeTravelIntent) {
  const group = intent.travelers;
  if (!group) return null;
  if (Number(group.total) > 0) return Number(group.total);
  const total = Number(group.adults || 0) + Number(group.children || 0) + Number(group.seniors || 0);
  return total > 0 ? total : null;
}

function dateSummary(intent: SingaporeTravelIntent) {
  if (isCalendarDate(intent.startDate) && isCalendarDate(intent.endDate)) {
    if (!intent.durationDays) {
      const days = Math.round((Date.parse(`${intent.endDate}T00:00:00Z`) - Date.parse(`${intent.startDate}T00:00:00Z`)) / 86_400_000) + 1;
      if (days > 7) return `${intent.startDate} — ${intent.endDate} · ${days} 天（上限 7 天）`;
      return `${intent.startDate} — ${intent.endDate} · 日期待确认`;
    }
    return `${intent.startDate} — ${intent.endDate} · ${intent.durationDays} 天`;
  }
  return "待补充准确日期";
}

function asksAboutPreviousIssue(message: string) {
  return /^(?:啥意思|什么意思|这(?:是|个)?什么(?:意思|问题)|哪里(?:有问题|错了)|为什么(?:不行|报错|失败)|能解释一下吗)(?:[，,。\s]*(?:你不能给我安排行程吗|怎么不能安排行程|为什么不能安排行程))?[？?。.!！\s]*$/i.test(message.trim());
}

function explainPreviousIssue(issue: string) {
  if (/只支持规划 1–7 天|上限 7 天/.test(issue)) {
    return `上一次没有生成行程，是因为所选日期包含开始日和结束日后超过了 7 天。${issue} 你可以缩短起止日期，我会保留已识别的其他旅行条件。`;
  }
  if (/数据格式|未能完整解析|未返回可解析/.test(issue)) {
    return `这表示智能服务这次返回的结构化结果不完整，不代表你的旅行要求一定有问题。${issue} 请把日期、住宿和时间分别说清楚后重试；不明白的地点名称也可以换一种说法。`;
  }
  if (/船形酒店|头上顶着船|滨海湾金沙酒店吗/.test(issue)) {
    return `我不能只凭外观描述就擅自选定酒店。${issue} 请确认是否为滨海湾金沙酒店，或直接说出酒店名。`;
  }
  return `上一条提示的意思是：${issue} 请按提示确认或换一种说法，我会继续保留已经识别的条件。`;
}

function accommodationSummary(intent: SingaporeTravelIntent) {
  return intent.accommodation?.hotelName || intent.accommodation?.areaName || "待补充";
}

function sameHotelName(left?: string | null, right?: string | null) {
  return Boolean(left && right && left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US"));
}

function accommodationState(intent: SingaporeTravelIntent, anchor: ConfirmedAccommodationAnchor | null) {
  if (anchor) return "Google Places 已确认 · 全程锚点";
  if (intent.accommodation?.hotelName) return "已识别，待比较价格并确认";
  if (intent.accommodation?.areaName) return "已识别，待比较酒店与价格";
  return "请提供酒店或住宿区域";
}

function isCalendarDate(value?: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasExactTravelDates(intent: SingaporeTravelIntent) {
  return Boolean(isCalendarDate(intent.startDate) && isCalendarDate(intent.endDate) && intent.durationDays);
}

function hasTravelers(intent: SingaporeTravelIntent) {
  return Boolean(totalTravelers(intent));
}

function hasAccommodationPreference(intent: SingaporeTravelIntent) {
  return Boolean(intent.accommodation?.hotelName?.trim() || intent.accommodation?.areaName?.trim());
}

function canStartAccommodationSelection(intent: SingaporeTravelIntent) {
  return Boolean(
    hasExactTravelDates(intent) &&
      hasTravelers(intent) &&
      hasAccommodationPreference(intent) &&
      intent.dailyStartTime &&
      intent.dailyEndTime &&
      intent.pace,
  );
}

function canBuildTrip(intent: SingaporeTravelIntent, anchor: ConfirmedAccommodationAnchor | null) {
  const hasStay = Boolean(anchor?.userConfirmed && anchor.placeId);
  return Boolean(
    canStartAccommodationSelection(intent) &&
      hasStay &&
      intent.durationDays,
  );
}

function hotelSearchTerm(intent: SingaporeTravelIntent) {
  const hotel = intent.accommodation?.hotelName?.trim();
  if (hotel) return hotel;
  const area = intent.accommodation?.areaName?.trim();
  return area ? `${area} hotel` : "";
}

function hotelSelectionKey(intent: SingaporeTravelIntent) {
  return [
    hotelSearchTerm(intent).toLocaleLowerCase("en-US"),
    intent.startDate || "",
    intent.endDate || "",
    totalTravelers(intent) || "",
    intent.dailyStartTime || "",
    intent.dailyEndTime || "",
    intent.pace || "",
  ].join("|");
}

function quoteLabel(commerce: TravelCommerce | null | undefined, loading: boolean) {
  if (loading && !commerce) return "飞猪价格查询中…";
  if (!commerce) return "飞猪价格暂未返回";
  if (commerce.status === "available") {
    return cnyReferenceLabel(commerce.price);
  }
  if (commerce.status === "needs_details") return "飞猪：仍需补充入住条件";
  return "飞猪：暂无可靠报价";
}

function withSelectedHotelCommerce(trip: SingaporePlanResponse["trip"], commerce: TravelCommerce | null) {
  if (!commerce) return trip;
  return {
    ...trip,
    commerce: {
      provider: "fliggy" as const,
      status: commerce.status,
      note: commerce.note,
      updatedAt: commerce.updatedAt,
    },
    days: trip.days.map((day) => ({
      ...day,
      stops: day.stops.map((stop, index) => stop.kind === "hotel" && index === 0 ? { ...stop, commerce } : stop),
    })),
  };
}

function hasCompleteOutline(outline: SingaporeOutlineDay[], durationDays?: number | null) {
  return Boolean(
    durationDays &&
      outline.length === durationDays &&
      outline.every((day, index) =>
        day.day === index + 1 &&
        day.theme.trim() &&
        day.areas.length &&
        day.experiences.length &&
        day.summary.trim(),
      ),
  );
}

function isOutlineConfirmation(message: string) {
  const normalized = message.trim().replace(/[\s。！!，,；;？?]/g, "");
  if (/修改|调整|减少|增加|不要|改成|换|等等|但是/.test(normalized)) return false;
  return /^(可以|确认|确认草案|就这样|按这个安排|按这版|没问题|开始生成地图|生成地图|确认并生成真实地图行程)$/.test(normalized);
}

const PENDING_INTENT_TURN_KEY = "travelworld:pending-intent-turn:v1";
type PendingIntentTurn = { message: string; turnId: string; visitToken: string; requestBody: string };

function singaporeCurrentDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function readPendingIntentTurn(): PendingIntentTurn | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PENDING_INTENT_TURN_KEY) || "null") as Partial<PendingIntentTurn> | null;
    return value && typeof value.message === "string" && typeof value.turnId === "string" && typeof value.visitToken === "string" && typeof value.requestBody === "string"
      ? value as PendingIntentTurn : null;
  } catch {
    return null;
  }
}

function writePendingIntentTurn(value: PendingIntentTurn | null) {
  try {
    if (value) window.sessionStorage.setItem(PENDING_INTENT_TURN_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(PENDING_INTENT_TURN_KEY);
  } catch {
    // An in-memory turn ID still protects retries until this page is reloaded.
  }
}

export function PlannerClient({ initialPrompt }: { initialPrompt: string }) {
  const nextId = useRef(3);
  const intentRef = useRef<SingaporeTravelIntent>({ destination: "Singapore" });
  const outlineRef = useRef<SingaporeOutlineDay[]>([]);
  const confirmedAccommodationRef = useRef<ConfirmedAccommodationAnchor | null>(null);
  const confirmedHotelIntentNameRef = useRef<string | null>(null);
  const confirmedHotelCommerceRef = useRef<TravelCommerce | null>(null);
  const pendingHotelSelectionRef = useRef<PendingHotelSelection | null>(null);
  const hotelCandidateQueryRef = useRef("");
  const promptStripRef = useRef<HTMLDivElement | null>(null);
  const phaseRef = useRef<"idle" | "intent" | "plan">("idle");
  const pendingIntentTurnRef = useRef<PendingIntentTurn | null>(null);
  const pendingHandoffTurnRef = useRef<{ stateVersion: number; turnId: string } | null>(null);
  const stateVersionRef = useRef(0);
  const lastIntentExplanationRef = useRef("");
  const [input, setInput] = useState("");
  const [visitReady, setVisitReady] = useState(false);
  const [visitRecoveryError, setVisitRecoveryError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [phase, setPhase] = useState<"idle" | "intent" | "plan">("idle");
  const [intent, setIntent] = useState<SingaporeTravelIntent>(intentRef.current);
  const [outline, setOutline] = useState<SingaporeOutlineDay[]>([]);
  const [confirmedAccommodation, setConfirmedAccommodation] = useState<ConfirmedAccommodationAnchor | null>(null);
  const [hotelCandidates, setHotelCandidates] = useState<HotelCandidate[]>([]);
  const [hotelLookup, setHotelLookup] = useState<"idle" | "loading" | "error">("idle");
  const [hotelLookupError, setHotelLookupError] = useState("");
  const [hotelQuotes, setHotelQuotes] = useState<Record<string, TravelCommerce | null>>({});
  const [hotelQuotesLoading, setHotelQuotesLoading] = useState(false);
  const [hotelQuotesError, setHotelQuotesError] = useState("");
  const analysisRef = useRef<IntentAnalysis>({
    missingInformation: ["准确出行日期（年份、开始日、结束日）", "同行人数", "住宿区域或意向酒店", "每日开始时间", "每日返回酒店时间", "旅行节奏"],
    ambiguities: [],
    blockingIssues: [],
    complete: false,
    progress: 5,
    issues: null,
  });
  const [analysis, setAnalysis] = useState<IntentAnalysis>(analysisRef.current);
  const [analysisError, setAnalysisError] = useState("");
  const [placeDiscoveryReady, setPlaceDiscoveryReady] = useState(false);
  const [placeDiscoveryIssues, setPlaceDiscoveryIssues] = useState<string[]>([]);
  const [handoff, setHandoff] = useState<HandoffPayload | null>(null);
  const [helpContext, setHelpContext] = useState<PlanningHelpContext | null>(null);
  const [planningMilestones, setPlanningMilestones] = useState<string[]>([]);
  const [openHelpFor, setOpenHelpFor] = useState<string | null>(null);
  const updateHelpContext = useCallback((context: PlanningHelpContext | null, milestones: string[]) => {
    setHelpContext(context);
    setPlanningMilestones(milestones);
  }, []);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const plannerGridRef = useRef<HTMLElement | null>(null);
  const [leftPanelPercent, setLeftPanelPercent] = useState<number | null>(null);
  const defaultLeftPanelPercent = NEW_PLANNING_FLOW && handoff?.planningSessionReady ? 34 : 46;
  const visibleLeftPanelPercent = leftPanelPercent ?? defaultLeftPanelPercent;
  const [hiddenPanel, setHiddenPanel] = useState<"conversation" | "preview" | null>(null);
  const [conditionsExpanded, setConditionsExpanded] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<"conversation" | "preview">("conversation");
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 1, role: "assistant", text: initialAssistant },
    ...(initialPrompt ? [{ id: 2, role: "user" as const, text: initialPrompt }] : []),
  ]);

  useEffect(() => {
    const saved = Number(window.sessionStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= 30 && saved <= 70) setLeftPanelPercent(saved);
  }, []);

  useEffect(() => {
    if (leftPanelPercent !== null) window.sessionStorage.setItem(PANEL_WIDTH_KEY, String(leftPanelPercent));
  }, [leftPanelPercent]);

  function resizePlanner(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = plannerGridRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const percent = Math.round(((event.clientX - bounds.left - 16) / Math.max(1, bounds.width - 32)) * 100);
    setLeftPanelPercent(Math.max(30, Math.min(70, percent)));
  }

  function setBusy(next: "idle" | "intent" | "plan") {
    phaseRef.current = next;
    setPhase(next);
  }

  function clearConfirmedAccommodation() {
    confirmedAccommodationRef.current = null;
    confirmedHotelIntentNameRef.current = null;
    confirmedHotelCommerceRef.current = null;
    setConfirmedAccommodation(null);
  }

  function applyIntentState(result: SingaporeIntentResponse, version?: number, acceptPendingHotel = false) {
    if (Number.isInteger(version) && Number(version) >= 0) stateVersionRef.current = Number(version);
    if (NEW_PLANNING_FLOW) setHandoff((current) => current && current.sourceIntentStateVersion === stateVersionRef.current ? current : null);
    const pendingHotel = acceptPendingHotel ? pendingHotelSelectionRef.current : null;
    const pendingHotelAccepted = pendingHotel && (
      sameHotelName(pendingHotel.anchor.name, result.intent.accommodation?.hotelName) ||
      Boolean(result.intent.accommodation?.hotelName && result.acceptedChanges?.some((change) =>
        change.field === "accommodation.hotelName" && change.op === "set" && change.evidenceText.includes(pendingHotel.anchor.name),
      ))
    );
    if (acceptPendingHotel) pendingHotelSelectionRef.current = null;
    if (pendingHotelAccepted) {
      confirmedAccommodationRef.current = pendingHotel.anchor;
      confirmedHotelCommerceRef.current = pendingHotel.commerce;
      setConfirmedAccommodation(pendingHotel.anchor);
      setHotelCandidates([]);
      setHotelQuotes({});
      setHotelQuotesLoading(false);
      hotelCandidateQueryRef.current = "";
    }
    const anchor = confirmedAccommodationRef.current;
    const acceptedSelectedHotel = anchor && result.acceptedChanges?.some((change) =>
      change.field === "accommodation.hotelName" && change.op === "set" && change.evidenceText.includes(anchor.name),
    );
    const matchingAnchor = anchor && (
      sameHotelName(anchor.name, result.intent.accommodation?.hotelName) ||
      sameHotelName(confirmedHotelIntentNameRef.current, result.intent.accommodation?.hotelName) ||
      Boolean(acceptedSelectedHotel && result.intent.accommodation?.hotelName)
    );
    if (matchingAnchor) confirmedHotelIntentNameRef.current = result.intent.accommodation?.hotelName || null;
    const nextIntent: SingaporeTravelIntent = matchingAnchor
      ? {
          ...result.intent,
          accommodation: {
            ...result.intent.accommodation,
            googlePlaceId: anchor.placeId,
          },
        }
      : result.intent;
    const hotelChanged = (nextIntent.accommodation?.hotelName || null) !== (intentRef.current.accommodation?.hotelName || null);
    if (anchor && !matchingAnchor) clearConfirmedAccommodation();
    if (hotelChanged) {
      setHotelCandidates([]);
      hotelCandidateQueryRef.current = "";
    }
    intentRef.current = nextIntent;
    outlineRef.current = result.outline || [];
    setIntent(nextIntent);
    setOutline(result.outline || []);
    const nextAnalysis: IntentAnalysis = {
      missingInformation: result.missingInformation || [],
      ambiguities: result.ambiguities || [],
      blockingIssues: result.blockingIssues || [],
      complete: Boolean(result.complete),
      progress: Math.max(0, Math.min(100, result.progress || 0)),
      issues: Array.isArray(result.issues) ? result.issues : null,
    };
    analysisRef.current = nextAnalysis;
    setAnalysis(nextAnalysis);
    lastIntentExplanationRef.current = result.issues?.length || result.blockingIssues?.length || result.ambiguities?.length
      ? result.reply || result.nextQuestion || "有一处信息需要确认，请换一种说法补充。"
      : "";
    setAnalysisError("");
    if (!NEW_PLANNING_FLOW && !confirmedAccommodationRef.current) void loadHotelCandidates(nextIntent, hotelChanged);
  }

  async function loadHotelQuotes(
    nextIntent: SingaporeTravelIntent,
    candidates: HotelCandidate[],
    key: string,
  ) {
    if (!canStartAccommodationSelection(nextIntent) || !candidates.length) return;
    const pricedCandidates = candidates.slice(0, 5);
    setHotelQuotes({});
    setHotelQuotesError("");
    setHotelQuotesLoading(true);
    try {
      const response = await fetch("/api/travel/singapore/hotel-quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({
          intent: nextIntent,
          candidates: pricedCandidates.map((candidate) => ({ placeId: candidate.placeId })),
        }),
      });
      const payload = await response.json().catch(() => null) as {
        quotes?: Array<{ placeId?: string; commerce?: TravelCommerce }>;
        error?: unknown;
      } | null;
      if (!response.ok) throw new Error(errorMessage(payload, "暂时无法查询飞猪价格。"));
      if (hotelCandidateQueryRef.current !== key) return;
      const quotes = Object.fromEntries(
        (payload?.quotes || [])
          .filter((quote) => quote.placeId && quote.commerce)
          .map((quote) => [quote.placeId as string, quote.commerce as TravelCommerce]),
      );
      setHotelQuotes(quotes);
    } catch (error) {
      if (hotelCandidateQueryRef.current !== key) return;
      setHotelQuotesError(error instanceof Error ? error.message : "暂时无法查询飞猪价格。");
    } finally {
      if (hotelCandidateQueryRef.current === key) setHotelQuotesLoading(false);
    }
  }

  async function loadHotelCandidates(nextIntent: SingaporeTravelIntent, force = false) {
    if (!canStartAccommodationSelection(nextIntent)) {
      hotelCandidateQueryRef.current = "";
      setHotelCandidates([]);
      setHotelQuotes({});
      setHotelQuotesLoading(false);
      setHotelQuotesError("");
      setHotelLookup("idle");
      setHotelLookupError("");
      return;
    }
    const query = hotelSearchTerm(nextIntent);
    const key = hotelSelectionKey(nextIntent);
    if (!query) {
      hotelCandidateQueryRef.current = "";
      setHotelCandidates([]);
      setHotelQuotes({});
      setHotelQuotesLoading(false);
      setHotelQuotesError("");
      setHotelLookup("idle");
      setHotelLookupError("");
      return;
    }
    if (!force && hotelCandidateQueryRef.current === key) return;
    hotelCandidateQueryRef.current = key;
    setHotelLookup("loading");
    setHotelLookupError("");
    setHotelQuotes({});
    setHotelQuotesLoading(false);
    setHotelQuotesError("");
    try {
      const response = await fetch("/api/travel/singapore/places", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({
          query,
          maxResults: 5,
          includedType: "lodging",
          strictTypeFiltering: true,
          languageCode: "zh-CN",
        }),
      });
      const payload = await response.json().catch(() => null) as { places?: HotelCandidate[]; error?: unknown } | null;
      if (!response.ok) throw new Error(errorMessage(payload, "暂时无法匹配酒店候选。"));
      if (hotelCandidateQueryRef.current !== key) return;
      const candidates = Array.isArray(payload?.places) ? payload.places : [];
      setHotelCandidates(candidates);
      setHotelQuotes({});
      setHotelQuotesError("");
      if (!candidates.length) {
        setHotelQuotesLoading(false);
        setHotelLookup("error");
        setHotelLookupError("没有找到可确认的住宿候选，请换一种酒店名称或区域写法。");
        return;
      }
      setHotelLookup("idle");
      void loadHotelQuotes(nextIntent, candidates, key);
    } catch (error) {
      if (hotelCandidateQueryRef.current !== key) return;
      setHotelCandidates([]);
      setHotelQuotes({});
      setHotelQuotesLoading(false);
      setHotelLookup("error");
      setHotelLookupError(error instanceof Error ? error.message : "暂时无法匹配酒店候选。");
    }
  }

  function chooseHotelCandidate(candidate: HotelCandidate) {
    if (phaseRef.current !== "idle") return;
    const anchor: ConfirmedAccommodationAnchor = {
      placeId: candidate.placeId,
      name: candidate.name,
      address: candidate.address,
      location: candidate.location,
      googleMapsUri: candidate.googleMapsUri,
      kind: "hotel",
      source: "google_places",
      userConfirmed: true,
    };
    pendingHotelSelectionRef.current = { anchor, commerce: hotelQuotes[candidate.placeId] || null };
    // Keep this Google candidate visible until the authoritative intent
    // response confirms its name. A failed request must not unlock the map.
    void understand(`我选择入住 ${candidate.name}，将它作为全程住宿锚点。`);
  }

  async function understand(message: string, appendUser = true) {
    if (!message.trim() || phaseRef.current !== "idle") return;
    if (appendUser && asksAboutPreviousIssue(message) && lastIntentExplanationRef.current) {
      setMessages((current) => [
        ...current,
        { id: nextId.current++, role: "user", text: message.trim() },
        { id: nextId.current++, role: "assistant", text: explainPreviousIssue(lastIntentExplanationRef.current) },
      ]);
      setInput("");
      return;
    }
    if (
      !NEW_PLANNING_FLOW &&
      appendUser &&
      isOutlineConfirmation(message) &&
      canBuildTrip(intentRef.current, confirmedAccommodationRef.current) &&
      hasCompleteOutline(outlineRef.current, intentRef.current.durationDays) &&
      (analysisRef.current.issues ?? legacyIntentIssues(analysisRef.current)).length === 0 &&
      !analysisError
    ) {
      setMessages((current) => [
        ...current,
        { id: nextId.current++, role: "user", text: message.trim() },
        { id: nextId.current++, role: "assistant", text: "草案已确认。现在开始用 Google Places 与 Routes 校验真实地点和路程。" },
      ]);
      setInput("");
      void compileTrip();
      return;
    }
    const history = messages
      .filter((entry, index, all) => !(
        index === all.length - 1 &&
        entry.role === "user" &&
        entry.text.trim() === message.trim()
      ))
      .slice(-16)
      .map((entry) => ({ role: entry.role, content: entry.text }));
    const normalizedMessage = message.trim();
    if (appendUser) {
      setMessages((current) => [...current, { id: nextId.current++, role: "user", text: message.trim() }]);
    }
    setInput("");
    setBusy("intent");
    setAnalysisError("");
    try {
      const visitToken = await getTravelVisitToken();
      const previousTurn = pendingIntentTurnRef.current ?? readPendingIntentTurn();
      const retrying = previousTurn?.message === normalizedMessage && previousTurn.visitToken === visitToken;
      const turnId = retrying ? previousTurn.turnId : crypto.randomUUID();
      const requestBody = retrying ? previousTurn.requestBody : JSON.stringify({
        message: normalizedMessage,
        turnId,
        expectedStateVersion: stateVersionRef.current,
        referenceDate: singaporeCurrentDate(),
        replyToIssueId: analysisRef.current.issues?.[0]?.issueId ?? null,
        conversationHistory: history,
      });
      pendingIntentTurnRef.current = { message: normalizedMessage, turnId, visitToken, requestBody };
      writePendingIntentTurn(pendingIntentTurnRef.current);
      const response = await fetch("/api/travel/singapore/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": visitToken },
        body: requestBody,
      });
      const payload = await response.json().catch(() => null) as IntentApiPayload | null;
      if (response.status === 409 && payload?.code === "STATE_VERSION_CONFLICT") {
        pendingHotelSelectionRef.current = null;
        pendingIntentTurnRef.current = null;
        writePendingIntentTurn(null);
        if (Number.isInteger(payload.stateVersion)) stateVersionRef.current = Number(payload.stateVersion);
        if (payload.state?.intent) applyIntentState(payload.state, payload.stateVersion);
        if (NEW_PLANNING_FLOW) {
          setPlaceDiscoveryReady(Boolean(payload.placeDiscoveryReady));
          setPlaceDiscoveryIssues(payload.placeDiscoveryIssues || []);
        }
        const conflictMessage = "旅行条件已在另一轮更新；本条修改尚未应用。我已同步最新条件，请确认后重新发送。";
        setInput(normalizedMessage);
        setMessages((current) => [...current, {
          id: nextId.current++, role: "assistant", error: true, text: conflictMessage,
        }]);
        return;
      }
      if (!response.ok || !payload?.intent) {
        throw new Error(errorMessage(payload, "暂时无法理解这句话，请稍后重试。"));
      }
      pendingIntentTurnRef.current = null;
      writePendingIntentTurn(null);
      applyIntentState(payload as SingaporeIntentResponse, payload.stateVersion, true);
      if (NEW_PLANNING_FLOW) {
        setPlaceDiscoveryReady(Boolean(payload.placeDiscoveryReady));
        setPlaceDiscoveryIssues(payload.placeDiscoveryIssues || []);
      }
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        text: payload.reply || payload.nextQuestion || (NEW_PLANNING_FLOW ? "条件已更新。足够开始找地点时，你可以确认当前条件。" : "条件已更新。你可以继续补充；信息完整后我会先给出每日草案。"),
      }]);
    } catch (error) {
      pendingHotelSelectionRef.current = null;
      const message = error instanceof Error ? error.message : "意图识别服务暂时不可用，请稍后重试。";
      lastIntentExplanationRef.current = message;
      setAnalysisError(message);
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        error: true,
        text: message,
      }]);
    } finally {
      setBusy("idle");
    }
  }

  async function startPlanning() {
    if (!NEW_PLANNING_FLOW || !visitReady || !placeDiscoveryReady || handoffBusy || handoff?.planningSessionReady) return;
    setHandoffBusy(true);
    setHandoffError("");
    try {
      const stateVersion = stateVersionRef.current;
      const previous = pendingHandoffTurnRef.current;
      const turnId = previous?.stateVersion === stateVersion ? previous.turnId : crypto.randomUUID();
      pendingHandoffTurnRef.current = { stateVersion, turnId };
      const response = await fetch("/api/travel/singapore/planning/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({ expectedIntentStateVersion: stateVersion, turnId }),
      });
      const payload = await response.json().catch(() => null) as HandoffPayload | null;
      if (response.status === 409 && payload?.code === "STATE_VERSION_CONFLICT") {
        pendingHandoffTurnRef.current = null;
        if (payload.state?.intent) applyIntentState(payload.state, payload.currentIntentStateVersion);
        setPlaceDiscoveryReady(false);
        throw new Error("旅行条件已更新。请核对最新条件后重新确认进入地点规划。");
      }
      if (!response.ok || !payload?.handoff || !payload.handoffId || !payload.planningSessionReady) {
        throw new Error(payload?.issues?.join("；") || errorMessage(payload, "暂时无法进入地点规划，请重试。"));
      }
      pendingHandoffTurnRef.current = null;
      setHandoff(payload);
      setMessages((current) => [...current, {
        id: nextId.current++, role: "assistant",
        text: "旅行条件已确认。现在进入详细规划，我会先查找真实地点供你挑选，再一起决定分天、航班和住宿。",
      }]);
    } catch (cause) {
      setHandoffError(cause instanceof Error ? cause.message : "暂时无法进入地点规划，请重试。");
    } finally {
      setHandoffBusy(false);
    }
  }

  const inStagedPlanning = NEW_PLANNING_FLOW && Boolean(handoff?.handoff && handoff.handoffId);
  const currentHelp = inStagedPlanning && helpContext?.handoffId === handoff?.handoffId ? helpContext : null;
  const helpOpen = Boolean(currentHelp && openHelpFor === currentHelp.handoffId);

  function updatePlanningHandoff(payload: { handoff: PlanningHandoffV1; handoffId: string; intentResult: SingaporeIntentResponse; sourceIntentStateVersion: number; planningSessionReady: boolean }) {
    applyIntentState(payload.intentResult, payload.sourceIntentStateVersion);
    setPlaceDiscoveryReady(true);
    setPlaceDiscoveryIssues([]);
    setHandoff({ handoff: payload.handoff, handoffId: payload.handoffId,
      sourceIntentStateVersion: payload.sourceIntentStateVersion, planningSessionReady: payload.planningSessionReady });
  }

  function openCompiledTrip(payload: SingaporePlanResponse) {
    if (!payload.trip?.days?.length) {
      setHandoffError("规划结果没有可显示的日期，请重新核算后再试。");
      return;
    }
    const trip = { ...payload.trip, source: "live" as const, generatedAt: payload.meta.generatedAt, warnings: payload.meta.warnings };
    const stored: StoredLiveTrip = {
      trip, meta: payload.meta, intent: intentRef.current, outline: outlineRef.current, savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(liveTripStorageKey(trip.id), JSON.stringify(stored));
    window.location.assign(`/travel/${encodeURIComponent(trip.id)}`);
  }

  useEffect(() => {
    let active = true;
    setVisitReady(false);
    setVisitRecoveryError("");
    void (async () => {
      let restored = false;
      try {
        const visitToken = await getTravelVisitToken();
        if (!active) return;
        await fetch("/api/travel/visit", {
          method: "POST",
          headers: { "x-travel-visit": visitToken },
        });
        if (!active) return;
        const response = await fetch("/api/travel/singapore/intent", {
          method: "GET",
          headers: { "x-travel-visit": visitToken },
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as IntentStatePayload | null;
        if (!active) return;
        if (!response.ok || !Number.isInteger(payload?.stateVersion) || Number(payload?.stateVersion) < 0 ||
            (Number(payload?.stateVersion) > 0 && !payload?.state?.intent)) {
          throw new Error(errorMessage(payload, "暂时无法读取本次访问的旅行条件。"));
        }
        stateVersionRef.current = Number(payload?.stateVersion);
        if (NEW_PLANNING_FLOW) {
          setPlaceDiscoveryReady(Boolean(payload?.placeDiscoveryReady));
          setPlaceDiscoveryIssues(payload?.placeDiscoveryIssues || []);
          const handoffResponse = await fetch("/api/travel/singapore/planning/handoff", {
            headers: { "x-travel-visit": visitToken }, cache: "no-store",
          });
          const handoffPayload = await handoffResponse.json().catch(() => null) as HandoffPayload | null;
          if (!active) return;
          if (!handoffResponse.ok || !handoffPayload) throw new Error(errorMessage(handoffPayload, "暂时无法恢复本次访问的规划进度。"));
          setHandoff(handoffPayload.handoff && handoffPayload.sourceIntentStateVersion === Number(payload?.stateVersion) ? handoffPayload : null);
        }
        if (payload?.state?.intent) {
          applyIntentState(payload.state, payload.stateVersion);
          setMessages([
            { id: 1, role: "assistant", text: initialAssistant },
            {
              id: nextId.current++,
              role: "assistant",
              text: `已恢复本次访问的旅行条件。${payload.state.reply || "你可以继续补充或修改。"}`,
            },
          ]);
          restored = true;
        }
      } catch (error) {
        if (!active) return;
        setVisitRecoveryError(error instanceof Error ? error.message : "暂时无法读取本次访问的旅行条件。");
        return;
      }
      if (!active) return;
      setVisitReady(true);
      if (initialPrompt && !restored) void understand(initialPrompt, false);
    })();
    return () => { active = false; };
    // Strict Mode may replay this effect. The latest setup must still run its
    // GET after the previous setup's cleanup has invalidated its result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, restoreAttempt]);

  const conditionProgress = NEW_PLANNING_FLOW && (placeDiscoveryReady || handoff) ? 100 : analysis.progress;
  const visibleIssues = analysis.issues ?? legacyIntentIssues(analysis);
  const hasPendingIntentIssue = visibleIssues.length > 0 || Boolean(analysisError);
  const intentReady = canBuildTrip(intent, confirmedAccommodation) && !hasPendingIntentIssue;
  const outlineReady = intentReady && hasCompleteOutline(outline, intent.durationDays);
  const readyToBuild = outlineReady;
  const people = totalTravelers(intent);
  const stay = accommodationSummary(intent);
  const stayState = accommodationState(intent, confirmedAccommodation);
  const latestReturnTime = intent.latestReturnTime || intent.dailyEndTime;
  const preferredReturnTime = intent.preferredReturnTime;
  const returnTimeSummary = preferredReturnTime && latestReturnTime && preferredReturnTime !== latestReturnTime
    ? `${preferredReturnTime} 首选 · ${latestReturnTime} 最晚`
    : latestReturnTime || "待补充";
  const interestSignals = [
    ...(intent.interests || []),
    ...(intent.mustVisit || []),
    ...(intent.allowAutomaticRecommendations ? ["由 travelworld 自动推荐"] : []),
  ].filter(Boolean);
  const assumptions = useMemo(() => {
    const values: string[] = [];
    if (intent.dailyStartTime) values.push(`${intent.dailyStartTime} 出发`);
    if (latestReturnTime) values.push(preferredReturnTime && preferredReturnTime !== latestReturnTime
      ? `${preferredReturnTime} 首选返店、${latestReturnTime} 最晚返店`
      : `${latestReturnTime} 返回酒店`);
    if (intent.originCity) values.push(`从 ${intent.originCity} 出发`);
    if (intent.budgetDetails?.amount) {
      const scopeLabels: Record<string, string> = {
        per_person_per_day: "每人每天",
        group_per_day: "全体每天",
        per_person_total: "每人全程",
        group_total: "全体全程",
      };
      values.push(`${scopeLabels[intent.budgetDetails.scope || ""] || "预算"} ${intent.budgetDetails.amount} ${intent.budgetDetails.currency || "币种待确认"}`);
    } else if (intent.budget) {
      const budgetLabels: Record<string, string> = { budget: "经济", standard: "标准", moderate: "中等", premium: "高端" };
      values.push(`${budgetLabels[intent.budget] || intent.budget}预算`);
    }
    if (intent.budgetDetails?.excludesFlights) values.push("预算不含机票");
    if (intent.preferredTransport?.length) values.push(intent.preferredTransport.join(" / "));
    if (intent.dietaryPreferences?.length) values.push(intent.dietaryPreferences.join(" / "));
    return values;
  }, [intent, latestReturnTime, preferredReturnTime]);

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!visitReady || inStagedPlanning) return;
    void understand(input);
  }

  function scrollPromptSuggestions(direction: -1 | 1) {
    const strip = promptStripRef.current;
    if (!strip) return;
    strip.scrollBy({ left: direction * Math.max(220, strip.clientWidth * 0.75), behavior: "smooth" });
  }

  async function compileTrip() {
    const currentIntent = intentRef.current;
    const currentOutline = outlineRef.current;
    if (
      !canBuildTrip(currentIntent, confirmedAccommodationRef.current) ||
      !hasCompleteOutline(currentOutline, currentIntent.durationDays) ||
      hasPendingIntentIssue ||
      phaseRef.current !== "idle"
    ) return;
    setBusy("plan");
    try {
      const response = await fetch("/api/travel/singapore/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-travel-visit": await getTravelVisitToken() },
        body: JSON.stringify({
          intent: currentIntent,
          outline: currentOutline,
          outlineConfirmed: true,
          accommodationAnchor: confirmedAccommodationRef.current,
        }),
      });
      const payload = await response.json().catch(() => null) as SingaporePlanResponse | null;
      if (!response.ok || !payload?.trip?.days?.length) {
        throw new Error(errorMessage(payload, "Google 地点与路线暂时无法生成，请稍后再试。"));
      }
      const trip = {
        ...withSelectedHotelCommerce(payload.trip, confirmedHotelCommerceRef.current),
        source: "live" as const,
        generatedAt: payload.meta.generatedAt,
        warnings: payload.meta.warnings,
      };
      const stored: StoredLiveTrip = {
        trip,
        meta: payload.meta,
        intent: currentIntent,
        outline: currentOutline,
        savedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(liveTripStorageKey(trip.id), JSON.stringify(stored));
      window.location.assign(`/travel/${encodeURIComponent(trip.id)}`);
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        error: true,
        text: error instanceof Error ? error.message : "地图行程生成失败，请稍后再试。",
      }]);
      setBusy("idle");
    }
  }

  return (
    <div className="tw-planner-page">
      <header className="tw-planner-header">
        <a className="tw-icon-button" href="/travel" aria-label="返回 travelworld 首页"><ArrowLeft size={19} /></a>
        <TravelLogo />
        <div className="tw-stepper" aria-label="规划进度">
          <span className={(NEW_PLANNING_FLOW ? Boolean(handoff) : intentReady) ? "is-complete" : "is-current"}>{(NEW_PLANNING_FLOW ? Boolean(handoff) : intentReady) && <Check size={14} />}意图</span><i />
          <span className={NEW_PLANNING_FLOW ? handoff ? "is-current" : "" : outlineReady ? "is-complete" : intentReady ? "is-current" : ""}>{NEW_PLANNING_FLOW ? "分阶段规划" : "草案"}</span><i />
          <span className={!NEW_PLANNING_FLOW && phase === "plan" ? "is-current" : ""}>地图</span>
        </div>
        <span className="tw-draft-state"><i />Singapore Intelligence v1.7</span>
      </header>

      <main ref={plannerGridRef} className={`tw-planner-grid${hiddenPanel ? ` is-${hiddenPanel}-hidden` : ""} is-mobile-${mobilePanel}`} style={{ "--tw-planner-left": `${visibleLeftPanelPercent}%` } as CSSProperties}>
        <div className="tw-planner-panel-toolbar" aria-label="规划工作区布局">
          <span>{inStagedPlanning ? "旅行条件与当前规划" : "对话记录与当前规划"}</span>
          <div className="tw-planner-desktop-controls">
            <button type="button" onClick={() => setHiddenPanel((current) => current === "conversation" ? null : "conversation")} aria-label={hiddenPanel === "conversation" ? "显示对话" : "隐藏对话"}>{hiddenPanel === "conversation" ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}{hiddenPanel === "conversation" ? "显示对话" : "隐藏对话"}</button>
            <button type="button" onClick={() => setHiddenPanel((current) => current === "preview" ? null : "preview")} aria-label={hiddenPanel === "preview" ? "显示规划" : "隐藏规划"}>{hiddenPanel === "preview" ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}{hiddenPanel === "preview" ? "显示规划" : "隐藏规划"}</button>
          </div>
          <div className="tw-planner-mobile-controls" role="tablist" aria-label="选择工作区">
            <button type="button" role="tab" aria-selected={mobilePanel === "conversation"} onClick={() => setMobilePanel("conversation")}>{inStagedPlanning ? "条件与帮助" : "对话"}</button>
            <button type="button" role="tab" aria-selected={mobilePanel === "preview"} onClick={() => setMobilePanel("preview")}>当前规划</button>
          </div>
        </div>
        <section className="tw-conversation-panel" aria-label="旅行规划对话">
          <div className="tw-panel-heading">
            <p>PLAN WITH AI · SINGAPORE</p><h1>{inStagedPlanning ? "旅行条件与进度" : "像聊天一样规划新加坡"}</h1>
            {currentHelp && <button
              className="tw-planning-help-toggle"
              type="button"
              aria-expanded={helpOpen}
              aria-controls="planning-help-panel"
              onClick={() => setOpenHelpFor(helpOpen ? null : currentHelp.handoffId)}
            >
              <span className="tw-planning-help-toggle-icon"><CircleHelp size={20} aria-hidden="true" /></span>
              <span>{helpOpen ? "收起帮助" : "需要帮助"}</span>
              <ChevronDown className="tw-planning-help-chevron" size={19} aria-hidden="true" />
            </button>}
            {!inStagedPlanning && <span>将一切交给对话：说出旅行愿望，一起挑选地点，再把安排落到地图。</span>}
            <details className="tw-planner-data-help"><summary>地点、路线与价格从哪里来？</summary><p>{NEW_PLANNING_FLOW ? "百炼理解旅行条件并给出建议；Google 核实地点与路线，飞猪仅提供实际查到的航班、酒店和景点商品信息。" : "百炼智能体负责理解意图；酒店先由 Google Places 确认，路线由 Google Maps 实时校验，飞猪补充价格参考。"}</p></details>
          </div>

          {inStagedPlanning ? <div className="tw-planning-context-scroll">
            <section className="tw-planning-context" hidden={helpOpen}>
              <h2>已确认的旅行条件</h2>
              <p>{dateSummary(intent)} · {people ? `${people} 人` : "人数待补充"}{stay ? ` · ${stay}` : ""}</p>
              {interestSignals.length > 0 && <p>偏好：{interestSignals.join("、")}</p>}
              <h2>规划进度</h2>
              <ul><li>旅行条件已确认</li>{planningMilestones.map((item) => <li key={item}>{item}</li>)}</ul>
              <details><summary>查看原对话记录</summary>
                {messages.map((message) => <p key={message.id}><strong>{message.role === "assistant" ? "旅行助手：" : "你："}</strong>{message.text}</p>)}
              </details>
            </section>
            {currentHelp && <PlanningHelpPanel key={currentHelp.handoffId} context={currentHelp} open={helpOpen} />}
          </div> : <>
          <div className="tw-message-list" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`tw-message is-${message.role} ${message.error ? "is-error" : ""}`}>
                {message.role === "assistant" && <span className="tw-ai-avatar"><Sparkles size={16} /></span>}
                <div><small>{message.role === "assistant" ? "travelworld intelligence" : "你"}</small><p>{message.text}</p></div>
              </article>
            ))}
            {phase === "intent" && <article className="tw-message is-assistant"><span className="tw-ai-avatar"><Sparkles size={16} /></span><div><small>正在理解</small><p className="tw-thinking"><i /><i /><i /></p></div></article>}
          </div>

          <div className="tw-prompt-suggestion-shell" aria-label="示例输入">
            <button type="button" className="tw-prompt-scroll" onClick={() => scrollPromptSuggestions(-1)} aria-label="查看上一个示例"><ChevronLeft size={16} /></button>
            <div className="tw-prompt-suggestions" ref={promptStripRef}>
              {planningPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setInput(prompt)}>{prompt}<ArrowRight size={14} /></button>)}
            </div>
            <button type="button" className="tw-prompt-scroll" onClick={() => scrollPromptSuggestions(1)} aria-label="查看下一个示例"><ChevronRight size={16} /></button>
          </div>

          <form className="tw-planner-composer" onSubmit={sendMessage}>
            <label htmlFor="planner-message" className="tw-sr-only">继续描述旅行偏好</label>
            <textarea id="planner-message" rows={2} value={input} onChange={(event) => setInput(event.target.value)} placeholder="例如：2026/10/20–10/23，两位成人，住 Bugis，每天 10:00–20:30，轻松一些……" />
            <button type="submit" disabled={!visitReady || !input.trim() || phase !== "idle"} aria-label="发送"><Send size={17} /></button>
          </form>
          </>}
        </section>

        <div className="tw-planner-resizer" role="separator" aria-label="调整对话与规划宽度" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={70} aria-valuenow={visibleLeftPanelPercent} tabIndex={0}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={resizePlanner}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); setLeftPanelPercent((value) => Math.max(30, (value ?? defaultLeftPanelPercent) - 2)); }
            if (event.key === "ArrowRight") { event.preventDefault(); setLeftPanelPercent((value) => Math.min(70, (value ?? defaultLeftPanelPercent) + 2)); }
            if (event.key === "Home") { event.preventDefault(); setLeftPanelPercent(30); }
            if (event.key === "End") { event.preventDefault(); setLeftPanelPercent(70); }
          }} onDoubleClick={() => { setLeftPanelPercent(null); window.sessionStorage.removeItem(PANEL_WIDTH_KEY); }} />

        <section className="tw-plan-preview" aria-label="结构化旅行条件">
          {visitRecoveryError && <div className="tw-signal-warning" role="alert">
            无法恢复本次访问的旅行条件：{visitRecoveryError} 本轮没有重新提交。
            <button type="button" onClick={() => setRestoreAttempt((attempt) => attempt + 1)}>重新读取</button>
          </div>}
          {NEW_PLANNING_FLOW && <div className="tw-conditions-toggle">
            <button type="button" aria-expanded={conditionsExpanded} aria-controls="tw-condition-details tw-current-intent-details" onClick={() => setConditionsExpanded((value) => !value)}>
              <span>旅行条件</span><span>{conditionsExpanded ? "收起" : "展开"}</span>
            </button>
            <p>新加坡 · {dateSummary(intent)} · {people ? `${people} 人` : "人数待补充"} · {paceLabels[intent.pace || ""] || "节奏待补充"}</p>
            <small role="status">{analysisError ? "本轮条件未更新，请查看对话提示" : handoffError ? "条件确认尚未完成，请展开处理" : handoff ? "已确认" : placeDiscoveryIssues.length ? `${placeDiscoveryIssues.length} 项待处理` : "可进入详细规划"}</small>
          </div>}
          <div id="tw-condition-details" hidden={NEW_PLANNING_FLOW && !conditionsExpanded}>
          <div className="tw-preview-progress">
            <div><p>INFORMATION COMPLETENESS · 条件完整度</p><strong>{conditionProgress}%</strong></div>
            <span><i style={{ width: `${conditionProgress}%` }} /></span>
            <small>{
              !visitReady
                ? visitRecoveryError || "正在恢复本次访问的旅行条件…"
                : analysisError
                ? `本轮未更新：${analysisError}`
                : NEW_PLANNING_FLOW
                ? handoff ? "旅行条件已确认；请按阶段挑地点、分天、确认航班与住宿。" : placeDiscoveryReady ? "条件已足够；进入详细规划后会自动查找真实地点。" : placeDiscoveryIssues[0] || "请继续补充旅行条件。"
                : visibleIssues.length
                  ? `待处理：${visibleIssues[0].message}${visibleIssues.length > 1 ? `；另有 ${visibleIssues.length - 1} 项` : ""}`
                : readyToBuild
                ? "每日草案已就绪；只有确认后才查询真实地点与路线"
                  : !confirmedAccommodation
                    ? "请先从 Google Places 候选中确认一间全程住宿"
                  : intentReady
                    ? "必要条件已完整，正在整理每日草案"
                    : "正在整理每日草案"
            }</small>
          </div>

          <div className="tw-condition-grid">
            <article><span><MapPin size={18} /></span><div><small>目的地</small><strong>新加坡</strong><em className="is-verified"><CheckCircle2 size={13} /> v1 固定范围</em></div></article>
            <article><span><CalendarDays size={18} /></span><div><small>日期与时长</small><strong>{dateSummary(intent)}</strong><em className={hasExactTravelDates(intent) ? "is-verified" : ""}>{hasExactTravelDates(intent) ? "已识别 · 自动计算时长" : "年份与起止日必填"}</em></div></article>
            <article><span><Hotel size={18} /></span><div><small>{NEW_PLANNING_FLOW ? "住宿偏好（可稍后决定）" : "住宿与路线锚点"}</small><strong>{stay}</strong><em className={confirmedAccommodation ? "is-verified" : ""}>{NEW_PLANNING_FLOW ? (hasAccommodationPreference(intent) ? "已记录 · 在分天与航班后选具体酒店" : "地点分天后再决定区域与酒店") : confirmedAccommodation ? <><ShieldCheck size={13} /> {stayState}</> : stayState}</em></div></article>
            <article><span><Clock3 size={18} /></span><div><small>每日行动时段</small><strong>{intent.dailyStartTime || "待补充"} — {returnTimeSummary}</strong><em className={intent.dailyStartTime && intent.dailyEndTime ? "is-verified" : ""}>{intent.dailyStartTime && intent.dailyEndTime ? <><CheckCircle2 size={13} /> 已识别</> : "出发与返回均必填"}</em></div></article>
            <article><span><Users size={18} /></span><div><small>同行与节奏</small><strong>{people ? `${people} 人` : "人数待补充"} · {paceLabels[intent.pace || ""] || intent.pace || "节奏待补充"}</strong><em className={people && intent.pace ? "is-verified" : ""}>{people && intent.pace ? "已识别" : "人数与节奏均必填"}</em></div></article>
          </div>
          </div>

          {NEW_PLANNING_FLOW ? <>
            <article id="tw-current-intent-details" className="tw-intelligence-card" hidden={!conditionsExpanded}>
              <div className="tw-draft-route-head"><div><small>LIVE INTENT · 实时结构化</small><h2>当前旅行条件</h2></div><span>{handoff ? "已确认" : placeDiscoveryReady ? "可进入详细规划" : `${placeDiscoveryIssues.length} 项待处理`}</span></div>
              <div className="tw-signal-section"><small>兴趣与必去</small><div>{interestSignals.length ? interestSignals.map((value) => <span key={value}>{value}</span>) : <em>未指定兴趣时会提供有来源的热门候选</em>}</div></div>
              {intent.avoid?.length ? <div className="tw-signal-section is-muted"><small>明确避开</small><div>{intent.avoid.map((value) => <span key={value}>{value}</span>)}</div></div> : null}
              {!handoff && placeDiscoveryIssues.map((issue) => <div className="tw-signal-warning" key={issue}>{issue}</div>)}
              {handoffError && <div className="tw-signal-warning" role="alert">{handoffError}</div>}
              {(!handoff || !handoff.planningSessionReady) && <button className="tw-compile-button" type="button" disabled={!visitReady || !placeDiscoveryReady || Boolean(analysisError) || phase !== "idle" || handoffBusy} onClick={() => void startPlanning()}>
                {handoffBusy ? <span className="tw-spinner" /> : <MapPin size={18} />}
                {handoffBusy ? "正在进入详细规划…" : "进入详细规划"}<ArrowRight size={17} />
              </button>}
            </article>
            {handoff?.handoff && handoff.handoffId && <PlanningJourney key={handoff.handoffId} handoff={handoff.handoff} handoffId={handoff.handoffId} onCompiled={openCompiledTrip} onHandoffChange={updatePlanningHandoff} onHelpContext={updateHelpContext} autoStartDiscovery />}
          </> : <>
          {!confirmedAccommodation && canStartAccommodationSelection(intent) && (hotelLookup !== "idle" || hotelCandidates.length > 0) && (
            <article className="tw-hotel-picker" aria-live="polite">
              <div className="tw-draft-route-head">
                <div><small>CONFIRM ACCOMMODATION · 住宿确认</small><h2>选择全程的出发与返回酒店</h2></div>
                <span>{hotelLookup === "loading" ? "正在匹配" : "Google Places"}</span>
              </div>
              <p>以下酒店均由 Google Places 识别；飞猪价格按你的出行日期与同行人数查询。选择后，它才会成为每天的出发与返回锚点。</p>
              {hotelLookup === "loading" && <div className="tw-hotel-picker-loading"><span className="tw-spinner" />正在查询新加坡住宿候选…</div>}
              {hotelLookup === "error" && <div className="tw-signal-warning">{hotelLookupError}</div>}
              {hotelQuotesLoading && <div className="tw-hotel-picker-loading"><span className="tw-spinner" />正在用一个临时会话依次查询最多 5 家酒店的飞猪价格…</div>}
              {hotelQuotesError && <div className="tw-signal-warning">{hotelQuotesError} 你仍可选择 Google 验证的酒店继续规划。</div>}
              {hotelLookup === "idle" && !hotelCandidates.length && <div className="tw-signal-warning">没有找到可确认的住宿候选，请换一种酒店名称或区域写法。</div>}
              {hotelCandidates.length > 0 && (
                <div className="tw-hotel-candidates">
                  {hotelCandidates.map((candidate) => (
                    <button type="button" className="tw-hotel-candidate" key={candidate.placeId} onClick={() => chooseHotelCandidate(candidate)} disabled={phase !== "idle"}>
                      <span><Hotel size={16} /></span>
                      <div><strong>{candidate.name}</strong><small>{candidate.address}</small><em>{candidate.rating ? `Google ${candidate.rating.toFixed(1)}${candidate.userRatingCount ? ` · ${candidate.userRatingCount} 条评价` : ""}` : "Google Places 已验证"}</em><em className="tw-hotel-quote">{quoteLabel(hotelQuotes[candidate.placeId], hotelQuotesLoading)}</em></div>
                      <b>设为全程住宿<ArrowRight size={14} /></b>
                    </button>
                  ))}
                </div>
              )}
            </article>
          )}

          <article className="tw-intelligence-card">
            <div className="tw-draft-route-head"><div><small>LIVE INTENT · 实时结构化</small><h2>先把旅行条件整理清楚</h2></div><span>{analysisError ? "本轮未更新" : visibleIssues.length ? `${visibleIssues.length} 项待处理` : confirmedAccommodation ? "必要条件完整" : "待选择具体酒店"}</span></div>
            <div className="tw-signal-section"><small>兴趣与必去</small><div>{interestSignals.length ? interestSignals.map((value) => <span key={value}>{value}</span>) : <em>还没有识别到偏好</em>}</div></div>
            {intent.avoid?.length ? <div className="tw-signal-section is-muted"><small>避开</small><div>{intent.avoid.map((value) => <span key={value}>{value}</span>)}</div></div> : null}
            {analysisError
              ? <div className="tw-signal-warning" role="status">本轮未更新：{analysisError}</div>
              : visibleIssues.map((issue) => <div className="tw-signal-warning" key={issue.issueId}>
                {issue.message}{issue.suggestedQuestion && !issue.message.includes(issue.suggestedQuestion) ? `。${issue.suggestedQuestion}` : ""}
              </div>)}
          </article>

          <article className={`tw-draft-route tw-outline-review ${outlineReady ? "is-ready" : ""}`}>
            <div className="tw-draft-route-head">
              <div><small>DAILY OUTLINE · 每日草案</small><h2>先确认每天大概怎么玩</h2></div>
              <span>{outlineReady ? "等待你的确认" : "条件完整后生成"}</span>
            </div>
            {outline.length ? (
              <ol className="tw-outline-list">
                {outline.map((day) => (
                  <li key={day.day}>
                    <time>DAY {String(day.day).padStart(2, "0")}</time>
                    <i aria-hidden="true" />
                    <div>
                      <strong>{day.theme}</strong>
                      <small>{day.areas.join(" · ")}</small>
                      <p>{day.summary}</p>
                      <span>{day.experiences.join(" / ")}</span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="tw-outline-empty">先补齐日期、人数、每日时间、节奏与住宿偏好；随后选择一间具体酒店，这里会出现按天拆分的可修改草案。此时还不会调用 Google 地图。</p>
            )}
          </article>

          <div className="tw-plan-assumptions">
            <p><Sparkles size={15} />已识别的约束</p>
            {assumptions.length ? assumptions.map((value) => <span key={value}>{value}</span>) : <span>尚未指定时间、预算或交通偏好</span>}
          </div>

          <button className="tw-compile-button" type="button" disabled={!readyToBuild || phase !== "idle"} onClick={compileTrip}>
            {phase === "plan" ? <span className="tw-spinner" /> : <Route size={18} />}
            {phase === "plan" ? "正在查询 Google 地点与路线…" : "确认此草案并生成真实地图"}
            {phase !== "plan" && <ArrowRight size={17} />}
          </button>
          <small className="tw-compile-note">确认住宿与草案后，才会调用 Google Places 与 Routes；飞猪价格查询不会改变地图地点或路线。</small>
          </>}
        </section>
      </main>
    </div>
  );
}
