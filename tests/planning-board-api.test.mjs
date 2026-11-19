import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

let sqlite;
const migrations = await Promise.all((await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort().map(name => readFile(path.join("drizzle", name), "utf8")));
const mocks = {
  "next/server": 'export class NextRequest extends Request{};export const NextResponse={json(body,options){return Response.json(body,options)}};',
  "@/lib/travel/bailian": 'export async function initializeTravelPlanningSession(){return true;} export async function askBailianAgent(){throw new Error("No model expected");}',
};
const vite = await createServer({ configFile:false, server:{middlewareMode:true,hmr:false}, optimizeDeps:{noDiscovery:true}, logLevel:"error",
  resolve:{alias:[...Object.keys(mocks).map(find=>({find,replacement:"\0board-test:"+find})),{find:"@",replacement:process.cwd()},{find:"cloudflare:workers",replacement:path.join(process.cwd(),"tests/fixtures/visit-agent-sqlite-env.ts")}]},
  plugins:[{name:"board-test-boundaries",enforce:"pre",resolveId(id){if(id.startsWith("\0board-test:"))return id;const key=Object.keys(mocks).find(key=>id===key||key.startsWith("@/")&&id===path.join(process.cwd(),key.slice(2)));if(key)return"\0board-test:"+key;},load(id){return id.startsWith("\0board-test:")?mocks[id.slice("\0board-test:".length)]:null;}}],
});
after(()=>vite.close()); afterEach(()=>{delete globalThis.__travelVisitSqliteDb;sqlite?.close();});
const { acquireTravelVisit } = await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const { PlanningDraftSchema, buildPlanningHandoff } = await vite.ssrLoadModule("/lib/travel/planning-state.ts");
const { EMPTY_SINGAPORE_TRAVEL_INTENT } = await vite.ssrLoadModule("/lib/travel/singapore-intent.ts");
const { POST:postBoard, GET:readBoard } = await vite.ssrLoadModule("/app/api/travel/singapore/planning/board/route.ts");
const { GET:readScenes } = await vite.ssrLoadModule("/app/api/travel/singapore/planning/scenes/route.ts");
const { POST:postDayCount } = await vite.ssrLoadModule("/app/api/travel/singapore/planning/day-count/route.ts");
const token="11111111-2222-4333-8444-000000011042";
const handoffId="10000000-0000-4000-8000-000000011042";
async function seed(){
 sqlite = new DatabaseSync(":memory:"); for(const sql of migrations)sqlite.exec(sql);
 class Statement{constructor(sql,values=[]){this.sql=sql;this.values=values;}bind(...values){return new Statement(this.sql,values);}runSync(){return{meta:{changes:Number(sqlite.prepare(this.sql).run(...this.values).changes)}};}async run(){return this.runSync();}async first(){return sqlite.prepare(this.sql).get(...this.values)||null;}}
 globalThis.__travelVisitSqliteDb={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec("BEGIN IMMEDIATE");try{const result=statements.map(s=>s.runSync());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
 const result={intent:{...EMPTY_SINGAPORE_TRAVEL_INTENT,startDate:"2026-12-20",endDate:"2026-12-22",durationDays:3,travelers:{total:2,adults:2,children:null,seniors:null},dailyStartTime:"09:30",dailyEndTime:"21:00",preferredReturnTime:"21:00",latestReturnTime:"21:00",pace:"relaxed",interests:["建筑"]},outline:[],acceptedChanges:[],pendingCandidates:[],missingInformation:[],ambiguities:[],blockingIssues:[],issues:[],primaryIssueId:null,nextQuestion:null,complete:true,progress:100,readiness:{complete:true,completeness:100},reply:"旅行条件已确认"};
 const candidate={id:"place-0001",placeId:"place-0001",name:"Gallery",address:"Singapore",location:{lat:1.3,lng:103.85},area:"市政区",category:"建筑与艺术",kind:"sight",sceneRole:"attraction",reason:"欣赏建筑",estimatedMinutes:90,pros:"适合慢逛",cons:"步行",source:"preference",sourceNote:"Google核实",estimateSource:"bailian",verified:true,googleMapsUri:null,rating:4,userRatingCount:1,openingHours:[]};
 const draft=PlanningDraftSchema.parse({version:0,handoffId,sourceIntentStateVersion:1,stage:"day_allocation",candidates:[candidate],selectedPlaceIds:[candidate.placeId],placesConfirmed:true,assignments:[1,2,3].map(day=>({day,orderedCandidateIds:[]})),boardConfirmed:false,updatedAt:new Date().toISOString()});
 const lease=await acquireTravelVisit(token,new AbortController().signal);
 try{await lease.readIntentState();await lease.commitIntentTurn({turnId:"seed-intent-test",inputHash:"a".repeat(64),expectedStateVersion:0,resultJson:JSON.stringify(result),slotMetaJson:"{}"});await lease.commitPlanningHandoff({handoffId,sourceIntentStateVersion:1,handoffJson:JSON.stringify(buildPlanningHandoff(result,1)),initialDraftJson:JSON.stringify(draft)});}finally{await lease.release();}
 return draft;
}
const post=(handler,body)=>handler(new Request("https://local.test/api/travel/singapore/planning/board",{method:"POST",headers:{"content-type":"application/json","x-travel-visit":token},body:JSON.stringify(body)}));
const assignments=()=>[{day:1,orderedCandidateIds:["place-0001"],periodByCandidateId:{"place-0001":"morning"},periodConstraintByCandidateId:{"place-0001":{strength:"soft",source:"user",evidence:"用户安排在上午"}}},{day:2,orderedCandidateIds:[],dayPurpose:"rest"},{day:3,orderedCandidateIds:[],dayPurpose:"rest"}];
test("real board API saves required AM/PM in a whole day draft and safely replays one confirmation",async()=>{
 await seed();const body={expectedVersion:0,turnId:"confirm-board-test",confirmed:true,assignments:assignments()};
 let response=await post(postBoard,body);assert.equal(response.status,200);let result=await response.json();assert.equal(result.draft.stage,"flights");assert.equal(result.draft.version,1);assert.equal(result.draft.assignments[0].periodByCandidateId["place-0001"],"morning");assert.equal(result.draft.assignments[0].periodConstraintByCandidateId["place-0001"].strength,"soft");
 response=await post(postBoard,body);assert.equal(response.status,200);result=await response.json();assert.equal(result.replayed,true);assert.equal(result.draft.version,1);
});
test("real board API rejects duplicate scenes, unknown IDs and unconfirmed empty days before saving",async()=>{
 await seed();
 const cases=[{assignments:[{day:1,orderedCandidateIds:["place-0001","place-0001"]}],code:"DUPLICATE_SCENE"},{assignments:[{day:1,orderedCandidateIds:["unknown-place"]}],code:"UNVERIFIED_SCENE"},{assignments:[{day:1,orderedCandidateIds:["place-0001"],periodByCandidateId:{"place-0001":"morning"}}],code:"EMPTY_DAYS_UNCONFIRMED"}];
 for(const item of cases){const response=await post(postBoard,{expectedVersion:0,turnId:crypto.randomUUID(),confirmed:true,assignments:item.assignments});assert.equal(response.status,422);assert.equal((await response.json()).error.code,item.code);}
 assert.equal(sqlite.prepare("SELECT version FROM travel_planning_drafts").get().version,0);
});
test("real board API rejects missing or flexible periods without committing but permits unconfirmed editing",async()=>{
 await seed();
 for (const periods of [undefined, {"place-0001":"flexible"}]) {
   const request=assignments();request[0]={day:1,orderedCandidateIds:["place-0001"],...(periods?{periodByCandidateId:periods}:{})};
   const response=await post(postBoard,{expectedVersion:0,turnId:crypto.randomUUID(),confirmed:true,assignments:request});
   assert.equal(response.status,422);const result=await response.json();assert.equal(result.error.code,"DAY_PERIOD_REQUIRED");assert.deepEqual(result.placeIds,["place-0001"]);assert.match(result.error.message,/Gallery.*上午或下午/);
 }
 assert.equal(sqlite.prepare("SELECT version FROM travel_planning_drafts").get().version,0);
 const request=assignments();delete request[0].periodByCandidateId;delete request[0].periodConstraintByCandidateId;
 const response=await post(postBoard,{expectedVersion:0,turnId:crypto.randomUUID(),confirmed:false,assignments:request});assert.equal(response.status,200);assert.equal((await response.json()).draft.boardConfirmed,false);
});
test("date deletion atomically carries local assignments and pending place restrictions; undo restores that board",async()=>{
 await seed();const preference={"place-0001":{period:"afternoon",constraint:{strength:"hard",source:"user",evidence:"只能下午"}}};
 const local=[{day:1,orderedCandidateIds:[]},{day:2,orderedCandidateIds:[]},{day:3,orderedCandidateIds:["place-0001"],periodByCandidateId:{"place-0001":"afternoon"},periodConstraintByCandidateId:{"place-0001":preference["place-0001"].constraint}}];
 let response=await post(postDayCount,{action:"delete",day:2,expectedIntentStateVersion:1,expectedDraftVersion:0,turnId:"delete-day-local",workingAssignments:local,placeTimePreferences:preference});assert.equal(response.status,200);let result=await response.json();assert.equal(result.handoff.dates.end,"2026-12-21");assert.deepEqual(result.draft.assignments[1].orderedCandidateIds,["place-0001"]);assert.equal(result.draft.placeTimePreferences["place-0001"].constraint.strength,"hard");
 response=await post(postDayCount,{action:"undo",expectedIntentStateVersion:2,expectedDraftVersion:0,turnId:"undo-day-local"});assert.equal(response.status,200);result=await response.json();assert.equal(result.handoff.dates.end,"2026-12-22");assert.deepEqual(result.draft.assignments[2].orderedCandidateIds,["place-0001"]);
});

test("validated board confirmation resolves only its legacy notice and preserves unchanged downstream data",async()=>{
 await seed();
 let response=await post(postBoard,{expectedVersion:0,turnId:"board-proof-initial",confirmed:true,assignments:assignments()});
 assert.equal(response.status,200);let result=await response.json();
 const confirmed=result.draft.reviewItems.find(item=>item.kind==='board');assert.equal(confirmed.status,'resolved');assert.equal(confirmed.sourceFingerprint,confirmed.resolvedInputFingerprint);
 const row=sqlite.prepare('SELECT draft_json FROM travel_planning_drafts').get();const draft=JSON.parse(row.draft_json);
 Object.assign(draft,{stage:'route',flightSelection:{mode:'none'},stayConfirmed:true,staySegments:[],dayEstimates:[{day:1,date:'2026-12-20',sentinel:'keep-route-evidence'}],reviewRequired:['地点与分天','住宿预算','自定义待确认']});
 sqlite.prepare('UPDATE travel_planning_drafts SET draft_json=?').run(JSON.stringify(draft));
 response=await post(postBoard,{expectedVersion:1,turnId:'board-proof-unchanged',confirmed:true,assignments:assignments()});assert.equal(response.status,200);result=await response.json();
 assert.equal(result.draft.stage,'route');assert.equal(result.draft.stayConfirmed,true);assert.deepEqual(result.draft.flightSelection,draft.flightSelection);assert.deepEqual(result.draft.dayEstimates,draft.dayEstimates);
 assert.deepEqual(result.draft.reviewRequired,['住宿预算','自定义待确认']);assert.ok(!result.draft.pendingReviews.some(item=>item.kind==='board'));
 assert.ok(result.draft.pendingReviews.some(item=>item.message.includes('住宿预算')));assert.ok(result.draft.pendingReviews.some(item=>item.message.includes('自定义待确认')));
});

test("temporary board saves and rejected or stale confirmations cannot resolve the current board review",async()=>{
 await seed();let response=await post(postBoard,{expectedVersion:0,turnId:'board-review-save',confirmed:false,assignments:assignments()});assert.equal(response.status,200);
 let result=await response.json();assert.equal(result.draft.reviewItems.find(item=>item.kind==='board').status,'pending');
 response=await post(postBoard,{expectedVersion:0,turnId:'board-review-stale',confirmed:true,assignments:assignments()});assert.equal(response.status,409);result=await response.json();assert.ok(result.draft.pendingReviews.some(item=>item.kind==='board'));
 const invalid=assignments();delete invalid[0].periodByCandidateId;delete invalid[0].periodConstraintByCandidateId;
 response=await post(postBoard,{expectedVersion:1,turnId:'board-review-invalid',confirmed:true,assignments:invalid});assert.equal(response.status,422);
 const stored=JSON.parse(sqlite.prepare('SELECT draft_json FROM travel_planning_drafts').get().draft_json);assert.equal(stored.reviewItems.find(item=>item.kind==='board').status,'pending');
});

test("reconfirming the same board after reopening keeps valid selections; a real period change creates downstream reviews",async()=>{
 await seed();let response=await post(postBoard,{expectedVersion:0,turnId:'board-reopen-initial',confirmed:true,assignments:assignments()});assert.equal(response.status,200);
 const draft=JSON.parse(sqlite.prepare('SELECT draft_json FROM travel_planning_drafts').get().draft_json);Object.assign(draft,{stage:'day_allocation',boardConfirmed:false,flightSelection:{mode:'none'},stayConfirmed:true,staySegments:[],reviewRequired:[]});
 sqlite.prepare('UPDATE travel_planning_drafts SET draft_json=?').run(JSON.stringify(draft));
 response=await post(postBoard,{expectedVersion:1,turnId:'board-reopen-same',confirmed:true,assignments:assignments()});assert.equal(response.status,200);let result=await response.json();assert.equal(result.draft.stage,'route');assert.deepEqual(result.draft.reviewRequired,[]);
 const changed=assignments();changed[0].periodByCandidateId['place-0001']='afternoon';changed[0].periodConstraintByCandidateId['place-0001'].evidence='用户改为下午';
 response=await post(postBoard,{expectedVersion:2,turnId:'board-reopen-changed',confirmed:true,assignments:changed});assert.equal(response.status,200);result=await response.json();assert.equal(result.draft.stage,'flights');assert.ok(result.draft.reviewRequired.includes('航班'));
 assert.notEqual(result.draft.reviewItems.find(item=>item.kind==='board').sourceFingerprint,draft.reviewItems.find(item=>item.kind==='board').sourceFingerprint);
});

test("board and scene restoration share derived readiness without writing or trusting saved projections",async()=>{
 await seed();const draft=JSON.parse(sqlite.prepare('SELECT draft_json FROM travel_planning_drafts').get().draft_json);
 Object.assign(draft,{pendingReviews:[],staleScheduleDays:[],scheduleReady:true});sqlite.prepare('UPDATE travel_planning_drafts SET draft_json=?').run(JSON.stringify(draft));
 const request=()=>new Request('https://local.test/api/travel/singapore/planning/board',{headers:{'x-travel-visit':token}});
 const board=await (await readBoard(request())).json(),scenes=await (await readScenes(request())).json();
 assert.equal(board.draft.scheduleReady,false);assert.ok(board.draft.pendingReviews.some(item=>item.kind==='board'));assert.deepEqual(scenes.draft.pendingReviews,board.draft.pendingReviews);
 const stored=JSON.parse(sqlite.prepare('SELECT draft_json FROM travel_planning_drafts').get().draft_json);assert.equal(stored.version,0);assert.equal(stored.reviewItems,undefined);
});
