import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_SINGAPORE_TRAVEL_INTENT, parseSingaporeIntentResult } from "../lib/travel/singapore-intent.ts";
import { updateIntentSlotMeta } from "../lib/travel/intent-slot-meta.ts";

function model(patches) {
  return JSON.stringify({ purpose: "update_intent", patches, unresolvedMentions: [], acknowledgement: "已记录。" });
}

function patch(field, op, value, evidenceText) {
  return { field, op, value, evidenceText, certainty: "explicit" };
}

function input(message, currentIntent) {
  return { message, currentIntent, currentOutline: [], conversationHistory: [] };
}

test("更换住宿区域时记录明确变更和依赖清除的来源", () => {
  const previous = {
    ...EMPTY_SINGAPORE_TRAVEL_INTENT,
    accommodation: { areaName: "Bugis", hotelName: "Village Hotel Bugis", googlePlaceId: "old-place-id" },
  };
  const request = input("我不住 Bugis 了，改住 Orchard。", previous);
  const result = parseSingaporeIntentResult(model([
    patch("accommodation.areaName", "set", "Orchard", "改住 Orchard"),
  ]), request, "2026-10-25");
  const meta = updateIntentSlotMeta({
    previous: {}, before: previous, result, turnId: "turn-0001", source: "bailian",
    message: request.message, updatedAt: "2026-10-25T00:00:00.000Z",
  });
  assert.deepEqual(meta["accommodation.areaName"], {
    source: "bailian", evidence: "改住 Orchard", turnId: "turn-0001",
    status: "confirmed", updatedAt: "2026-10-25T00:00:00.000Z",
  });
  assert.equal(meta["accommodation.hotelName"].source, "derived");
  assert.equal(meta["accommodation.hotelName"].status, "cleared");
  assert.equal(meta["accommodation.googlePlaceId"].status, "cleared");
});

test("明确设置 false 是已确认值，未变化槽位保留原来源", () => {
  const previous = { ...EMPTY_SINGAPORE_TRAVEL_INTENT, allowAutomaticRecommendations: true };
  const request = input("不要自动推荐。", previous);
  const result = parseSingaporeIntentResult(model([
    patch("allowAutomaticRecommendations", "set", false, "不要自动推荐"),
  ]), request, "2026-10-25");
  const oldMeta = {
    "accommodation.areaName": {
      source: "code", evidence: "住 Bugis", turnId: "turn-old", status: "confirmed",
      updatedAt: "2026-10-24T00:00:00.000Z",
    },
  };
  const meta = updateIntentSlotMeta({
    previous: oldMeta, before: previous, result, turnId: "turn-0002", source: "bailian",
    message: request.message, updatedAt: "2026-10-25T00:00:00.000Z",
  });
  assert.equal(meta.allowAutomaticRecommendations.status, "confirmed");
  assert.equal(meta.allowAutomaticRecommendations.evidence, "不要自动推荐");
  assert.deepEqual(meta["accommodation.areaName"], oldMeta["accommodation.areaName"]);
});
