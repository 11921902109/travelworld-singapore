import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { planRegularVisit } from '../lib/travel/planning-hours.ts';

const vite = await createServer({ configFile:false, server:{middlewareMode:true,hmr:false}, resolve:{alias:{'@':process.cwd(),'cloudflare:workers':path.join(process.cwd(),'tests/fixtures/flight-agent-env.ts')}}, optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const { mergePlanningTimeOverride } = await vite.ssrLoadModule('/lib/travel/planning-time-overrides.ts');
const { buildDailyAdvice, dailyTransportSummary, defaultFreeTimePolicies, scheduleFingerprint } = await vite.ssrLoadModule('/lib/travel/planning-schedule-policy.ts');
const { calculatePlanningDays, compilePlanningTrip, buildPlanningDayJourney, planningDayInputFingerprint } = await vite.ssrLoadModule('/lib/travel/planning-trip.ts');
const { schedulePlanningDay } = await vite.ssrLoadModule('/lib/travel/planning-scheduler.ts');
const loc={lat:1.3,lng:103.85};
const route=(minutes)=>({mode:'drive',distanceMeters:1000,distanceText:'1km',durationSeconds:minutes*60,durationMinutes:minutes,durationText:minutes+'m',encodedPolyline:''});
const reference=(durations)=>({fingerprint:JSON.stringify(durations.map(()=>[loc,loc,'taxi'])),routes:durations.map(route),queriedAt:'2026-11-04T00:00:00Z'});
const anchor=(id)=>({placeId:id,name:id,address:'Singapore',location:loc,googleMapsUri:null,source:'google_places',verified:true});
const candidate=(id,patch={})=>({id,placeId:id,name:id,address:'Singapore',location:loc,area:'市政区',category:'建筑',kind:'sight',reason:'适合建筑体验',estimatedMinutes:90,recommendedMinutes:90,pros:'适合慢逛',cons:'适量步行',source:'preference',sourceNote:'百炼建议',estimateSource:'bailian',verified:true,googleMapsUri:null,rating:4,userRatingCount:10,openingHours:[],...patch});
const handoff={schemaVersion:1,sourceIntentStateVersion:1,destination:'Singapore',dates:{start:'2026-12-20',end:'2026-12-22',days:3},dailyWindow:{start:'09:30',preferredReturn:'21:00',latestReturn:'21:00'},pace:'relaxed',preferences:{interests:['建筑'],mustVisit:[],avoid:[],mobilityConstraints:[],dietaryPreferences:[],preferredTransport:[],allowAutomaticRecommendations:true},travelers:{total:2},confirmedByUser:true};
function draftFixture(){return {version:1,handoffId:'test-handoff',sourceIntentStateVersion:1,stage:'route',boardConfirmed:true,stayConfirmed:true,flightSelection:{mode:'none'},candidates:[1,2,3].map(x=>candidate('place-000'+x)),assignments:[1,2,3].map(day=>({day,orderedCandidateIds:['place-000'+day]})),staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-21',hotel:anchor('hotel-a')},{startDay:2,area:'Bugis',checkInDate:'2026-12-21',checkOutDate:'2026-12-23',hotel:anchor('hotel-b')}],dayEstimates:[1,2,3].map(day=>({day,routeReference:reference([25,40])})),reviewRequired:[]};}
const stop=(id,kind)=>({id,placeId:id,name:id,kind,verified:true,location:loc,time:'00:00',endTime:'00:00',openingHours:[],note:'',area:'',x:0,y:0,duration:''});
const baseDay={day:{id:'day-1',label:'Day 1',date:'12/20',weekday:'周日',theme:'',summary:'',color:'',stops:[],legs:[]},orderedStops:[stop('hotel-a','hotel'),stop('one','sight'),stop('two','sight'),stop('hotel-b','hotel')],startTime:'09:30',returnBy:'21:00',requestedVisitMinutes:{one:90,two:90},routeReference:reference([25,45,40]),taxiPickupMinutes:0,mealReserveMinutes:90,bufferReserveMinutes:30};

const routeMocks={
 '@/lib/travel/planning-state': `export async function readPlanningDraft(){const s=globalThis.__scheduleRouteTest;if(s.advanceOnRead){s.draft={...s.draft,version:s.draft.version+1};delete s.advanceOnRead;}return s.draft;} export async function commitPlanningDraft(token,input){const s=globalThis.__scheduleRouteTest;if(s.draft.version!==input.expectedVersion)return{committed:false,draft:s.draft};s.commits++;s.draft={...input.nextDraft,version:s.draft.version+1,updatedAt:'2026-11-04T00:00:00Z'};return{committed:true,draft:s.draft};}`,
 '@/lib/travel/planning-scenes': `export async function readPlanningSceneContext(){return{handoff:globalThis.__scheduleRouteTest.handoff,draft:globalThis.__scheduleRouteTest.draft};} export const PlanningSceneCandidateSchema={safeParse(value){return{success:true,data:value};}};`,
 '@/lib/travel/visit-session': `export function readTravelVisitToken(){return'test-visit-token';}`,
 '@/lib/travel/api-guard': `export function guardSingaporeApi(){return null;}`,
 'next/server': `export class NextRequest extends Request {} export const NextResponse={json(body,options){return new Response(JSON.stringify(body),{status:options?.status||200,headers:{'Content-Type':'application/json',...options?.headers}});}};`,
};
const routeVite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:[...Object.keys(routeMocks).map(find=>({find,replacement:'\0schedule-mock:'+find})),{find:'@',replacement:process.cwd()},{find:'cloudflare:workers',replacement:path.join(process.cwd(),'tests/fixtures/flight-agent-env.ts')}]},plugins:[{name:'schedule-test-boundaries',enforce:'pre',resolveId(id){if(id.startsWith('\0schedule-mock:'))return id;const key=Object.keys(routeMocks).find(key=>id===key||(key.startsWith('@/')&&id===path.join(process.cwd(),key.slice(2))));if(key)return'\0schedule-mock:'+key;},load(id){return id.startsWith('\0schedule-mock:')?routeMocks[id.slice('\0schedule-mock:'.length)]:null;}}],optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>routeVite.close());
const {POST}=await routeVite.ssrLoadModule('/app/api/travel/singapore/planning/schedule/route.ts');
const postSchedule=(body)=>POST(new Request('https://local.test/api/travel/singapore/planning/schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));

test('single-day recalculation retains actual Day identity, changing-hotel endpoints, and untouched estimates',async()=>{
 const draft=draftFixture();
 const first=await calculatePlanningDays(handoff,draft);draft.dayEstimates=first.map(x=>x.estimate);
 const original1=draft.dayEstimates[0],original3=draft.dayEstimates[2];
 const updated={...draft,scheduleOverrides:[{day:2,visitMinutesByPlaceId:{'place-0002':120}}]};
 const result=await calculatePlanningDays(handoff,updated,{day:2});
 assert.equal(result.length,1);assert.equal(result[0].estimate.day,2);assert.equal(result[0].estimate.date,'2026-12-21');
 assert.equal(result[0].day.stops[0].placeId,'hotel-a');assert.equal(result[0].day.stops.at(-1).placeId,'hotel-b');
 assert.equal(draft.dayEstimates[0],original1);assert.equal(draft.dayEstimates[2],original3);
 assert.equal(result[0].estimate.metrics.freeMinutes,draft.dayEstimates[1].metrics.freeMinutes-30);
 const merged={...updated,stage:'complete',dayEstimates:[original1,result[0].estimate,original3]};
 const cached=await calculatePlanningDays(handoff,merged,{day:2});assert.equal(cached[0].estimate,result[0].estimate);
 const compiled=await compilePlanningTrip(handoff,merged);assert.equal(compiled.trip.days.length,3);assert.equal(compiled.estimates[1],result[0].estimate);
});

test('a middle-day update with flights does not resolve unrelated first/last-day airports',async()=>{
 const draft=draftFixture();const h={...handoff,dates:{start:'2026-12-20',end:'2026-12-23',days:4}};
 draft.flightSelection={mode:'manual',arrivalAt:'2026-12-20T05:30',departureAt:'2026-12-23T20:00',arrivalAirportName:'Singapore Changi Airport',departureAirportName:'Singapore Changi Airport'};
 draft.assignments.push({day:4,orderedCandidateIds:['place-0004']});draft.candidates.push(candidate('place-0004'));
 const result=await calculatePlanningDays(h,draft,{day:2});assert.equal(result.length,1);assert.equal(result[0].estimate.day,2);
});

test('middle-day legacy manual transport is invalidated only for that day and never enters the new route', async () => {
 const draft = draftFixture();
 const first = await calculatePlanningDays(handoff, draft);
 draft.dayEstimates = first.map(({estimate}) => estimate);
 draft.scheduleOverrides = [{day:2, travelTotalMinutes:0}];
 const former = draft.dayEstimates[1];
 draft.dayEstimates[1] = {...former, metrics:{...former.metrics, travelSource:'user', travelMinutes:0}, transport:{...former.transport, source:'user'}};
 const rebuilt = await calculatePlanningDays(handoff, draft);
 assert.equal(rebuilt[0].estimate, draft.dayEstimates[0]);
 assert.equal(rebuilt[2].estimate, draft.dayEstimates[2]);
 assert.equal(rebuilt[1].estimate.metrics.travelSource, 'google');
 assert.equal(rebuilt[1].estimate.metrics.travelMinutes, former.metrics.travelMinutes);
 assert.equal(rebuilt[1].day.legs.reduce((minutes, leg) => minutes + leg.minutes, 0), former.metrics.travelMinutes);
});

test('schedule API refuses a new manual transport total even on an ordinary day', async () => {
 const draft = draftFixture(); globalThis.__scheduleRouteTest = { handoff, draft, commits:0 };
 const response = await postSchedule({action:'updateDay', expectedVersion:1, turnId:'new-manual-travel', overrides:{day:2, travelTotalMinutes:0}});
 assert.equal(response.status, 422);
 assert.equal((await response.json()).error.code, 'TRAVEL_DURATION_READ_ONLY');
 assert.equal(globalThis.__scheduleRouteTest.commits, 0);
});

test('map compilation restores original advice in legacy estimates and keeps it tied to the selected place', async () => {
  const draft = { ...draftFixture(), stage: 'complete' };
  const initial = await calculatePlanningDays(handoff, draft);
  draft.dayEstimates = initial.map(({ estimate }) => estimate);
  const cachedDay = draft.dayEstimates[1].scheduledDay;
  delete cachedDay.stops.find((item) => item.placeId === 'place-0002').aiAdvice;

  const compiled = await compilePlanningTrip(handoff, draft);
  const advice = compiled.trip.days[1].stops.find((item) => item.placeId === 'place-0002').aiAdvice;
  assert.deepEqual(advice, { pros: '适合慢逛', cons: '适量步行' });
  assert.equal(compiled.estimates[1].routeReference, draft.dayEstimates[1].routeReference);

  draft.candidates.push(candidate('place-replacement', { pros: '适合参观展览', cons: '展区可能拥挤' }));
  draft.assignments[1].orderedCandidateIds = ['place-replacement'];
  const [updated] = await calculatePlanningDays(handoff, draft, { day: 2 });
  assert.equal(updated.day.stops.some((item) => item.placeId === 'place-0002'), false);
  assert.deepEqual(updated.day.stops.find((item) => item.placeId === 'place-replacement').aiAdvice, {
    pros: '适合参观展览', cons: '展区可能拥挤',
  });
});

test('complete transport displays the whole route including airports and retains exact time balance',async()=>{
 const result=await schedulePlanningDay(baseDay);
 assert.equal(result.transport.totalMinutes,110);assert.equal(result.metrics.travelMinutes,110);
 assert.equal(dailyTransportSummary(result.transport),'约 1.83 小时');
 assert.equal(result.metrics.freeMinutes,690-180-90-30-110);
 assert.equal(result.day.legs.reduce((s,x)=>s+x.minutes,0),110);
 assert.equal(dailyTransportSummary({...result.transport,totalMinutes:90,hotelMinutes:90}),'约 1.5 小时');
 assert.doesNotMatch(dailyTransportSummary({...result.transport,totalMinutes:90,hotelMinutes:90}),/超过/);
 assert.equal(dailyTransportSummary({...result.transport,totalMinutes:29,hotelMinutes:29}),'约 0.48 小时');
 assert.equal(dailyTransportSummary({...result.transport,totalMinutes:92,hotelMinutes:48,airportMinutes:44}),'约 1.53 小时');
 assert.equal(dailyTransportSummary({...result.transport,totalMinutes:44,hotelMinutes:0,airportMinutes:44}),'约 0.73 小时');
 assert.match(dailyTransportSummary(undefined),/待核实/);
 assert.match(dailyTransportSummary({...result.transport,airportMinutes:undefined}),/待核实/);
 assert.match(dailyTransportSummary({...result.transport,hotelMinutes:0}),/待核实/);
 const manual=await schedulePlanningDay({...baseDay,travelTotalMinutes:65});assert.equal(manual.transport.source,'user');assert.equal(manual.metrics.travelMinutes,65);assert.equal(manual.metrics.pickupMinutes,0);
});

test('default free-time policy is bound to estimate facts and needs no second user keep action',async()=>{
 const fingerprint=await scheduleFingerprint({day:2,minutes:90});
 const estimates=[{day:2,inputFingerprint:fingerprint,computedAt:'now',metrics:{freeMinutes:200,overtimeMinutes:0}}];
 const keep=defaultFreeTimePolicies(estimates);assert.equal(keep[0].source,'default_policy');assert.equal(keep[0].decision,'keep');
 const changed=defaultFreeTimePolicies([{...estimates[0],metrics:{freeMinutes:170,overtimeMinutes:0}}],keep);
 assert.notEqual(changed[0].estimateFingerprint,keep[0].estimateFingerprint);
 assert.deepEqual(defaultFreeTimePolicies([{...estimates[0],metrics:{freeMinutes:0,overtimeMinutes:30}}]),[]);
 assert.equal(mergePlanningTimeOverride(undefined,{day:2}),undefined);
 assert.deepEqual(mergePlanningTimeOverride({day:2,travelTotalMinutes:65},{day:2,visitMinutesByPlaceId:{one:120}}),{day:2,travelTotalMinutes:65,visitMinutesByPlaceId:{one:120}});
});

test('soft periods do not create artificial noon waiting; explicit legacy periods remain hard',()=>{
 const input={weekdayDescriptions:['Monday: 10:00 AM–7:00 PM'],visitDate:'2026-12-21',arrivalMinute:10*60,durationMinutes:90,preferredPeriod:'afternoon'};
 const soft=planRegularVisit({...input,periodStrength:'soft'});assert.equal(soft.startMinute,600);assert.equal(soft.waitMinutes,0);
 const hard=planRegularVisit(input);assert.equal(hard.startMinute,720);assert.equal(hard.openingWaitMinutes,0);assert.equal(hard.periodFreeMinutes,120);
 const realOpening=planRegularVisit({...input,arrivalMinute:9*60,periodStrength:'soft'});assert.equal(realOpening.openingWaitMinutes,60);
});

test('explicit afternoon gap is free time, with reserves allocated once and no false opening wait',async()=>{
 const input={...baseDay,orderedStops:[baseDay.orderedStops[0],baseDay.orderedStops[1],baseDay.orderedStops.at(-1)],routeReference:reference([0,0]),visitDate:'2026-12-21',openingHoursByStop:{one:['Monday: 9:00 AM–7:00 PM']},periodByStop:{one:'afternoon'},periodConstraintByStop:{one:{strength:'hard',source:'user'}},requestedVisitMinutes:{one:90}};
 const result=await schedulePlanningDay(input);assert.equal(result.metrics.openingWaitMinutes,0);assert.equal(result.metrics.periodFreeMinutes,30);
 assert.equal(result.metrics.freeMinutes,690-90-90-30);assert.equal(result.metrics.overtimeMinutes,0);
});

test('culinary-area included meals are counted once and never silently converted from explicit restaurants',async()=>{
 const input={...baseDay,orderedStops:[baseDay.orderedStops[0],stop('one','food'),baseDay.orderedStops.at(-1)],routeReference:reference([0,0]),sceneRoleByStop:{one:'culinary_area'},includedMealMinutesByStop:{one:45},requestedVisitMinutes:{one:90}};
 const area=await schedulePlanningDay(input);assert.equal(area.metrics.visitMinutes,45);assert.equal(area.metrics.foodMinutes,45);assert.equal(area.metrics.mealReserveMinutes,45);
 assert.equal(area.metrics.freeMinutes,690-90-45-30);
 const restaurant=await schedulePlanningDay({...input,sceneRoleByStop:{one:'restaurant_meal'},includedMealMinutesByStop:{}});
 assert.equal(restaurant.metrics.visitMinutes,0);assert.equal(restaurant.metrics.foodMinutes,90);
});

test('soft end-time warning does not erase hard return constraints or rewrite raw schedule hours',async()=>{
 const soft=await schedulePlanningDay({...baseDay,preferredReturnBy:'12:00',returnBy:'21:00'});assert.equal(soft.metrics.overtimeMinutes,0);assert.ok(soft.metrics.softOverrunMinutes>0);assert.equal(soft.metrics.freeMinutes,0);
 const hard=await schedulePlanningDay({...baseDay,returnBy:'12:00'});assert.ok(hard.metrics.overtimeMinutes>0);
 const advice=buildDailyAdvice({fingerprint:'fp',pace:'relaxed',sceneCount:2,visitMinutes:180,travelMinutes:60,freeMinutes:240,overtimeMinutes:0,freeWindows:[{id:'remaining',startTime:'17:00',endTime:'21:00',minutes:240,fromStopId:'hotel',toStopId:'hotel',kind:'after_route'}]});assert.equal(advice.adjustment.action,'optional_add');assert.match(advice.adjustment.reason,/也可以/);assert.equal(advice.source,'planning_rules');
});


test('unchanged verified airport anchors and route evidence are reused while airport minutes remain separate',async()=>{
 const h={...handoff,dates:{start:'2026-12-20',end:'2026-12-21',days:2}};
 const airport={placeId:'airport-changi',name:'Singapore Changi Airport',address:'Singapore',location:loc,primaryType:'international_airport',types:['airport'],googleMapsUri:null};
 const selection={mode:'manual',arrivalAt:'2026-12-20T05:30',departureAt:'2026-12-21T23:00',arrivalAirportPlaceId:airport.placeId,departureAirportPlaceId:airport.placeId,arrivalAirportName:airport.name,departureAirportName:airport.name};
 const identityFingerprint=await scheduleFingerprint({placeId:airport.placeId,query:'Singapore Changi Airport'});
 const draft={...draftFixture(),candidates:[candidate('place-0001'),candidate('place-0002')],assignments:[1,2].map(day=>({day,orderedCandidateIds:['place-000'+day]})),flightSelection:selection,staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-21',hotel:anchor('hotel-a')}],dayEstimates:[{day:1,routeReference:reference([25,25,40]),airportAnchors:{arrival:{identityFingerprint,place:airport}}},{day:2,routeReference:reference([25,40]),airportAnchors:{departure:{identityFingerprint,place:airport}}}]};
 const first=await calculatePlanningDays(h,draft);assert.equal(first.length,2);
 for(const result of first){assert.ok(result.estimate.transport.airportMinutes>0);assert.equal(result.estimate.transport.airportMinutes+result.estimate.transport.hotelMinutes,result.estimate.metrics.travelMinutes);}
 draft.dayEstimates=first.map(x=>x.estimate);
 const second=await calculatePlanningDays(h,{...draft,scheduleOverrides:[{day:1,visitMinutesByPlaceId:{'place-0001':120}}]},{day:1});
 assert.equal(second.length,1);assert.equal(second[0].estimate.airportAnchors.arrival.place.placeId,airport.placeId);
 assert.equal(second[0].estimate.transport.includesHotelReturn,true);
});




test('schedule API atomically saves only the edited day with default keep, safely replays and skips unchanged requests',async()=>{
 const draft=draftFixture();const calculated=await calculatePlanningDays(handoff,draft);draft.dayEstimates=calculated.map(x=>x.estimate);draft.reviewRequired=['住宿预算'];
 const one=draft.dayEstimates[0],three=draft.dayEstimates[2];globalThis.__scheduleRouteTest={handoff,draft,commits:0};
 const body={action:'updateDay',expectedVersion:1,turnId:'schedule-operation-001',overrides:{day:2,visitMinutesByPlaceId:{'place-0002':120}}};
 const response=await postSchedule(body);assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.draft.freeTimeDecisions.length,3);assert.ok(result.draft.freeTimeDecisions.every(x=>x.decision==='keep'&&x.source==='default_policy'));
 assert.equal(result.draft.dayEstimates[0].computedAt,one.computedAt);assert.equal(result.draft.dayEstimates[2].computedAt,three.computedAt);assert.equal(result.draft.dayEstimates[1].metrics.travelSource,'google');
 assert.deepEqual(result.draft.reviewRequired,['住宿预算']);assert.equal(globalThis.__scheduleRouteTest.commits,1);
 const replay=await postSchedule(body);assert.equal(replay.status,200);assert.equal((await replay.json()).alreadyApplied,true);assert.equal(globalThis.__scheduleRouteTest.commits,1);
 const unchanged=await postSchedule({...body,expectedVersion:2,turnId:'schedule-operation-002'});assert.equal(unchanged.status,200);assert.equal((await unchanged.json()).unchanged,true);assert.equal(globalThis.__scheduleRouteTest.commits,1);
 const final=await postSchedule({action:'confirm',expectedVersion:2,turnId:'schedule-operation-003'});assert.equal(final.status,409);assert.equal((await final.json()).error.code,'REVIEW_REQUIRED');
 globalThis.__scheduleRouteTest.draft.reviewRequired=[];
 const ready=await postSchedule({action:'confirm',expectedVersion:2,turnId:'schedule-operation-004'});assert.equal(ready.status,200);assert.equal((await ready.json()).draft.stage,'complete');
});

test('overlong pending labels reject with capacity first and preserve saved overrides and successful estimates', async () => {
 const h = {...handoff,dailyWindow:{start:'14:30',preferredReturn:'21:00',latestReturn:'21:00'}};
 const draft=draftFixture(); draft.candidates[1].openingHours=['Monday: 9:00 AM–7:00 PM'];
 draft.dayEstimates=(await calculatePlanningDays(h,draft)).map(x=>x.estimate);
 const original=structuredClone(draft); const block={id:'rest-long',day:2,kind:'rest',title:'休息',durationMinutes:480,source:'user',anchor:{nodeId:draft.dayEstimates[1].scheduledDay.stops[0].id,placement:'after'}};
 globalThis.__scheduleRouteTest={handoff:h,draft,commits:0};
 const response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'capacity-reject-label',overrides:{day:2,localBlocks:[block]}});
 assert.equal(response.status,422); const data=await response.json();
 assert.equal(data.error.code,'DAY_CAPACITY_EXCEEDED'); assert.equal(data.capacity.status,'hard_exceeded');
 assert.equal(data.conflicts[0].capacity.deficitMinutes,data.capacity.deficitMinutes); assert.equal(data.blockId,block.id);
 assert.equal(data.capacity.addedMinutes,480); assert.match(data.error.message,/净增 8 小时/);
 assert.equal(globalThis.__scheduleRouteTest.commits,0); assert.deepEqual(globalThis.__scheduleRouteTest.draft,original);
 // Several concurrent pending changes must not claim that just this label caused the problem.
 const mixed=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'capacity-reject-mixed',overrides:{day:2,localBlocks:[block],visitMinutesByPlaceId:{'place-0002':180}}});
 assert.equal(mixed.status,422); assert.equal((await mixed.json()).blockId,undefined);
 // Correcting the same form succeeds and retains unrelated days.
 const corrected=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'capacity-correct-label',overrides:{day:2,localBlocks:[{...block,durationMinutes:30}]}});
 assert.equal(corrected.status,200); assert.equal(globalThis.__scheduleRouteTest.commits,1);
 assert.equal(globalThis.__scheduleRouteTest.draft.dayEstimates[0].computedAt,original.dayEstimates[0].computedAt);
});

test('a real opening conflict after the capacity check also rejects without saving the attempted duration', async () => {
 const draft=draftFixture(); draft.candidates[1].openingHours=['Monday: 10:00 AM–12:00 PM'];
 draft.dayEstimates=(await calculatePlanningDays(handoff,draft)).map(x=>x.estimate);
 const original=structuredClone(draft); globalThis.__scheduleRouteTest={handoff,draft,commits:0};
 const response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'opening-atomic-reject',overrides:{day:2,visitMinutesByPlaceId:{'place-0002':180}}});
 assert.equal(response.status,422); const data=await response.json();
 assert.notEqual(data.error.code,'DAY_CAPACITY_EXCEEDED'); assert.equal(data.conflicts[0].placeId,'place-0002');
 assert.equal(globalThis.__scheduleRouteTest.commits,0); assert.deepEqual(globalThis.__scheduleRouteTest.draft,original);
});

test('a draft changed during failed calculation returns the latest version instead of a stale 422', async () => {
 const h={...handoff,dailyWindow:{start:'14:30',preferredReturn:'21:00',latestReturn:'21:00'}};
 const draft=draftFixture(); draft.dayEstimates=(await calculatePlanningDays(h,draft)).map(x=>x.estimate);
 globalThis.__scheduleRouteTest={handoff:h,draft,commits:0,advanceOnRead:true};
 const block={id:'racing-rest',day:2,kind:'rest',title:'休息',durationMinutes:480,source:'user',anchor:{nodeId:draft.dayEstimates[1].scheduledDay.stops[0].id,placement:'after'}};
 const response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'concurrent-failed-label',overrides:{day:2,localBlocks:[block]}});
 assert.equal(response.status,409); const data=await response.json(); assert.equal(data.error.code,'PLANNING_VERSION_CONFLICT');
 assert.equal(data.draft.version,2); assert.equal(globalThis.__scheduleRouteTest.commits,0);
});

test('full recalculation retains the previous successful day evidence when a saved legacy edit conflicts', async () => {
 const h={...handoff,dailyWindow:{start:'14:30',preferredReturn:'21:00',latestReturn:'21:00'}};
 const draft=draftFixture(); draft.dayEstimates=(await calculatePlanningDays(h,draft)).map(x=>x.estimate);
 const prior=structuredClone(draft.dayEstimates[1]);
 draft.scheduleOverrides=[{day:2,localBlocks:[{id:'legacy-bad-rest',day:2,kind:'rest',title:'休息',durationMinutes:480,source:'user',anchor:{nodeId:prior.scheduledDay.stops[0].id,placement:'after'}}]}];
 globalThis.__scheduleRouteTest={handoff:h,draft,commits:0};
 const response=await postSchedule({action:'calculate',expectedVersion:1,turnId:'calculate-preserve-evidence'});
 assert.equal(response.status,200); const data=await response.json();
 assert.equal(data.draft.dayEstimates.length,3); assert.equal(data.conflicts[0].code,'DAY_CAPACITY_EXCEEDED');
 const retained=data.estimates.find(x=>x.day===2);
 assert.equal(retained.computedAt,prior.computedAt); assert.equal(retained.inputFingerprint,prior.inputFingerprint);
 assert.deepEqual(retained.metrics,prior.metrics); assert.deepEqual(retained.routeReference,prior.routeReference);
 assert.deepEqual(retained.scheduledDay,JSON.parse(JSON.stringify(prior.scheduledDay)));
 // Keeping evidence is for correction; conflict still blocks confirming a map.
 const confirm=await postSchedule({action:'confirm',expectedVersion:2,turnId:'blocked-preserved-evidence'});
 assert.equal(confirm.status,422); assert.equal((await confirm.json()).error.code,'SCHEDULE_CONFLICTS_REQUIRED');
});

test('exceeding the user soft end still saves when the full route and hard cutoff fit', async () => {
 const draft=draftFixture(); draft.dayEstimates=(await calculatePlanningDays(handoff,draft)).map(x=>x.estimate);
 globalThis.__scheduleRouteTest={handoff,draft,commits:0};
 const response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'soft-end-update-safe',overrides:{day:2,dailyWindow:{start:'14:30',preferredReturn:'18:00',latestReturn:'18:00',returnConstraint:{strength:'soft',source:'user'}},localBlocks:[{id:'long-rest',day:2,kind:'rest',title:'休息',durationMinutes:300,source:'user',anchor:{nodeId:draft.dayEstimates[1].scheduledDay.stops[0].id,placement:'after'}}]}});
 assert.equal(response.status,200); const data=await response.json(); const edited=data.estimates.find(x=>x.day===2);
 assert.equal(edited.metrics.overtimeMinutes,0); assert.ok(edited.metrics.softOverrunMinutes>0); assert.equal(globalThis.__scheduleRouteTest.commits,1);
});

test('a valid old estimate without default keep receives the policy without changing route evidence',async()=>{
 const draft=draftFixture();draft.dayEstimates=(await calculatePlanningDays(handoff,draft)).map(x=>x.estimate);const before=draft.dayEstimates.map(x=>x.computedAt);globalThis.__scheduleRouteTest={handoff,draft,commits:0};
 const response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'schedule-policy-migrate',overrides:{day:2}});
 assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.draft.dayEstimates.map(x=>x.computedAt),before);assert.equal(result.draft.freeTimeDecisions.length,3);assert.equal(globalThis.__scheduleRouteTest.commits,1);
});


test('only an explicit user soft-return choice relaxes the deadline; legacy soft metadata does not',async()=>{
 const draft=draftFixture();draft.scheduleOverrides=[{day:2,visitMinutesByPlaceId:{'place-0002':180}}];
 const dailyWindow={start:'09:30',preferredReturn:'12:00',latestReturn:'12:00'};
 const hard=await calculatePlanningDays({...handoff,dailyWindow},draft,{day:2});assert.ok(hard[0].estimate.metrics.overtimeMinutes>0);
 const soft=await calculatePlanningDays({...handoff,dailyWindow:{...dailyWindow,returnConstraint:{strength:'soft',source:'user'}}},draft,{day:2});assert.equal(soft[0].estimate.metrics.overtimeMinutes,0);assert.ok(soft[0].estimate.metrics.softOverrunMinutes>0);assert.equal(soft[0].estimate.metrics.freeMinutes,0);
 const legacy=await calculatePlanningDays({...handoff,dailyWindow:{...dailyWindow,returnConstraint:{strength:'soft',source:'legacy'}}},draft,{day:2});assert.ok(legacy[0].estimate.metrics.overtimeMinutes>0);
});

test('free gaps past the preferred end are not counted as available time before it',async()=>{
 const input={...baseDay,orderedStops:[baseDay.orderedStops[0],baseDay.orderedStops[1],baseDay.orderedStops.at(-1)],routeReference:reference([0,0]),visitDate:'2026-12-21',openingHoursByStop:{one:['Monday: 9:00 AM–7:00 PM']},periodByStop:{one:'afternoon'},periodConstraintByStop:{one:{strength:'hard',source:'user'}},requestedVisitMinutes:{one:90},mealReserveMinutes:0,bufferReserveMinutes:30,preferredReturnBy:'11:00'};
 const result=await schedulePlanningDay(input);assert.equal(result.metrics.periodFreeMinutes,60);assert.equal(result.metrics.freeMinutes,60);assert.ok(result.metrics.softOverrunMinutes>0);
});

test('persisted place-level afternoon requirements survive unassigned-day history and enter the schedule fingerprint',async()=>{
 const draft=draftFixture();draft.candidates[1]={...draft.candidates[1],openingHours:['Monday: 9:00 AM–7:00 PM']};
 const before=await calculatePlanningDays(handoff,draft,{day:2});
 draft.placeTimePreferences={'place-0002':{period:'afternoon',constraint:{strength:'hard',source:'user',evidence:'只能下午'}}};
 const after=await calculatePlanningDays(handoff,draft,{day:2});
 assert.notEqual(before[0].estimate.inputFingerprint,after[0].estimate.inputFingerprint);
 assert.equal(after[0].estimate.scenes[0].preferredPeriod,'afternoon');
 assert.ok(after[0].estimate.scheduledDay.stops.find(s=>s.placeId==='place-0002').time>='12:00');
});

test('schedule API accepts included meals only within a culinary experience and carries them to the final map stop',async()=>{
 const draft=draftFixture();draft.candidates[1]={...draft.candidates[1],kind:'food',sceneRole:'culinary_area'};
 draft.dayEstimates=(await calculatePlanningDays(handoff,draft)).map(x=>x.estimate);globalThis.__scheduleRouteTest={handoff,draft,commits:0};
 let response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'included-meal-invalid',overrides:{day:2,includedMealMinutesByPlaceId:{'place-0002':120}}});assert.equal(response.status,422);assert.equal(globalThis.__scheduleRouteTest.commits,0);
 response=await postSchedule({action:'updateDay',expectedVersion:1,turnId:'included-meal-valid',overrides:{day:2,includedMealMinutesByPlaceId:{'place-0002':45}}});assert.equal(response.status,200);
 const result=await response.json();const estimate=result.draft.dayEstimates.find(x=>x.day===2);
 assert.equal(estimate.metrics.visitMinutes,45);assert.equal(estimate.metrics.foodMinutes,45);assert.equal(estimate.metrics.mealReserveMinutes,45);
 assert.equal(estimate.scenes[0].includedMealMinutes,45);assert.equal(estimate.scheduledDay.stops.find(x=>x.placeId==='place-0002').includedMealMinutes,45);
});

function journeyDraftFixture() {
 const h={...handoff,dates:{start:'2026-12-20',end:'2026-12-21',days:2}};
 const airport={placeId:'airport-changi',name:'Singapore Changi Airport',address:'Singapore',location:loc,primaryType:'international_airport',types:['airport'],googleMapsUri:null};
 const endpoint=(localDateTime,timeZone,name)=>({localDateTime,timeZone,airport:{name}});
 const journey={source:'user',outbound:{source:'user',departure:endpoint('2026-12-19T23:00','Asia/Kolkata','原居地机场'),arrival:endpoint('2026-12-20T12:00','Asia/Singapore',airport.name)},inbound:{source:'user',departure:endpoint('2026-12-21T18:00','Asia/Singapore',airport.name),arrival:endpoint('2026-12-21T23:00','Europe/London','返程机场')}};
 const selection={mode:'manual',arrivalAt:'2026-12-20T12:00',departureAt:'2026-12-21T18:00',arrivalAirportPlaceId:airport.placeId,departureAirportPlaceId:airport.placeId,arrivalAirportName:airport.name,departureAirportName:airport.name,journey};
 const draft={...draftFixture(),candidates:[candidate('place-0001'),candidate('place-0002')],assignments:[1,2].map(day=>({day,orderedCandidateIds:['place-000'+day]})),flightSelection:selection,staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-21',hotel:anchor('hotel-a')}]};
 return {h,draft,airport};
}

test('complete first and last flight axes keep true ticket times and add transport without changing local free time',async()=>{
 const {h,draft,airport}=journeyDraftFixture();
 const identityFingerprint=await scheduleFingerprint({placeId:airport.placeId,query:airport.name});
 draft.dayEstimates=[{day:1,routeReference:reference([25,25,40]),airportAnchors:{arrival:{identityFingerprint,place:airport}}},{day:2,routeReference:reference([25,40]),airportAnchors:{departure:{identityFingerprint,place:airport}}}];
 const full=await calculatePlanningDays(h,draft);
 const legacy=await calculatePlanningDays(h,{...draft,flightSelection:{...draft.flightSelection,journey:undefined}});
 assert.deepEqual(full.map(x=>x.estimate.metrics.freeMinutes),legacy.map(x=>x.estimate.metrics.freeMinutes));
 assert.deepEqual(full[0].estimate.effectiveWindow,{start:'14:00',returnBy:'21:00'});
 assert.deepEqual(full[1].estimate.effectiveWindow,{start:'09:30',returnBy:'15:00'});
 const first=full[0].estimate.journey,last=full[1].estimate.journey;
 assert.deepEqual(first.milestones.map(x=>x.id),['outbound-departure','outbound-arrival','local-activities','hotel-return']);
 assert.deepEqual(last.milestones.map(x=>x.id),['hotel-start','local-activities','inbound-departure','inbound-arrival']);
 assert.equal(first.milestones[0].localDateTime,'2026-12-19T23:00');
 assert.equal(first.milestones[0].airportReminderAt,'2026-12-19T20:00');
 assert.equal(last.milestones[2].localDateTime,'2026-12-21T18:00');
 assert.equal(last.milestones[2].airportReminderAt,'2026-12-21T15:00');
 assert.equal(first.flightMinutes,630);assert.equal(last.flightMinutes,780);
 assert.equal(first.totalTransportMinutes,630+full[0].estimate.metrics.travelMinutes);
 assert.equal(last.totalTransportMinutes,780+full[1].estimate.metrics.travelMinutes);
 assert.equal(first.airportProcessMinutes,120);assert.equal(last.airportPreparationMinutes,180);
 assert.equal(legacy[0].estimate.journey.flightMinutes,null);
 assert.equal(legacy[0].estimate.journey.milestones[0].localDateTime,null);
 assert.equal(legacy[1].estimate.journey.milestones.at(-1).localDateTime,null);
 draft.dayEstimates=full.map(x=>x.estimate);
 const changed=await calculatePlanningDays(h,{...draft,scheduleOverrides:[{day:1,visitMinutesByPlaceId:{'place-0001':120},travelTotalMinutes:0}]},{day:1});
 assert.equal(changed[0].estimate.metrics.travelSource,'google');
 assert.equal(changed[0].estimate.metrics.travelMinutes,full[0].estimate.metrics.travelMinutes);
 assert.equal(full[0].estimate.metrics.freeMinutes-changed[0].estimate.metrics.freeMinutes,30);
 assert.deepEqual(changed[0].estimate.journey.milestones,first.milestones);
});

test('a missing endpoint never becomes zero flight time, and next-day ground travel is counted in its own ledger',()=>{
 const {h,draft}=journeyDraftFixture();
 const estimate={day:2,date:'2026-12-21',dailyWindow:h.dailyWindow,metrics:{travelMinutes:70},nextDayDepartureTransfer:{leg:{minutes:47}}};
 const ledger=buildPlanningDayJourney(h,draft,estimate);
 assert.equal(ledger.flightMinutes,780);assert.equal(ledger.groundMinutes,117);assert.equal(ledger.totalTransportMinutes,897);assert.equal(ledger.nextDayGroundMinutes,47);
 draft.flightSelection.journey.inbound.arrival.timeZone=null;
 const missing=buildPlanningDayJourney(h,draft,estimate);
 assert.equal(missing.flightMinutes,null);assert.equal(missing.totalTransportMinutes,null);
 assert.equal(estimate.metrics.travelMinutes,70);
});

test('editing an outbound outer timestamp invalidates the arrival-day axis without invalidating the return-day result',async()=>{
 const {h,draft}=journeyDraftFixture();
 const before=await Promise.all([1,2].map(day=>planningDayInputFingerprint(h,draft,day)));
 draft.flightSelection.journey.outbound.departure.localDateTime='2026-12-19T22:00';
 const after=await Promise.all([1,2].map(day=>planningDayInputFingerprint(h,draft,day)));
 assert.notEqual(before[0],after[0]);assert.equal(before[1],after[1]);
});
