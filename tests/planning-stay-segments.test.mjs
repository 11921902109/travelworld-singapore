import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileStaySegments } from "../lib/travel/planning-stay-segments.ts";

const previous = [{ id: "original", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23",
  nights: 3, budgetPerNight: { amount: 250, currency: "SGD" }, hotel: { placeId: "hotel-a" },
  hotelCandidates: [{ placeId: "hotel-a", commerce: { price: 200 } }] }];
const config = (patch = {}) => ({ id: "stay-day-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20",
  checkOutDate: "2026-12-23", nights: 3, budgetPerNight: { amount: 250, currency: "SGD" }, ...patch });

test("identical lodging save retains selected hotel, quote, identity and confirmed timing", () => {
  const result = reconcileStaySegments(previous, [config({ area: "  BUGIS " })]);
  assert.equal(result.unchanged, true);
  assert.equal(result.segments, previous);
  assert.equal(result.timingChanged, false);
  assert.deepEqual(result.invalidatedHotelSegments, []);
});

test("budget-only change retains hotel and quotes while requesting a budget review", () => {
  const result = reconcileStaySegments(previous, [config({ budgetPerNight: { amount: 300, currency: "SGD" } })]);
  assert.equal(result.unchanged, false);
  assert.equal(result.timingChanged, false);
  assert.equal(result.segments[0].hotel.placeId, "hotel-a");
  assert.equal(result.segments[0].id, "original");
  assert.equal(result.segments[0].budgetReviewRequired, true);
  assert.deepEqual(result.budgetReviewSegments, [1]);
  assert.deepEqual(result.invalidatedHotelSegments, []);
});

test("date or area changes clear old hotel selection and explain exactly which segment changed", () => {
  for (const patch of [{ area: "Marina Bay" }, { checkOutDate: "2026-12-24", nights: 4 }]) {
    const result = reconcileStaySegments(previous, [config(patch)]);
    assert.equal(result.timingChanged, true);
    assert.equal(result.segments[0].hotel, undefined);
    assert.equal(result.segments[0].hotelCandidates, undefined);
    assert.deepEqual(result.invalidatedHotelSegments, [1]);
  }
});

test("adding another stay clears dates that changed but preserves a compatible later stay", () => {
  const old = [...previous, { ...config({ id: "later", startDay: 3, area: "Sentosa", checkInDate: "2026-12-22", checkOutDate: "2026-12-24" }), hotel: { placeId: "hotel-b" } }];
  old[0] = { ...old[0], checkOutDate: "2026-12-22" };
  const result = reconcileStaySegments(old, [config({ checkOutDate: "2026-12-21" }), config({ startDay: 2, area: "City Hall", checkInDate: "2026-12-21", checkOutDate: "2026-12-22" }), config({ startDay: 3, area: "Sentosa", checkInDate: "2026-12-22", checkOutDate: "2026-12-24" })]);
  assert.equal(result.segments[2].hotel.placeId, "hotel-b");
  assert.deepEqual(result.invalidatedHotelSegments, [1]);
});
