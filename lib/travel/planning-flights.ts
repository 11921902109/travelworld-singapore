import { extractJsonObject } from "@/lib/travel/singapore-intent";
import { firstFeizhuBookingUrl } from "./feizhu-link";
import { normalizeFlightLocation } from "./flight-location";
import { normalizeFlightTimeZone } from "./planning-flight-journey";

export type FlightOffer = {
  id: string;
  direction: "outbound" | "inbound";
  origin: string;
  destination: string;
  departureLocal: string;
  arrivalLocal: string;
  departureTimeZone?: string | null;
  arrivalTimeZone?: string | null;
  airline: string;
  flightNumber: string;
  price: { amount: number; currency: string; display: string } | null;
  priceBasis?: "per_person" | "total" | "unknown";
  bookingUrl: string | null;
  baggageAllowance: string | null;
  fareConditions: string | null;
  queriedAt: string;
  source: "bailian_flyai";
};

export type FlightQueryOutcome = {
  direction: "outbound" | "inbound";
  departureDate: string;
  status: "available" | "empty" | "failed" | "filtered" | "unknown";
  acceptedCount: number;
  rejectedCount: number;
  /** The Agent's report, not an independently verified FlyAI tool result. */
  reportedStatus: "success" | "empty" | "error" | null;
  errorCode: string | null;
  reportedErrorMessage?: string | null;
};

export type FlightLookupLink = { direction: "outbound" | "inbound"; departureDate: string | null; url: string; queriedAt: string; source: "bailian_flyai" };

export type FlightRejectedReason = "invalid_time" | "outside_query_dates" | "wrong_arrival_date" | "missing_identity" | "no_price_or_booking_link";
export type FlightRejectionCount = { direction: "outbound" | "inbound"; departureDate: string | null; reason: FlightRejectedReason; count: number };

export type FlightSearchResult = {
  outbound: FlightOffer[];
  inbound: FlightOffer[];
  queriedAt: string;
  status: "available" | "unavailable";
  queryOutcomes?: FlightQueryOutcome[];
  rejected?: FlightRejectionCount[];
  searchLinks?: FlightLookupLink[];
  failureReason?: "agent_unavailable" | "invalid_response" | "no_eligible_offers";
  travelers?: { total: number; adults: number | null; children: number | null; seniors: number | null };
  preferences?: { arrivalBefore: string | null; departureAfter: string | null };
  /** Full search conditions, including the direction not retried this time. */
  searchQuery?: FlightSearchQuery;
  contextFingerprint?: string;
};

export type FlightSearchDirection = "outbound" | "inbound" | "both";
export type FlightSearchInput = {
  direction?: FlightSearchDirection;
  originCity: string;
  startDate: string;
  endDate: string;
  travelers: { total: number; adults: number | null; children: number | null; seniors: number | null };
  preferences?: { arrivalBefore?: string | null; departureAfter?: string | null };
  outboundDepartureDate?: string;
  inboundDepartureDate?: string;
  includePreviousEvening?: boolean;
  includeNextDayReturn?: boolean;
};

export type FlightSearchQuery = {
  direction?: FlightSearchDirection;
  originCity: string;
  startDate: string;
  endDate: string;
  outboundDates: string[];
  inboundDates: string[];
  travelers: FlightSearchInput["travelers"];
  preferences: NonNullable<FlightSearchResult["preferences"]>;
};

export type FlightSearchJob = {
  id: string;
  direction?: FlightSearchDirection;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "superseded";
  message: string;
  createdAt: string;
  deadlineAt: string;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bookingUrlFrom(value: Record<string, unknown>): string | null {
  return firstFeizhuBookingUrl(value.bookingUrl, value.jumpUrl, value.jump_url, value.booking_url);
}

function safeReportedError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180);
  if (!message) return null;
  if (/https?:\/\/|\bBearer\s|(?:api[_ -]?key|secret|password|token)\s*[:=]|密钥|密码/i.test(message)) return "查询工具返回错误，详细信息已省略。";
  return message;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validLocalDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return validDate(value.slice(0, 10));
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function offerFromAgent(
  value: unknown,
  direction: FlightOffer["direction"],
  departureDates: string[],
  itineraryDate: string,
  queriedAt: string,
  index: number,
): { offer: FlightOffer | null; reason: FlightRejectedReason | null; departureDate: string | null } {
  const source = object(value);
  const departureLocal = string(source.departureLocal, 16);
  const arrivalLocal = string(source.arrivalLocal, 16);
  const departureDate = validLocalDateTime(departureLocal) ? departureLocal.slice(0, 10) : null;
  if (!departureDate || !validLocalDateTime(arrivalLocal)) return { offer: null, reason: "invalid_time", departureDate };
  if (!departureDates.includes(departureDate)) return { offer: null, reason: "outside_query_dates", departureDate };
  if (direction === "outbound" && arrivalLocal.slice(0, 10) !== itineraryDate) return { offer: null, reason: "wrong_arrival_date", departureDate };
  const flightNumber = string(source.flightNumber, 24);
  const airline = string(source.airline, 80);
  const origin = string(source.origin, 100);
  const destination = string(source.destination, 100);
  if (!flightNumber || !airline || !origin || !destination) return { offer: null, reason: "missing_identity", departureDate };
  const amount = Number(object(source.price).amount);
  const currency = string(object(source.price).currency, 3).toUpperCase();
  const price = Number.isFinite(amount) && amount > 0 && amount <= 1_000_000 && /^[A-Z]{3}$/.test(currency)
    ? { amount, currency, display: `${currency} ${amount}` }
    : null;
  const bookingUrl = bookingUrlFrom(source);
  if (!price && !bookingUrl) return { offer: null, reason: "no_price_or_booking_link", departureDate };
  const priceBasis = source.priceBasis === "per_person" || source.priceBasis === "total" ? source.priceBasis : "unknown";
  return { offer: {
    id: `${direction}-${flightNumber.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}-${departureLocal.replace(/\D/g, "")}-${index}`,
    direction,
    origin,
    destination,
    departureLocal,
    arrivalLocal,
    departureTimeZone: normalizeFlightTimeZone(source.departureTimeZone),
    arrivalTimeZone: normalizeFlightTimeZone(source.arrivalTimeZone),
    airline,
    flightNumber,
    price,
    priceBasis,
    bookingUrl,
    baggageAllowance: string(source.baggageAllowance, 160) || null,
    fareConditions: string(source.fareConditions, 160) || null,
    queriedAt,
    source: "bailian_flyai",
  }, reason: null, departureDate };
}

function queryOutcomes(
  parsed: Record<string, unknown>,
  requested: Array<{ direction: FlightQueryOutcome["direction"]; departureDate: string }>,
  accepted: FlightOffer[],
  rejected: FlightRejectionCount[],
): FlightQueryOutcome[] {
  const reports = Array.isArray(parsed.queries) ? parsed.queries.map(object) : [];
  return requested.map(({ direction, departureDate }) => {
    const report = reports.find((item) => item.direction === direction && item.departureDate === departureDate);
    const rawStatus = report?.status;
    const reportedStatus = rawStatus === "success" || rawStatus === "empty" || rawStatus === "error" ? rawStatus : null;
    const acceptedCount = accepted.filter((offer) => offer.direction === direction && offer.departureLocal.slice(0, 10) === departureDate).length;
    const rejectedCount = rejected.filter((item) => item.direction === direction && item.departureDate === departureDate).reduce((sum, item) => sum + item.count, 0);
    const status = acceptedCount ? "available" : reportedStatus === "error" ? "failed"
      : rejectedCount ? "filtered" : reportedStatus === "empty" || reportedStatus === "success" ? "empty" : "unknown";
    const errorCode = reportedStatus === "error" && typeof report?.errorCode === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(report.errorCode)
      ? report.errorCode : null;
    const reportedErrorMessage = reportedStatus === "error" ? safeReportedError(report?.reportedErrorMessage) || safeReportedError(report?.errorMessage) || (!errorCode ? safeReportedError(report?.errorCode) : null) : null;
    return { direction, departureDate, status, acceptedCount, rejectedCount, reportedStatus, errorCode, reportedErrorMessage };
  });
}

export function parseFlightAgentResponse(input: {
  text: string;
  queriedAt: string;
  outboundDates: string[];
  inboundDates: string[];
  requiredArrivalDate: string;
  travelers: FlightSearchResult["travelers"];
  preferences: NonNullable<FlightSearchResult["preferences"]>;
}): FlightSearchResult {
  const parsed = object(extractJsonObject(input.text));
  if (!Array.isArray(parsed.outbound) || !Array.isArray(parsed.inbound)) throw new Error("INVALID_FLIGHT_RESPONSE");
  const rejected: FlightRejectionCount[] = [];
  const searchLinks: FlightLookupLink[] = [];
  function addSearchLink(direction: "outbound" | "inbound", value: Record<string, unknown>, dates: string[]) {
    const url = bookingUrlFrom(value);
    if (!url || !dates.length) return;
    const rawDate = string(value.departureDate, 10) || string(value.departureLocal, 16).slice(0, 10);
    if (rawDate && (!validDate(rawDate) || !dates.includes(rawDate))) return;
    const departureDate = rawDate || (dates.length === 1 ? dates[0] : null);
    if (!searchLinks.some((item) => item.direction === direction && item.departureDate === departureDate && item.url === url)) {
      searchLinks.push({ direction, departureDate, url, queriedAt: input.queriedAt, source: "bailian_flyai" });
    }
  }
  const parseDirection = (direction: "outbound" | "inbound", dates: string[]) => {
    if (!dates.length) return [];
    const values = Array.isArray(parsed[direction]) ? parsed[direction] : [];
    const unique = new Set<string>();
    const offers: FlightOffer[] = [];
    values.forEach((value, index) => {
      const source = object(value);
      // Search-level links cannot provide arrival/departure constraints.
      if (bookingUrlFrom(source) && (!validLocalDateTime(string(source.departureLocal, 16)) || !validLocalDateTime(string(source.arrivalLocal, 16)) || !string(source.flightNumber) || !string(source.airline) || !string(source.origin) || !string(source.destination))) {
        addSearchLink(direction, source, dates); return;
      }
      const result = offerFromAgent(value, direction, dates, input.requiredArrivalDate, input.queriedAt, index);
      if (result.reason) {
        const existing = rejected.find((item) => item.direction === direction && item.departureDate === result.departureDate && item.reason === result.reason);
        if (existing) existing.count += 1;
        else rejected.push({ direction, departureDate: result.departureDate, reason: result.reason, count: 1 });
      } else if (result.offer) {
        const key = `${result.offer.flightNumber}:${result.offer.departureLocal}`;
        if (!unique.has(key)) { unique.add(key); offers.push(result.offer); }
      }
    });
    return offers;
  };
  const outbound = parseDirection("outbound", input.outboundDates)
    .sort((a, b) => Number(Boolean(input.preferences.arrivalBefore) && b.arrivalLocal.slice(11) <= input.preferences.arrivalBefore!) - Number(Boolean(input.preferences.arrivalBefore) && a.arrivalLocal.slice(11) <= input.preferences.arrivalBefore!))
    .slice(0, 5);
  const inbound = parseDirection("inbound", input.inboundDates)
    .sort((a, b) => Number(Boolean(input.preferences.departureAfter) && b.departureLocal.slice(11) >= input.preferences.departureAfter!) - Number(Boolean(input.preferences.departureAfter) && a.departureLocal.slice(11) >= input.preferences.departureAfter!))
    .slice(0, 5);
  const requested = [
    ...input.outboundDates.map((departureDate) => ({ direction: "outbound" as const, departureDate })),
    ...input.inboundDates.map((departureDate) => ({ direction: "inbound" as const, departureDate })),
  ];
  for (const value of Array.isArray(parsed.searchLinks) ? parsed.searchLinks : []) {
    const item = object(value);
    if (item.direction === "outbound" || item.direction === "inbound") addSearchLink(item.direction, item, item.direction === "outbound" ? input.outboundDates : input.inboundDates);
  }
  if (requested.length === 1 && bookingUrlFrom(parsed)) addSearchLink(requested[0].direction, parsed, [requested[0].departureDate]);
  return {
    outbound, inbound, queriedAt: input.queriedAt,
    status: outbound.length || inbound.length ? "available" : "unavailable",
    queryOutcomes: queryOutcomes(parsed, requested, [...outbound, ...inbound], rejected),
    rejected, searchLinks: searchLinks.slice(0, 10), failureReason: outbound.length || inbound.length ? undefined : "no_eligible_offers",
    travelers: input.travelers, preferences: input.preferences,
  };
}

/** Resolve exactly the dates that the traveller selected; adjacent days are opt-in. */
export function buildFlightSearchQuery(input: FlightSearchInput): FlightSearchQuery {
  const originCity = string(input.originCity, 100);
  if (!originCity || !validDate(input.startDate) || !validDate(input.endDate) || input.endDate < input.startDate) {
    throw new Error("FLIGHT_SEARCH_INPUT_INVALID");
  }
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const preferences = {
    arrivalBefore: input.preferences?.arrivalBefore || null,
    departureAfter: input.preferences?.departureAfter || null,
  };
  if ((preferences.arrivalBefore && !timePattern.test(preferences.arrivalBefore)) ||
      (preferences.departureAfter && !timePattern.test(preferences.departureAfter)) ||
      !Number.isInteger(input.travelers.total) || input.travelers.total < 1 || input.travelers.total > 20) {
    throw new Error("FLIGHT_SEARCH_INPUT_INVALID");
  }
  const outboundDepartureDate = input.outboundDepartureDate || input.startDate;
  const inboundDepartureDate = input.inboundDepartureDate || input.endDate;
  if (![input.startDate, addDays(input.startDate, -1)].includes(outboundDepartureDate) ||
      ![input.endDate, addDays(input.endDate, 1)].includes(inboundDepartureDate)) throw new Error("FLIGHT_SEARCH_INPUT_INVALID");
  const outboundDates = [...new Set([outboundDepartureDate, ...(input.includePreviousEvening ? [addDays(input.startDate, -1)] : [])])].sort();
  const inboundDates = [...new Set([inboundDepartureDate, ...(input.includeNextDayReturn ? [addDays(input.endDate, 1)] : [])])].sort();
  const direction = input.direction || "both";
  if (!["outbound", "inbound", "both"].includes(direction)) throw new Error("FLIGHT_SEARCH_INPUT_INVALID");
  return { direction, originCity, startDate: input.startDate, endDate: input.endDate, outboundDates, inboundDates, travelers: input.travelers, preferences };
}

export function requestedFlightDates(query: FlightSearchQuery) {
  return { outboundDates: query.direction === "inbound" ? [] : query.outboundDates,
    inboundDates: query.direction === "outbound" ? [] : query.inboundDates };
}

export function flightSearchPrompt(query: FlightSearchQuery): string {
  const dates = requestedFlightDates(query);
  const origin = normalizeFlightLocation(query.originCity);
  const singapore = normalizeFlightLocation("Singapore");
  const lookup = {
    travelDates: { start: query.startDate, end: query.endDate },
    requestedQueries: [
      ...dates.outboundDates.map((departureDate) => ({ direction: "outbound", origin: origin.name, destination: singapore.name, departureDate })),
      ...dates.inboundDates.map((departureDate) => ({ direction: "inbound", origin: singapore.name, destination: origin.name, departureDate })),
    ],
    locationResolution: { origin, singapore },
    travelers: Object.fromEntries(Object.entries(query.travelers).filter(([, value]) => value !== null)),
    preferences: Object.fromEntries(Object.entries(query.preferences).filter(([, value]) => value !== null)),
  };
  return `你负责本次指定方向的航班查询。只查询 requestedQueries 列出的方向；未列出的另一方向不得查询、不得复用会话旧结果，返回空数组。使用 FlyAI Skill，逐项执行 requestedQueries 的 search-flight，不增加日期、不额外换名称重查。所有日期均是出发地当地的出发日期；去程须在 travelDates.start 抵达新加坡，返程须在 travelDates.end 或次日从新加坡离境。每项记录工具报告的 success、empty 或 error，机器 errorCode 仅在工具明确给出时填写；中文或其他简短错误说明放 reportedErrorMessage，不输出工具日志或敏感字段。某项失败不得覆盖其他成功结果。只返回工具实际提供的航班、当地时刻、价格和 HTTPS 预订链接，不换汇、不编造。人数不被接口支持时不可声称是全部旅客总价。价格未知可省略或为 null，真实 jumpUrl 归一为 bookingUrl；只有搜索级链接而无具体航班时刻时放 searchLinks，不把同一个搜索链接复制为多条精确航班链接。没有工具返回的链接不得拼造。可选的行李、退改、链接和错误码未知时省略，priceBasis 无法确定时为 unknown。arrivalBefore/departureAfter 只是排序偏好。locationResolution 仅规范已知名称。按当前 search-flight 文档解析中文城市／机场名称，不猜机场代码、不把明确机场改成全市或扩大范围；若契约不支持该机场请明确报告。不要输出密钥或工具日志。\n查询数据：${JSON.stringify(lookup)}\n只输出一个 JSON 对象，包含 queries、outbound、inbound 三个数组，可选 searchLinks 数组。queries 的方向和日期集合必须与 requestedQueries 完全一致，每项字段为 direction、departureDate、status（success/empty/error）、可选 errorCode、reportedErrorMessage（简短说明）。searchLinks 每项含 direction、departureDate、工具实际返回的 bookingUrl 或 jumpUrl，仅用于前往飞猪查看，不当作航班。航班字段为 origin、destination、departureLocal、arrivalLocal（YYYY-MM-DDTHH:mm 当地时刻）、airline、flightNumber、仅在工具明确返回时可含 departureTimeZone、arrivalTimeZone（IANA 时区，未知省略，不按机场名称猜测）、可选真实 price:{amount,currency}（未知则省略或 null）、priceBasis（per_person/total/unknown）、可选 bookingUrl、baggageAllowance、fareConditions。每个方向最多5项；无真实候选返回空数组。`;
}

/** Retained bounded adapter for callers that do not need the resumable job flow. */
export async function searchFlightOffers(input: FlightSearchInput & { visitToken: string; turnId?: string }): Promise<FlightSearchResult> {
  const query = buildFlightSearchQuery(input);
  const queriedAt = new Date().toISOString();
  const { askBailianAgent } = await import("@/lib/travel/bailian");
  const reply = await askBailianAgent(flightSearchPrompt(query), "planning", input.visitToken, input.turnId);
  if (!reply) return { outbound: [], inbound: [], queriedAt, status: "unavailable", failureReason: "agent_unavailable", travelers: input.travelers, preferences: query.preferences };
  try {
    return parseFlightAgentResponse({ text: reply.text, queriedAt, ...requestedFlightDates(query), requiredArrivalDate: input.startDate, travelers: input.travelers, preferences: query.preferences });
  } catch {
    return { outbound: [], inbound: [], queriedAt, status: "unavailable", failureReason: "invalid_response", travelers: input.travelers, preferences: query.preferences };
  }
}
