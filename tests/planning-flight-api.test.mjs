import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
const mocks={
 '@/lib/travel/google-maps':`const p={placeId:'changi-airport',name:'Singapore Changi Airport',address:'Singapore',location:{lat:1.35,lng:103.99},googleMapsUri:null,primaryType:'airport',types:['airport']};export class GoogleMapsServiceError extends Error{} export async function searchSingaporePlaces(){globalThis.__flightApi.lookups++;return[p];} export async function getSingaporePlaceDetails(){return p;}`,
 '@/lib/travel/planning-state':`export async function readPlanningDraft(){return globalThis.__flightApi.draft;} export async function readPlanningHandoff(){return{handoff:globalThis.__flightApi.handoff};} export async function commitPlanningDraft(token,input){const s=globalThis.__flightApi;s.commits++;s.draft={...input.nextDraft,version:s.draft.version+1};return{committed:true,draft:s.draft};}`,
 '@/lib/travel/planning-flight-jobs':`export async function createPlanningFlightJob(){throw new Error('not used');}export async function pollPlanningFlightJob(){return null;}`,
 '@/lib/travel/visit-session':`export function readTravelVisitToken(){return'test-visit';}`,
 '@/lib/travel/api-guard':`export function guardSingaporeApi(){return null;}`,
 'next/server':`export class NextRequest extends Request{} export const NextResponse={json(body,options){return new Response(JSON.stringify(body),{status:options?.status||200,headers:{'Content-Type':'application/json',...options?.headers}});}};`,
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:[...Object.keys(mocks).map(find=>({find,replacement:'\0flight-api:'+find})),{find:'@',replacement:process.cwd()}]},plugins:[{name:'flight-api-boundaries',enforce:'pre',resolveId(id){if(id.startsWith('\0flight-api:'))return id;const key=Object.keys(mocks).find(key=>id===key||(key.startsWith('@/')&&id===path.join(process.cwd(),key.slice(2))));if(key)return'\0flight-api:'+key;},load(id){return id.startsWith('\0flight-api:')?mocks[id.slice('\0flight-api:'.length)]:null;}}],optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {GET,POST}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/flights/route.ts');
const {flightJourneyLegMinutes}=await vite.ssrLoadModule('/lib/travel/planning-flight-journey.ts');
const handoff={dates:{start:'2026-12-20',end:'2026-12-23',days:4},dailyWindow:{start:'09:30',latestReturn:'21:00'},originCity:'成田国际机场'};
function reset(){globalThis.__flightApi={handoff,lookups:0,commits:0,draft:{version:1,handoffId:'flight-test',stage:'flights',boardConfirmed:true,assignments:[1,2,3,4].map(day=>({day,orderedCandidateIds:[]})),candidates:[],reviewRequired:['预算待确认','住宿待核对','航班','Day 1 抵达后还需预留约 2 小时入境、行李与交通；请复核当天地点。']}};return globalThis.__flightApi;}
const manual={action:'manual',expectedVersion:1,turnId:'manual-flight-test',outboundDepartureAt:'2026-12-19T23:45',arrivalAt:'2026-12-20T06:30',departureAt:'2026-12-23T22:00',inboundArrivalAt:'2026-12-24T06:00',outboundAirportQuery:'成田国际机场',arrivalAirportQuery:'新加坡樟宜机场',departureAirportQuery:'新加坡樟宜机场',inboundAirportQuery:'成田国际机场',outboundTimeZone:'Asia/Tokyo',inboundTimeZone:'Asia/Tokyo',airportsConfirmed:true};
const post=(body)=>POST(new Request('https://local.test/api/travel/singapore/planning/flights',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));

test('new skip and incomplete legacy-shaped confirmations cannot create selections or call Google',async()=>{
 const s=reset();s.draft.flightSelection={mode:'none'};
 const skip=await post({action:'skip',expectedVersion:1,turnId:'skip-flight-test'});assert.equal(skip.status,422);assert.equal((await skip.json()).error.code,'FLIGHT_INFORMATION_REQUIRED');
 const incomplete={...manual};delete incomplete.outboundDepartureAt;
 assert.equal((await post(incomplete)).status,422);assert.equal(s.lookups,0);assert.equal(s.commits,0);assert.deepEqual(s.draft.flightSelection,{mode:'none'});
 const request={nextUrl:new URL('https://local.test/api/travel/singapore/planning/flights')};const read=await GET(request);assert.equal(read.status,200);assert.deepEqual((await read.json()).selection,{mode:'none'});
});

test('manual confirmation persists four exact dates and source, computes different-zone durations, and preserves unrelated reviews',async()=>{
 const s=reset();const response=await post(manual);assert.equal(response.status,200);const data=await response.json();
 const selection=data.selection;assert.equal(selection.mode,'manual');assert.equal(selection.arrivalAt,manual.arrivalAt);assert.equal(selection.departureAt,manual.departureAt);
 assert.equal(selection.journey.source,'user');assert.equal(selection.journey.outbound.departure.localDateTime,manual.outboundDepartureAt);assert.equal(selection.journey.inbound.arrival.localDateTime,manual.inboundArrivalAt);
 assert.equal(selection.journey.outbound.departure.airport.source,'user');assert.equal(selection.journey.outbound.arrival.airport.source,'google_places');
 assert.equal(flightJourneyLegMinutes(selection.journey.outbound),465);assert.equal(flightJourneyLegMinutes(selection.journey.inbound),420);
 assert.deepEqual(data.draft.reviewRequired,['预算待确认','住宿待核对','路线']);assert.equal(data.draft.reviewItems.length,2);assert.ok(data.draft.reviewItems.every(item=>item.status==='pending'));
 assert.equal(s.commits,1);assert.equal(s.lookups,2);
});

test('invalid calendar dates, IANA zones and reversed instants fail before airport lookup and retain original selection',async()=>{
 for(const change of [{outboundTimeZone:'guess'},{arrivalAt:'2026-02-30T12:00'},{inboundArrivalAt:'2026-12-23T21:00'},{outboundDepartureAt:'2026-12-20T12:00'}]){
  const s=reset();s.draft.flightSelection={mode:'manual',arrivalAt:'2026-12-20T12:00',departureAt:'2026-12-23T18:00'};const previous=structuredClone(s.draft.flightSelection);
  const response=await post({...manual,...change});assert.equal(response.status,422);assert.equal(s.lookups,0);assert.equal(s.commits,0);assert.deepEqual(s.draft.flightSelection,previous);
 }
});

test('query confirmation requires explicit outer time zones and retains the real candidate times',async()=>{
 const s=reset();const offer=(direction)=>({id:direction,direction,origin:direction==='outbound'?'成田国际机场':'新加坡樟宜机场',destination:direction==='outbound'?'新加坡樟宜机场':'成田国际机场',departureLocal:direction==='outbound'?manual.outboundDepartureAt:manual.departureAt,arrivalLocal:direction==='outbound'?manual.arrivalAt:manual.inboundArrivalAt,airline:'真实航空',flightNumber:'REAL123',price:null,bookingUrl:'https://router.feizhu.com/ws/real'});
 s.draft.flightQuotes={outbound:[offer('outbound')],inbound:[offer('inbound')]};
 const body={action:'select',expectedVersion:1,turnId:'select-flight-test',outboundId:'outbound',inboundId:'inbound'};
 assert.equal((await post(body)).status,422);assert.equal(s.commits,0);assert.equal(s.lookups,0);
 const response=await post({...body,outboundTimeZone:'Asia/Tokyo',inboundTimeZone:'Asia/Tokyo',timeZonesConfirmed:true});assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.selection.journey.source,'supplier');assert.equal(data.selection.journey.inbound.arrival.localDateTime,manual.inboundArrivalAt);assert.deepEqual(data.selection.outbound,offer('outbound'));
});
