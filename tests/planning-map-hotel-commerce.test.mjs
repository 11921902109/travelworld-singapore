import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  resolve: { alias: { '@': process.cwd(), 'cloudflare:workers': path.join(process.cwd(), 'tests/fixtures/flight-agent-env.ts') } },
  optimizeDeps: { noDiscovery: true }, logLevel: 'error',
});
after(() => vite.close());
const { hotelMapQuotePresentation, projectPlanningMapHotelQuotes } = await vite.ssrLoadModule('/lib/travel/planning-map-hotel-commerce.ts');
const { hotelIdentityContextKey } = await vite.ssrLoadModule('/lib/travel/planning-hotel-snapshot.ts');
const { compilePlanningTrip, calculatePlanningDays, planningDayInputFingerprint } = await vite.ssrLoadModule('/lib/travel/planning-trip.ts');

const handoffId = 'handoff-test';
const loc = { lat: 1.3, lng: 103.85 };
const hotel = { placeId: 'hotel-one', name: '已确认酒店', address: 'Singapore', location: loc, kind: 'hotel', source: 'google_places', userConfirmed: true };
const hotelUrl = 'https://router.feizhu.com/ws/example-supplier-test';
const hotelOffer = (bookingUrl = hotelUrl, amount) => ({
  provider: 'fliggy', kind: 'hotel', status: 'available', bookingUrl,
  ...(amount ? { price: { amount, currency: 'CNY', display: 'not trusted copy', unit: '每晚起' } } : {}),
});
const segment = (id, startDay, checkInDate, checkOutDate, commerce, quoteStatus) => {
  const value = { id, startDay, area: 'Bugis', checkInDate, checkOutDate, hotel };
  return { ...value, hotelCandidates: [{ placeId: hotel.placeId, commerce, quoteStatus, verifiedPlace: { contextKey: hotelIdentityContextKey(handoffId, value) } }] };
};
const stop = (day, side, extra = {}) => ({
  id: `day-${day}-hotel-${side}`, placeId: hotel.placeId, verified: true, kind: 'hotel',
  name: hotel.name, lat: loc.lat, lng: loc.lng, time: side === 'start' ? '09:30' : '18:00', ...extra,
});
const day = (number, ...stops) => ({ id: `day-${number}`, stops, legs: [{ from: 'a', to: 'b', minutes: 30 }] });
const departure = hotelOffer('https://www.fliggy.com/hotel/departure', 480);
const arrival = hotelOffer('https://www.fliggy.com/hotel/arrival', 620);
const first = segment('segment-1', 1, '2026-12-20', '2026-12-21', departure, 'available');
const second = segment('segment-2', 2, '2026-12-21', '2026-12-23', arrival, 'available');

test('the same Google hotel on adjacent segments keeps previous-night and return quotes separate', () => {
  const journey = day(2, stop(2, 'start'), stop(2, 'return'));
  const projected = projectPlanningMapHotelQuotes(journey, '2026-12-21', handoffId, [second, first]);
  assert.equal(projected.stops[0].commerce.bookingUrl, departure.bookingUrl);
  assert.equal(projected.stops[1].commerce.bookingUrl, arrival.bookingUrl);
  assert.equal(hotelMapQuotePresentation(projected.stops[0]).dates, '12/20 入住 → 12/21 退房');
  assert.equal(hotelMapQuotePresentation(projected.stops[1]).price, '¥620 · 每晚起');
  assert.equal(projected.legs, journey.legs);
  assert.deepEqual(projected.stops.map(stop => stop.time), journey.stops.map(stop => stop.time));
  assert.equal(journey.stops[0].commerce, undefined);
});

test('arrival hotel uses the arrival date and exact ID, never the same name or a stale context', () => {
  const journey = day(1, stop(1, 'arrival'), stop(1, 'return', { placeId: 'another-hotel' }), stop(1, 'baggage'));
  const [arrived, different, baggage] = projectPlanningMapHotelQuotes(journey, '2026-12-20', handoffId, [first, second]).stops;
  assert.equal(arrived.commerce.bookingUrl, departure.bookingUrl);
  assert.equal(different, journey.stops[1]);
  assert.equal(baggage, journey.stops[2]);
  assert.equal(projectPlanningMapHotelQuotes(journey, '2026-12-20', 'older-handoff', [first]).stops[0].commerce, undefined);
  assert.equal(projectPlanningMapHotelQuotes(journey, '2026-12-19', handoffId, [first]).stops[0].commerce, undefined);
});

test('hotel-only link, price-only and invalid supplier links surface distinct states', () => {
  const bookingOnly = hotelMapQuotePresentation({ commerce: hotelOffer() });
  assert.equal(bookingOnly.bookingUrl, hotelUrl);
  assert.equal(bookingOnly.price, undefined);
  assert.match(bookingOnly.message, /未返回价格/);
  const priceOnly = hotelMapQuotePresentation({ commerce: hotelOffer(null, 520) });
  assert.equal(priceOnly.price, '¥520 · 每晚起');
  assert.match(priceOnly.message, /未返回酒店详情链接/);
  for (const url of [
    'https://untrusted.example/hotel/abc',
    'https://www.fliggy.com/',
    'https://www.fliggy.com/search/hotel',
    'https://router.feizhu.com/jump?url=https%3A%2F%2Fwww.fliggy.com%2Fhotel-search',
  ]) {
    assert.equal(hotelMapQuotePresentation({ commerce: hotelOffer(url) }).bookingUrl, undefined);
  }
  assert.equal(hotelMapQuotePresentation({ commerce: { ...hotelOffer(), kind: 'poi' } }).bookingUrl, undefined);
});

test('unqueried, unmatched and failed quotes stay distinct, including a failed current batch', () => {
  const journey = day(1, stop(1, 'arrival'));
  const presentation = (status, job) => {
    const lodging = segment('segment', 1, '2026-12-20', '2026-12-23', null, status);
    lodging.hotelSearchId = 'latest-candidate-list';
    const result = projectPlanningMapHotelQuotes(journey, '2026-12-20', handoffId, [lodging], job);
    return hotelMapQuotePresentation(result.stops[0]);
  };
  assert.match(presentation('not_requested').message, /尚未查询/);
  assert.match(presentation('failed').message, /未成功/);
  assert.match(presentation('unavailable').message, /未返回可核实/);
  const job = { status: 'failed', startDay: 1, searchId: 'latest-candidate-list', placeIds: [hotel.placeId] };
  assert.match(presentation('not_requested', job).message, /未成功/);
  assert.match(presentation('not_requested', { ...job, searchId: 'previous-batch' }).message, /尚未查询/);
  assert.match(hotelMapQuotePresentation({}).message, /未保存/);
});

test('normal map compilation carries the verified booking link without changing route fingerprints or estimates', async () => {
  const handoff = {
    dates: { start: '2026-12-20', end: '2026-12-21', days: 2 }, travelers: { total: 2 },
    dailyWindow: { start: '09:30', preferredReturn: '21:00', latestReturn: '21:00' },
    pace: 'relaxed', preferences: { interests: ['建筑'] },
  };
  const scene = (index) => ({
    id: `place-000${index}`, placeId: `place-000${index}`, name: `Sight ${index}`, address: 'Singapore', location: loc,
    area: 'Bugis', category: '建筑', kind: 'sight', reason: '建筑体验', estimatedMinutes: 60, recommendedMinutes: 60,
    pros: '适合慢逛', cons: '步行', source: 'preference', sourceNote: '建议', estimateSource: 'bailian', verified: true,
    googleMapsUri: null, rating: null, userRatingCount: null, openingHours: [],
  });
  const route = { mode: 'drive', distanceMeters: 1000, distanceText: '1 km', durationSeconds: 600, durationMinutes: 10, encodedPolyline: '' };
  const draft = {
    version: 1, handoffId, stage: 'complete', boardConfirmed: true, stayConfirmed: true, flightSelection: { mode: 'none' },
    candidates: [scene(1), scene(2)], assignments: [1, 2].map(day => ({ day, orderedCandidateIds: [`place-000${day}`] })),
    staySegments: [first, { ...second, checkOutDate: '2026-12-22', hotelCandidates: [] }], reviewRequired: [],
    dayEstimates: [1, 2].map(day => ({ day, routeReference: { fingerprint: JSON.stringify([[loc, loc, 'taxi'], [loc, loc, 'taxi']]), routes: [route, route] } })),
  };
  const before = await planningDayInputFingerprint(handoff, draft, 1);
  const calculated = await calculatePlanningDays(handoff, draft);
  draft.dayEstimates = calculated.map(item => item.estimate);
  const compiled = await compilePlanningTrip(handoff, draft);
  assert.equal(compiled.trip.days[0].stops[0].commerce.bookingUrl, departure.bookingUrl);
  assert.equal(compiled.trip.days[1].stops[0].commerce.bookingUrl, departure.bookingUrl);
  assert.equal(compiled.trip.days[1].stops.at(-1).hotelQuote.status, 'not_requested');
  assert.equal(compiled.estimates[0].scheduledDay.stops[0].commerce, undefined);
  assert.deepEqual(compiled.trip.days[1].legs, calculated[1].day.legs);
  assert.equal(await planningDayInputFingerprint(handoff, { ...draft, staySegments: [{ ...first, hotelCandidates: [] }, draft.staySegments[1]] }, 1), before);
});
