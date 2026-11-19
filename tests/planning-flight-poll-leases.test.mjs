import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import { createPlanningTiming } from "../lib/travel/planning-timing.ts";

const modules={
  "./planning-state": `export const PlanningDraftSchema={parse:x=>x}; export const commitPlanningDraft=(...args)=>globalThis.__flightPollTest.commit(...args);`,
  "./visit-session": `export const acquireTravelVisit=(...args)=>globalThis.__flightPollTest.dataLease(...args); export const acquirePlanningAgentLease=(...args)=>globalThis.__flightPollTest.agentLease(...args);`,
  "./bailian": `export const advancePlanningAgentTask=(...args)=>globalThis.__flightPollTest.advance(...args);`,
};
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:{"@":process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:"error",plugins:[{name:"flight-poll-test-adapters",enforce:"pre",resolveId(id){const normalized=id.replaceAll("\\","/");const key=Object.keys(modules).find(key=>normalized===key||normalized.endsWith("/"+key.slice(2)+".ts"));return key?"\0flight-test:"+key:null;},load(id){return id.startsWith("\0flight-test:")?modules[id.slice("\0flight-test:".length)]:null;}}]});
after(async()=>{delete globalThis.__flightPollTest;await vite.close();});
const {pollPlanningFlightJob,flightBoardFingerprint}=await vite.ssrLoadModule("/lib/travel/planning-flight-jobs.ts");
const {buildFlightSearchQuery}=await vite.ssrLoadModule("/lib/travel/planning-flights.ts");

function setup(){
  const state={dataHeld:0,agentHeld:0,advances:0,commits:0};
  state.draft={version:1,handoffId:"handoff-1",sourceIntentStateVersion:1,stage:"flights",boardConfirmed:true,assignments:[],candidates:[],flightSearchJob:{id:"job-1",status:"running"},updatedAt:new Date().toISOString()};
  const query={...buildFlightSearchQuery({originCity:"温州",startDate:"2026-12-20",endDate:"2026-12-23",travelers:{total:2,adults:2,children:null,seniors:null}}),boardFingerprint:flightBoardFingerprint(state.draft)};
  state.jobs=new Map([["job-1",{job_id:"job-1",handoff_id:"handoff-1",source_intent_state_version:1,status:"running",query_json:JSON.stringify(query),input_hash:"test",result_json:null,error_code:null,created_at:Date.now(),updated_at:Date.now(),deadline_at:Date.now()+480000}]]);
  state.dataLease=async()=>{
    assert.equal(state.dataHeld,0,"data lease is exclusive");state.dataHeld++;
    return {readPlanningDraftRow:async()=>({draft_json:JSON.stringify(state.draft)}),readFlightJob:async id=>state.jobs.get(id),readIntentState:async()=>({stateVersion:1}),readPlanningHandoff:async()=>({handoff_id:"handoff-1",source_intent_state_version:1}),saveFlightJob:async job=>{assert.equal(state.dataHeld,1);state.jobs.set(job.job_id,job);},release:async()=>{state.dataHeld--;}};
  };
  state.agentLease=async()=>{assert.equal(state.dataHeld,0,"never wait for Agent while holding data");state.agentHeld++;await state.onAgentLock?.();return{release:async()=>{state.agentHeld--;}};};
  state.advance=async()=>{assert.equal(state.dataHeld,0,"remote tool wait does not hold data");assert.equal(state.agentHeld,1);state.advances++;await state.onAdvance?.();return{status:"completed",text:JSON.stringify({queries:[{direction:"outbound",departureDate:"2026-12-20",status:"empty"},{direction:"inbound",departureDate:"2026-12-23",status:"error",reportedErrorMessage:"搜索机票低价行业失败"}],outbound:[],inbound:[]})};};
  state.commit=async(_token,{expectedVersion,nextDraft})=>{assert.equal(state.dataHeld,0);assert.equal(state.agentHeld,0);state.commits++;if(expectedVersion!==state.draft.version)return{committed:false,draft:state.draft};state.draft={...nextDraft,version:state.draft.version+1,updatedAt:new Date().toISOString()};return{committed:true,draft:state.draft};};
  globalThis.__flightPollTest=state;return state;
}

test("remote flight polling releases data locks and merges into the latest unrelated edit",async()=>{
  const s=setup();s.onAdvance=async()=>{const lease=await s.dataLease();s.draft={...s.draft,version:2,unrelatedSavedChoice:"kept"};await lease.release();};
  const timing=createPlanningTiming("flights","poll");
  const result=await pollPlanningFlightJob("test-token",false,timing);
  for(const phase of ["context_read","lease_wait","agent_wait","state_commit"]) assert.ok(timing.projection().steps.some(item=>item.name===phase),phase);
  assert.equal(result.draft.unrelatedSavedChoice,"kept");
  assert.equal(result.job.status,"completed");
  assert.equal(result.draft.flightQuotes.queryOutcomes[1].reportedErrorMessage,"搜索机票低价行业失败");
  assert.equal(s.advances,1);assert.equal(s.dataHeld,0);assert.equal(s.agentHeld,0);
  await pollPlanningFlightJob("test-token");assert.equal(s.advances,1,"completed polling never resends a tool turn");
});

test("board changes during a remote wait supersede the late result",async()=>{
  const s=setup();s.onAdvance=async()=>{s.draft={...s.draft,version:2,assignments:[{day:1,orderedCandidateIds:["new-place"]}]};};
  const result=await pollPlanningFlightJob("test-token");
  assert.equal(result.job.status,"superseded");assert.equal(result.draft.flightQuotes,undefined);assert.equal(s.commits,0);assert.equal(s.dataHeld,0);assert.equal(s.agentHeld,0);
});

test("a newer query selected while waiting for the Agent lock prevents old submission",async()=>{
  const s=setup();s.onAgentLock=async()=>{s.jobs.set("job-2",{...s.jobs.get("job-1"),job_id:"job-2",status:"queued"});s.draft={...s.draft,version:2,flightSearchJob:{id:"job-2",status:"queued"}};};
  const result=await pollPlanningFlightJob("test-token");
  assert.equal(result.job.id,"job-2");assert.equal(s.advances,0);assert.equal(s.dataHeld,0);assert.equal(s.agentHeld,0);
});
