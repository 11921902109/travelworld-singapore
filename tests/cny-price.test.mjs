import assert from "node:assert/strict";
import { test } from "node:test";
import { cnyPriceLabel, cnyReferenceLabel, CNY_PRICE_UNVERIFIED, foreignBudgetNotice } from "../lib/travel/cny-price.ts";
import { assessHotelBudget } from "../lib/travel/hotel-budget.ts";

test("CNY presentation uses the numeric amount and preserves the actual unit", () => {
  const price = { amount: 244.98, currency: "CNY", display: "S$99999", unit: "成人票参考" };
  assert.equal(cnyPriceLabel(price), "¥244.98");
  assert.equal(cnyReferenceLabel(price), "¥244.98 · 成人票参考");
});

test("foreign, unknown and invalid prices cannot acquire a RMB label from display text", () => {
  for (const price of [null, { amount: 250, currency: "SGD", display: "¥250" }, { amount: 250, display: "¥250" }, { amount: NaN, currency: "CNY" }, { amount: 0, currency: "CNY" }]) {
    assert.equal(cnyPriceLabel(price), null);
    assert.equal(cnyReferenceLabel(price), CNY_PRICE_UNVERIFIED);
  }
});

test("old foreign budgets remain evidence and cannot be compared as yuan", () => {
  const budget = { amount: 250, currency: "SGD" };
  const before = structuredClone(budget);
  assert.match(foreignBudgetNotice(budget), /250 SGD.*重新填写人民币/);
  assert.equal(assessHotelBudget(budget, { kind: "hotel", status: "available", price: { amount: 200, currency: "SGD", unit: "每晚起" } }).status, "currency_uncomparable");
  assert.deepEqual(budget, before);
  assert.equal(foreignBudgetNotice({ amount: 1200, currency: "CNY" }), null);
});
