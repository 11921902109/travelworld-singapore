import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";
import {
  createSharedTripSnapshot,
  prepareSharedTripInput,
  SharedTripSnapshotSchema,
} from "../lib/travel/shared-trip.ts";

const timestamp = "2026-11-09T07:00:00.000Z";
const privateHotel = {
  name: "测试私密酒店",
  address: "私密街道 88 号",
  placeId: "private-hotel-place-id",
  location: { lat: 1.281123, lng: 103.882123 },
};
const airport = {
  name: "新加坡樟宜机场",
  placeId: "changi-airport-place-id",
  location: { lat: 1.364, lng: 103.991 },
};
const sight = {
  id: "temple",
  name: "维拉马卡里拉曼庙",
  placeId: "temple-place-id",
  area: "小印度",
  time: "16:00",
  endTime: "16:45",
  duration: "45 分钟",
  kind: "sight",
  verified: true,
  description: "建筑与节庆体验",
  location: { lat: 1.305, lng: 103.852 },
  aiAdvice: { pros: "可参观彩绘塔楼", cons: "进入时注意礼仪" },
  openingHours: ["RAW-OPENING-HOURS"],
  rating: 4.2,
  googleMapsUri: "https://maps.example/RAW-GOOGLE-URL",
  commerce: { bookingUrl: "https://supplier.example/RAW-BOOKING-URL" },
};
const route = (from, to, minutes) => ({
  from,
  to,
  mode: "taxi",
  minutes,
  distance: "RAW-GOOGLE-DISTANCE",
  provider: "google",
  timeSource: "google",
  encodedPolyline: "RAW-ROUTE-POLYLINE",
});

function itinerary() {
  const firstDay = {
    label: "Day 1",
    date: "12/20",
    weekday: "周日",
    theme: "小印度",
    color: "#f16449",
    summary: `抵达后前往${privateHotel.name}`,
    returnBy: "21:00",
    terminalKind: "hotel",
    overtimeAcceptance: {
      minutes: 195,
      acceptedAt: timestamp,
      deadline: "21:00",
      estimatedArrival: "24:15",
    },
    stops: [
      { id: "airport", ...airport, area: "樟宜", time: "15:00", endTime: "15:00", duration: "抵达", kind: "other", verified: true },
      sight,
      { id: "manual-user-point", name: "自选观景位置", area: "自定义位置", time: "17:00", endTime: "17:30", duration: "30 分钟", kind: "other", verified: false, location: { lat: 1.31, lng: 103.87 } },
      { id: "manual-hotel-duplicate", name: "接送点", area: "自定义位置", time: "23:50", endTime: "24:00", duration: "10 分钟", kind: "other", verified: false, location: privateHotel.location },
      { id: "arrival-private-hotel-place-id", ...privateHotel, area: "明古连", time: "24:15", endTime: "24:15", duration: "返回", kind: "hotel", verified: true },
    ],
    legs: [
      route("airport", "temple", 30),
      { ...route("temple", "manual-user-point", 15), timeSource: "user" },
      route("manual-user-point", "manual-hotel-duplicate", 12),
      route("manual-hotel-duplicate", "arrival-private-hotel-place-id", 5),
    ],
  };
  return {
    title: "新加坡周末",
    destination: "新加坡",
    dateRange: "12/20",
    timezone: "Asia/Singapore",
    pace: "轻松",
    people: 2,
    hotel: privateHotel.name,
    accommodationAnchor: privateHotel,
    accommodationSegments: [{ startDayId: "day-1", anchor: privateHotel }],
    source: "live",
    warnings: [`预计返回 ${privateHotel.name}，${privateHotel.address}。`],
    departureTransfer: {
      date: "2026-12-21",
      departureAt: "2026-12-21T08:00",
      leaveHotelAt: "2026-12-21T04:15",
      arriveAirportAt: "2026-12-21T04:45",
      airportCutoffAt: "2026-12-21T05:00",
      airportLeadMinutes: 180,
      fromHotel: privateHotel,
      toAirport: airport,
      leg: route("departure-hotel", "departure-airport", 30),
      note: `从 ${privateHotel.name} 赴机场。`,
    },
    days: [firstDay],
  };
}

test("V27 airport and manual stops, accepted midnight return, and same-place AI advice can be shared", () => {
  const snapshot = createSharedTripSnapshot(itinerary(), timestamp, true);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.includeAccommodation, true);
  const day = snapshot.days[0];
  assert.equal(day.stops[0].kind, "other");
  assert.equal(day.stops[0].placeId, airport.placeId);
  assert.equal(day.stops.at(-1).time, "24:15");
  assert.equal(day.overtimeAcceptance.estimatedArrival, "24:15");
  assert.deepEqual(day.stops[1].aiAdvice, sight.aiAdvice);
  assert.deepEqual(day.stops[2].location, { lat: 1.31, lng: 103.87 });
  assert.equal(day.legs[1].timeSource, "user");
  assert.equal(day.legs[1].from, day.stops[1].id);
  assert.equal(day.legs[1].to, day.stops[2].id);
  assert.equal(snapshot.accommodationSegments[0].name, privateHotel.name);
  assert.equal(snapshot.departureTransfer.fromHotel.placeId, privateHotel.placeId);
  assert.equal(snapshot.departureTransfer.leg.minutes, 30);
  assert.deepEqual(SharedTripSnapshotSchema.parse(snapshot), snapshot);
});

test("hotel protection drops affected legs and scrubbed transfer geometry including a co-located manual marker", () => {
  const snapshot = createSharedTripSnapshot(itinerary(), timestamp);
  assert.equal(snapshot.includeAccommodation, false);
  assert.equal(snapshot.accommodationSegments, undefined);
  const { stops, legs } = snapshot.days[0];
  assert.equal(stops.length, 5);
  assert.equal(stops[3].kind, "hotel");
  assert.equal(stops[4].kind, "hotel");
  assert.equal(legs.length, 2);
  assert.ok(legs.every((leg) => ![stops[3].id, stops[4].id].includes(leg.from) && ![stops[3].id, stops[4].id].includes(leg.to)));
  assert.equal(snapshot.departureTransfer.toAirport.placeId, airport.placeId);
  assert.equal(snapshot.departureTransfer.departureAt, "2026-12-21T08:00");
  assert.equal(snapshot.departureTransfer.fromHotel.placeId, undefined);
  assert.equal(snapshot.departureTransfer.leaveHotelAt, undefined);
  assert.equal(snapshot.departureTransfer.arriveAirportAt, undefined);
  assert.equal(snapshot.departureTransfer.leg, undefined);
  const json = JSON.stringify(snapshot);
  for (const secret of [privateHotel.name, privateHotel.placeId, privateHotel.address, "1.281123", "103.882123", "2026-12-21T04:15", "2026-12-21T04:45"]) {
    assert.ok(!json.includes(secret), `private value survived: ${secret}`);
  }
});

test("both projections store plan content and public place IDs while excluding raw provider fields", () => {
  const trip = itinerary();
  for (const includeAccommodation of [false, true]) {
    const snapshot = createSharedTripSnapshot(trip, timestamp, includeAccommodation);
    const json = JSON.stringify(snapshot);
    assert.ok(!json.includes("RAW-"));
    assert.ok(!json.includes('"encodedPolyline"'));
    assert.ok(!json.includes('"distance"'));
    assert.ok(!json.includes('"address"'));
    assert.ok(!json.includes('"rating"'));
    assert.ok(!json.includes("1.305"));
    assert.equal(snapshot.days[0].stops[1].placeId, sight.placeId);
    assert.deepEqual(snapshot.days[0].stops[1].aiAdvice, sight.aiAdvice);
    assert.deepEqual(createSharedTripSnapshot(prepareSharedTripInput(trip), timestamp, includeAccommodation), snapshot);
  }
});

test("historical textual snapshots normalize to stable public IDs and still show their summaries", () => {
  const oldStop = { name: "住宿地点（分享中已隐藏）", area: "", time: "09:00", endTime: "09:00", duration: "出发", kind: "hotel", verified: true };
  const oldSnapshot = {
    title: "旧分享",
    destination: "新加坡",
    dateRange: "12/20",
    timezone: "Asia/Singapore",
    pace: "轻松",
    people: 1,
    sharedAt: timestamp,
    days: [{
      label: "Day 1", date: "12/20", weekday: "周日", theme: "散步", summary: "旧版摘要",
      stops: [oldStop, { ...oldStop, name: "散步地点", kind: "sight" }],
      legs: [{ mode: "walk", minutes: 12, distance: "0.8 km" }],
    }],
  };
  const normalized = SharedTripSnapshotSchema.parse(oldSnapshot);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.includeAccommodation, false);
  const day = normalized.days[0];
  assert.equal(day.summary, "旧版摘要");
  assert.equal(day.legs[0].from, day.stops[0].id);
  assert.equal(day.legs[0].to, day.stops[1].id);
  assert.equal(day.legs[0].distance, "0.8 km");
  assert.equal(day.stops[1].placeId, undefined);
  assert.equal(SharedTripSnapshotSchema.safeParse({ ...oldSnapshot, version: 2 }).success, false);
});

const mocks = {
  "@/db": 'export function getDb() {return {insert: () => ({values: async value => globalThis.__shareWrites.push(value)})};}',
  "@/db/schema": "export const travelSharedTrips = {};",
  "@/lib/travel/api-guard": "export function guardSingaporeApi(_request, options) {globalThis.__shareBuckets.push(options.bucket);return null;}",
  "next/server": "export const NextResponse = {json: (body, options) => Response.json(body, options)};",
};
const mockPrefix = "\0share-test:";
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
  resolve: { alias: [
    ...Object.keys(mocks).map((find) => ({ find, replacement: mockPrefix + find })),
    { find: "@", replacement: process.cwd() },
  ] },
  plugins: [{
    name: "share-test",
    enforce: "pre",
    resolveId(source) {
      if (source.startsWith(mockPrefix)) return source;
      const key = Object.keys(mocks).find((key) => source === key || (key.startsWith("@/") && source === path.join(process.cwd(), key.slice(2))));
      return key ? mockPrefix + key : null;
    },
    load(source) {
      return source.startsWith(mockPrefix) ? mocks[source.slice(mockPrefix.length)] : null;
    },
  }],
});
after(() => vite.close());
const { POST } = await vite.ssrLoadModule("/app/api/travel/share/route.ts");

function share(body, preview = false) {
  const url = new URL(preview ? "https://local.test/api/travel/share?preview=1" : "https://local.test/api/travel/share");
  const request = new Request(url, { method: "POST", body: JSON.stringify(body) });
  return POST(Object.assign(request, { nextUrl: url }));
}

test("actual share API preview has no insert, save persists matching scope, and forged scope is rejected", async () => {
  globalThis.__shareWrites = [];
  globalThis.__shareBuckets = [];
  const trip = itinerary();
  const preview = await share({ trip }, true);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(globalThis.__shareWrites, []);
  const { snapshot: previewed } = await preview.json();
  const save = await share({ trip });
  assert.equal(save.status, 200);
  const { url, expiresAt, snapshot } = await save.json();
  assert.match(url, /^https:\/\/local\.test\/travel\/shared\/[a-f0-9]{32}$/);
  assert.equal(globalThis.__shareWrites.length, 1);
  assert.deepEqual(JSON.parse(globalThis.__shareWrites[0].snapshotJson), snapshot);
  assert.equal(Date.parse(expiresAt) - Date.parse(snapshot.sharedAt), 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual({ ...previewed, sharedAt: snapshot.sharedAt }, snapshot);
  assert.deepEqual(globalThis.__shareBuckets, ["travel-share-preview", "travel-share"]);
  const malformed = await share({ trip, includeAccommodation: "true" });
  assert.equal(malformed.status, 400);
  assert.equal(globalThis.__shareWrites.length, 1);
});
