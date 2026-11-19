import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {deriveFlightJourney,flightJourneyLegMinutes,flightLocalDateTimeEpoch,normalizeFlightTimeZone,validateFlightJourney}=await vite.ssrLoadModule('/lib/travel/planning-flight-journey.ts');
const point=(localDateTime,timeZone,name='具体机场')=>({localDateTime,timeZone,airport:{name}});
const leg=(departure,arrival)=>({departure,arrival,source:'user'});

test('date and IANA conversions handle overnight, different zones and date-line arrival correctly',()=>{
 assert.equal(flightJourneyLegMinutes(leg(point('2026-12-19T23:45','Asia/Tokyo'),point('2026-12-20T06:30','Asia/Singapore'))),465);
 assert.equal(flightJourneyLegMinutes(leg(point('2026-12-23T22:00','Asia/Singapore'),point('2026-12-23T18:00','America/Los_Angeles'))),720);
 assert.equal(flightJourneyLegMinutes(leg(point('2026-12-23T22:00','Asia/Singapore'),point('2026-12-24T06:00','Asia/Tokyo'))),420);
});

test('invalid dates, unknown zones, missing endpoints and DST ambiguity never become zero-duration flights',()=>{
 assert.equal(normalizeFlightTimeZone('unknown'),null);
 assert.equal(flightLocalDateTimeEpoch('2026-02-30T12:00','Asia/Singapore'),null);
 assert.equal(flightLocalDateTimeEpoch('2026-03-08T02:30','America/New_York'),null);
 assert.equal(flightLocalDateTimeEpoch('2026-11-01T01:30','America/New_York'),null);
 assert.equal(flightLocalDateTimeEpoch('2026-07-01T12:00','America/New_York'),Date.parse('2026-07-01T16:00Z'));
 assert.equal(flightJourneyLegMinutes(leg(point(null,null),point('2026-12-20T06:30','Asia/Singapore'))),null);
 assert.equal(flightJourneyLegMinutes(leg(point('2026-12-20T06:30','Asia/Singapore'),point('2026-12-20T06:30','Asia/Singapore'))),null);
});

test('legacy manual and historical none remain readable without invented outer endpoints',()=>{
 const journey=deriveFlightJourney({mode:'manual',arrivalAt:'2026-12-20T12:00',departureAt:'2026-12-23T18:00',arrivalAirportName:'新加坡樟宜机场',departureAirportName:'新加坡樟宜机场'});
 assert.equal(journey.outbound.departure.localDateTime,null);assert.equal(journey.inbound.arrival.localDateTime,null);
 assert.equal(journey.outbound.arrival.localDateTime,'2026-12-20T12:00');assert.equal(journey.inbound.departure.timeZone,'Asia/Singapore');
 assert.equal(validateFlightJourney(journey).valid,false);assert.equal(flightJourneyLegMinutes(journey.outbound),null);
 const none=deriveFlightJourney({mode:'none'});assert.equal(none.outbound.arrival.localDateTime,null);assert.equal(none.inbound.departure.timeZone,null);
});

test('full journeys retain exact user times and require chronological instants',()=>{
 const journey={source:'user',outbound:leg(point('2026-12-19T23:45','Asia/Tokyo'),point('2026-12-20T06:30','Asia/Singapore')),inbound:leg(point('2026-12-23T22:00','Asia/Singapore'),point('2026-12-24T06:00','Asia/Tokyo'))};
 const restored=deriveFlightJourney({mode:'manual',journey});assert.deepEqual(restored.outbound.departure,journey.outbound.departure);assert.equal(validateFlightJourney(restored).valid,true);
 restored.inbound.arrival.localDateTime='2026-12-23T21:00';assert.equal(validateFlightJourney(restored).valid,false);
});
