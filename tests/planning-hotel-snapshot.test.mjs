import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedHotelAnchor, hotelIdentityContextKey } from "../lib/travel/planning-hotel-snapshot.ts";

const now = Date.parse("2026-11-04T01:00:00Z");
const segment = { id: "stay-1", area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23" };
const contextKey = hotelIdentityContextKey("handoff-1", segment);
const snapshot = { placeId: "hotel-id-a", name: "Hotel A", address: "1 Test Road", location: { lat: 1.3, lng: 103.85 }, kind: "hotel", source: "google_places", verifiedAt: new Date(now).toISOString(), contextKey };

test("a current server snapshot provides an anchor without another Google call", () => {
  const result = verifiedHotelAnchor(snapshot, "hotel-id-a", contextKey, now);
  assert.equal(result.userConfirmed, true);
  assert.equal(result.name, snapshot.name);
  assert.deepEqual(result.location, snapshot.location);
});

test("missing, expired, mismatched or outside-Singapore snapshots require fresh details", () => {
  for (const candidate of [undefined, { ...snapshot, verifiedAt: new Date(now - 16 * 60_000).toISOString() }, { ...snapshot, location: { lat: 20, lng: 103.85 } }, { ...snapshot, contextKey: "other" }, { ...snapshot, source: "client" }]) {
    assert.equal(verifiedHotelAnchor(candidate, "hotel-id-a", contextKey, now), null);
  }
  assert.notEqual(hotelIdentityContextKey("handoff-1", { ...segment, checkOutDate: "2026-12-24" }), contextKey);
});
