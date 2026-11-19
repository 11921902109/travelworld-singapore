import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";
import { distributeTravelMinutes, PlanningTimeOverrideSchema } from "../lib/travel/planning-time-overrides.ts";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, resolve: { alias: { "@": process.cwd(), "cloudflare:workers": path.join(process.cwd(), "tests/fixtures/flight-agent-env.ts") } }, optimizeDeps: { noDiscovery: true }, logLevel: "error" });
after(() => vite.close());
const { schedulePlanningDay } = await vite.ssrLoadModule("/lib/travel/planning-scheduler.ts");
const { planningEditImpact } = await vite.ssrLoadModule("/lib/travel/planning-review.ts");
const location = { lat: 1.3, lng: 103.85 };
const stop = (id, kind) => ({ id, placeId: id, name: id, kind, verified: true, location, time: "00:00", endTime: "00:00", openingHours: [], note: "", area: "", x: 0, y: 0, duration: "" });
const stops = [stop("hotel", "hotel"), stop("one", "sight"), stop("two", "sight"), stop("hotel", "hotel")];
const routes = [10, 20, 30].map((minutes) => ({ mode: "drive", distanceMeters: 1000, distanceText: "1km", durationSeconds: minutes * 60, durationMinutes: minutes, durationText: `${minutes}m`, encodedPolyline: "" }));
const reference = { fingerprint: JSON.stringify(routes.map(() => [location, location, "taxi"])), routes, queriedAt: "2026-11-03T00:00:00Z" };
const base = { day: { id: "day-1", label: "Day 1", date: "12/20", weekday: "周日", theme: "", summary: "", color: "", stops: [], legs: [] }, orderedStops: stops, startTime: "09:30", returnBy: "21:00", requestedVisitMinutes: { one: 120, two: 120 }, routeReference: reference, mealReserveMinutes: 90, bufferReserveMinutes: 30, personalMinutes: 0 };

test("a daily travel total is allocated exactly once, with source and original reference retained", async () => {
  assert.equal(distributeTravelMinutes(65, [18, 28, 38]).reduce((a, b) => a + b, 0), 65);
  const result = await schedulePlanningDay({ ...base, travelTotalMinutes: 65 });
  assert.equal(result.metrics.travelMinutes, 65);
  assert.equal(result.metrics.pickupMinutes, 0);
  assert.equal(result.metrics.referenceTravelMinutes, 84);
  assert.equal(result.day.legs.reduce((sum, leg) => sum + leg.minutes, 0), 65);
  assert.ok(result.day.legs.every((leg) => leg.timeSource === "user"));
  assert.equal(result.metrics.freeMinutes, 690 - 240 - 90 - 30 - 65);
});

test("changing a visit by 30 minutes reuses route evidence and reduces free time by 30", async () => {
  const before = await schedulePlanningDay(base);
  const after = await schedulePlanningDay({ ...base, requestedVisitMinutes: { one: 150, two: 120 } });
  assert.equal(before.metrics.freeMinutes - after.metrics.freeMinutes, 30);
  assert.equal(after.routeReference.queriedAt, reference.queriedAt);
});

test("overtime remains explicit, and rest days also account for user reserves", async () => {
  const result = await schedulePlanningDay({ ...base, returnBy: "12:00", travelTotalMinutes: 65 });
  assert.equal(result.metrics.freeMinutes, 0);
  assert.equal(result.metrics.overtimeMinutes, 240 + 90 + 30 + 65 - 150);
  const rest = await schedulePlanningDay({ ...base, orderedStops: [stops[0], stops[3]], personalMinutes: 60, travelTotalMinutes: 30 });
  assert.equal(rest.metrics.freeMinutes, 690 - 60 - 30 - 90 - 30);
});

test("invalid return windows are rejected rather than inheriting an invisible later deadline", () => {
  assert.equal(PlanningTimeOverrideSchema.safeParse({ day: 1, dailyWindow: { start: "09:30", preferredReturn: "21:00", latestReturn: "20:00" } }).success, false);
  assert.equal(PlanningTimeOverrideSchema.safeParse({ day: 1, travelTotalMinutes: -1 }).success, false);
  assert.equal(PlanningTimeOverrideSchema.safeParse({ day: 1, dailyWindow: { start: "00:00", preferredReturn: "23:00", latestReturn: "23:59" } }).success, false);
});

test("review impact names only existing downstream work", () => {
  assert.deepEqual(planningEditImpact({ boardConfirmed: true }, "day_allocation"), []);
  assert.deepEqual(planningEditImpact({ boardConfirmed: true, flightSelection: { mode: "none" } }, "day_allocation"), ["已有航班安排保留为待复核"]);
  assert.ok(!planningEditImpact({ boardConfirmed: true, flightSearchJob: { status: "running" } }, "day_allocation").join().includes("住宿"));
});
