import { cnyPriceLabel } from "./cny-price";
import { normalizeFeizhuBookingUrl } from "./feizhu-link";
import { hotelQuoteJobMatchesSegment } from "./planning-hotel-batch";
import type { HotelQuoteJob } from "./planning-hotel-jobs";
import { hotelIdentityContextKey } from "./planning-hotel-snapshot";
import type { HotelStopQuote, TravelCommerce, TripDay, TripStop } from "./types";

export type MapHotelSegment = {
  id: string;
  startDay: number;
  area: string;
  checkInDate: string;
  checkOutDate: string;
  hotelSearchId?: string;
  hotel?: { placeId: string };
  hotelCandidates?: Array<{
    placeId: string;
    commerce?: TravelCommerce | null;
    quoteStatus?: string;
    quoteJobId?: string;
    verifiedPlace?: { contextKey: string };
  }>;
};

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;

function hotelDetailUrl(value: unknown): string | undefined {
  const safe = normalizeFeizhuBookingUrl(value);
  if (!safe) return;
  const searchPaths = /(?:^|\/)(?:search[-_a-z]*|s|hotel[-_]?(?:search|list)[-_a-z]*)(?:\.html?|\/|$)/i;
  function isDetail(target: URL, depth: number): boolean {
    const path = decodeURIComponent(target.pathname);
    const hashPath = decodeURIComponent(target.hash.replace(/^#/, "").split("?")[0]);
    if (depth > 4 || searchPaths.test(path) || searchPaths.test(hashPath)) return false;
    if (target.pathname === "/" && !target.hash.replace(/^#\/?/, "").split("?")[0]) return false;
    for (const params of [target.searchParams, new URLSearchParams(target.hash.split("?")[1] || "")]) {
      for (const [key, nested] of params) {
        if (!nested || !/^(?:url|redirect(?:_?(?:url|uri))?|target(?:_?url)?|return_?url)$/i.test(key)) continue;
        let value = nested;
        for (let attempt = 0; attempt < 3 && /^[a-z](?:[a-z0-9+.-]*)(?:%25)*%?3a/i.test(value); attempt++) value = decodeURIComponent(value);
        if (!isDetail(new URL(value, target), depth + 1)) return false;
      }
    }
    return true;
  }
  try { return isDetail(new URL(safe), 0) ? safe : undefined; }
  catch { return; }
}

export function projectPlanningMapHotelQuotes(day: TripDay, date: string, handoffId: string, segments: MapHotelSegment[], job?: HotelQuoteJob): TripDay {
  const dayNumber = Number(/^day-(\d+)$/.exec(day.id)?.[1]);
  if (!dayNumber || !calendarDate.test(date)) return day;
  const previous = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(previous.getTime())) return day;
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDate = previous.toISOString().slice(0, 10);
  let changed = false;
  const stops = day.stops.map((stop) => {
    const side = new RegExp(`^day-${dayNumber}-hotel-(start|arrival|return)$`).exec(stop.id)?.[1];
    if (stop.kind !== "hotel" || !stop.verified || !stop.placeId || !side) return stop;
    const night = dayNumber > 1 && side === "start" ? previousDate : date;
    const covering = segments.filter((segment) => calendarDate.test(segment.checkInDate) && calendarDate.test(segment.checkOutDate)
      && segment.checkInDate <= night && night < segment.checkOutDate);
    if (covering.length !== 1) return stop;
    const segment = covering[0];
    if (segment.hotel?.placeId !== stop.placeId) return stop;
    const { checkInDate, checkOutDate } = segment;
    const candidate = segment.hotelCandidates?.find((item) => item.placeId === stop.placeId);
    const contextMatches = candidate && (!candidate.verifiedPlace
      || candidate.verifiedPlace.contextKey === hotelIdentityContextKey(handoffId, segment));
    const raw = contextMatches ? candidate.commerce : undefined;
    const quoteStatus = contextMatches ? candidate.quoteStatus : undefined;
    const dates = { checkInDate, checkOutDate };
    let status: HotelStopQuote["status"] = !candidate || quoteStatus === "not_requested" ? "not_requested" : "unavailable";
    if (quoteStatus === "failed") status = "failed";
    let commerce: TravelCommerce | undefined;
    if (raw?.provider === "fliggy" && raw.kind === "hotel" && raw.status === "available" && status !== "failed" && quoteStatus !== "not_requested") {
      const bookingUrl = hotelDetailUrl(raw.bookingUrl);
      const price = raw.price && typeof raw.price.amount === "number" && Number.isFinite(raw.price.amount) && raw.price.amount > 0
        && /^[A-Z]{3}$/.test(raw.price.currency) ? raw.price : undefined;
      if (price || bookingUrl) {
        status = "available";
        commerce = { ...raw, price, bookingUrl };
      }
    }
    if (status !== "available" && job?.status === "failed" && job.placeIds?.includes(stop.placeId) && hotelQuoteJobMatchesSegment(job, segment)) status = "failed";
    changed = true;
    return { ...stop, commerce, hotelQuote: { ...dates, status } };
  });
  return changed ? { ...day, stops } : day;
}

export function hotelMapQuotePresentation(stop: Pick<TripStop, "commerce" | "hotelQuote">) {
  const commerce = stop.commerce?.provider === "fliggy" && stop.commerce.kind === "hotel" ? stop.commerce : undefined;
  const bookingUrl = commerce?.status === "available" ? hotelDetailUrl(commerce.bookingUrl) : undefined;
  const quote = stop.hotelQuote;
  const dates = quote && calendarDate.test(quote.checkInDate) && calendarDate.test(quote.checkOutDate)
    ? `${quote.checkInDate.slice(5).replace("-", "/")} 入住 → ${quote.checkOutDate.slice(5).replace("-", "/")} 退房` : undefined;
  const amount = commerce?.status === "available" ? cnyPriceLabel(commerce.price) : null;
  const price = amount ? `${amount}${commerce?.price?.unit ? ` · ${commerce.price.unit}` : ""}` : undefined;
  let message: string | undefined;
  if (price) message = bookingUrl ? undefined : "本次未返回酒店详情链接。";
  else if (bookingUrl) message = commerce?.price ? "本次未返回可核实的人民币参考价，可前往查看酒店详情。" : "本次未返回价格，可前往查看酒店详情。";
  else if (quote?.status === "failed") message = "本住宿段飞猪报价查询未成功，酒店选择不受影响。";
  else if (quote?.status === "not_requested") message = "本住宿段尚未查询飞猪报价。";
  else if (quote?.status === "unavailable" || commerce) message = "本次未返回可核实的酒店参考价或详情链接。";
  else message = "当前行程未保存本住宿段的飞猪报价或详情链接。";
  return { dates, price, bookingUrl, message };
}
