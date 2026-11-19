export type FlightJourneyAirport = { name: string; placeId?: string; source?: "user" | "google_places" | "supplier" };
export type FlightJourneyEndpoint = {
  localDateTime: string | null;
  timeZone: string | null;
  airport: FlightJourneyAirport | null;
  timeZoneSource?: "user_confirmed" | "supplier" | "airport_location";
};
export type FlightJourneyLeg = { departure: FlightJourneyEndpoint; arrival: FlightJourneyEndpoint; source: "user" | "supplier" | "legacy" };
export type FlightJourney = { outbound: FlightJourneyLeg; inbound: FlightJourneyLeg; source: "user" | "supplier" | "legacy" };
export type ManualFlightInput = {
  outboundDepartureAt: string; arrivalAt: string; departureAt: string; inboundArrivalAt: string;
  outboundAirportQuery: string; arrivalAirportQuery: string; departureAirportQuery: string; inboundAirportQuery: string;
  outboundTimeZone: string; inboundTimeZone: string; airportsConfirmed: true;
};
export type FlightTimeZoneConfirmation = { outboundTimeZone: string; inboundTimeZone: string; timeZonesConfirmed: true };

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function normalizeFlightTimeZone(value: unknown): string | null {
  const zone = text(value);
  if (!zone || zone.length > 100 || !(zone === "UTC" || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(zone))) return null;
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; } catch { return null; }
}

function localAt(epoch: number, zone: string): string {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(epoch).map((part) => [part.type, part.value]));
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Reject skipped or repeated daylight-saving wall times rather than guessing an offset. */
export function flightLocalDateTimeEpoch(localDateTime: string, timeZone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(localDateTime)) return null;
  const localEpoch = Date.parse(`${localDateTime}:00Z`);
  if (!Number.isFinite(localEpoch) || new Date(localEpoch).toISOString().slice(0, 16) !== localDateTime) return null;
  const zone = normalizeFlightTimeZone(timeZone);
  if (!zone) return null;
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = localEpoch + hours * 3_600_000;
    offsets.add(Date.parse(`${localAt(sample, zone)}:00Z`) - sample);
  }
  const matches = [...offsets].map((offset) => localEpoch - offset).filter((epoch) => localAt(epoch, zone) === localDateTime);
  return matches.length === 1 ? matches[0] : null;
}

function airport(value: unknown, fallback?: unknown): FlightJourneyAirport | null {
  const raw = object(value);
  const name = text(raw.name) || text(value) || text(fallback);
  if (!name) return null;
  return { name, ...(text(raw.placeId) ? { placeId: text(raw.placeId)! } : {}),
    ...(raw.source === "user" || raw.source === "google_places" || raw.source === "supplier" ? { source: raw.source } : {}) };
}

function endpoint(value: unknown, fallback: FlightJourneyEndpoint): FlightJourneyEndpoint {
  const raw = object(value);
  return { localDateTime: text(raw.localDateTime) || fallback.localDateTime,
    timeZone: normalizeFlightTimeZone(raw.timeZone) || fallback.timeZone,
    airport: airport(raw.airport) || fallback.airport,
    ...(raw.timeZoneSource === "user_confirmed" || raw.timeZoneSource === "supplier" || raw.timeZoneSource === "airport_location" ? { timeZoneSource: raw.timeZoneSource } : {}) };
}

/** Read old selections without inventing the two missing manual endpoints. */
export function deriveFlightJourney(value: unknown): FlightJourney {
  const selection = object(value), saved = object(selection.journey);
  const outbound = object(selection.outbound), inbound = object(selection.inbound);
  const source = saved.source === "user" || saved.source === "supplier" || saved.source === "legacy" ? saved.source : selection.mode === "quoted" ? "supplier" : "legacy";
  const arrivalAirport = airport(selection.arrivalAirport, selection.arrivalAirportName) || airport(outbound.destination);
  const departureAirport = airport(selection.departureAirport, selection.departureAirportName) || airport(inbound.origin);
  const fallback: FlightJourney = {
    source,
    outbound: { source, departure: { localDateTime: text(outbound.departureLocal), timeZone: normalizeFlightTimeZone(outbound.departureTimeZone), airport: airport(outbound.origin) },
      arrival: { localDateTime: text(selection.mode === "manual" ? selection.arrivalAt : outbound.arrivalLocal), timeZone: selection.mode === "manual" || selection.mode === "quoted" ? "Asia/Singapore" : null, airport: arrivalAirport } },
    inbound: { source, departure: { localDateTime: text(selection.mode === "manual" ? selection.departureAt : inbound.departureLocal), timeZone: selection.mode === "manual" || selection.mode === "quoted" ? "Asia/Singapore" : null, airport: departureAirport },
      arrival: { localDateTime: text(inbound.arrivalLocal), timeZone: normalizeFlightTimeZone(inbound.arrivalTimeZone), airport: airport(inbound.destination) } },
  };
  for (const direction of ["outbound", "inbound"] as const) {
    const leg = object(saved[direction]);
    fallback[direction] = { source: leg.source === "user" || leg.source === "supplier" || leg.source === "legacy" ? leg.source : source,
      departure: endpoint(leg.departure, fallback[direction].departure), arrival: endpoint(leg.arrival, fallback[direction].arrival) };
  }
  return fallback;
}

export function flightJourneyLegMinutes(leg: FlightJourneyLeg): number | null {
  const { departure, arrival } = leg;
  if (!departure.localDateTime || !departure.timeZone || !arrival.localDateTime || !arrival.timeZone) return null;
  const start = flightLocalDateTimeEpoch(departure.localDateTime, departure.timeZone), end = flightLocalDateTimeEpoch(arrival.localDateTime, arrival.timeZone);
  return start !== null && end !== null && end > start ? (end - start) / 60_000 : null;
}

export function validateFlightJourney(journey: FlightJourney): { valid: boolean; message?: string } {
  const endpoints = [journey.outbound.departure, journey.outbound.arrival, journey.inbound.departure, journey.inbound.arrival];
  if (endpoints.some((point) => !point.localDateTime || !point.airport?.name || !point.timeZone)) return { valid: false, message: "请补齐往返四个带日期的时刻、具体机场及当地时区。" };
  const epochs = endpoints.map((point) => flightLocalDateTimeEpoch(point.localDateTime!, point.timeZone!));
  if (epochs.some((epoch) => epoch === null)) return { valid: false, message: "日期、时区或当地时刻无法唯一对应，请按机票核对；夏令时重复或不存在的时刻不能用于自动核算。" };
  if (epochs.some((epoch, index) => index > 0 && epoch! <= epochs[index - 1]!)) return { valid: false, message: "按当地时区换算后，往返四个时刻应按起飞、抵达、返程起飞、返程到达依次递增。" };
  return { valid: true };
}
