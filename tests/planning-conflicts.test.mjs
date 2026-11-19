import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { planRegularVisit } from '../lib/travel/planning-hours.ts';

const loc={lat:1.3,lng:103.85};
const anchor={placeId:'hotel-main',name:'Hotel',address:'Singapore',location:loc,googleMapsUri:null,source:'google_places',verified:true};
const opening=['Sunday: 10:00 AM–7:00 PM','Monday: 10:00 AM–7:00 PM','Tuesday: 10:00 AM–7:00 PM'];
const scene=(id,estimatedMinutes=60)=>({id,placeId:id,name:id==='gallery-001'?'国家美术馆':id,address:'Singapore',location:loc,area:'市政区',category:'建筑',kind:'sight',reason:'建筑体验',estimatedMinutes,recommendedMinutes:estimatedMinutes,pros:'适合慢逛',cons:'适量步行',source:'preference',sourceNote:'百炼建议',estimateSource:'bailian',verified:true,googleMapsUri:null,rating:4,userRatingCount:10,openingHours:opening});
const handoff={schemaVersion:1,sourceIntentStateVersion:1,destination:'Singapore',dates:{start:'2026-12-20',end:'2026-12-22',days:3},dailyWindow:{start:'09:30',preferredReturn:'21:00',latestReturn:'21:00'},pace:'relaxed',preferences:{interests:['建筑'],mustVisit:[],avoid:[],mobilityConstraints:[],dietaryPreferences:[],preferredTransport:[],allowAutomaticRecommendations:true},travelers:{total:2},confirmedByUser:true};
const fixture=()=>({version:1,handoffId:'test-handoff',sourceIntentStateVersion:1,stage:'route',boardConfirmed:true,stayConfirmed:true,
 flightSelection:{mode:'manual',arrivalAt:'2026-12-20T15:00',departureAt:'2026-12-22T23:00',arrivalAirportPlaceId:'airport-arrival',departureAirportPlaceId:'airport-departure',arrivalAirportName:'Changi Airport',departureAirportName:'Changi Airport'},
 candidates:[scene('gallery-001',150),scene('park-002')],assignments:[{day:1,orderedCandidateIds:['gallery-001'],periodByCandidateId:{'gallery-001':'afternoon'},periodConstraintByCandidateId:{'gallery-001':{strength:'hard',source:'user'}}},{day:2,orderedCandidateIds:['park-002'],periodByCandidateId:{'park-002':'afternoon'}},{day:3,orderedCandidateIds:[],dayPurpose:'rest'}],
 staySegments:[{startDay:1,area:'Bugis',checkInDate:'2026-12-20',checkOutDate:'2026-12-22',hotel:anchor}],reviewRequired:[]});
const mocks={
 '@/lib/travel/google-maps': `
  const loc={lat:1.3,lng:103.85};
  export const SINGAPORE_BOUNDS={west:103,east:105,south:1,north:2};
  export async function getSingaporePlaceDetails(id){return {placeId:id,name:'Changi Airport',address:'Singapore',location:loc,googleMapsUri:null,primaryType:'airport',types:['airport']};}
  export async function searchSingaporePlaces(){return [];}
  export async function computeSingaporeRoute({origin,destination}){
   const unavailable = globalThis.__conflictTest?.unavailableRouteLocation;
   if (unavailable && [origin,destination].some(waypoint => waypoint.lat === unavailable.lat && waypoint.lng === unavailable.lng)) {
    const error = new Error('Mock Google Routes outage');
    error.name = 'GoogleMapsServiceError';
    throw error;
   }
   return {mode:'drive',distanceMeters:1000,distanceText:'1km',durationSeconds:600,durationMinutes:10,durationText:'10min',encodedPolyline:''};
  }`,
 '@/lib/travel/planning-state': `export async function readPlanningDraft(){return globalThis.__conflictTest.draft;} export async function commitPlanningDraft(token,input){const s=globalThis.__conflictTest;if(s.draft.version!==input.expectedVersion)return{committed:false,draft:s.draft};s.commits++;s.draft={...input.nextDraft,version:s.draft.version+1,updatedAt:'2026-11-05T00:00:00Z'};return{committed:true,draft:s.draft};}`,
 '@/lib/travel/planning-scenes': `export async function readPlanningSceneContext(){return{handoff:globalThis.__conflictTest.handoff,draft:globalThis.__conflictTest.draft};} export const PlanningSceneCandidateSchema={safeParse(value){return{success:true,data:value};}};`,
 '@/lib/travel/visit-session': `export function readTravelVisitToken(){return'test-visit-token';}`,
 '@/lib/travel/api-guard': `export function guardSingaporeApi(){return null;}`,
 'next/server': `export class NextRequest extends Request {} export const NextResponse={json(body,options){return new Response(JSON.stringify(body),{status:options?.status||200,headers:{'Content-Type':'application/json',...options?.headers}});}};`,
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:[...Object.keys(mocks).map(find=>({find,replacement:'\0conflict-mock:'+find})),{find:'@',replacement:process.cwd()},{find:'cloudflare:workers',replacement:path.join(process.cwd(),'tests/fixtures/flight-agent-env.ts')}]},plugins:[{name:'conflict-boundaries',enforce:'pre',resolveId(id){if(id.startsWith('\0conflict-mock:'))return id;const key=Object.keys(mocks).find(key=>id===key||(key.startsWith('@/')&&id===path.join(process.cwd(),key.slice(2))));if(key)return'\0conflict-mock:'+key;},load(id){return id.startsWith('\0conflict-mock:')?mocks[id.slice('\0conflict-mock:'.length)]:null;}}],optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {calculatePlanningOutcome,previewScheduleMove,draftForScheduleMove}=await vite.ssrLoadModule('/lib/travel/planning-trip.ts');
const {POST}=await vite.ssrLoadModule('/app/api/travel/singapore/planning/schedule/route.ts');
const post=(body)=>POST(new Request('https://local.test/api/travel/singapore/planning/schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));

test('opening window exact closing boundary and one-minute deficit preserve integer evidence',()=>{
 const input={weekdayDescriptions:opening,visitDate:'2026-12-21',durationMinutes:150,preferredPeriod:'afternoon'};
 assert.equal(planRegularVisit({...input,arrivalMinute:990}).status,'scheduled');
 const failed=planRegularVisit({...input,arrivalMinute:991});assert.equal(failed.status,'closed');assert.equal(failed.failure.missingMinutes,1);assert.equal(failed.failure.latestFeasibleStart,990);assert.equal(failed.failure.reasonCode,'arrival_too_late');
});

test('late arrival conflict explains actual flight, airport reserve, hotel and traffic while other days survive',async()=>{
 const result=await calculatePlanningOutcome(handoff,fixture());
 assert.equal(result.conflicts.length,1);assert.equal(result.estimates.length,2);
 const c=result.conflicts[0];assert.equal(c.day,1);assert.equal(c.placeId,'gallery-001');assert.equal(c.arrivalAt,'2026-12-20T15:00');assert.equal(c.airportReserveMinutes,120);assert.equal(c.hotelMinutes,0);assert.equal(c.routeMinutes,36);assert.equal(c.window.visitMinutes,150);assert.equal(c.window.earliestVisitStart,1056);assert.equal(c.window.missingMinutes,66);assert.match(c.message,/15:00/);assert.match(c.message,/19:00/);assert.match(c.message,/Day 2/);
});

test('first calculation persists partial results while failed duration edits are atomic and remain correctable',async()=>{
 globalThis.__conflictTest={draft:fixture(),handoff,commits:0};
 let response=await post({action:'calculate',expectedVersion:1,turnId:'calculate-first'});assert.equal(response.status,200);
 let data=await response.json();assert.equal(data.draft.scheduleConflicts.length,1);assert.equal(data.draft.dayEstimates.length,2);
 const selected=data.draft.flightSelection,stay=data.draft.staySegments;
 response=await post({action:'updateDay',expectedVersion:2,turnId:'update-conflict',overrides:{day:1,visitMinutesByPlaceId:{'gallery-001':90}}});assert.equal(response.status,422);
 data=await response.json();assert.equal(data.conflicts[0].window.visitMinutes,90);assert.equal(data.conflicts[0].visitSource,'user');
 const saved=globalThis.__conflictTest.draft;assert.equal(saved.version,2);assert.equal(saved.scheduleOverrides,undefined);assert.equal(saved.dayEstimates.length,2);assert.deepEqual(saved.flightSelection,selected);assert.deepEqual(saved.staySegments,stay);
 response=await post({action:'confirm',expectedVersion:2,turnId:'confirm-with-conflict'});assert.equal(response.status,422);
 response=await post({action:'updateDay',expectedVersion:2,turnId:'resolve-conflict',overrides:{day:1,visitMinutesByPlaceId:{'gallery-001':30}}});assert.equal(response.status,200);data=await response.json();assert.equal(data.draft.scheduleConflicts.length,0);assert.equal(data.draft.dayEstimates.length,3);
});

test('conflict operation replay does not repeat commits when no estimate exists for failed day',async()=>{
 globalThis.__conflictTest={draft:fixture(),handoff,commits:0};
 const body={action:'calculate',expectedVersion:1,turnId:'replay-conflict-001'};
 await post(body);const commits=globalThis.__conflictTest.commits;const response=await post(body);assert.equal(response.status,200);assert.equal((await response.json()).alreadyApplied,true);assert.equal(globalThis.__conflictTest.commits,commits);
});

test('next-day preview does not move until confirmed, checks both days, carries user duration and rejects stale preview',async()=>{
 const draft=fixture();draft.scheduleOverrides=[{day:1,visitMinutesByPlaceId:{'gallery-001':135}}];
 const move={day:1,targetDay:2,placeId:'gallery-001'};
 const prepared=draftForScheduleMove(handoff,draft,move);assert.equal(prepared.scheduleOverrides.find(x=>x.day===2).visitMinutesByPlaceId['gallery-001'],135);assert.equal(draft.assignments[0].orderedCandidateIds.length,1);
 const {preview}=await previewScheduleMove(handoff,draft,move);assert.equal(preview.feasible,true);assert.equal(preview.days.length,2);assert.equal(preview.days.find(x=>x.day===1).placeNames.length,0);
 globalThis.__conflictTest={draft,handoff,commits:0};let response=await post({action:'previewMove',move,expectedVersion:1,turnId:'preview-next-day'});assert.equal(response.status,200);const data=await response.json();assert.equal(globalThis.__conflictTest.commits,0);
 response=await post({action:'applyMove',move,previewFingerprint:'stale-fingerprint',expectedVersion:1,turnId:'stale-next-day'});assert.equal(response.status,409);assert.equal(globalThis.__conflictTest.commits,0);
 response=await post({action:'applyMove',move,previewFingerprint:data.movePreview.fingerprint,expectedVersion:1,turnId:'apply-next-day'});assert.equal(response.status,200);const result=await response.json();assert.equal(result.draft.assignments[0].orderedCandidateIds.length,0);assert.ok(result.draft.assignments[1].orderedCandidateIds.includes('gallery-001'));assert.equal(result.draft.dayEstimates.length,2);assert.deepEqual(result.draft.flightSelection,draft.flightSelection);assert.deepEqual(result.draft.staySegments,draft.staySegments);
});

test('next day closed prevents move and unknown hours cannot be advertised as verified feasible',async()=>{
 const draft=fixture();draft.candidates[0].openingHours=['Sunday: 10:00 AM–7:00 PM','Monday: Closed'];
 const move={day:1,targetDay:2,placeId:'gallery-001'};
 let result=await previewScheduleMove(handoff,draft,move);assert.equal(result.preview.feasible,false);assert.equal(result.preview.conflicts[0].code,'closed_day');
 draft.candidates[0].openingHours=[];result=await previewScheduleMove(handoff,draft,move);assert.equal(result.preview.feasible,false);assert.ok(result.preview.conflicts.some(x=>x.code==='OPENING_HOURS_UNKNOWN'));
});

test('user-selected AM grouping requests confirmation before crossing, while a model-only suggestion can adapt',async()=>{
 const draft=fixture();draft.flightSelection={mode:'none'};draft.staySegments[0].checkOutDate='2026-12-23';
 const later={...handoff,dailyWindow:{start:'13:00',preferredReturn:'21:00',latestReturn:'21:00'}};
 draft.candidates[0].estimatedMinutes=90;
 draft.assignments[0].periodByCandidateId={'gallery-001':'morning'};
 draft.assignments[0].periodConstraintByCandidateId={'gallery-001':{strength:'soft',source:'user'}};
 let result=await calculatePlanningOutcome(later,draft,{days:[1]});
 assert.equal(result.conflicts[0].code,'period_conflict');assert.equal(result.conflicts[0].periodStrength,'soft');
 draft.assignments[0].periodConstraintByCandidateId={'gallery-001':{strength:'soft',source:'suggestion'}};
 result=await calculatePlanningOutcome(later,draft,{days:[1]});assert.equal(result.conflicts.length,0);assert.equal(result.estimates.length,1);
 draft.assignments[0].periodConstraintByCandidateId={'gallery-001':{strength:'hard',source:'user'}};
 result=await calculatePlanningOutcome(later,draft,{days:[1]});assert.equal(result.conflicts[0].code,'period_conflict');assert.equal(result.conflicts[0].periodStrength,'hard');
});

test('same-day afternoon preview preserves original AM until explicit apply and carries hard requirement evidence',async()=>{
 const draft=fixture();draft.flightSelection.arrivalAt='2026-12-20T12:00';draft.candidates[0].estimatedMinutes=90;
 draft.assignments[0].periodByCandidateId={'gallery-001':'morning'};
 draft.assignments[0].periodConstraintByCandidateId={'gallery-001':{strength:'hard',source:'user',evidence:'我原先只能上午'}};
 draft.scheduleOverrides=[{day:1,visitMinutesByPlaceId:{'gallery-001':90}}];
 const move={day:1,targetDay:1,placeId:'gallery-001',targetPeriod:'afternoon'};
 const original=structuredClone(draft);
 const {preview,moved}=await previewScheduleMove(handoff,draft,move);
 assert.equal(preview.feasible,true);assert.equal(preview.days.length,1);assert.equal(preview.periodChange.from,'morning');assert.equal(preview.periodChange.to,'afternoon');assert.equal(preview.periodChange.strength,'hard');assert.equal(preview.periodChange.evidence,'我原先只能上午');
 assert.deepEqual(draft,original);assert.equal(moved.assignments[0].periodByCandidateId['gallery-001'],'afternoon');assert.equal(moved.placeTimePreferences['gallery-001'].period,'afternoon');assert.match(moved.placeTimePreferences['gallery-001'].constraint.evidence,/原.*上午.*固定要求/);
 globalThis.__conflictTest={draft,handoff,commits:0};
 let response=await post({action:'previewMove',move,expectedVersion:1,turnId:'preview-same-afternoon'});assert.equal(response.status,200);const data=await response.json();assert.equal(globalThis.__conflictTest.commits,0);assert.equal(globalThis.__conflictTest.draft.assignments[0].periodByCandidateId['gallery-001'],'morning');
 response=await post({action:'applyMove',move,previewFingerprint:data.movePreview.fingerprint,expectedVersion:1,turnId:'apply-same-afternoon'});assert.equal(response.status,200);const applied=await response.json();assert.equal(applied.draft.assignments[0].periodByCandidateId['gallery-001'],'afternoon');assert.equal(applied.draft.placeTimePreferences['gallery-001'].period,'afternoon');assert.equal(applied.draft.dayEstimates.length,1);assert.deepEqual(applied.draft.flightSelection,original.flightSelection);assert.deepEqual(applied.draft.staySegments,original.staySegments);
});

test('same-day adjustment still refuses late closing and cannot claim unknown hours as feasible',async()=>{
 const draft=fixture();draft.assignments[0].periodByCandidateId={'gallery-001':'morning'};
 const move={day:1,targetDay:1,placeId:'gallery-001',targetPeriod:'afternoon'};
 let result=await previewScheduleMove(handoff,draft,move);assert.equal(result.preview.feasible,false);assert.ok(result.preview.conflicts.some(item=>item.code==='arrival_too_late'));
 draft.flightSelection.arrivalAt='2026-12-20T12:00';draft.candidates[0].openingHours=[];
 result=await previewScheduleMove(handoff,draft,move);assert.equal(result.preview.feasible,false);assert.ok(result.preview.conflicts.some(item=>item.code==='OPENING_HOURS_UNKNOWN'));
 assert.equal(draft.assignments[0].periodByCandidateId['gallery-001'],'morning');
});

test('same-day preview cannot be replayed after route or input changes and ordinary move requires a different day',async()=>{
 const draft=fixture();draft.flightSelection.arrivalAt='2026-12-20T12:00';draft.candidates[0].estimatedMinutes=90;draft.assignments[0].periodByCandidateId={'gallery-001':'morning'};
 assert.throws(()=>draftForScheduleMove(handoff,draft,{day:1,targetDay:1,placeId:'gallery-001'}),/其他有效旅行日/);
 const move={day:1,targetDay:1,placeId:'gallery-001',targetPeriod:'afternoon'};
 const {preview}=await previewScheduleMove(handoff,draft,move);
 globalThis.__conflictTest={draft:{...draft,candidates:draft.candidates.map((item)=>item.id==='gallery-001'?{...item,estimatedMinutes:100}:item)},handoff,commits:0};
 const response=await post({action:'applyMove',move,previewFingerprint:preview.fingerprint,expectedVersion:1,turnId:'stale-same-afternoon'});assert.equal(response.status,409);assert.equal(globalThis.__conflictTest.commits,0);
 delete draft.assignments[0].periodConstraintByCandidateId;
 const legacy=await previewScheduleMove(handoff,draft,move);assert.equal(legacy.preview.periodChange.strength,'hard');assert.equal(legacy.moved.placeTimePreferences['gallery-001'].constraint.strength,'hard');
});

function arrivalDayConflictFixture() {
 const draft = fixture();
 draft.flightSelection.arrivalAt = '2026-12-20T12:49';
 draft.candidates = [
  {...scene('chijmes-001', 45), name:'赞美广场'},
  {...scene('artscience-003', 45), name:'艺术科学博物馆'},
  {...scene('park-002'), name:'Park View Square'},
 ];
 draft.assignments[0] = {
  day:1,
  orderedCandidateIds:['chijmes-001', 'artscience-003'],
  periodByCandidateId:{'chijmes-001':'morning', 'artscience-003':'morning'},
  periodConstraintByCandidateId:{
   'chijmes-001':{strength:'soft', source:'user'},
   'artscience-003':{strength:'hard', source:'user', evidence:'博物馆只能上午'},
  },
 };
 draft.scheduleOverrides = [{day:1, visitMinutesByPlaceId:{'chijmes-001':75}}];
 return draft;
}

const moveArtScienceToAfternoon = {day:1, targetDay:1, placeId:'artscience-003', targetPeriod:'afternoon'};

test('confirmed midday arrival surfaces both morning blockers before any move is proposed', async () => {
 const result = await calculatePlanningOutcome(handoff, arrivalDayConflictFixture());
 assert.deepEqual(result.conflicts.map(({day, code, placeId}) => [day, code, placeId]), [
  [1, 'period_conflict', 'chijmes-001'],
  [1, 'period_conflict', 'artscience-003'],
 ]);
 assert.equal(result.conflicts[1].periodStrength, 'hard');
 assert.equal(result.conflicts[1].startBoundaryOnly, true);
 assert.deepEqual(result.estimates.map(({day}) => day), [2, 3]);
});

test('adding ArtScience to the same-day preview retains the CHIJMES proposal and saves them together', async () => {
 const draft = arrivalDayConflictFixture();
 const original = structuredClone(draft);
 const state = globalThis.__conflictTest = {draft, handoff, commits:0};
 const moveChijmes = {day:1, targetDay:1, placeId:'chijmes-001', targetPeriod:'afternoon'};

 let response = await post({action:'previewMove', moves:[moveChijmes], expectedVersion:1, turnId:'same-day-first-proposal'});
 assert.equal(response.status, 200);
 const initial = (await response.json()).movePreview;
 assert.equal(initial.feasible, false);
 assert.deepEqual(initial.affectedDays, [1]);
 assert.deepEqual(initial.moves.map(({placeId}) => placeId), ['chijmes-001']);
 assert.deepEqual(initial.conflicts.map(({day, placeId}) => [day, placeId]), [[1, 'artscience-003']]);
 response = await post({action:'applyMove', moves:[moveChijmes], previewFingerprint:initial.fingerprint, expectedVersion:1, turnId:'same-day-reject-partial'});
 assert.equal(response.status, 422);
 assert.equal((await response.json()).error.code, 'MOVE_NOT_FEASIBLE');
 assert.equal(state.commits, 0);
 assert.deepEqual(state.draft, original);

 const moves = [moveChijmes, moveArtScienceToAfternoon];
 response = await post({action:'previewMove', moves, expectedVersion:1, turnId:'same-day-both-proposals'});
 assert.equal(response.status, 200);
 const combined = (await response.json()).movePreview;
 assert.equal(combined.feasible, true);
 assert.notEqual(combined.fingerprint, initial.fingerprint);
 assert.deepEqual(combined.moves.map(({placeId, targetPeriod}) => [placeId, targetPeriod]), [
  ['chijmes-001', 'afternoon'], ['artscience-003', 'afternoon'],
 ]);
 assert.deepEqual(combined.days.map(({day}) => day), [1]);
 assert.equal(combined.requiresAcknowledgement, true);
 response = await post({action:'applyMove', moves, previewFingerprint:combined.fingerprint, expectedVersion:1, turnId:'same-day-ack-required'});
 assert.equal(response.status, 422);
 assert.equal((await response.json()).error.code, 'MOVE_PREFERENCE_REQUIRED');
 assert.equal(state.commits, 0);
 assert.deepEqual(state.draft, original);

 response = await post({action:'applyMove', moves, previewFingerprint:combined.fingerprint, preferenceAcknowledged:true, expectedVersion:1, turnId:'same-day-apply-all'});
 assert.equal(response.status, 200);
 assert.equal(state.commits, 1);
 assert.equal(state.draft.version, 2);
 assert.deepEqual(state.draft.assignments[0].periodByCandidateId, {'chijmes-001':'afternoon', 'artscience-003':'afternoon'});
 assert.equal(state.draft.assignments[0].periodConstraintByCandidateId['artscience-003'].strength, 'hard');
 assert.match(state.draft.assignments[0].periodConstraintByCandidateId['artscience-003'].evidence, /博物馆只能上午/);
});

test('cross-day preview retains passing Day 2 and atomically applies both proposals after both days pass', async () => {
 const state = globalThis.__conflictTest = {draft:arrivalDayConflictFixture(), handoff, commits:0};
 let response = await post({action:'calculate', expectedVersion:1, turnId:'cross-day-original-calculation'});
 assert.equal(response.status, 200);
 const original = structuredClone(state.draft);
 const commits = state.commits;
 const moveChijmes = {day:1, targetDay:2, placeId:'chijmes-001'};

 response = await post({action:'previewMove', moves:[moveChijmes], expectedVersion:2, turnId:'cross-day-first-proposal'});
 assert.equal(response.status, 200);
 const initial = (await response.json()).movePreview;
 assert.equal(initial.feasible, false);
 assert.deepEqual(initial.affectedDays, [1, 2]);
 assert.deepEqual(initial.days.map(({day}) => day), [2]);
 assert.deepEqual(initial.days[0].placeNames.slice().sort(), ['Park View Square', '赞美广场']);
 assert.deepEqual(initial.conflicts.map(({day, placeId}) => [day, placeId]), [[1, 'artscience-003']]);

 const moves = [moveChijmes, moveArtScienceToAfternoon];
 response = await post({action:'previewMove', moves, expectedVersion:2, turnId:'cross-day-both-proposals'});
 assert.equal(response.status, 200);
 const combined = (await response.json()).movePreview;
 assert.equal(combined.feasible, true);
 assert.deepEqual(combined.days.map(({day}) => day), [1, 2]);
 assert.deepEqual(combined.days.find(({day}) => day === 1).placeNames, ['艺术科学博物馆']);
 assert.deepEqual(combined.days.find(({day}) => day === 2), initial.days[0]);

 response = await post({action:'applyMove', moves, previewFingerprint:initial.fingerprint, expectedVersion:2, turnId:'cross-day-reject-stale-list'});
 assert.equal(response.status, 409);
 assert.equal((await response.json()).error.code, 'MOVE_PREVIEW_STALE');
 response = await post({action:'previewMove', moves:[moveChijmes, {...moveChijmes, targetDay:3}], expectedVersion:2, turnId:'cross-day-reject-duplicate'});
 assert.equal(response.status, 422);
 response = await post({action:'applyMove', moves, previewFingerprint:combined.fingerprint, expectedVersion:1, turnId:'cross-day-reject-old-version'});
 assert.equal(response.status, 409);
 assert.equal((await response.json()).error.code, 'PLANNING_VERSION_CONFLICT');
 assert.equal(state.commits, commits);
 assert.deepEqual(state.draft, original);

 const apply = {action:'applyMove', moves, previewFingerprint:combined.fingerprint, preferenceAcknowledged:true, expectedVersion:2, turnId:'cross-day-apply-all'};
 response = await post(apply);
 assert.equal(response.status, 200);
 assert.equal(state.commits, commits + 1);
 assert.equal(state.draft.version, 3);
 assert.deepEqual(state.draft.assignments[0].orderedCandidateIds, ['artscience-003']);
 assert.equal(state.draft.assignments[0].periodByCandidateId['artscience-003'], 'afternoon');
 assert.ok(state.draft.assignments[1].orderedCandidateIds.includes('chijmes-001'));
 assert.equal(state.draft.assignments[1].periodByCandidateId['chijmes-001'], 'morning');
 assert.equal(state.draft.scheduleOverrides.find(({day}) => day === 2).visitMinutesByPlaceId['chijmes-001'], 75);
 assert.deepEqual(state.draft.scheduleConflicts, []);
 assert.deepEqual(state.draft.dayEstimates.find(({day}) => day === 3), original.dayEstimates.find(({day}) => day === 3));
 assert.deepEqual(state.draft.flightSelection, original.flightSelection);
 assert.deepEqual(state.draft.staySegments, original.staySegments);

 response = await post(apply);
 assert.equal(response.status, 200);
 assert.equal((await response.json()).alreadyApplied, true);
 assert.equal(state.commits, commits + 1);
});

test('moving both places still calculates the empty source day and rejects closed or unverified destinations', async () => {
 const draft = arrivalDayConflictFixture();
 const state = globalThis.__conflictTest = {draft, handoff, commits:0};
 const moves = ['chijmes-001', 'artscience-003'].map((placeId) => ({day:1, targetDay:2, placeId}));
 const artScience = draft.candidates.find(({id}) => id === 'artscience-003');
 const preview = async (turnId) => {
  const response = await post({action:'previewMove', moves, expectedVersion:1, turnId});
  assert.equal(response.status, 200);
  return (await response.json()).movePreview;
 };

 artScience.openingHours = ['Monday: Closed'];
 let result = await preview('empty-source-closed');
 assert.equal(result.feasible, false);
 assert.ok(result.conflicts.some(({day, placeId, code}) => day === 2 && placeId === 'artscience-003' && code === 'closed_day'));

 artScience.openingHours = [];
 result = await preview('empty-source-unknown');
 assert.equal(result.feasible, false);
 assert.ok(result.conflicts.some(({day, placeId, code}) => day === 2 && placeId === 'artscience-003' && code === 'OPENING_HOURS_UNKNOWN'));

 artScience.openingHours = opening;
 result = await preview('empty-source-feasible');
 assert.equal(result.feasible, true);
 assert.deepEqual(result.days.find(({day}) => day === 1).placeNames, []);
 assert.equal(state.commits, 0);
 assert.deepEqual(state.draft.assignments[0].orderedCandidateIds, ['chijmes-001', 'artscience-003']);
});

test('temporary route outage retains Day 2 as passed while Day 1 waits for retry', async () => {
 const draft = arrivalDayConflictFixture();
 const unavailableRouteLocation = {lat:1.35, lng:103.89};
 draft.candidates.find(({id}) => id === 'artscience-003').location = unavailableRouteLocation;
 const original = structuredClone(draft);
 const state = globalThis.__conflictTest = {draft, handoff, commits:0, unavailableRouteLocation};
 const moveChijmes = {day:1, targetDay:2, placeId:'chijmes-001'};
 const moves = [moveChijmes, moveArtScienceToAfternoon];
 const request = {action:'previewMove', moves, expectedVersion:1};

 let response = await post({...request, turnId:'cross-day-routes-unavailable'});
 assert.equal(response.status, 200);
 const partial = (await response.json()).movePreview;
 assert.equal(partial.feasible, false);
 assert.deepEqual(partial.days.map(({day}) => day), [2]);
 assert.deepEqual(partial.conflicts.map(({day, code}) => [day, code]), [[1, 'ROUTE_EVIDENCE_UNAVAILABLE']]);
 assert.deepEqual(partial.moves.map(({placeId}) => placeId), ['chijmes-001', 'artscience-003']);
 assert.equal(state.commits, 0);
 assert.deepEqual(state.draft, original);

 delete state.unavailableRouteLocation;
 response = await post({...request, turnId:'cross-day-routes-retry'});
 assert.equal(response.status, 200);
 const recovered = (await response.json()).movePreview;
 assert.equal(recovered.feasible, true);
 assert.deepEqual(recovered.days.map(({day}) => day), [1, 2]);
 assert.deepEqual(recovered.days.find(({day}) => day === 2), partial.days[0]);
 assert.equal(state.commits, 0);
 assert.deepEqual(state.draft, original);
});
