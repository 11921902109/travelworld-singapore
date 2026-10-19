"use client";

/* Native anchors deliberately bypass the deployed Vinext client router. */
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-location-assign-relative-destination */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Hotel, MapPin,
  Route, Send, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { TravelLogo } from "@/components/travel/travel-logo";
import { planningPrompts } from "@/lib/travel/demo-trip";
import { liveTripStorageKey, type StoredLiveTrip } from "@/lib/travel/trip-storage";
import type {
  ConfirmedAccommodationAnchor,
  SingaporeIntentResponse,
  SingaporeOutlineDay,
  SingaporePlanResponse,
  SingaporeTravelIntent,
  TravelCommerce,
} from "@/lib/travel/types";

type Message = { id: number; role: "assistant" | "user"; text: string; error?: boolean };
type HotelCandidate = {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  rating: number | null;
  userRatingCount: number | null;
  googleMapsUri: string | null;
};

const initialAssistant = "先告诉我准确的出行日期（含年份、开始日和结束日）、同行人数、想住的区域或酒店、每日出发与回酒店时间，以及旅行节奏。信息补齐后，我会先展示 Google 验证的酒店候选和飞猪价格参考，选定一间后才会生成地图。";

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

function totalTravelers(intent: SingaporeTravelIntent) {
  const group = intent.travelers;
  if (!group) return null;
  if (Number(group.total) > 0) return Number(group.total);
  const total = Number(group.adults || 0) + Number(group.children || 0) + Number(group.seniors || 0);
  return total > 0 ? total : null;
}

function dateSummary(intent: SingaporeTravelIntent) {
  if (!hasExactTravelDates(intent)) return "待补充准确日期";
  if (intent.startDate && intent.endDate) {
    return `${intent.startDate} — ${intent.endDate} · ${intent.durationDays} 天`;
  }
  return "待补充准确日期";
}

function accommodationSummary(intent: SingaporeTravelIntent) {
  return intent.accommodation?.hotelName || intent.accommodation?.areaName || "待补充";
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
  if (commerce.status === "available" && commerce.price) {
    return `飞猪参考 ${commerce.price.display}${commerce.price.unit ? ` · ${commerce.price.unit}` : ""}`;
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

export function PlannerClient({ initialPrompt }: { initialPrompt: string }) {
  const nextId = useRef(3);
  const intentRef = useRef<SingaporeTravelIntent>({ destination: "Singapore" });
  const outlineRef = useRef<SingaporeOutlineDay[]>([]);
  const confirmedAccommodationRef = useRef<ConfirmedAccommodationAnchor | null>(null);
  const confirmedHotelCommerceRef = useRef<TravelCommerce | null>(null);
  const hotelCandidateQueryRef = useRef("");
  const promptStripRef = useRef<HTMLDivElement | null>(null);
  const initialized = useRef(false);
  const phaseRef = useRef<"idle" | "intent" | "plan">("idle");
  const [input, setInput] = useState("");
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
  const [analysis, setAnalysis] = useState<Pick<SingaporeIntentResponse, "missingInformation" | "ambiguities" | "blockingIssues" | "complete" | "progress">>({
    missingInformation: ["准确出行日期（年份、开始日、结束日）", "同行人数", "住宿区域或意向酒店", "每日开始时间", "每日返回酒店时间", "旅行节奏"],
    ambiguities: [],
    blockingIssues: [],
    complete: false,
    progress: 5,
  });
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 1, role: "assistant", text: initialAssistant },
    ...(initialPrompt ? [{ id: 2, role: "user" as const, text: initialPrompt }] : []),
  ]);

  function setBusy(next: "idle" | "intent" | "plan") {
    phaseRef.current = next;
    setPhase(next);
  }

  function clearConfirmedAccommodation() {
    confirmedAccommodationRef.current = null;
    confirmedHotelCommerceRef.current = null;
    setConfirmedAccommodation(null);
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
    const nextIntent: SingaporeTravelIntent = {
      ...intentRef.current,
      accommodation: {
        ...intentRef.current.accommodation,
        hotelName: candidate.name,
        googlePlaceId: candidate.placeId,
      },
    };
    confirmedAccommodationRef.current = anchor;
    const selectedCommerce = hotelQuotes[candidate.placeId] || null;
    confirmedHotelCommerceRef.current = selectedCommerce;
    intentRef.current = nextIntent;
    setConfirmedAccommodation(anchor);
    setIntent(nextIntent);
    setHotelCandidates([]);
    setHotelQuotes({});
    setHotelQuotesLoading(false);
    hotelCandidateQueryRef.current = "";
    if (hasCompleteOutline(outlineRef.current, nextIntent.durationDays)) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        text: `已将 ${candidate.name} 设为全程住宿锚点。请查看右侧每日草案；确认后即可生成真实地图。`,
      }]);
      return;
    }
    void understand(`我选择入住 ${candidate.name}，将它作为全程住宿锚点。`);
  }

  async function understand(message: string, appendUser = true) {
    if (!message.trim() || phaseRef.current !== "idle") return;
    if (
      appendUser &&
      isOutlineConfirmation(message) &&
      canBuildTrip(intentRef.current, confirmedAccommodationRef.current) &&
      hasCompleteOutline(outlineRef.current, intentRef.current.durationDays) &&
      analysis.blockingIssues.length === 0
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
    const previousHotelName = intentRef.current.accommodation?.hotelName || null;
    if (appendUser) {
      setMessages((current) => [...current, { id: nextId.current++, role: "user", text: message.trim() }]);
    }
    setInput("");
    setBusy("intent");
    try {
      const response = await fetch("/api/travel/singapore/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          currentIntent: intentRef.current,
          currentOutline: outlineRef.current,
          conversationHistory: history,
        }),
      });
      const payload = await response.json().catch(() => null) as SingaporeIntentResponse | null;
      if (!response.ok || !payload?.intent) {
        throw new Error(errorMessage(payload, "暂时无法理解这句话，请稍后重试。"));
      }
      const hotelChanged = (payload.intent.accommodation?.hotelName || null) !== previousHotelName;
      if (hotelChanged) {
        clearConfirmedAccommodation();
        setHotelCandidates([]);
        hotelCandidateQueryRef.current = "";
      }
      intentRef.current = payload.intent;
      outlineRef.current = payload.outline || [];
      setIntent(payload.intent);
      setOutline(payload.outline || []);
      setAnalysis({
        missingInformation: payload.missingInformation || [],
        ambiguities: payload.ambiguities || [],
        blockingIssues: payload.blockingIssues || [],
        complete: Boolean(payload.complete),
        progress: Math.max(0, Math.min(100, payload.progress || 0)),
      });
      if (!confirmedAccommodationRef.current) void loadHotelCandidates(payload.intent, hotelChanged);
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        text: payload.reply || payload.nextQuestion || "条件已更新。你可以继续补充；信息完整后我会先给出每日草案。",
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        error: true,
        text: error instanceof Error ? error.message : "意图识别服务暂时不可用。",
      }]);
    } finally {
      setBusy("idle");
    }
  }

  useEffect(() => {
    if (!initialPrompt || initialized.current) return;
    initialized.current = true;
    void understand(initialPrompt, false);
    // The initial prompt is intentionally processed once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const conditionProgress = analysis.progress;
  const intentReady = canBuildTrip(intent, confirmedAccommodation) && analysis.blockingIssues.length === 0;
  const outlineReady = intentReady && hasCompleteOutline(outline, intent.durationDays);
  const readyToBuild = outlineReady;
  const people = totalTravelers(intent);
  const stay = accommodationSummary(intent);
  const stayState = accommodationState(intent, confirmedAccommodation);
  const interestSignals = [
    ...(intent.interests || []),
    ...(intent.mustVisit || []),
    ...(intent.allowAutomaticRecommendations ? ["由 travelworld 自动推荐"] : []),
  ].filter(Boolean);
  const assumptions = useMemo(() => {
    const values: string[] = [];
    if (intent.dailyStartTime) values.push(`${intent.dailyStartTime} 出发`);
    if (intent.dailyEndTime) values.push(`${intent.dailyEndTime} 返回酒店`);
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
  }, [intent]);

  function sendMessage(event: FormEvent) {
    event.preventDefault();
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
      analysis.blockingIssues.length > 0 ||
      phaseRef.current !== "idle"
    ) return;
    setBusy("plan");
    try {
      const response = await fetch("/api/travel/singapore/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          <span className={intentReady ? "is-complete" : "is-current"}>{intentReady && <Check size={14} />}意图</span><i />
          <span className={outlineReady ? "is-complete" : intentReady ? "is-current" : ""}>{outlineReady && <Check size={14} />}草案</span><i />
          <span className={phase === "plan" ? "is-current" : ""}>地图</span>
        </div>
        <span className="tw-draft-state"><i />Singapore Intelligence v1.7</span>
      </header>

      <main className="tw-planner-grid">
        <section className="tw-conversation-panel" aria-label="旅行规划对话">
          <div className="tw-panel-heading">
            <p>PLAN WITH AI · SINGAPORE</p><h1>像聊天一样规划新加坡</h1>
            <span>百炼智能体负责理解意图；酒店先由 Google Places 确认，路线由 Google Maps 实时校验，飞猪补充价格参考。</span>
          </div>

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
            <button type="submit" disabled={!input.trim() || phase !== "idle"} aria-label="发送"><Send size={17} /></button>
          </form>
        </section>

        <section className="tw-plan-preview" aria-label="结构化旅行条件">
          <div className="tw-preview-progress">
            <div><p>INTENT CONFIDENCE</p><strong>{conditionProgress}%</strong></div>
            <span><i style={{ width: `${conditionProgress}%` }} /></span>
            <small>{
              readyToBuild
                ? "每日草案已就绪；只有确认后才查询真实地点与路线"
                : analysis.blockingIssues.length
                  ? `需要先确认：${analysis.blockingIssues[0]}`
                  : !canStartAccommodationSelection(intent)
                    ? `还需要：${analysis.missingInformation.join("、") || "一项关键信息"}`
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
            <article><span><Hotel size={18} /></span><div><small>住宿与路线锚点</small><strong>{stay}</strong><em className={confirmedAccommodation ? "is-verified" : ""}>{confirmedAccommodation ? <><ShieldCheck size={13} /> {stayState}</> : stayState}</em></div></article>
            <article><span><Clock3 size={18} /></span><div><small>每日行动时段</small><strong>{intent.dailyStartTime || "待补充"} — {intent.dailyEndTime || "待补充"}</strong><em className={intent.dailyStartTime && intent.dailyEndTime ? "is-verified" : ""}>{intent.dailyStartTime && intent.dailyEndTime ? <><CheckCircle2 size={13} /> 已识别</> : "出发与返回均必填"}</em></div></article>
            <article><span><Users size={18} /></span><div><small>同行与节奏</small><strong>{people ? `${people} 人` : "人数待补充"} · {paceLabels[intent.pace || ""] || intent.pace || "节奏待补充"}</strong><em className={people && intent.pace ? "is-verified" : ""}>{people && intent.pace ? "已识别" : "人数与节奏均必填"}</em></div></article>
          </div>

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
            <div className="tw-draft-route-head"><div><small>LIVE INTENT · 实时结构化</small><h2>先把旅行条件整理清楚</h2></div><span>{analysis.complete ? confirmedAccommodation ? "必要条件完整" : "待选择具体酒店" : `${analysis.missingInformation.length + analysis.blockingIssues.length} 项待处理`}</span></div>
            <div className="tw-signal-section"><small>兴趣与必去</small><div>{interestSignals.length ? interestSignals.map((value) => <span key={value}>{value}</span>) : <em>还没有识别到偏好</em>}</div></div>
            {intent.avoid?.length ? <div className="tw-signal-section is-muted"><small>避开</small><div>{intent.avoid.map((value) => <span key={value}>{value}</span>)}</div></div> : null}
            {analysis.missingInformation.length ? <div className="tw-signal-warning">生成前还需要：{analysis.missingInformation.join("；")}</div> : null}
            {analysis.blockingIssues.length ? <div className="tw-signal-warning">需要确认：{analysis.blockingIssues.join("；")}</div> : null}
            {analysis.ambiguities.length ? <div className="tw-signal-warning">仍需确认：{analysis.ambiguities.join("；")}</div> : null}
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
        </section>
      </main>
    </div>
  );
}
