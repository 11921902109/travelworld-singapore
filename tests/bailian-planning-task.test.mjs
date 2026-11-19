import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const originalFetch=globalThis.fetch, originalWarn=console.warn, originalNow=Date.now;
let sqlite;
const sql=await Promise.all((await readdir("drizzle")).filter(n=>n.endsWith(".sql")).sort().map(n=>readFile(path.join("drizzle",n),"utf8")));
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:{"@":process.cwd(),"cloudflare:workers":path.join(process.cwd(),"tests/fixtures/visit-agent-sqlite-env.ts")}},optimizeDeps:{noDiscovery:true},logLevel:"error"});
after(()=>vite.close());
afterEach(()=>{globalThis.fetch=originalFetch;console.warn=originalWarn;Date.now=originalNow;delete globalThis.__travelVisitSqliteDb;sqlite?.close();});
const {acquireTravelVisit,acquirePlanningAgentLease}=await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const {askBailianAgent,advancePlanningAgentTask}=await vite.ssrLoadModule("/lib/travel/bailian.ts");
const token="11111111-2222-4333-8444-000000117032", sessionId="sesn_adapter_test_12345678";
const message="Only this travel planning input, not a log field.";
async function setup(){
 sqlite=new DatabaseSync(":memory:");for(const item of sql)sqlite.exec(item);
 class Statement{constructor(query,values=[]){this.query=query;this.values=values;}bind(...values){return new Statement(this.query,values);}runSync(){return{meta:{changes:Number(sqlite.prepare(this.query).run(...this.values).changes)}};}async run(){return this.runSync();}async first(){return sqlite.prepare(this.query).get(...this.values)||null;}}
 globalThis.__travelVisitSqliteDb={prepare:q=>new Statement(q),batch:async items=>{sqlite.exec("BEGIN IMMEDIATE");try{const result=items.map(item=>item.runSync());sqlite.exec("COMMIT");return result;}catch(error){sqlite.exec("ROLLBACK");throw error;}}};
 const data=await acquireTravelVisit(token,new AbortController().signal);
 try{await data.readIntentState();await data.commitIntentTurn({turnId:"seed-input",inputHash:"a".repeat(64),expectedStateVersion:0,resultJson:"{}",slotMetaJson:"{}"});await data.commitPlanningHandoff({handoffId:"test-handoff",sourceIntentStateVersion:1,handoffJson:"{}",initialDraftJson:"{}"});await data.bindPlanningSession(sessionId,1);}finally{await data.release();}
 const state={posts:0,ready:true,logs:[],inputEvent:null,mode:"ok"};console.warn=(...args)=>state.logs.push(args);
 globalThis.fetch=async(url,options={})=>{
  const target=new URL(url);
  if(target.pathname.endsWith("/events")&&options.method==="POST"){
   state.posts++;if(state.mode==="post-auth-error")return Response.json({error:{code:"AccessDenied"}},{status:401});const body=JSON.parse(options.body);state.inputEvent={id:"event-input",created_at:"2026-11-17T11:00:00Z",...body.input[0]};
   if(state.mode==="uncertain")throw Error("connection reset after upstream acceptance");
   return Response.json({data:[state.inputEvent]});
  }
  if(target.pathname.endsWith("/events")){
   if(state.mode==="reply-error")return Response.json({error:{code:"ServiceUnavailable"}},{status:503});
   return Response.json({data:state.inputEvent?[state.inputEvent,...(state.ready?[{id:"reply",type:"message",role:"assistant",content:[{type:"text",text:'{"suggestions":[]}' }]},{id:"end",type:"session_status",content:[{data:{stop_reason:{type:"end_turn"}}}]}]:[])]:[]});
  }
  if(state.mode==="auth-error")return Response.json({error:{code:"InvalidApiKey"}},{status:401,headers:{"x-request-id":"request-test-1"}});
  if(state.mode==="invalid-json")return new Response("<html>bad upstream response</html>");
  return Response.json({id:sessionId,status:"idle"});
 };
 return state;
}
async function advance(id="planning-adapter-turn",options){const lease=await acquirePlanningAgentLease(token,new AbortController().signal);try{return await advancePlanningAgentTask(message,id,lease,options);}finally{await lease.release();}}
test("original exchange and resumable task share the same completed turn without another prompt",async()=>{
 const state=await setup();const first=await askBailianAgent(message,"planning",token,"shared-planning-turn");assert.equal(first.text,'{"suggestions":[]}');const replay=await advance("shared-planning-turn");assert.equal(replay.status,"completed");assert.equal(state.posts,1);assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"completed");
});
test("an 86-second late answer resumes its original input and does not POST twice",async()=>{
 const state=await setup();state.ready=false;const first=await advance();assert.equal(first.status,"running");assert.equal(first.submitted,true);let now=originalNow();Date.now=()=>now;now+=86000;state.ready=true;const later=await advance();assert.equal(later.status,"completed");assert.equal(state.posts,1);
});
test("reply failures preserve the submitted input and expose a retryable read-stage error",async()=>{
 const state=await setup();state.mode="reply-error";const failed=await advance();assert.equal(failed.status,"failed");assert.equal(failed.reason,"read_failed");assert.equal(failed.stage,"reply_read");assert.equal(failed.code,"agent_http_503");assert.equal(failed.retryable,true);assert.equal(failed.submitted,true);assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"submitted");state.mode="ok";assert.equal((await advance()).status,"completed");assert.equal(state.posts,1);
});
test("a POST with unknown outcome is recovered by marker instead of being sent twice",async()=>{
 const state=await setup();state.mode="uncertain";const first=await advance();assert.equal(first.status,"running");assert.equal(first.retryableCode,"submission_uncertain");assert.equal(first.submitted,"unknown");assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"uncertain");state.mode="ok";assert.equal((await advance()).status,"completed");assert.equal(state.posts,1);
});
test("pre-submit authentication and malformed-response errors are explicit and logs omit input and credentials",async()=>{
 const state=await setup();state.mode="auth-error";const auth=await advance();assert.equal(auth.status,"failed");assert.equal(auth.stage,"session_check");assert.equal(auth.code,"agent_http_401");assert.equal(auth.submitted,false);assert.equal(auth.retryable,false);assert.equal(state.posts,0);state.mode="invalid-json";const invalid=await advance();assert.equal(invalid.code,"agent_response_invalid");assert.equal(invalid.submitted,false);const logs=JSON.stringify(state.logs);for(const value of [message,sessionId,"test-only-placeholder","<html>"])assert.equal(logs.includes(value),false);
});
test("only explicit retry of the same rejected input can clear its reservation and submit again",async()=>{
 const state=await setup();state.mode="post-auth-error";const first=await advance();assert.equal(first.submitted,false);assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"rejected");state.mode="ok";assert.equal((await advance()).code,"submission_rejected");assert.equal(state.posts,1);
 const lease=await acquirePlanningAgentLease(token,new AbortController().signal);let changed;try{changed=await advancePlanningAgentTask("different input","planning-adapter-turn",lease,{retryRejected:true});}finally{await lease.release();}assert.equal(changed.code,"turn_input_conflict");assert.equal(sqlite.prepare("SELECT status FROM travel_agent_turns").get().status,"rejected");assert.equal(state.posts,1);
 assert.equal((await advance("planning-adapter-turn",{retryRejected:true})).status,"completed");assert.equal(state.posts,2);
});
