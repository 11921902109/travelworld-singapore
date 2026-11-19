import { z } from "zod";

const label = z.string().trim().min(1).max(240);
const detail = z.string().trim().max(500);
const id = z.string().min(1).max(120);
// An accepted late return may be represented as 24:15 or later by the scheduler.
const clock = z.string().regex(/^\d{2,3}:[0-5]\d$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/);
const stopKind = z.enum(["hotel", "sight", "food", "other", "buffer"]);
const mode = z.enum(["walk", "transit", "taxi", "drive", "bicycle"]);
const color = z.string().regex(/^(?:#[0-9a-fA-F]{6}|var\(--route-day-[1-7]\))$/);
const coordinate = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const aiAdvice = z.object({ pros: detail, cons: detail });
const privateAccommodationName = "住宿地点（分享中已隐藏）";

const stopPlan = z.object({
  name: label,
  area: detail,
  time: clock,
  endTime: clock,
  duration: detail,
  kind: stopKind,
  categoryLabel: detail.optional(),
  verified: z.boolean(),
});
const stopDetails = stopPlan.extend({
  description: detail.optional(),
  note: detail.optional(),
  warning: detail.optional(),
  durationReason: detail.optional(),
  sceneRole: z.enum(["culinary_area", "restaurant_meal", "attraction"]).optional(),
  placeId: z.string().trim().min(1).max(255).optional(),
  aiAdvice: aiAdvice.optional(),
});
const legPlan = z.object({ mode, minutes: z.number().int().min(0).max(1440), distance: detail.optional() });
const dayPlan = z.object({
  label,
  date: label,
  weekday: detail,
  theme: label,
  summary: detail,
  returnBy: clock.optional(),
});
const tripPlan = z.object({
  title: label,
  destination: z.literal("新加坡"),
  dateRange: label,
  timezone: label,
  pace: detail,
  people: z.number().int().min(1).max(20),
});
const tripMetadata = z.object({
  generatedAt: z.string().datetime().optional(),
  warnings: z.array(detail).max(30).optional(),
});
const dayMetadata = z.object({
  terminalKind: z.enum(["hotel", "airport"]).optional(),
  overtimeAcceptance: z.object({
    minutes: z.number().int().positive(),
    acceptedAt: z.string().datetime(),
    deadline: clock,
    estimatedArrival: clock,
  }).optional(),
});
const legMetadata = z.object({ timeSource: z.enum(["google", "user"]).optional() });
const transferPlan = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departureAt: localDateTime,
  leaveHotelAt: localDateTime.optional(),
  arriveAirportAt: localDateTime.optional(),
  airportCutoffAt: localDateTime,
  airportLeadMinutes: z.number().int().min(0).max(1440),
  note: detail,
});

const InputStopSchema = stopDetails.extend({
  id: id.optional(),
  address: detail.optional(),
  location: coordinate.optional(),
  lat: coordinate.shape.lat.optional(),
  lng: coordinate.shape.lng.optional(),
});
const InputLegSchema = legPlan.merge(legMetadata).extend({
  from: id.optional(),
  to: id.optional(),
  provider: z.enum(["google", "demo"]).optional(),
});
const AnchorSchema = z.object({
  name: label,
  address: detail.optional(),
  placeId: stopDetails.shape.placeId,
  location: coordinate.optional(),
});
const InputTripSchema = tripPlan.merge(tripMetadata).extend({
  hotel: detail,
  source: z.enum(["demo", "live"]).optional(),
  days: z.array(dayPlan.merge(dayMetadata).extend({
    color: color.optional(),
    stops: z.array(InputStopSchema).min(2).max(15),
    legs: z.array(InputLegSchema).max(15),
  })).min(1).max(7),
  accommodationSegments: z.array(z.object({
    startDayId: id.optional(),
    anchor: AnchorSchema,
  })).max(7).optional(),
  accommodationAnchor: AnchorSchema.optional(),
  departureTransfer: transferPlan.extend({
    fromHotel: AnchorSchema,
    toAirport: AnchorSchema,
    leg: InputLegSchema,
  }).optional(),
});

/** Trim provider payloads before sending a trip to the share endpoint. */
export function prepareSharedTripInput(input: unknown) {
  return InputTripSchema.parse(input);
}

const SharedStopSchema = stopDetails.extend({ id, location: coordinate.optional() });
const SharedLegSchema = legPlan.merge(legMetadata).extend({ from: id, to: id });
const SharedDaySchema = dayPlan.merge(dayMetadata).extend({
  id,
  color,
  stops: z.array(SharedStopSchema).min(2).max(15),
  legs: z.array(SharedLegSchema).max(15),
});
const ShareV2Schema = tripPlan.merge(tripMetadata).extend({
  version: z.literal(2),
  includeAccommodation: z.boolean(),
  sharedAt: z.string().datetime(),
  days: z.array(SharedDaySchema).min(1).max(7),
  accommodationSegments: z.array(z.object({
    startDayId: id,
    name: label,
    placeId: stopDetails.shape.placeId,
  })).max(7).optional(),
  departureTransfer: transferPlan.extend({
    fromHotel: SharedStopSchema,
    toAirport: SharedStopSchema,
    leg: SharedLegSchema.optional(),
  }).optional(),
});

export type SharedTripSnapshot = z.infer<typeof ShareV2Schema>;
export type SharedTripStop = z.infer<typeof SharedStopSchema>;
export type SharedTripLeg = z.infer<typeof SharedLegSchema>;

const LegacyShareSchema = tripPlan.extend({
  version: z.literal(1).optional(),
  sharedAt: z.string().datetime(),
  days: z.array(dayPlan.extend({
    stops: z.array(stopPlan).min(2).max(15),
    legs: z.array(legPlan).max(15),
  })).min(1).max(7),
});

const dayId = (index: number) => `day-${index + 1}`;
const stopId = (day: string, index: number) => `${day}-stop-${index + 1}`;
const dayColor = (index: number) => ["#f16449", "#15745f", "#d8983e", "#5676a8", "#835c9d", "#a95d73", "#4f8172"][index];

// The legacy format only contained textual stops and ordinal legs. Keep it readable.
export const SharedTripSnapshotSchema = z.union([
  ShareV2Schema,
  LegacyShareSchema.transform(({ days, ...trip }): SharedTripSnapshot => ({
    ...trip,
    version: 2,
    includeAccommodation: false,
    days: days.map((day, dayIndex) => {
      const currentDayId = dayId(dayIndex);
      return {
        ...day,
        id: currentDayId,
        color: dayColor(dayIndex),
        stops: day.stops.map((stop, index) => ({ ...stop, id: stopId(currentDayId, index) })),
        legs: day.legs.slice(0, day.stops.length - 1).map((leg, index) => ({
          ...leg,
          from: stopId(currentDayId, index),
          to: stopId(currentDayId, index + 1),
        })),
      };
    }),
  })),
]);

export function isSharedTripExpired(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

type InputStop = z.infer<typeof InputStopSchema>;
type InputLeg = z.infer<typeof InputLegSchema>;
type InputAnchor = z.infer<typeof AnchorSchema>;
type Coordinate = z.infer<typeof coordinate>;

function positionOf(stop: InputStop) {
  return stop.location ?? (stop.lat !== undefined && stop.lng !== undefined ? { lat: stop.lat, lng: stop.lng } : undefined);
}

function samePosition(left: Coordinate | undefined, right: Coordinate | undefined) {
  return left && right && Math.abs(left.lat - right.lat) < 0.000001 && Math.abs(left.lng - right.lng) < 0.000001;
}

function transferStop(anchor: InputAnchor, kind: "hotel" | "other", at?: string): InputStop {
  const time = at?.slice(11) ?? "00:00";
  return { ...anchor, kind, time, endTime: time, duration: "", area: "", verified: Boolean(anchor.placeId) };
}

export function createSharedTripSnapshot(
  input: unknown,
  sharedAt = new Date().toISOString(),
  includeAccommodation = false,
): SharedTripSnapshot {
  const trip = prepareSharedTripInput(input);
  const privateStops = trip.days.flatMap((day) => day.stops.filter((stop) => stop.kind === "hotel"));
  const privateAnchors = [
    trip.accommodationAnchor,
    ...(trip.accommodationSegments?.map(({ anchor }) => anchor) ?? []),
    trip.departureTransfer?.fromHotel,
  ].filter((anchor): anchor is InputAnchor => Boolean(anchor));
  const privatePlaces = [...privateStops, ...privateAnchors];
  const privateLabels = [...new Set([
    trip.hotel,
    ...privatePlaces.flatMap((place) => [place.name, place.address, place.placeId]),
  ].filter((value): value is string => Boolean(value)))].sort((left, right) => right.length - left.length);
  const privatePlaceIds = new Set(privatePlaces.flatMap((place) => place.placeId ? [place.placeId] : []));
  const privatePositions = [...privateStops.map(positionOf), ...privateAnchors.map((anchor) => anchor.location)];
  const redact = (value: string) => includeAccommodation ? value : privateLabels.reduce((text, privateLabel) =>
    text.split(privateLabel).join("住宿地点"), value);
  const redactOptional = (value?: string) => value === undefined ? undefined : redact(value);

  function isPrivateStop(stop: InputStop) {
    return !includeAccommodation && (
      stop.kind === "hotel"
      || Boolean(stop.placeId && privatePlaceIds.has(stop.placeId))
      || Boolean(!stop.verified && privatePositions.some((position) => samePosition(position, positionOf(stop))))
    );
  }

  function projectStop(stop: InputStop, publicId: string): SharedTripStop {
    if (isPrivateStop(stop)) {
      return {
        id: publicId, name: privateAccommodationName, kind: "hotel", area: "",
        time: stop.time, endTime: stop.endTime, duration: redact(stop.duration), verified: false,
      };
    }
    return {
      id: publicId,
      name: redact(stop.name),
      area: redact(stop.area),
      time: stop.time,
      endTime: stop.endTime,
      duration: redact(stop.duration),
      kind: stop.kind,
      categoryLabel: redactOptional(stop.categoryLabel),
      verified: stop.verified,
      description: redactOptional(stop.description),
      note: redactOptional(stop.note),
      warning: redactOptional(stop.warning),
      durationReason: redactOptional(stop.durationReason),
      sceneRole: stop.sceneRole,
      placeId: stop.placeId,
      aiAdvice: stop.aiAdvice && { pros: redact(stop.aiAdvice.pros), cons: redact(stop.aiAdvice.cons) },
      // The coordinate belongs to the plan only when the user explicitly placed it.
      location: !stop.verified && !stop.placeId && stop.id?.startsWith("manual-") ? positionOf(stop) : undefined,
    };
  }

  function projectLeg(leg: InputLeg, from: string, to: string): SharedTripLeg {
    return {
      from, to, mode: leg.mode, minutes: leg.minutes, timeSource: leg.timeSource,
      // Google geometry and distance are obtained at display time, outside the snapshot.
      distance: trip.source === "live" || leg.provider === "google" || leg.timeSource === "google"
        ? undefined
        : redactOptional(leg.distance),
    };
  }

  const transfer = trip.departureTransfer;
  let departureTransfer: SharedTripSnapshot["departureTransfer"];
  if (transfer) {
    const fromHotel = projectStop(transferStop(transfer.fromHotel, "hotel", transfer.leaveHotelAt), "transfer-hotel");
    const toAirport = projectStop(transferStop(transfer.toAirport, "other", transfer.airportCutoffAt), "transfer-airport");
    departureTransfer = {
      date: transfer.date,
      departureAt: transfer.departureAt,
      airportCutoffAt: transfer.airportCutoffAt,
      airportLeadMinutes: transfer.airportLeadMinutes,
      note: includeAccommodation ? transfer.note : "住宿位置与赴机场路线已隐藏，请按机场截止时间预留交通。",
      fromHotel: includeAccommodation ? fromHotel : { ...fromHotel, time: "00:00", endTime: "00:00" },
      toAirport,
      leaveHotelAt: includeAccommodation ? transfer.leaveHotelAt : undefined,
      arriveAirportAt: includeAccommodation ? transfer.arriveAirportAt : undefined,
      leg: includeAccommodation ? projectLeg(transfer.leg, fromHotel.id, toAirport.id) : undefined,
    };
  }

  return ShareV2Schema.parse({
    version: 2,
    includeAccommodation,
    title: redact(trip.title),
    destination: trip.destination,
    dateRange: trip.dateRange,
    timezone: trip.timezone,
    pace: redact(trip.pace),
    people: trip.people,
    sharedAt,
    generatedAt: trip.generatedAt,
    warnings: trip.warnings?.map(redact),
    days: trip.days.map((day, dayIndex) => {
      const currentDayId = dayId(dayIndex);
      const stops = day.stops.map((stop, index) => projectStop(stop, stopId(currentDayId, index)));
      const sourceIds = new Map(day.stops.flatMap((stop, index) => stop.id ? [[stop.id, index]] : []));
      const legs = day.legs.flatMap((leg, index) => {
        const from = leg.from ? sourceIds.get(leg.from) : index;
        const to = leg.to ? sourceIds.get(leg.to) : index + 1;
        if (from === undefined || to === undefined || !stops[from] || !stops[to]) return [];
        if (isPrivateStop(day.stops[from]) || isPrivateStop(day.stops[to])) return [];
        return [projectLeg(leg, stops[from].id, stops[to].id)];
      });
      return {
        id: currentDayId,
        label: day.label,
        date: day.date,
        weekday: day.weekday,
        theme: redact(day.theme),
        color: day.color ?? dayColor(dayIndex),
        summary: redact(day.summary),
        returnBy: day.returnBy,
        terminalKind: day.terminalKind,
        overtimeAcceptance: day.overtimeAcceptance,
        stops,
        legs,
      };
    }),
    accommodationSegments: includeAccommodation ? trip.accommodationSegments?.flatMap((segment) => {
      const startDayId = segment.startDayId;
      return startDayId && /^day-[1-7]$/.test(startDayId)
        ? [{ startDayId, name: segment.anchor.name, placeId: segment.anchor.placeId }]
        : [];
    }) : undefined,
    departureTransfer,
  });
}
