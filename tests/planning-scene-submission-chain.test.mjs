import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

// Keep the production API, task coordinator, Bailian adapter and SQL leases.
// Only HTTP responses are simulated. No browser, real supplier or E2E journey.
const mocks = {
  "next/server": 'export class NextRequest extends Request{};export const NextResponse={json(body,options){return Response.json(body,options)}};',
  "cloudflare:workers": 'export const env={get DB(){return globalThis.__travelVisitSqliteDb},DASHSCOPE_API_KEY:"test-only-placeholder",BAILIAN_API_BASE_URL:"https://test.maas.aliyuncs.com/api/v1/agentstudio",BAILIAN_AGENT_ID:"test-agent",BAILIAN_ENVIRONMENT_ID:"test-environment",GOOGLE_MAPS_SERVER_KEY:"test-only-placeholder"};',
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true},logLevel:"error",
  resolve:{alias:[{find:"@",replacement:process.cwd()}]},
  plugins:[{name:"scene-real-adapter-http-boundaries",enforce:"pre",resolveId(id){if(id.startsWith("\0scene-chain:"))return id;if(id in mocks)return "\0scene-chain:"+id;},load(id){return id.startsWith("\0scene-chain:")?mocks[id.slice("\0scene-chain:".length)]:null;}}]});
const migrations=await Promise.all((await readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort().map(name=>readFile(path.join("drizzle",name),"utf8")));
const {acquireTravelVisit}=await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const {PlanningDraftSchema,buildPlanningHandoff}=await vite.ssrLoadModule("/lib/travel/planning-state.ts");
const {EMPTY_SINGAPORE_TRAVEL_INTENT}=await vite.ssrLoadModule("/lib/travel/singapore-intent.ts");
const {POST,GET}=await vite.ssrLoadModule("/app/api/travel/singapore/planning/scenes/route.ts");
const originalFetch=globalThis.fetch,originalNow=Date.now,originalRandom=Math.random;
let sqlite,state,requestNumber=0;
const token="11111111-2222-4333-8444-000000011719";
const handoffId="10000000-0000-4000-8000-000000011719";
const sessionId="sesn_scene_submission_chain";
const suggestion=query=>({query,kind:"sight",area:"滨海湾",reason:"建筑与风景",estimatedMinutes:90,pros:"适合慢逛",cons:"需步行"});
const json=(body,status=200)=>Response.json(body,{status,headers:{"x-request-id":"test-provider-request"}});
function localInputEvent(input){return{id:"sevt_scene_input",created_at:new Date(Date.now()).toISOString(),...input};}
function events(){
 const values=[...state.inputs];
 if(state.inputs.length&&Date.now()>=state.completeAt){
  values.push({id:"sevt_scene_answer",type:"message",role:"assistant",content:[{type:"text",text:JSON.stringify({suggestions:[suggestion("Gallery"),suggestion("Merlion")]})}]});
  values.push({id:"sevt_scene_end",type:"session_status",content:[{type:"data",data:{stop_reason:{type:"end_turn"}}}]});
 }
 return values;
}
async function supplierFetch(input,init={}){
 const url=new URL(String(input)),method=init.method||"GET";state.http.push({host:url.host,path:url.pathname,method});
 if(url.host==="test.maas.aliyuncs.com"){
  if(url.pathname.endsWith("/sessions")&&method==="POST"){
   if(state.createError)return json({error:{code:"ServiceUnavailable"}},503);
   return json({id:sessionId,status:"idle"});
  }
  if(url.pathname.endsWith("/events")&&method==="POST"){
   const body=JSON.parse(init.body);state.posts.push(body);
   if(state.submitRejected)return json({error:{code:"AccessDenied"}},401);
   state.inputs.push(localInputEvent(body.input[0]));
   if(state.uncertainOnce){state.uncertainOnce=false;throw new TypeError("simulated lost POST response");}
   return json({data:[state.inputs.at(-1)]});
  }
  if(url.pathname.endsWith("/events")){
   if(state.readError)return json({error:{code:"ServiceUnavailable"}},503);
   return json({data:events(),next_page:null});
  }
  if(url.pathname.endsWith(`/sessions/${sessionId}`)){
   if(state.sessionError)return json({error:{code:"AccessDenied"}},403);
   return json({id:sessionId,status:"idle",stop_reason:{type:"end_turn"}});
  }
 }
 if(url.host==="places.googleapis.com"&&url.pathname==="/v1/places:searchText"){
  const query=JSON.parse(init.body).textQuery;
  return json({places:[{id:`google-${query}`,displayName:{text:query},formattedAddress:"1 Singapore Road",location:{latitude:1.3,longitude:103.8},types:["tourist_attraction"],primaryType:"tourist_attraction",businessStatus:"OPERATIONAL",rating:4.5,userRatingCount:200}]});
 }
 throw new Error(`Unexpected mocked HTTP destination: ${url.origin}${url.pathname}`);
}
async function setup({existingSession=false}={}){
 sqlite=new DatabaseSync(":memory:");for(const sql of migrations)sqlite.exec(sql);
 state={sqlCount:0,sql:[],http:[],posts:[],inputs:[],completeAt:Infinity,now:originalNow()};
 Date.now=()=>state.now;Math.random=()=>0.5;globalThis.fetch=supplierFetch;
 class Statement{
  constructor(sql,values=[]){this.sql=sql;this.values=values;}
  bind(...values){return new Statement(this.sql,values);}
  count(){state.sqlCount++;state.sql.push(this.sql);}
  runSync(){this.count();return{meta:{changes:Number(sqlite.prepare(this.sql).run(...this.values).changes)}};}
  async run(){return this.runSync();}
  async first(){this.count();return sqlite.prepare(this.sql).get(...this.values)||null;}
 }
 globalThis.__travelVisitSqliteDb={prepare:sql=>new Statement(sql),batch:async statements=>{sqlite.exec("BEGIN IMMEDIATE");try{const results=statements.map(s=>s.runSync());sqlite.exec("COMMIT");return results;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
 const result={intent:{...EMPTY_SINGAPORE_TRAVEL_INTENT,startDate:"2026-12-20",endDate:"2026-12-22",durationDays:3,travelers:{total:2,adults:2,children:null,seniors:null},dailyStartTime:"09:30",dailyEndTime:"21:00",preferredReturnTime:"21:00",latestReturnTime:"21:00",pace:"relaxed",interests:["建筑"]},outline:[],acceptedChanges:[],pendingCandidates:[],missingInformation:[],ambiguities:[],blockingIssues:[],issues:[],primaryIssueId:null,nextQuestion:null,complete:true,progress:100,readiness:{complete:true,completeness:100},reply:"旅行条件已确认"};
 const handoff=buildPlanningHandoff(result,1);handoff.preferences.recommendationDeclined=true;handoff.preferences.mustVisit=["Gallery","Merlion"];
 const draft=PlanningDraftSchema.parse({version:0,handoffId,sourceIntentStateVersion:1,stage:"places",candidates:[],selectedPlaceIds:[],assignments:[],boardConfirmed:false,updatedAt:new Date(Date.now()).toISOString()});
 const lease=await acquireTravelVisit(token,new AbortController().signal);
 try{await lease.readIntentState();await lease.commitIntentTurn({turnId:"seed-scene-chain-intent",inputHash:"a".repeat(64),expectedStateVersion:0,resultJson:JSON.stringify(result),slotMetaJson:"{}"});await lease.commitPlanningHandoff({handoffId,sourceIntentStateVersion:1,handoffJson:JSON.stringify(handoff),initialDraftJson:JSON.stringify(draft)});if(existingSession)await lease.bindPlanningSession(sessionId,1);}finally{await lease.release();}
 state.sqlCount=0;state.sql=[];return state;
}
after(async()=>{await vite.close();});
afterEach(()=>{Date.now=originalNow;Math.random=originalRandom;globalThis.fetch=originalFetch;delete globalThis.__travelVisitSqliteDb;sqlite?.close();});
async function call(method,body,query=""){
 const response=await(method==="POST"?POST:GET)(new Request(`https://local.test/api/travel/singapore/planning/scenes${query}`,{method,headers:{"content-type":"application/json","x-travel-visit":token,"cf-connecting-ip":`scene-chain-${++requestNumber}`},...(body?{body:JSON.stringify(body)}:{})}));
 const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload;
}
const generate=(version=0)=>call("POST",{action:"generate",expectedVersion:version,turnId:crypto.randomUUID()});
const poll=(resume=false)=>call("GET",null,`?poll=1${resume?"&resume=1":""}`);

test("production scene coordinator sends the real prompt adapter POST and persists its acknowledged event before waiting",async(t)=>{
 const s=await setup();let result=await generate();assert.equal(result.job.status,"queued");assert.equal(s.posts.length,0);
 s.sqlCount=0;s.sql=[];result=await poll();
 assert.equal(s.posts.length,1);assert.match(s.posts[0].input[0].content[0].text,/新加坡|Singapore/);
 const turn=sqlite.prepare("SELECT turn_id,status,input_event_id,input_created_at FROM travel_agent_turns").get();
 assert.equal(turn.status,"submitted");assert.equal(turn.input_event_id,"sevt_scene_input");assert.ok(turn.input_created_at);assert.match(turn.turn_id,/:suggest$/);
 assert.equal(result.job.status,"running");assert.equal(result.candidates.length,0);
 t.diagnostic(`first model poll SQL statements: ${s.sqlCount}`);
 assert.ok(s.sqlCount<100,`first model poll used ${s.sqlCount} SQL statements`);
});
test("an 86-second delayed response is read from the same input once and does not regenerate or repost",async()=>{
 const s=await setup({existingSession:true});await generate();await poll();const inputId=sqlite.prepare("SELECT input_event_id FROM travel_agent_turns").get().input_event_id;
 s.completeAt=s.now+86_000;s.now+=86_000;let result=await poll();
 assert.equal(result.job.stage,"verify");assert.equal(s.posts.length,1);assert.equal(sqlite.prepare("SELECT input_event_id FROM travel_agent_turns").get().input_event_id,inputId);
 result=await poll();assert.equal(result.job.status,"completed");assert.equal(result.candidates.length,2);await poll();assert.equal(s.posts.length,1);
});
test("a pre-submission session failure is a recoverable failure with no prompt falsely marked submitted",async()=>{
 const s=await setup({existingSession:true});s.sessionError=true;await generate();let result=await poll();
 assert.equal(result.job.status,"failed");assert.equal(s.posts.length,0);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM travel_agent_turns").get().n,0);
 assert.equal(result.job.canResume,true);assert.match(result.job.message,/提交|连接|会话|百炼/);assert.doesNotMatch(result.job.message,/正在整理本次地点/);
 s.sessionError=false;result=await poll(true);assert.equal(s.posts.length,1);assert.equal(result.job.status,"running");
});
test("a failed event read keeps the acknowledged message and reports failure instead of normal processing",async()=>{
 const s=await setup();s.readError=true;await generate();let result=await poll();
 assert.equal(s.posts.length,1);assert.equal(result.job.status,"failed");assert.equal(result.job.canResume,true);assert.doesNotMatch(result.job.message,/正在整理本次地点/);
 assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"submitted");
 s.readError=false;s.completeAt=s.now;result=await poll(true);assert.equal(result.job.stage,"verify");assert.equal(s.posts.length,1);
});
test("an accepted POST whose response was lost is recovered by marker without a duplicate prompt",async()=>{
 const s=await setup();s.uncertainOnce=true;await generate();let result=await poll();
 assert.equal(s.posts.length,1);assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"uncertain");assert.equal(result.job.errorCode,"submission_uncertain");
 s.completeAt=s.now;result=await poll(true);assert.equal(result.job.stage,"verify");assert.equal(s.posts.length,1);assert.equal(sqlite.prepare("SELECT input_event_id FROM travel_agent_turns").get().input_event_id,"sevt_scene_input");
});
test("the 120-second result budget pauses automatic waiting, and explicit resume reads the same acknowledged input",async()=>{
 const s=await setup();const created=await generate();await poll();const original=sqlite.prepare("SELECT turn_id,input_event_id FROM travel_agent_turns").get();
 s.now+=121_000;let result=await poll();assert.equal(result.job.status,"timed_out");assert.equal(result.job.errorCode,"response_wait_timeout");assert.equal(s.posts.length,1);
 s.completeAt=s.now;result=await poll(true);assert.equal(result.job.id,created.job.id);assert.equal(result.job.stage,"verify");assert.equal(s.posts.length,1);assert.deepEqual(sqlite.prepare("SELECT turn_id,input_event_id FROM travel_agent_turns").get(),original);
});
test("a definitively rejected POST is distinguished from an uncertain submission and only explicit retry sends it again",async()=>{
 const s=await setup();s.submitRejected=true;await generate();let result=await poll();
 assert.equal(s.posts.length,1);assert.equal(result.job.status,"failed");assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"rejected");assert.equal(s.inputs.length,0);
 await poll();assert.equal(s.posts.length,1);
 s.submitRejected=false;result=await poll(true);assert.equal(s.posts.length,2);assert.equal(s.inputs.length,1);assert.equal(result.job.status,"running");assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"submitted");
});
