import assert from "node:assert/strict";
import { test } from "node:test";
import { assessHotelBudget, hotelBudgetGroups, hotelBudgetAcknowledgementKey } from "../lib/travel/hotel-budget.ts";

const budget = { amount: 250, currency: "CNY" };
const quote = (amount = 200, currency = "CNY", unit = "每晚起") => ({ kind: "hotel", status: "available", price: { amount, currency, unit } });

test("nightly budget is an upper bound, including cheaper and equal prices", () => {
  assert.equal(assessHotelBudget(budget, quote(200)).status, "within_budget");
  assert.equal(assessHotelBudget(budget, quote(250)).status, "within_budget");
  assert.deepEqual(assessHotelBudget(budget, quote(300.5)), { status: "over_budget", difference: 50.5, message: "参考每晚起价超出上限 ¥50.5" });
});

test("different currencies cannot be compared numerically", () => {
  assert.equal(assessHotelBudget({ amount: 250, currency: "SGD" }, quote(200)).status, "currency_uncomparable");
});

test("unknown price and non-nightly price are unknown, never over budget or unavailable stock", () => {
  for (const commerce of [null, { status: "unavailable" }, quote(0), quote(500, "CNY", "全程总价"), quote(300, "CNY", "每人每晚"), { ...quote(300), price: { ...quote(300).price, unit: undefined } }]) {
    assert.equal(assessHotelBudget(budget, commerce).status, "price_unknown");
  }
});

test("no-budget results stay in the main list", () => {
  const candidates = [{ placeId: "a", commerce: quote() }, { placeId: "b", commerce: null }];
  assert.equal(hotelBudgetGroups(null, candidates).primary.length, 2);
  assert.equal(hotelBudgetGroups(null, candidates).alternatives.length, 0);
});

test("within-budget results are primary; unavailable and excess-price alternatives remain explicit", () => {
  const candidates = [{ placeId: "a", commerce: quote(250) }, { placeId: "b", commerce: quote(350) }, { placeId: "c", commerce: null }];
  const groups = hotelBudgetGroups(budget, candidates);
  assert.deepEqual(groups.primary.map(({ hotel }) => hotel.placeId), ["a"]);
  assert.deepEqual(groups.alternatives.map(({ hotel }) => hotel.placeId), ["b", "c"]);
  assert.equal(groups.overBudgetCount, 1);
  assert.equal(groups.unknownCount, 1);
});

test("over-budget acknowledgement expires if budget, dates, price or hotel changes", () => {
  const segment = { budgetPerNight: budget, checkInDate: "2026-12-20", checkOutDate: "2026-12-23" };
  const candidate = { placeId: "a", commerce: quote(300) };
  const key = hotelBudgetAcknowledgementKey(segment, candidate);
  for (const [nextSegment, nextCandidate] of [
    [{ ...segment, budgetPerNight: { ...budget, amount: 200 } }, candidate],
    [{ ...segment, checkOutDate: "2026-12-24" }, candidate],
    [segment, { ...candidate, commerce: quote(310) }],
    [segment, { ...candidate, placeId: "b" }],
  ]) assert.notEqual(hotelBudgetAcknowledgementKey(nextSegment, nextCandidate), key);
});
