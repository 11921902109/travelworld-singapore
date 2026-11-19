import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "@": process.cwd(), "cloudflare:workers": path.join(process.cwd(), "tests/fixtures/flight-agent-env.ts") } },
  optimizeDeps: { noDiscovery: true }, logLevel: "error" });
after(async () => { await vite.close(); });
const { hotelJobQuery, hotelJobIsCurrent, settleHotelJob, mergeHotelQuoteResult, publicHotelJob } = await vite.ssrLoadModule("/lib/travel/planning-hotel-jobs.ts");
const { parseHotelBatchReply, hotelBatchLookupPrompt } = await vite.ssrLoadModule("/lib/travel/flyai.ts");
const { hotelQuoteJobMatchesSegment, hotelBatchWaiting } = await vite.ssrLoadModule("/lib/travel/planning-hotel-batch.ts");

const travelers = { total: 2, adults: 2, children: null, seniors: null };
const handoff = { travelers, sourceIntentStateVersion: 1 };
const segment = { id: "stay-day-1", startDay: 1, area: "Bugis", checkInDate: "2026-12-20", checkOutDate: "2026-12-23",
  hotel: { placeId: "hotel-id-a", name: "Selected A" }, budgetPerNight: { amount: 250, currency: "CNY" },
  hotelCandidates: [{ placeId: "hotel-id-a", name: "Hotel A", address: "1 Test Road", commerce: null, quoteStatus: "not_requested" },
    { placeId: "hotel-id-b", name: "Hotel B", address: "2 Test Road", commerce: null, quoteStatus: "not_requested" }] };
const draft = { version: 4, handoffId: "handoff-1", sourceIntentStateVersion: 1, stage: "stays", boardConfirmed: true,
  hotelQuoteJob: { id: "hotel-job-test-1" }, staySegments: [segment], dayEstimates: [{ day: 1 }], flightSelection: { mode: "none" } };
const created = Date.parse("2026-11-04T01:00:00Z");
function job() { return { job_id: "hotel-job-test-1", handoff_id: "handoff-1", source_intent_state_version: 1, input_hash: "testhash",
  query_json: JSON.stringify(hotelJobQuery(handoff, draft, 1, ["hotel-id-a"])), status: "running", result_json: null,
  error_code: null, created_at: created, updated_at: created, deadline_at: created + 8 * 60_000 }; }

test("single hotel quote reads server-owned dates and party; batch remains limited to saved candidates", () => {
  const query = hotelJobQuery(handoff, draft, 1, ["hotel-id-a"]);
  assert.equal(query.checkInDate, "2026-12-20");
  assert.equal(query.checkOutDate, "2026-12-23");
  assert.equal(query.travelers.total, 2);
  assert.equal(query.hotels.length, 1);
  assert.throws(() => hotelJobQuery(handoff, draft, 1, ["not-saved-place"]), /CANDIDATE_MISSING/);
  assert.equal(hotelJobQuery(handoff, draft, 1).hotels.length, 2);
});

test("a later selection/version change still accepts same-context late hotel quotes", () => {
  const changed = { ...draft, version: 9, stage: "route", staySegments: [{ ...segment, hotel: { placeId: "hotel-id-b" } }] };
  assert.equal(hotelJobIsCurrent(job(), changed, handoff), true);
  for (const patch of [{ checkOutDate: "2026-12-24" }, { area: "Sentosa" }, { hotelCandidates: [segment.hotelCandidates[1]] }]) {
    assert.equal(hotelJobIsCurrent(job(), { ...changed, staySegments: [{ ...segment, ...patch }] }, handoff), false);
  }
  assert.equal(hotelJobIsCurrent(job(), changed, { ...handoff, travelers: { ...travelers, total: 3 } }), false);
  assert.equal(hotelJobIsCurrent(job(), { ...changed, handoffId: "other" }, handoff), false);
});

test("172-second results are collected, and timeout resumes refer to the same saved job", () => {
  const row = job();
  assert.equal(settleHotelJob(row, { status: "running" }, created + 75_000).status, "running");
  const completed = settleHotelJob(row, { status: "completed", text: JSON.stringify({ results: [{ placeId: "hotel-id-a", status: "available", jumpUrl: "https://router.feizhu.com/ws/test-hotel" }] }) }, created + 172_000);
  assert.equal(completed.status, "completed");
  const quote = JSON.parse(completed.result_json)["hotel-id-a"];
  assert.equal(quote.price, undefined);
  assert.equal(quote.bookingUrl, "https://router.feizhu.com/ws/test-hotel");
  const timedOut = settleHotelJob(row, { status: "running" }, created + 481_000);
  assert.equal(timedOut.status, "timed_out");
  assert.match(publicHotelJob(timedOut).message, /同一次报价/);
});

test("malformed quote JSON is failed; supplier unavailable is explicit, not invented price", () => {
  assert.equal(settleHotelJob(job(), { status: "completed", text: "not json" }, created + 1000).status, "failed");
  const result = settleHotelJob(job(), { status: "completed", text: JSON.stringify({ results: [{ placeId: "hotel-id-a", status: "unavailable" }] }) }, created + 1000);
  assert.equal(JSON.parse(result.result_json)["hotel-id-a"].status, "unavailable");
});

test("late prices update only requested commerce and mark excess-budget selection for review", () => {
  const quote = { provider: "fliggy", kind: "hotel", status: "available", price: { amount: 300, currency: "CNY", display: "¥300", unit: "每晚起" } };
  const changes = mergeHotelQuoteResult(draft, JSON.parse(job().query_json), job().job_id, { "hotel-id-a": quote });
  const next = { ...draft, ...changes };
  assert.equal(next.staySegments[0].hotel, segment.hotel);
  assert.equal(next.staySegments[0].hotelCandidates[1], segment.hotelCandidates[1]);
  assert.equal(next.dayEstimates, draft.dayEstimates);
  assert.equal(next.flightSelection, draft.flightSelection);
  assert.equal(next.staySegments[0].budgetReviewRequired, true);
  assert.deepEqual(next.reviewRequired, ["住宿预算"]);
});

test("link aliases require a trusted supplier URL and never turn a foreign-currency amount into CNY", () => {
  const result = parseHotelBatchReply(JSON.stringify({ results: [{ placeId: "hotel-id-a", status: "available", bookingUrl: "https://untrusted.example/hotel", jumpUrl: "https://www.fliggy.com/hotel/123", price: { amount: 200, currency: "SGD", unit: "每晚起" } }] }), new Date(created).toISOString(), [segment.hotelCandidates[0]]).get("hotel-id-a");
  assert.equal(result.price.currency, "SGD");
  assert.equal(result.price.amount, 200);
  assert.doesNotMatch(result.price.display, /¥/);
  assert.equal(result.bookingUrl, "https://www.fliggy.com/hotel/123");
  assert.match(hotelBatchLookupPrompt({ hotels: [segment.hotelCandidates[0]], checkInDate: segment.checkInDate, checkOutDate: segment.checkOutDate, travelers: 2 }), /价格可空|价格.*可空|price.*省略/);
});

test("a missing currency remains unverified even when provider display text claims yuan", () => {
  const result = parseHotelBatchReply(JSON.stringify({ results: [{ placeId: "hotel-id-a", status: "available", bookingUrl: "https://router.feizhu.com/ws/hotel", price: { amount: 250, display: "¥250", unit: "每晚起" } }] }), new Date(created).toISOString(), [segment.hotelCandidates[0]]).get("hotel-id-a");
  assert.equal(result.status, "available");
  assert.equal(result.price.amount, 250);
  assert.equal(result.price.currency, "");
  assert.doesNotMatch(result.price.display, /¥/);
  assert.equal(result.bookingUrl, "https://router.feizhu.com/ws/hotel");
  const row = { ...job(), status: "completed", result_json: JSON.stringify({ "hotel-id-a": result }) };
  assert.equal(publicHotelJob(row).resultCounts.priced, 0);
  assert.equal(publicHotelJob(row).resultCounts.linkOnly, 1);
});

test("a new search with the same hotel IDs invalidates the old task and completion banner", () => {
  const first = { ...draft, staySegments: [{ ...segment, hotelSearchId: "search-first" }] };
  const row = { ...job(), query_json: JSON.stringify(hotelJobQuery(handoff, first, 1)) };
  const replacement = { ...first, staySegments: [{ ...segment, hotelSearchId: "search-next" }] };
  assert.equal(hotelJobIsCurrent(row, replacement, handoff), false);
  assert.equal(hotelQuoteJobMatchesSegment(publicHotelJob(row), replacement.staySegments[0]), false);
  assert.equal(hotelQuoteJobMatchesSegment(publicHotelJob(row), first.staySegments[0]), true);
  assert.equal(hotelQuoteJobMatchesSegment({ ...publicHotelJob(job()), status: "completed" }, segment), false,
    "v25 completion with untouched not_requested cards cannot claim this batch is done");
});

test("batch completion reports actual per-hotel outcomes without requiring every hotel to have a price", () => {
  const hotels = ["a", "b", "c", "d"].map((suffix) => ({ placeId: `hotel-id-${suffix}`, name: `Hotel ${suffix}`, address: "Singapore" }));
  const batchDraft = { ...draft, staySegments: [{ ...segment, hotelSearchId: "search-batch", hotelCandidates: hotels }] };
  const row = { ...job(), query_json: JSON.stringify(hotelJobQuery(handoff, batchDraft, 1)) };
  const completed = settleHotelJob(row, { status: "completed", text: JSON.stringify({ results: [
    { placeId: "hotel-id-a", status: "available", price: { amount: 120, currency: "CNY", unit: "每晚起" } },
    { placeId: "hotel-id-b", status: "available", jumpUrl: "https://www.fliggy.com/hotel/123" },
    { placeId: "hotel-id-c", status: "unavailable" },
    { placeId: "hotel-id-d", status: "error", note: "supplier timeout" },
  ] }) }, created + 1000);
  const projected = publicHotelJob(completed);
  assert.deepEqual(projected.resultCounts, { total: 4, priced: 1, linkOnly: 1, unavailable: 1, failed: 1 });
  assert.match(projected.message, /1 家有参考价、1 家仅详情链接、1 家未匹配到报价、1 家查询失败/);
  const changes = mergeHotelQuoteResult(batchDraft, JSON.parse(row.query_json), row.job_id, JSON.parse(completed.result_json));
  assert.deepEqual(changes.staySegments[0].hotelCandidates.map((hotel) => hotel.quoteStatus), ["available", "available", "unavailable", "failed"]);
  assert.equal(changes.staySegments[0].hotelCandidates[0].commerce.price.amount, 120);
  assert.equal(changes.staySegments[0].hotelCandidates[3].commerce, null);
  assert.equal(hotelBatchWaiting({ ...projected, status: "timed_out" }), true);
  assert.equal(hotelBatchWaiting(projected), false);
});

test("pending V36 discovery snapshots no longer block V35 hotel search or confirmation", () => {
  const prior = publicHotelJob(job());
  for (const status of ["queued", "running", "timed_out"]) {
    assert.equal(hotelBatchWaiting({ ...prior, status }), true);
    assert.equal(hotelBatchWaiting({ ...prior, kind: "discovery", status, placeIds: [] }), false);
  }
});
