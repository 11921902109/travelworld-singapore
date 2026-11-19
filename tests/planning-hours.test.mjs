import assert from "node:assert/strict";
import test from "node:test";
import { assessRegularOpeningHours, planRegularVisit, regularOpeningHoursLabel } from "../lib/travel/planning-hours.ts";

const assess = (weekdayDescriptions, visitDate, startTime, endTime) =>
  assessRegularOpeningHours({ weekdayDescriptions, visitDate, startTime, endTime });

test("regular hours cover the entire scheduled visit", () => {
  const hours = ["Sunday: 9:00 AM–5:00 PM"];
  assert.equal(assess(hours, "2026-10-25", "09:30", "11:00").status, "open");
  assert.equal(assess(hours, "2026-10-25", "16:00", "18:00").status, "closed");
});

test("a known closed day blocks the visit", () => {
  assert.equal(assess(["Sunday: Closed"], "2026-10-25", "10:00", "12:00").status, "closed");
});

test("previous-day overnight hours are accepted", () => {
  const hours = ["Saturday: 6:00 PM–2:00 AM", "Sunday: Closed"];
  assert.equal(assess(hours, "2026-10-25", "00:30", "01:30").status, "open");
});

test("Chinese hours and unknown hours are handled conservatively", () => {
  assert.equal(assess(["星期日：上午9:00–下午6:00"], "2026-10-25", "10:00", "11:00").status, "open");
  assert.equal(assess([], "2026-10-25", "10:00", "11:00").status, "unknown");
  assert.equal(assess(["Sunday: 9:00 AM–5:00 PM, hours vary"], "2026-10-25", "18:00", "19:00").status, "unknown");
});

test("early arrival waits for the gallery to open instead of rejecting the day", () => {
  const hours = ["Monday: 10:00 AM–7:00 PM"];
  const plan = planRegularVisit({ weekdayDescriptions: hours, visitDate: "2026-12-21", arrivalMinute: 9 * 60 + 42, durationMinutes: 120, preferredPeriod: "morning" });
  assert.equal(plan.status, "scheduled");
  assert.equal(plan.startMinute, 10 * 60);
  assert.equal(plan.waitMinutes, 18);
  assert.equal(regularOpeningHoursLabel(hours, "2026-12-21"), "10:00 AM-7:00 PM");
});

test("requested afternoon and impossible opening windows are kept distinct", () => {
  const hours = ["Monday: 10:00 AM–1:00 PM"];
  const afternoon = planRegularVisit({ weekdayDescriptions: hours, visitDate: "2026-12-21", arrivalMinute: 10 * 60, durationMinutes: 60, preferredPeriod: "afternoon" });
  assert.equal(afternoon.status, "scheduled");
  assert.equal(afternoon.startMinute, 12 * 60);
  const impossible = planRegularVisit({ weekdayDescriptions: hours, visitDate: "2026-12-21", arrivalMinute: 12 * 60 + 30, durationMinutes: 90, preferredPeriod: "afternoon" });
  assert.equal(impossible.status, "closed");
  assert.equal(impossible.failure.reasonCode, "arrival_too_late");
  assert.equal(impossible.failure.effectivePeriod, "afternoon");
  assert.equal(impossible.failure.missingMinutes, 60);
});

test("unknown regular hours remain a warning, not a false closed result", () => {
  const plan = planRegularVisit({ weekdayDescriptions: [], visitDate: "2026-12-21", arrivalMinute: 9 * 60 + 42, durationMinutes: 120 });
  assert.equal(plan.status, "unknown");
  assert.equal(plan.startMinute, 9 * 60 + 42);
});

test("cross-midnight closing retains real 02:00 while the day cutoff remains a separate boundary", () => {
  const plan = planRegularVisit({ weekdayDescriptions: ['Sunday: 5:00 AM–2:00 AM'], visitDate: '2026-12-20', arrivalMinute: 23 * 60 + 17, durationMinutes: 180 });
  assert.equal(plan.status, 'closed'); assert.equal(plan.failure.closingMinute, 1560);
  assert.equal(plan.failure.actualClosingMinute, 1560); assert.equal(plan.failure.planningCutoffMinute, 1440);
  assert.equal(plan.failure.limitingBoundary, 'planning_day'); assert.equal(plan.failure.missingMinutes, 137);
  assert.match(plan.reason, /当天核算上限/); assert.match(plan.reason, /不代表场馆在午夜闭馆/);
  const lateOpening = planRegularVisit({ weekdayDescriptions: ['Sunday: 11:00 PM–2:00 AM'], visitDate: '2026-12-20', arrivalMinute: 10 * 60, durationMinutes: 120 });
  assert.equal(lateOpening.failure.limitingBoundary, 'planning_day');
});
