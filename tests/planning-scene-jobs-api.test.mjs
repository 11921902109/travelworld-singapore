import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// Run production API, draft persistence, SQL leases and discovery stages. Only
// remote supplier boundaries are mocked; this file never performs an E2E flow.
const mocks = {
  "next/server": 'export class NextRequest extends Request{}; export const NextResponse={json(body,options){return Response.json(body,options)}};',
  "bailian": 'export async function initializeTravelPlanningSession(){return true;} export async function askBailianAgent(){throw new Error("Unexpected synchronous model");} export const advancePlanningAgentTask=(...args)=>globalThis.__sceneJobTest.advance(...args);',
  "google-maps": 'export class GoogleMapsServiceError extends Error{constructor(code,message,status=502){super(message);this.code=code;this.status=status;}} export const googleMapsErrorResponse=e=>({status:e.status||503,body:{error:{code:e.code||"GOOGLE_FAILURE",message:e.message}}});export const searchSingaporePlaces=(...args)=>globalThis.__sceneJobTest.search(...args); export async function getSingaporePlaceDetails(){throw new Error("Unexpected details call");}',
};
const vite = await createServer({ configFile:false, server:{middlewareMode:true,hmr:false}, optimizeDeps:{noDiscovery:true}, logLevel:"error",
  resolve:{alias:[{find:"@",replacement:process.cwd()},{find:"cloudflare:workers",replacement:path.join(process.cwd(),"tests/fixtures/visit-agent-sqlite-env.ts")}]},
  plugins:[{name:"scene-job-supplier-boundaries",enforce:"pre",resolveId(id){const normalized=id.replaceAll("\\","/");const key=Object.keys(mocks).find(key=>id===key||key!=="next/server"&&new RegExp(`(?:^|/)${key}(?:\\.ts)?$`).test(normalized));return key?"\0scene-job:"+key:null;},load(id){return id.startsWith("\0scene-job:")?mocks[id.slice("\0scene-job:".length)]:null;}}],
});
let sqlite;
after(()=>vite.close()); afterEach(()=>{delete globalThis.__travelVisitSqliteDb;delete globalThis.__sceneJobTest;sqlite?.close();});
const migrations=await Promise.all((await readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort().map(name=>readFile(path.join("drizzle",name),"utf8")));
const { acquireTravelVisit }=await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const { PlanningDraftSchema,buildPlanningHandoff }=await vite.ssrLoadModule("/lib/travel/planning-state.ts");
const { EMPTY_SINGAPORE_TRAVEL_INTENT }=await vite.ssrLoadModule("/lib/travel/singapore-intent.ts");
const { POST,GET }=await vite.ssrLoadModule("/app/api/travel/singapore/planning/scenes/route.ts");
const { GoogleMapsServiceError }=await vite.ssrLoadModule("/lib/travel/google-maps.ts");
const token="11111111-2222-4333-8444-000000011717";
const handoffId="10000000-0000-4000-8000-000000011717";
const suggestion=query=>({query,kind:"sight",area:"滨海湾",reason:"建筑与风景",estimatedMinutes:90,pros:"适合慢逛",cons:"需步行"});
const place=query=>({placeId:`google-${query}`,name:query,address:"1 Singapore Road",location:{lat:1.3,lng:103.8},primaryType:"tourist_attraction",types:["tourist_attraction"],businessStatus:"OPERATIONAL",googleMapsUri:null,rating:4.5,userRatingCount:200,openingHours:null});
async function setup(){
  sqlite=new DatabaseSync(":memory:");for(const sql of migrations)sqlite.exec(sql);
  class Statement{constructor(sql,values=[]){this.sql=sql;this.values=values;}bind(...values){return new Statement(this.sql,values);}runSync(){return{meta:{changes:Number(sqlite.prepare(this.sql).run(...this.values).changes)}};}async run(){return this.runSync();}async first(){return sqlite.prepare(this.sql).get(...this.values)||null;}}
  globalThis.__travelVisitSqliteDb={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec("BEGIN IMMEDIATE");try{const result=statements.map(s=>s.runSync());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
  const result={intent:{...EMPTY_SINGAPORE_TRAVEL_INTENT,startDate:"2026-12-20",endDate:"2026-12-22",durationDays:3,travelers:{total:2,adults:2,children:null,seniors:null},dailyStartTime:"09:30",dailyEndTime:"21:00",preferredReturnTime:"21:00",latestReturnTime:"21:00",pace:"relaxed",interests:["建筑"]},outline:[],acceptedChanges:[],pendingCandidates:[],missingInformation:[],ambiguities:[],blockingIssues:[],issues:[],primaryIssueId:null,nextQuestion:null,complete:true,progress:100,readiness:{complete:true,completeness:100},reply:"旅行条件已确认"};
  const handoff=buildPlanningHandoff(result,1);handoff.preferences.recommendationDeclined=true;handoff.preferences.mustVisit=["Gallery","Merlion"];
  const draft=PlanningDraftSchema.parse({version:0,handoffId,sourceIntentStateVersion:1,stage:"places",candidates:[],selectedPlaceIds:[],assignments:[],boardConfirmed:false,updatedAt:new Date().toISOString()});
  const lease=await acquireTravelVisit(token,new AbortController().signal);
  try{await lease.readIntentState();await lease.commitIntentTurn({turnId:"seed-scene-intent",inputHash:"a".repeat(64),expectedStateVersion:0,resultJson:JSON.stringify(result),slotMetaJson:"{}"});await lease.commitPlanningHandoff({handoffId,sourceIntentStateVersion:1,handoffJson:JSON.stringify(handoff),initialDraftJson:JSON.stringify(draft)});}finally{await lease.release();}
  const state={advances:[],searches:[],complete:false,failGoogle:false};
  state.advance=async(_message,id)=>{state.advances.push(id);await state.onAdvance?.();return state.complete?{status:"completed",text:JSON.stringify({suggestions:[suggestion("Gallery"),suggestion("Merlion")]})}:{status:"running"};};
  state.search=async({query})=>{state.searches.push(query);if(state.failGoogle&&query==="Merlion")throw new GoogleMapsServiceError("GOOGLE_MAPS_PERMISSION_DENIED","Google 地点服务权限不足。",403);return[place(query)];};
  globalThis.__sceneJobTest=state;return state;
}
let req=0;
async function call(method,body,query=""){
  const response=await(method==="POST"?POST:GET)(new Request(`https://local.test/api/travel/singapore/planning/scenes${query}`,{method,headers:{"content-type":"application/json","x-travel-visit":token,"cf-connecting-ip":`scene-test-${++req}`},...(body?{body:JSON.stringify(body)}:{})}));
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload;
}
const generate=(expectedVersion=0,extra={})=>call("POST",{action:"generate",expectedVersion,turnId:crypto.randomUUID(),...extra});
const poll=(resume=false)=>call("GET",null,`?poll=1${resume?"&resume=1":""}`);

test("initial generation, refresh and repeated auto requests reuse one durable task/model turn",async()=>{
  const s=await setup();let result=await generate();const id=result.job.id;
  assert.equal(result.job.status,"queued");assert.equal(s.advances.length,0);
  result=await generate(0);assert.equal(result.job.id,id);assert.equal(result.draft.version,1);
  result=await poll();assert.equal(result.job.status,"running");assert.deepEqual(result.candidates,[]);
  const version=result.draft.version;result=await call("GET");assert.equal(result.job.id,id);assert.equal(result.draft.version,version);assert.equal(s.advances.length,1);
  s.complete=true;result=await poll();assert.deepEqual(result.candidates,[]);assert.equal(result.job.stage,"verify");
  result=await poll();assert.equal(result.job.status,"completed");assert.equal(result.candidates.length,2);
  assert.equal(new Set(s.advances).size,1);const advances=s.advances.length;await poll();assert.equal(s.advances.length,advances);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM travel_planning_scene_jobs").get().n,1);
});

test("partial verification publishes successes, preserves a later selection and retries only failed Google work",async()=>{
  const s=await setup();s.complete=true;s.failGoogle=true;await generate();await poll();let result=await poll();
  assert.equal(result.job.status,"partial");assert.equal(result.job.sourceErrorCode,"GOOGLE_MAPS_PERMISSION_DENIED");assert.match(result.job.message,/权限不足/);assert.equal(result.candidates.length,1);
  result=await call("POST",{action:"select",expectedVersion:result.draft.version,turnId:crypto.randomUUID(),selectedPlaceIds:["google-Gallery"]});
  s.failGoogle=false;result=await poll(true);
  assert.equal(result.job.status,"completed");assert.deepEqual(result.draft.selectedPlaceIds,["google-Gallery"]);assert.equal(result.candidates.length,2);
  assert.deepEqual(s.searches,["Gallery","Merlion","Merlion"]);assert.equal(s.advances.length,1);
});

test("deadline recovery continues the same original task; only explicit restart creates a new batch",async()=>{
  const s=await setup();let result=await generate();const id=result.job.id;await poll();
  sqlite.prepare("UPDATE travel_planning_scene_jobs SET deadline_at=?").run(Date.now()-1);
  result=await poll();assert.equal(result.job.status,"timed_out");assert.equal(s.advances.length,1);
  s.complete=true;result=await poll(true);assert.equal(result.job.id,id);assert.equal(new Set(s.advances).size,1);
  result=await poll();const next=await generate(result.draft.version,{restart:true});assert.notEqual(next.job.id,id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM travel_planning_scene_jobs").get().n,2);
});

test("an identical handoff body and source version with a new handoff identity gets an independent initial task",async()=>{
  await setup();const original=await generate();
  const handoffRow=sqlite.prepare("SELECT handoff_json FROM travel_planning_handoffs").get();
  const newId="10000000-0000-4000-8000-000000011718";
  const nextDraft=PlanningDraftSchema.parse({version:0,handoffId:newId,sourceIntentStateVersion:1,stage:"places",candidates:[],selectedPlaceIds:[],assignments:[],boardConfirmed:false,updatedAt:new Date().toISOString()});
  // Normal same-version confirmation intentionally reuses its handoff. Simulate
  // a reconstructed handoff while old durable discovery rows still exist.
  sqlite.prepare("DELETE FROM travel_planning_handoffs").run();
  const lease=await acquireTravelVisit(token,new AbortController().signal);
  try{await lease.commitPlanningHandoff({handoffId:newId,sourceIntentStateVersion:1,handoffJson:handoffRow.handoff_json,initialDraftJson:JSON.stringify(nextDraft)});}finally{await lease.release();}
  const latest=await generate();assert.notEqual(latest.job.id,original.job.id);
  assert.equal(latest.draft.handoffId,newId);assert.equal(latest.job.status,"queued");
  assert.equal(sqlite.prepare("SELECT handoff_id FROM travel_planning_scene_jobs WHERE job_id=?").get(latest.job.id).handoff_id,newId);
});

test("overlapping polls hold one durable poll lease and do not duplicate model work",async()=>{
  const s=await setup();await generate();let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  s.onAdvance=async()=>{entered();await gate;};
  const pending=poll();await started;await poll();assert.equal(s.advances.length,1);release();await pending;
  assert.equal(sqlite.prepare("SELECT poll_owner FROM travel_planning_scene_jobs").get().poll_owner,null);
});

test("a newer batch chosen while an old model waits is not replaced by the old response",async()=>{
  const s=await setup();const first=await generate();let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  s.onAdvance=async()=>{entered();await gate;};const pending=poll();await started;
  const latest=await generate(first.draft.version,{restart:true});release();const oldResponse=await pending;
  assert.equal(oldResponse.draft.sceneDiscoveryJob.id,latest.job.id);
  assert.equal(sqlite.prepare("SELECT status FROM travel_planning_scene_jobs WHERE job_id=?").get(first.job.id).status,"superseded");
});

test("a completed publication receipt does not resurrect a candidate removed after a worker checkpoint gap",async()=>{
  const s=await setup();s.complete=true;await generate();await poll();let result=await poll();
  const row=sqlite.prepare("SELECT job_id,result_json FROM travel_planning_scene_jobs").get();const state=JSON.parse(row.result_json);state.publishedIds=[];
  sqlite.prepare("UPDATE travel_planning_scene_jobs SET result_json=? WHERE job_id=?").run(JSON.stringify(state),row.job_id);
  result=await call("POST",{action:"remove",expectedVersion:result.draft.version,turnId:crypto.randomUUID(),placeId:"google-Merlion"});
  result=await poll();assert.deepEqual(result.candidates.map(item=>item.placeId),["google-Gallery"]);
});
