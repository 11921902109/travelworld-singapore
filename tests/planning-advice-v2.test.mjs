import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';

const loc={lat:1.3,lng:103.85};
const airport={placeId:'changi-airport',name:'Singapore Changi Airport',address:'Singapore',location:loc,types:['airport'],primaryType:'airport',googleMapsUri:null};
const storage={placeId:'storage-point',name:'真实寄存地点',address:'Storage Road, Singapore',location:{lat:1.31,lng:103.84},businessStatus:'OPERATIONAL',openingHours:{weekdayDescriptions:['Sunday: Open 24 hours','Monday: Open 24 hours']}};
const hotel={placeId:'hotel-main',name:'Hotel',address:'Singapore',location:loc,googleMapsUri:null,source:'google_places',verified:true};
const scene=id=>({id,placeId:id,name:id,address:'Singapore',location:loc,area:'滨海湾',category:'建筑',kind:'sight',reason:'建筑体验',estimatedMinutes:60,recommendedMinutes:60,pros:'适合慢逛',cons:'适量步行',source:'preference',sourceNote:'百炼建议',estimateSource:'bailian',verified:true,googleMapsUri:null,openingHours:['Sunday: Open 24 hours','Monday: Open 24 hours']});
const handoff={schemaVersion:1,sourceIntentStateVersion:1,destination:'Singapore',dates:{start:'2026-12-20',end:'2026-12-21',days:2},dailyWindow:{start:'09:30',preferredReturn:'21:00',latestReturn:'21:00'},pace:'relaxed',preferences:{interests:['建筑'],mustVisit:[],avoid:[],mobilityConstraints:[],dietaryPreferences:[],preferredTransport:[],allowAutomaticRecommendations:true},travelers:{total:2},confirmedByUser:true};
const endpoint=(localDateTime)=>({localDateTime,timeZone:'Asia/Singapore',airport:{name:airport.name}});
const selection={mode:'manual',arrivalAt:'2026-12-20T12:00',departureAt:'2026-12-21T20:00',arrivalAirportPlaceId:airport.placeId,departureAirportPlaceId:airport.placeId,arrivalAirportName:airport.name,departureAirportName:airport.name,journey:{outbound:{source:'user',departure:endpoint('2026-12-20T07:00'),arrival:endpoint('2026-12-20T12:00')},inbound:{source:'user',departure:endpoint('2026-12-21T20:00'),arrival:endpoint('2026-12-22T01:00')}}};
function fixture(){return{version:1,handoffId:'test-handoff',sourceIntentStateVersion:1,stage:'route',placesConfirmed:true,selectedPlaceIds:['place-0001','place-0002'],boardConfirmed:true,stayConfirmed:true,flightSelection:selection,candidates:[scene('place-0001'),scene('place-0002')],assignments:[1,2].map(day=>({day,orderedCandidateIds:['place-000'+day],status:'confirmed',dayPurpose:'activities'})),staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-21',hotel}],reviewRequired:[]};}
globalThis.__adviceV2={draft:fixture(),handoff,airport,storage,calls:[],commits:0};
const mocks={
 '@/lib/travel/google-maps':`export const SINGAPORE_BOUNDS={west:103.594,east:104.106,south:1.1496,north:1.4784};export class GoogleMapsServiceError extends Error{};export async function getSingaporePlaceDetails(id){const s=globalThis.__adviceV2;s.calls.push({type:'details',id});return id===s.storage.placeId?s.storage:s.airport;}export async function searchSingaporePlaces(input){const s=globalThis.__adviceV2;s.calls.push({type:'search',input});return[s.storage];}export async function computeSingaporeRoute(input){globalThis.__adviceV2.calls.push({type:'route',input});return{mode:'drive',distanceMeters:1000,distanceText:'1km',durationSeconds:600,durationMinutes:10,durationText:'10min',encodedPolyline:''};}`,
 '@/lib/travel/planning-state':`export async function readPlanningDraft(){return globalThis.__adviceV2.draft;}export async function readPlanningHandoff(){return{handoff:globalThis.__adviceV2.handoff,handoffId:'test-handoff'};}export async function commitPlanningDraft(token,input){const s=globalThis.__adviceV2;if(s.draft.version!==input.expectedVersion)return{committed:false,draft:s.draft};s.commits++;s.draft={...input.nextDraft,version:s.draft.version+1,updatedAt:'2026-11-15T00:00:00Z'};return{committed:true,draft:s.draft};}`,
 '@/lib/travel/planning-scenes':`export async function readPlanningSceneContext(){return{handoff:globalThis.__adviceV2.handoff,draft:globalThis.__adviceV2.draft};}export const PlanningSceneCandidateSchema={safeParse(value){return{success:true,data:value};}};`,
 '@/lib/travel/visit-session':`export function readTravelVisitToken(){return'test-visit-token';}`,
 '@/lib/travel/api-guard':`export function guardSingaporeApi(){return null;}`,
 'next/server':`export class NextRequest extends Request{};export const NextResponse={json(body,options){return Response.json(body,options);}};`,
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:[...Object.keys(mocks).map(find=>({find,replacement:'\0advice-v2:'+find})),{find:'@',replacement:process.cwd()},{find:'cloudflare:workers',replacement:path.join(process.cwd(),'tests/fixtures/flight-agent-env.ts')}]},plugins:[{name:'advice-v2',enforce:'pre',resolveId(id){if(id.startsWith('\0advice-v2:'))return id;const key=Object.keys(mocks).find(key=>id===key||(key.startsWith('@/')&&id===path.join(process.cwd(),key.slice(2))));if(key)return'\0advice-v2:'+key;},load(id){return id.startsWith('\0advice-v2:')?mocks[id.slice('\0advice-v2:'.length)]:null;}}],optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {buildDailyAdvice}=await vite.ssrLoadModule('/lib/travel/planning-schedule-policy.ts');
const {schedulePlanningDay}=await vite.ssrLoadModule('/lib/travel/planning-scheduler.ts');
const {calculatePlanningDays,projectPlanningDayAdvice}=await vite.ssrLoadModule('/lib/travel/planning-trip.ts');
const {POST,GET}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/schedule/route.ts');
const {PlanningTimeOverrideSchema}=await vite.ssrLoadModule('/lib/travel/planning-time-overrides.ts');
const base={fingerprint:'facts',pace:'relaxed',sceneCount:1,visitMinutes:75,travelMinutes:39,freeMinutes:466,overtimeMinutes:0};
const window=(minutes,id='remaining')=>({id,kind:'after_route',startTime:'13:14',endTime:'21:00',minutes,fromStopId:'hotel',toStopId:'hotel'});
const post=body=>POST(new Request('https://local.test/api/travel/singapore/planning/schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedVersion:globalThis.__adviceV2.draft.version,turnId:crypto.randomUUID(),...body})}));
function reset(){globalThis.__adviceV2={draft:fixture(),handoff,airport,storage,calls:[],commits:0};}

test('7.77 hours no longer implies one short visit, and unknown continuity cannot promise a half-day',()=>{
 const valid=buildDailyAdvice({...base,freeWindows:[window(466)]});
 assert.equal(valid.version,2);assert.equal(valid.canSuggestAddition,true);assert.equal(valid.maxContinuousFreeMinutes,466);
 assert.match(valid.adjustment.reason,/7.77 小时/);assert.match(valid.adjustment.reason,/半日体验或多个地点仍需核对/);assert.doesNotMatch(valid.adjustment.reason,/一处短时/);
 const unknown=buildDailyAdvice(base);assert.equal(unknown.canSuggestAddition,false);assert.equal(unknown.reasonCode,'windows_unverified');
});

test('scattered small windows and incomplete estimates cannot drive executable addition advice',()=>{
 const fragmented=buildDailyAdvice({...base,freeMinutes:180,freeWindows:Array.from({length:6},(_,i)=>window(30,'part-'+i))});
 assert.equal(fragmented.maxContinuousFreeMinutes,30);assert.equal(fragmented.canSuggestAddition,false);
 for(const flags of [{currentEstimate:false},{transportComplete:false},{hasConflict:true}]){
  const advice=buildDailyAdvice({...base,freeWindows:[window(466)],...flags});assert.equal(advice.canSuggestAddition,false);assert.equal(advice.reasonCode,'estimate_unavailable');
 }
});

test('arrival and departure remain conservative for both short and long residual time',()=>{
 for(const dayType of ['arrival','departure','arrival_departure'])for(const freeMinutes of [20,221,466]){
  const advice=buildDailyAdvice({...base,dayType,freeMinutes,freeWindows:[window(freeMinutes)],baggageStatus:'unknown'});
  assert.equal(advice.canSuggestAddition,false);assert.equal(advice.needsLogisticsCheck,true);assert.equal(advice.reasonCode,'baggage_unknown');
 }
 const confirmed=buildDailyAdvice({...base,dayType:'departure',baggageStatus:'confirmed',freeWindows:[window(466)]});
 assert.equal(confirmed.canSuggestAddition,false);assert.equal(confirmed.needsLogisticsCheck,false);assert.equal(confirmed.reasonCode,'flight_day');
});

test('hard overtime, rest days and a declined recommendation preserve their distinct reasons',()=>{
 assert.equal(buildDailyAdvice({...base,overtimeMinutes:15}).adjustment.action,'reduce');
 assert.equal(buildDailyAdvice({...base,sceneCount:0}).reasonCode,'rest_day');
 assert.equal(buildDailyAdvice({...base,recommendationDeclined:true,freeWindows:[window(466)]}).canSuggestAddition,false);
});

test('free windows account for real opening waits and use period gaps only after reserves',async()=>{
 const stop=(id,kind)=>({id,placeId:id,name:id,kind,verified:true,location:loc,time:'00:00',endTime:'00:00',openingHours:[],note:'',area:'',x:0,y:0,duration:''});
 const day={id:'day-1',label:'Day 1',date:'12/21',weekday:'周一',theme:'',color:'',summary:'',stops:[],legs:[]};
 const input={day,orderedStops:[stop('hotel','hotel'),stop('gallery','sight'),stop('hotel-end','hotel')],startTime:'09:00',returnBy:'18:00',visitDate:'2026-12-21',taxiPickupMinutes:0,requestedVisitMinutes:{gallery:60},openingHoursByStop:{gallery:['Monday: 10:00 AM–7:00 PM']},periodByStop:{gallery:'afternoon'},periodConstraintByStop:{gallery:{strength:'hard',source:'user'}},mealReserveMinutes:45,bufferReserveMinutes:15,personalMinutes:30};
 const result=await schedulePlanningDay(input);
 assert.equal(result.metrics.openingWaitMinutes,50);
 assert.equal(result.freeWindows.reduce((sum,item)=>sum+item.minutes,0),result.metrics.freeMinutes);
 const gap=result.freeWindows.find(item=>item.kind==='period_gap');
 assert.equal(gap.startTime,'11:30');assert.equal(gap.endTime,'12:00');assert.equal(gap.minutes,30);
 assert.equal(result.freeWindows.some(item=>item.startTime<'10:00'&&item.kind==='period_gap'),false);
});

test('an unassigned rest day has one remaining window and no fictitious outing',async()=>{
 reset();const plain={...globalThis.__adviceV2.draft,flightSelection:{mode:'none'},candidates:[],assignments:[1,2].map(day=>({day,orderedCandidateIds:[],dayPurpose:'rest'})),staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-22',hotel}]};
 const [result]=await calculatePlanningDays(handoff,plain,{day:2});
 assert.equal(result.estimate.freeWindows.length,1);assert.equal(result.estimate.freeWindows[0].minutes,result.estimate.metrics.freeMinutes);assert.equal(result.estimate.advice.reasonCode,'rest_day');
});

test('unknown luggage preserves the existing direct route and does not subtract airport preparation twice',async()=>{
 reset();const [result]=await calculatePlanningDays(handoff,globalThis.__adviceV2.draft,{day:2});
 const e=result.estimate;
 assert.equal(e.effectiveWindow.returnBy,'17:00');assert.equal(e.journey.airportPreparationMinutes,180);
 assert.equal(e.baggage.mode,'undecided');assert.equal(e.advice.canSuggestAddition,false);
 assert.equal(e.scheduledDay.stops.some(stop=>stop.id.includes('baggage')),false);
 const m=e.metrics;assert.equal(m.freeMinutes+m.visitMinutes+m.foodMinutes+m.mealReserveMinutes+m.bufferMinutes+m.logisticsMinutes+m.travelMinutes,450);
});

test('hotel collection replaces the direct airport leg and counts only the actual added handling and travel',async()=>{
 reset();const draft=globalThis.__adviceV2.draft;
 const [baseDay]=await calculatePlanningDays(handoff,draft,{day:2});
 const changed={...draft,scheduleOverrides:[{day:2,baggage:{mode:'hotel',handlingMinutes:5}}]};
 const [result]=await calculatePlanningDays(handoff,changed,{day:2});
 const e=result.estimate,ids=e.scheduledDay.stops.map(stop=>stop.id),pickup='day-2-baggage-collection';
 assert.ok(ids.includes(pickup));assert.equal(e.metrics.logisticsMinutes,5);
 assert.equal(e.scheduledDay.legs.at(-1).from,pickup);assert.equal(e.scheduledDay.legs.at(-1).to,'day-2-airport-departure');
 assert.equal(e.scheduledDay.legs.some(leg=>leg.from.includes('place-0002')&&leg.to==='day-2-airport-departure'),false);
 assert.equal(e.metrics.travelMinutes,e.scheduledDay.legs.reduce((sum,leg)=>sum+leg.minutes,0));
 assert.equal(baseDay.estimate.metrics.freeMinutes-e.metrics.freeMinutes,23);
 assert.equal(e.baggage.needsCollection,true);assert.equal(e.baggage.status,'confirmed');
});

test('other confirmed storage inserts both handling visits and includes every detour',async()=>{
 reset();const override={day:2,baggage:{mode:'other',placeId:storage.placeId,handlingMinutes:15,storagePlace:{...storage,openingHours:storage.openingHours.weekdayDescriptions}}};
 const [result]=await calculatePlanningDays(handoff,{...globalThis.__adviceV2.draft,scheduleOverrides:[override]},{day:2});
 const e=result.estimate;
 assert.equal(e.metrics.logisticsMinutes,30);assert.equal(e.metrics.visitMinutes,60);
 assert.deepEqual(e.scheduledDay.stops.filter(stop=>stop.id.includes('baggage')).map(stop=>stop.id),['day-2-baggage-deposit','day-2-baggage-collection']);
 assert.equal(e.scheduledDay.legs.length,4);assert.equal(e.metrics.travelMinutes,72);
 assert.equal(e.scheduledDay.legs.at(-1).from,'day-2-baggage-collection');
 assert.equal(e.freeWindows.reduce((sum,w)=>sum+w.minutes,0),e.metrics.freeMinutes);
});

test('saved baggage changes travel feasibility and preserves hard overtime rather than erasing it',async()=>{
 reset();const draft={...globalThis.__adviceV2.draft,scheduleOverrides:[{day:2,visitMinutesByPlaceId:{'place-0002':360},baggage:{mode:'hotel',handlingMinutes:120}}]};
 const [result]=await calculatePlanningDays(handoff,draft,{day:2});
 assert.ok(result.estimate.metrics.overtimeMinutes>0);assert.equal(result.estimate.advice.adjustment.action,'reduce');assert.equal(result.estimate.advice.canSuggestAddition,false);
});

test('cached and restored advice upgrades without any Google route query',async()=>{
 reset();const draft=globalThis.__adviceV2.draft;
 const results=await calculatePlanningDays(handoff,draft);draft.dayEstimates=results.map(item=>({...item.estimate,advice:{source:'planning_rules',adjustment:{action:'optional_add',reason:'一处短时地点'}}}));
 globalThis.__adviceV2.calls=[];
 const cached=await calculatePlanningDays(handoff,draft,{day:2});assert.equal(cached[0].estimate.advice.version,2);assert.equal(globalThis.__adviceV2.calls.length,0);
 const response=await GET(new Request('https://local.test/api/travel/singapore/planning/schedule'));assert.equal(response.status,200);
 const restored=await response.json();assert.equal(restored.draft.dayEstimates[1].advice.version,2);assert.equal(restored.draft.dayEstimates[1].advice.canSuggestAddition,false);assert.equal(globalThis.__adviceV2.calls.length,0);
 const stale=projectPlanningDayAdvice(handoff,draft,results[1].estimate,false);assert.equal(stale.advice.reasonCode,'estimate_unavailable');
});

test('storage search is read only, returns real matches and never commits a new planning version',async()=>{
 reset();const response=await post({action:'searchBaggagePlaces',query:'寄存',day:2});assert.equal(response.status,200);
 const data=await response.json();assert.deepEqual(data.matches,[{placeId:storage.placeId,name:storage.name,address:storage.address}]);
 assert.equal(data.draft.version,1);assert.equal(globalThis.__adviceV2.commits,0);assert.equal(globalThis.__adviceV2.calls.filter(call=>call.type==='search').length,1);
});

test('storage save discards forged coordinates and uses the server verified identity',async()=>{
 reset();const response=await post({action:'updateDay',overrides:{day:2,baggage:{mode:'other',handlingMinutes:15,placeId:storage.placeId,storagePlace:{placeId:storage.placeId,name:'伪造',address:'伪造',location:{lat:1.4,lng:104}}}}});
 assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const data=await response.json(),bag=data.draft.scheduleOverrides[0].baggage;
 assert.equal(bag.storagePlace.name,storage.name);assert.deepEqual(bag.storagePlace.location,storage.location);
 assert.equal(data.draft.dayEstimates[0].metrics.logisticsMinutes,30);
 assert.equal(globalThis.__adviceV2.calls.filter(call=>call.type==='details'&&call.id===storage.placeId).length,1);
});

test('storage inputs require a real identity and an explicit operation duration',()=>{
 assert.equal(PlanningTimeOverrideSchema.safeParse({day:2,baggage:{mode:'hotel'}}).success,false);
 assert.equal(PlanningTimeOverrideSchema.safeParse({day:2,baggage:{mode:'other',handlingMinutes:15}}).success,false);
 assert.equal(PlanningTimeOverrideSchema.safeParse({day:2,baggage:{mode:'carry'}}).success,true);
 assert.equal(PlanningTimeOverrideSchema.safeParse({day:2,baggage:{mode:'undecided'}}).success,true);
});
