import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';

const loc = {lat:1.3,lng:103.85};
const handoff = {schemaVersion:1,sourceIntentStateVersion:1,destination:'Singapore',dates:{start:'2026-12-20',end:'2026-12-22',days:3},dailyWindow:{start:'09:30',preferredReturn:'21:00',latestReturn:'21:00'},pace:'relaxed',preferences:{interests:['建筑'],mustVisit:[],avoid:[],mobilityConstraints:[],dietaryPreferences:[],preferredTransport:[],allowAutomaticRecommendations:true},travelers:{total:2},confirmedByUser:true};
const hotel = {placeId:'hotel-main',name:'Hotel',address:'Singapore',location:loc,googleMapsUri:null,source:'google_places',verified:true};
const scene = id => ({id,placeId:id,name:id,address:'Singapore',location:loc,area:'市政区',category:'建筑',kind:'sight',reason:'建筑体验',estimatedMinutes:60,recommendedMinutes:60,pros:'适合慢逛',cons:'适量步行',source:'preference',sourceNote:'百炼建议',estimateSource:'bailian',verified:true,googleMapsUri:null,rating:4,userRatingCount:10,openingHours:['Sunday: 10:00 AM–10:00 PM','Monday: 10:00 AM–10:00 PM','Tuesday: 10:00 AM–10:00 PM']});
const manual = {outboundDepartureAt:'2026-12-20T07:00',arrivalAt:'2026-12-20T12:00',departureAt:'2026-12-22T18:00',inboundArrivalAt:'2026-12-22T23:00',outboundAirportQuery:'温州龙湾国际机场',arrivalAirportQuery:'Singapore Changi Airport',departureAirportQuery:'Singapore Changi Airport',inboundAirportQuery:'温州龙湾国际机场',outboundTimeZone:'Asia/Shanghai',inboundTimeZone:'Asia/Shanghai',airportsConfirmed:true};
function fixture() {return {version:1,handoffId:'test-handoff',sourceIntentStateVersion:1,stage:'flights',boardConfirmed:true,stayConfirmed:false,candidates:[1,2,3].map(i=>scene('place-000'+i)),assignments:[1,2,3].map(day=>({day,orderedCandidateIds:['place-000'+day],periodByCandidateId:{['place-000'+day]:'afternoon'}})),staySegments:[{id:'stay-1',startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-22',nights:2,hotel}],reviewRequired:[]};}
const mocks = {
  '@/lib/travel/google-maps': `export const SINGAPORE_BOUNDS={west:103,east:105,south:1,north:2};export class GoogleMapsServiceError extends Error{};const airport={placeId:'changi-airport',name:'Singapore Changi Airport',address:'Singapore',location:{lat:1.3,lng:103.85},googleMapsUri:null,primaryType:'airport',types:['airport']};export async function searchSingaporePlaces(){return[airport];}export async function getSingaporePlaceDetails(id){return id==='hotel-main'?{...airport,placeId:id,name:'Hotel',primaryType:'lodging',types:['lodging']}:airport;}export async function computeSingaporeRoute(){return{mode:'drive',distanceMeters:1000,distanceText:'1km',durationSeconds:600,durationMinutes:10,durationText:'10min',encodedPolyline:''};}`,
  '@/lib/travel/planning-state': `export async function readPlanningDraft(){return globalThis.__reviewLife.draft;}export async function readPlanningHandoff(){return{handoff:globalThis.__reviewLife.handoff,handoffId:'test-handoff'};}export async function commitPlanningDraft(token,input){const s=globalThis.__reviewLife;if(s.draft.version!==input.expectedVersion)return{committed:false,draft:s.draft};s.draft={...input.nextDraft,version:s.draft.version+1,updatedAt:'2026-11-05T00:00:00Z'};return{committed:true,draft:s.draft};}`,
  '@/lib/travel/planning-scenes': `export async function readPlanningSceneContext(){return{handoff:globalThis.__reviewLife.handoff,draft:globalThis.__reviewLife.draft};}export const PlanningSceneCandidateSchema={safeParse(value){return{success:true,data:value};}};`,
  '@/lib/travel/planning-flight-jobs': `export async function createPlanningFlightJob(){throw Error('No supplier expected');}export async function pollPlanningFlightJob(){throw Error('No supplier expected');}`,
  '@/lib/travel/planning-hotel-jobs': `export async function createHotelQuoteJob(){throw Error('No supplier expected');}export async function currentActiveHotelQuoteJob(){return null;}export async function pollHotelQuoteJob(){throw Error('No supplier expected');}`,
  '@/lib/travel/planning-stays': `export async function suggestStayAdvice(){throw Error('No model expected');}`,
  '@/lib/travel/visit-session': `export function readTravelVisitToken(){return'test-visit-token';}`,
  '@/lib/travel/api-guard': `export function guardSingaporeApi(){return null;}`,
  'next/server': `export class NextRequest extends Request{};export const NextResponse={json(body,options){return Response.json(body,options);}};`,
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:[...Object.keys(mocks).map(find=>({find,replacement:'\0review-life:'+find})),{find:'@',replacement:process.cwd()},{find:'cloudflare:workers',replacement:path.join(process.cwd(),'tests/fixtures/flight-agent-env.ts')}]},plugins:[{name:'review-life',enforce:'pre',resolveId(id){if(id.startsWith('\0review-life:'))return id;const key=Object.keys(mocks).find(key=>id===key||(key.startsWith('@/')&&id===path.join(process.cwd(),key.slice(2))));if(key)return'\0review-life:'+key;},load(id){return id.startsWith('\0review-life:')?mocks[id.slice('\0review-life:'.length)]:null;}}],optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {POST:flight}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/flights/route.ts');
const {POST:stays}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/stays/route.ts');
const {POST:schedule,GET:readSchedule}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/schedule/route.ts');
const {POST:compile}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/compile/route.ts');
const {refreshFlightReviews,reconcileBoardReviews}=await vite.ssrLoadModule('/lib/travel/planning-review.ts');
const {planningDraftWithReadiness}=await vite.ssrLoadModule('/lib/travel/planning-readiness.ts');
const post=(handler,body)=>handler(new Request('https://local.test/api/travel/singapore/planning',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:globalThis.__reviewLife.draft.version,turnId:crypto.randomUUID(),...body})}));
const seed=()=>{globalThis.__reviewLife={handoff,draft:fixture()};};
async function setupRoute(){
 seed();let response=await post(flight,{action:'manual',...manual});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal(globalThis.__reviewLife.draft.reviewItems.filter(i=>i.status==='pending').length,2);
 response=await post(stays,{action:'confirm'});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 return globalThis.__reviewLife.draft;
}

test('actual flight save → stay confirm → day calculation → final confirmation → compile resolves only current flight reviews',async()=>{
 await setupRoute();let response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);
 let data=await response.json();assert.equal(data.conflicts.length,0);assert.equal(data.estimates.length,3);assert.ok(data.draft.reviewItems.every(i=>i.status==='resolved'&&i.resolvedInputFingerprint));
 for(const day of [1,2,3]){response=await post(schedule,{action:'updateDay',overrides:{day,visitMinutesByPlaceId:{['place-000'+day]:65}}});assert.equal(response.status,200);}
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal(globalThis.__reviewLife.draft.stage,'complete');response=await post(compile,{});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal((await response.json()).trip.days.length,3);
});

test('legacy exact flight notices migrate after valid calculation; arbitrary budget and unknown blockers survive',async()=>{
 await setupRoute();delete globalThis.__reviewLife.draft.reviewItems;
 globalThis.__reviewLife.draft.reviewRequired=['Day 1 抵达后还需预留约 2 小时入境、行李与交通；请复核当天地点。','最后一天需提前至少 3 小时结束游览并前往机场；请复核当天地点。','住宿预算','自定义待确认'];
 let response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.draft.reviewRequired,['住宿预算','自定义待确认']);assert.ok(data.draft.reviewItems.every(i=>i.status==='resolved'));
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,409);assert.match((await response.json()).error.message,/住宿预算/);
});

test('arrival day edits only the end and departure day only the start, preserving flight boundaries', async () => {
 await setupRoute();
 const state = globalThis.__reviewLife;
 const original = structuredClone(state.draft);
 const updateWindow = (day, values) => post(schedule, {action:'updateDay', overrides:{day, dailyWindow:{...handoff.dailyWindow, ...values}}});

 const endConstraint = {strength:'hard', source:'user', evidence:'首日 20:30 前结束'};
 let response = await updateWindow(1, {preferredReturn:'20:30', latestReturn:'20:30', returnConstraint:endConstraint});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 let result = (await response.json()).estimates.find(({day}) => day === 1);
 assert.deepEqual(result.dailyWindow, {start:'09:30', preferredReturn:'20:30', latestReturn:'20:30', returnConstraint:endConstraint});
 assert.deepEqual(result.effectiveWindow, {start:'14:00', returnBy:'20:30'});

 response = await updateWindow(3, {start:'12:15'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 result = (await response.json()).estimates.find(({day}) => day === 3);
 assert.deepEqual(result.dailyWindow, {...handoff.dailyWindow, start:'12:15'});
 assert.deepEqual(result.effectiveWindow, {start:'12:15', returnBy:'15:00'});

 const beforeRejected = structuredClone(state.draft);
 const rejected = [
  [1, {start:'10:00', preferredReturn:'20:30', latestReturn:'20:30', returnConstraint:endConstraint}],
  [3, {start:'12:15', preferredReturn:'20:30', latestReturn:'20:30'}],
  [3, {start:'12:15', returnConstraint:{strength:'soft', source:'user'}}],
 ];
 for (const [day, fields] of rejected) {
  response = await updateWindow(day, fields);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'FLIGHT_DAY_FIXED_TIMES');
 }
 for (const day of [1, 3]) {
  response = await post(schedule, {action:'updateDay', overrides:{day, travelTotalMinutes:0}});
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'TRAVEL_DURATION_READ_ONLY');
 }
 assert.deepEqual(state.draft, beforeRejected);
 assert.deepEqual(state.draft.flightSelection, original.flightSelection);
 assert.deepEqual(state.draft.staySegments, original.staySegments);
});

test('day with both confirmed arrival and departure keeps both time controls fixed', async () => {
 seed();
 const state = globalThis.__reviewLife;
 state.handoff = {...handoff, dates:{start:'2026-12-20', end:'2026-12-20', days:1}};
 state.draft.assignments = state.draft.assignments.slice(0, 1);
 state.draft.staySegments = [];
 let response = await post(flight, {action:'manual', ...manual, departureAt:'2026-12-20T21:00', inboundArrivalAt:'2026-12-21T02:00'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 response = await post(stays, {action:'confirm'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const original = structuredClone(state.draft);

 for (const values of [{start:'10:00'}, {preferredReturn:'20:30', latestReturn:'20:30'}]) {
  response = await post(schedule, {action:'updateDay', overrides:{day:1, dailyWindow:{...handoff.dailyWindow, ...values}}});
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'FLIGHT_DAY_FIXED_TIMES');
 }
 assert.deepEqual(state.draft, original);

 response = await post(schedule, {action:'updateDay', overrides:{day:1, dailyWindow:handoff.dailyWindow, visitMinutesByPlaceId:{'place-0001':65}}});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const result = (await response.json()).estimates[0];
 assert.deepEqual(result.effectiveWindow, {start:'14:00', returnBy:'18:00'});
 assert.equal(result.journey.kind, 'arrival_departure');
 assert.equal(result.scenes[0].selectedVisitMinutes, 65);
 assert.deepEqual(state.draft.flightSelection, original.flightSelection);
});

test('next-morning departure retains the same last-day edit boundary and the separate airport transfer', async () => {
 seed();
 const state = globalThis.__reviewLife;
 state.draft.staySegments[0].checkOutDate = '2026-12-23';
 state.draft.staySegments[0].nights = 3;
 let response = await post(flight, {action:'manual', ...manual, departureAt:'2026-12-23T06:00', inboundArrivalAt:'2026-12-23T11:00'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 response = await post(stays, {action:'confirm'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const dailyWindow = {...handoff.dailyWindow, start:'10:30'};
 response = await post(schedule, {action:'updateDay', overrides:{day:3, dailyWindow}});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const result = (await response.json()).estimates.find(({day}) => day === 3);
 assert.deepEqual(result.effectiveWindow, {start:'10:30', returnBy:'21:00'});
 assert.equal(result.nextDayDepartureTransfer.departureAt, '2026-12-23T06:00');
 const original = structuredClone(state.draft);
 response = await post(schedule, {action:'updateDay', overrides:{day:3, dailyWindow:{...dailyWindow, preferredReturn:'20:30', latestReturn:'20:30'}}});
 assert.equal(response.status, 422);
 assert.equal((await response.json()).error.code, 'FLIGHT_DAY_FIXED_TIMES');
 assert.deepEqual(state.draft, original);
});

test('a no-flight first day still accepts both local time changes', async () => {
 seed();
 const state = globalThis.__reviewLife;
 state.draft.flightSelection = {mode:'none'};
 state.draft.staySegments[0].checkOutDate = '2026-12-23';
 state.draft.staySegments[0].nights = 3;
 let response = await post(stays, {action:'confirm'});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const dailyWindow = {start:'10:30', preferredReturn:'20:30', latestReturn:'20:30'};
 response = await post(schedule, {action:'updateDay', overrides:{day:1, dailyWindow}});
 assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
 const result = (await response.json()).estimates[0];
 assert.deepEqual(result.dailyWindow, dailyWindow);
 assert.deepEqual(result.effectiveWindow, {start:'10:30', returnBy:'20:30'});
});

test('changed relevant inputs and actual conflicts prevent stale flight-review clearance',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});
 globalThis.__reviewLife.draft.assignments[0].periodByCandidateId={'place-0001':'morning'};
 globalThis.__reviewLife.draft.assignments[0].periodConstraintByCandidateId={'place-0001':{strength:'hard',source:'user',evidence:'只能上午'}};
 let response=await post(schedule,{action:'confirm'});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'ESTIMATES_STALE');
 response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);let data=await response.json();assert.equal(data.draft.reviewItems.find(i=>i.kind==='flight_arrival').status,'pending');assert.equal(data.draft.reviewItems.find(i=>i.kind==='flight_departure').status,'resolved');
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,422);
});

test('changing only the inbound leg preserves the resolved arrival review and unrelated blockers',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});const draft=globalThis.__reviewLife.draft;
 draft.reviewRequired=['住宿预算'];const next=structuredClone(draft.flightSelection);next.departureAt='2026-12-22T17:00';next.journey.inbound.departure.localDateTime=next.departureAt;
 const reviews=await refreshFlightReviews(handoff,draft,next);assert.equal(reviews.reviewItems.find(i=>i.kind==='flight_arrival').status,'resolved');assert.equal(reviews.reviewItems.find(i=>i.kind==='flight_departure').status,'pending');assert.deepEqual(reviews.reviewRequired,['住宿预算']);
});

test('reopening and editing one flight leg preserves hotels and unaffected day calculations; changed nights require renewed stays',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});
 const original=structuredClone(globalThis.__reviewLife.draft);
 let response=await post(flight,{action:'reopen'});assert.equal(response.status,200);assert.equal(globalThis.__reviewLife.draft.stayConfirmed,true);assert.equal(globalThis.__reviewLife.draft.dayEstimates.length,3);
 response=await post(flight,{action:'manual',...manual,departureAt:'2026-12-22T17:00'});assert.equal(response.status,200);
 let draft=globalThis.__reviewLife.draft;assert.equal(draft.stage,'route');assert.equal(draft.stayConfirmed,true);assert.deepEqual(draft.staySegments,original.staySegments);assert.deepEqual(draft.dayEstimates.map(i=>i.day),[1,2]);assert.deepEqual(draft.dayEstimates[0],original.dayEstimates[0]);assert.equal(draft.reviewItems.find(i=>i.kind==='flight_arrival').status,'resolved');assert.equal(draft.reviewItems.find(i=>i.kind==='flight_departure').status,'pending');
 await post(schedule,{action:'calculate'});assert.equal(globalThis.__reviewLife.draft.dayEstimates.length,3);
 const before=structuredClone(globalThis.__reviewLife.draft);response=await post(flight,{action:'manual',...manual,departureAt:'2026-12-22T17:00',outboundDepartureAt:'2026-12-20T08:00',arrivalAt:'2026-12-20T13:00'});assert.equal(response.status,200);
 draft=globalThis.__reviewLife.draft;assert.deepEqual(draft.dayEstimates.map(i=>i.day),[2,3]);assert.deepEqual(draft.dayEstimates.find(i=>i.day===3),before.dayEstimates.find(i=>i.day===3));
 response=await post(flight,{action:'manual',...manual,departureAt:'2026-12-23T01:00',inboundArrivalAt:'2026-12-23T06:00'});assert.equal(response.status,200);draft=globalThis.__reviewLife.draft;assert.equal(draft.stage,'stays');assert.equal(draft.stayConfirmed,false);assert.deepEqual(draft.dayEstimates,[]);assert.deepEqual(draft.staySegments,[]);
});

test('a validated legacy scene-board review is migrated and the full schedule-to-map chain succeeds',async()=>{
 await setupRoute();globalThis.__reviewLife.draft.reviewRequired=['地点与分天'];
 let response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);let data=await response.json();
 assert.equal(data.draft.reviewItems.find(item=>item.kind==='board').status,'resolved');assert.deepEqual(data.draft.pendingReviews,[]);assert.equal(data.draft.scheduleReady,true);
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,200);response=await post(compile,{});assert.equal(response.status,200);
});

test('changed confirmed board content and new-format incomplete periods remain blocking on restore, confirm and compile',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});const draft=globalThis.__reviewLife.draft;
 draft.assignments[1].periodByCandidateId['place-0002']='morning';
 let response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);let data=await response.json();assert.equal(data.draft.scheduleReady,false);assert.ok(data.draft.pendingReviews.some(item=>item.kind==='board'));
 response=await readSchedule(new Request('https://local.test/api/travel/singapore/planning/schedule'));assert.equal(response.status,200);data=await response.json();assert.ok(data.draft.pendingReviews.some(item=>item.kind==='board'&&item.targetStage==='day_allocation'));
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,409);assert.ok((await response.json()).draft.pendingReviews.some(item=>item.kind==='board'));
 globalThis.__reviewLife.draft.stage='complete';response=await post(compile,{});assert.equal(response.status,409);assert.ok((await response.json()).draft.pendingReviews.some(item=>item.kind==='board'));
 Object.assign(globalThis.__reviewLife.draft,{selectedPlaceIds:['place-0001','place-0002','place-0003'],placesConfirmed:true});delete globalThis.__reviewLife.draft.assignments[1].periodByCandidateId;
 const current=await planningDraftWithReadiness(handoff,globalThis.__reviewLife.draft);assert.ok(current.pendingReviews.some(item=>item.kind==='board'));
});

test('stale-day restoration and confirmation use the same authoritative readiness projection',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});
 globalThis.__reviewLife.draft.scheduleOverrides=[{day:2,personalMinutes:45}];
 let response=await readSchedule(new Request('https://local.test/api/travel/singapore/planning/schedule'));let data=await response.json();
 assert.equal(data.draft.scheduleReady,false);assert.deepEqual(data.draft.staleScheduleDays,[2]);assert.ok(data.draft.pendingReviews.some(item=>item.kind==='schedule_stale'&&item.day===2));
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,409);data=await response.json();assert.equal(data.error.code,'ESTIMATES_STALE');assert.deepEqual(data.draft.staleScheduleDays,[2]);
 globalThis.__reviewLife.draft.stage='complete';response=await post(compile,{});assert.equal(response.status,409);data=await response.json();assert.deepEqual(data.draft.staleScheduleDays,[2]);
});

test('an explicit valid board proof clears only its review, retaining budget and unknown pending work',async()=>{
 await setupRoute();await post(schedule,{action:'calculate'});const draft=globalThis.__reviewLife.draft;
 draft.assignments[1].periodByCandidateId['place-0002']='morning';draft.reviewRequired=['地点与分天','住宿预算','自定义待确认'];
 Object.assign(draft,await reconcileBoardReviews(handoff,draft,true));
 let response=await post(schedule,{action:'calculate'});assert.equal(response.status,200);const data=await response.json();
 assert.ok(!data.draft.pendingReviews.some(item=>item.kind==='board'));assert.deepEqual(data.draft.reviewRequired,['住宿预算','自定义待确认']);
 response=await post(schedule,{action:'confirm'});assert.equal(response.status,409);assert.match((await response.json()).error.message,/住宿预算.*自定义待确认/);
});
