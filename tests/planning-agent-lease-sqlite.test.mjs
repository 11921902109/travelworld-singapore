import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const originalFetch=globalThis.fetch, originalNow=Date.now;
let activeDb;
let d1Metrics;
const migrations=(await readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort();
const sql=await Promise.all(migrations.map(name=>readFile(path.join("drizzle",name),"utf8")));
function createD1(){
 const db=new DatabaseSync(":memory:");for(const migration of sql) db.exec(migration);activeDb=db;
 d1Metrics={calls:0,statements:0,cleanup:0};
 class Statement{
  constructor(query,values=[]){this.query=query;this.values=values;}
  bind(...values){return new Statement(this.query,values);}
  runSync(){d1Metrics.statements++;if(this.query.startsWith("DELETE FROM travel_")&&this.query.includes("created_at <"))d1Metrics.cleanup++;const result=db.prepare(this.query).run(...this.values);return{meta:{changes:Number(result.changes)}};}
  async run(){d1Metrics.calls++;return this.runSync();}
  async first(){d1Metrics.calls++;d1Metrics.statements++;return db.prepare(this.query).get(...this.values)||null;}
 }
 const d1={prepare:query=>new Statement(query),batch:async statements=>{d1Metrics.calls++;db.exec("BEGIN IMMEDIATE");try{const rows=statements.map(s=>s.runSync());db.exec("COMMIT");return rows;}catch(error){db.exec("ROLLBACK");throw error;}}};
 globalThis.__travelVisitSqliteDb=d1;return db;
}
const vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:{"@":process.cwd(),"cloudflare:workers":path.join(process.cwd(),"tests/fixtures/visit-agent-sqlite-env.ts")}},optimizeDeps:{noDiscovery:true},logLevel:"error"});
after(async()=>{await vite.close();});
afterEach(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;delete globalThis.__travelVisitSqliteDb;activeDb?.close();activeDb=null;});
const {acquireTravelVisit,acquirePlanningAgentLease,PlanningAgentHandoffChangedError}=await vite.ssrLoadModule("/lib/travel/visit-session.ts");
const {askBailianAgent,advancePlanningAgentTask,initializeTravelPlanningSession}=await vite.ssrLoadModule("/lib/travel/bailian.ts");
const token="11111111-2222-4333-8444-555555555555";
const signal=()=>new AbortController().signal;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function seed(){
 const db=createD1();assert.ok(migrations.length>=14,"all production migrations, including independent locks");
 const lease=await acquireTravelVisit(token,signal());await lease.readIntentState();
 await lease.commitIntentTurn({turnId:"initial-intent",inputHash:"a".repeat(64),expectedStateVersion:0,resultJson:"{}",slotMetaJson:"{}"});
 await lease.commitPlanningHandoff({handoffId:"handoff-one",sourceIntentStateVersion:1,handoffJson:'{"version":1}',initialDraftJson:'{"version":0}'});
 await lease.bindPlanningSession("sesn_testold12345678",1);await lease.release();return db;
}
async function changeHandoff(){
 const data=await acquireTravelVisit(token,signal());
 try{await data.commitIntentTurn({turnId:"changed-intent",inputHash:"b".repeat(64),expectedStateVersion:1,resultJson:"{}",slotMetaJson:"{}"});await data.commitPlanningHandoff({handoffId:"handoff-two",sourceIntentStateVersion:2,handoffJson:'{"version":2}',initialDraftJson:'{"version":0}'});}finally{await data.release();}
}

test("real D1 SQL keeps planning Agent exclusive while ordinary data edits proceed",{timeout:5000},async()=>{
 const db=await seed();const first=await acquirePlanningAgentLease(token,signal());
 assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);
 let secondReady=false;const controller=new AbortController();const secondPromise=acquirePlanningAgentLease(token,controller.signal).then(value=>{secondReady=true;return value;});
 await delay(30);assert.equal(secondReady,false);
 const data=await acquireTravelVisit(token,signal());const saved=await data.commitPlanningDraftRow({turnId:"ordinary-edit",inputHash:"c".repeat(64),expectedVersion:0,handoffId:"handoff-one",sourceIntentStateVersion:1,draftJson:'{"ordinaryEdit":true}'});assert.equal(saved.committed,true);await data.release();
 assert.equal(secondReady,false);await first.release();const second=await secondPromise;
 assert.equal(secondReady,true);assert.equal((await second.readPlanningDraftRow()).version,1);await second.release();
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);
});

test("75-second work fits the 100-second Agent TTL and expired leases cannot renew",async()=>{
 const db=await seed();let now=originalNow();Date.now=()=>now;
 const agent=await acquirePlanningAgentLease(token,signal());
 const expires=db.prepare("SELECT expires_at FROM travel_planning_agent_locks").get().expires_at;assert.equal(expires-now,100000);
 now+=75000;await agent.renew();assert.equal(db.prepare("SELECT expires_at FROM travel_planning_agent_locks").get().expires_at-now,100000);
 now+=100001;await assert.rejects(agent.renew(),/lease was lost/);await agent.release();
});

test("resetting an expired visit invalidates old Agent generation without deleting the new owner",async()=>{
 const db=await seed();let now=originalNow();Date.now=()=>now;
 const old=await acquirePlanningAgentLease(token,signal());const generation=db.prepare("SELECT created_at FROM travel_agent_visits").get().created_at;
 now+=1000;db.prepare("UPDATE travel_agent_visits SET expires_at=?,lease_owner=NULL,lease_expires_at=NULL").run(now-1);
 const replacement=await acquirePlanningAgentLease(token,signal());assert.notEqual(db.prepare("SELECT created_at FROM travel_agent_visits").get().created_at,generation);
 await assert.rejects(old.renew(),/lease was lost/);await old.release();
 await replacement.renew();assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,1);await replacement.release();
});

test("intent/date handoff changes invalidate an acquired Agent adapter before another turn is reserved",async()=>{
 const db=await seed();const old=await acquirePlanningAgentLease(token,signal());await changeHandoff();
 await assert.rejects(old.reserveTurn("stale-turn","sesn_testold12345678","d".repeat(64)),error=>error instanceof PlanningAgentHandoffChangedError);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_agent_turns").get().n,0);await old.release();
 const current=await acquirePlanningAgentLease(token,signal());assert.equal(current.planningIntentVersion,2);assert.equal((await current.readPlanningHandoff()).handoff_id,"handoff-two");await current.release();
});

test("planning API session wait holds no data lock and stops before POST after a handoff change",async()=>{
 const db=await seed();let posts=0;
 globalThis.fetch=async(_url,options={})=>{assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);if(options.method==="POST"){posts++;throw new Error("old turn must never be posted");}await changeHandoff();return Response.json({status:"idle"});};
 const reply=await askBailianAgent("old planning request","planning",token,"turn-stale-check");
 assert.equal(reply,null);assert.equal(posts,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_agent_turns").get().n,0);
});

test("network failure releases an owned Agent lock and leaves data storage usable",async()=>{
 const db=await seed();globalThis.fetch=async()=>{assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);throw new Error("simulated network failure");};
 assert.equal(await askBailianAgent("network test","planning",token,"turn-network-test"),null);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);
 const data=await acquireTravelVisit(token,signal());assert.equal((await data.readPlanningHandoff()).handoff_id,"handoff-one");await data.release();
});

test("short polling maps changed handoff to stale rather than retrying the old task",async()=>{
 await seed();const lease=await acquirePlanningAgentLease(token,signal());await changeHandoff();
 const result=await advancePlanningAgentTask("old task","turn-old-context",lease);assert.equal(result.status,"failed");assert.equal(result.reason,"stale_handoff");await lease.release();
});

test("planning session initialization without an existing lease uses only the Agent lock during HTTP",async()=>{
 const db=await seed();db.exec("UPDATE travel_agent_visits SET planning_session_id=NULL");
 globalThis.fetch=async(_url,options={})=>{assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,1);assert.equal(options.method,"POST");return Response.json({id:"sesn_newplanning123456"});};
 assert.equal(await initializeTravelPlanningSession(token,1),true);
 assert.equal(db.prepare("SELECT planning_session_id FROM travel_agent_visits").get().planning_session_id,"sesn_newplanning123456");assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);
});


test("failure while initializing an Agent adapter releases its claimed SQL lock",async()=>{
 const db=await seed();db.exec("UPDATE travel_intent_states SET state_version=2");
 await assert.rejects(acquirePlanningAgentLease(token,signal()),error=>error instanceof PlanningAgentHandoffChangedError);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);
 assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);
});

test("aborting a waiting second Agent does not release the first owner's SQL lock",{timeout:5000},async()=>{
 const db=await seed();const first=await acquirePlanningAgentLease(token,signal());const owner=db.prepare("SELECT owner FROM travel_planning_agent_locks").get().owner;
 const controller=new AbortController();const waiting=acquirePlanningAgentLease(token,controller.signal);await delay(20);controller.abort();await assert.rejects(waiting,/busy|timed out/);
 assert.equal(db.prepare("SELECT owner FROM travel_planning_agent_locks").get().owner,owner);await first.renew();await first.release();
});

test("two real planning adapters serialize model turns while data reads continue during HTTP wait",{timeout:5000},async()=>{
 const db=await seed();let posts=0;let latestInput;let unblockFirst;let firstWaiting;
 const gate=new Promise(resolve=>{unblockFirst=resolve;});const ready=new Promise(resolve=>{firstWaiting=resolve;});
 globalThis.fetch=async(url,options={})=>{
  assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null,"no ordinary data lease during remote HTTP");
  if(options.method==="POST"){
   posts++;latestInput={...JSON.parse(options.body).input[0],id:`input-event-${posts}`,created_at:new Date().toISOString()};
   return Response.json({data:[{id:latestInput.id,created_at:latestInput.created_at}]});
  }
  if(new URL(url).pathname.endsWith("/events")){
   const input=latestInput;if(posts===1){firstWaiting();await gate;}
   return Response.json({data:[input,{type:"message",role:"assistant",content:[{type:"text",text:'{"ok":true}'}]},{type:"session_status",content:[{data:{stop_reason:{type:"end_turn"}}}]}]});
  }
  return Response.json({status:"idle"});
 };
 const first=askBailianAgent("planning one","planning",token,"turn-model-first");await ready;
 const second=askBailianAgent("planning two","planning",token,"turn-model-second");await delay(30);
 assert.equal(posts,1,"second model turn must wait");const data=await acquireTravelVisit(token,signal());assert.equal((await data.readPlanningHandoff()).handoff_id,"handoff-one");await data.release();
 unblockFirst();const replies=await Promise.all([first,second]);assert.ok(replies.every(Boolean));assert.equal(posts,2);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_agent_turns WHERE status='completed'").get().n,2);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,0);
});

test("a planning turn reads context and reserved turn under one short data lease without repeated cleanup",async()=>{
 const db=await seed();const agent=await acquirePlanningAgentLease(token,signal());const before={...d1Metrics};
 const result=await agent.withPlanningTurnData(async data=>{
  assert.notEqual(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);
  const [handoff,state,turn]=await Promise.all([data.readPlanningHandoff(),data.readIntentState(),data.findTurn("one-short-read")]);return{handoff,state,turn};
 });
 assert.equal(result.handoff.handoff_id,"handoff-one");assert.equal(result.state.stateVersion,1);assert.equal(result.turn,null);
 assert.ok(d1Metrics.calls-before.calls<=9,`one context batch used ${d1Metrics.calls-before.calls} D1 calls`);assert.equal(d1Metrics.cleanup,before.cleanup,"hot planning data batches do not repeat stale-generation cleanup");
 assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);await agent.release();
});

test("a failed planning data batch releases only the data lock and allows same-task recovery",async()=>{
 const db=await seed();const agent=await acquirePlanningAgentLease(token,signal());
 await assert.rejects(agent.withPlanningTurnData(async data=>{await data.readPlanningHandoff();throw new Error("simulated callback failure");}),/simulated callback failure/);
 assert.equal(db.prepare("SELECT lease_owner FROM travel_agent_visits").get().lease_owner,null);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_planning_agent_locks").get().n,1);
 assert.equal(await agent.withPlanningTurnData(async data=>(await data.readPlanningHandoff()).handoff_id),"handoff-one");await agent.release();
});

test("the fast planning path cannot recreate an expired visit or reserve an old-generation turn",async()=>{
 const db=await seed();const agent=await acquirePlanningAgentLease(token,signal());const generation=db.prepare("SELECT created_at FROM travel_agent_visits").get().created_at;
 db.prepare("UPDATE travel_agent_visits SET expires_at=?").run(Date.now()-1);
 await assert.rejects(agent.withPlanningTurnData(data=>data.reserveTurn("expired-fast-turn","sesn_testold12345678","e".repeat(64))),/lease was lost|handoff was replaced/);
 assert.equal(db.prepare("SELECT created_at FROM travel_agent_visits").get().created_at,generation);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_agent_turns").get().n,0);await agent.release();
});

test("explicitly rejected reservations can be cleared while uncertain submitted and completed turns remain protected",async()=>{
 const db=await seed();const agent=await acquirePlanningAgentLease(token,signal());
 await agent.withPlanningTurnData(async data=>{
  for(const id of ["turn-rejected","turn-uncertain","turn-submitted","turn-completed"])await data.reserveTurn(id,"sesn_testold12345678","a".repeat(64));
  await data.markTurnUncertain("turn-uncertain");await data.markTurnSubmitted("turn-submitted","event-id",new Date().toISOString());await data.markTurnComplete("turn-completed","done");
  await data.markTurnRejected("turn-rejected");await data.markTurnRejected("turn-submitted");await data.markTurnRejected("turn-completed");
  assert.equal((await data.findTurn("turn-rejected")).status,"rejected");assert.equal((await data.findTurn("turn-submitted")).status,"submitted");assert.equal((await data.findTurn("turn-completed")).status,"completed");
  for(const id of ["turn-rejected","turn-uncertain","turn-submitted","turn-completed"])await data.clearRejectedTurn(id);
  assert.equal(await data.findTurn("turn-rejected"),null);assert.equal((await data.findTurn("turn-uncertain")).status,"uncertain");assert.equal((await data.findTurn("turn-submitted")).status,"submitted");assert.equal((await data.findTurn("turn-completed")).status,"completed");
 });
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM travel_agent_turns").get().n,3);await agent.release();
});

test("a released data owner cannot reject or clear reservations held by the next owner",async()=>{
 await seed();const old=await acquireTravelVisit(token,signal());await old.reserveTurn("turn-owner-guard","sesn_testold12345678","a".repeat(64));await old.release();
 const current=await acquireTravelVisit(token,signal());await old.markTurnRejected("turn-owner-guard");assert.equal((await current.findTurn("turn-owner-guard")).status,"reserved");
 await current.markTurnRejected("turn-owner-guard");await old.clearRejectedTurn("turn-owner-guard");assert.equal((await current.findTurn("turn-owner-guard")).status,"rejected");
 await current.clearRejectedTurn("turn-owner-guard");assert.equal(await current.findTurn("turn-owner-guard"),null);await current.release();
});
