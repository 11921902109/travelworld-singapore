import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import path from "node:path";
import { createServer } from "vite";

const mocks = {
  "google-maps": `export const SINGAPORE_BOUNDS={south:1.1496,west:103.594,north:1.4784,east:104.106};export async function searchSingaporePlaces(input){globalThis.__attractionTest.searches.push(input);return globalThis.__attractionTest.results;}export async function getSingaporePlaceDetails(id){return globalThis.__attractionTest.results.find(p=>p.placeId===id);}`,
  "planning-trip": `export async function calculatePlanningOutcome(handoff,draft,options){globalThis.__attractionTest.calculations.push({draft,options});const day=options.days[0];return {estimates:[{day,metrics:{travelMinutes:35,freeMinutes:200,overtimeMinutes:0},scheduledDay:{stops:[{id:'hotel-start',placeId:'hotel-0001',time:'09:30',endTime:'09:30'},...draft.assignments.find(x=>x.day===day).orderedCandidateIds.map((id,i)=>({id,placeId:id,time:'10:00',endTime:'11:00'})),{id:'hotel-end',placeId:'hotel-0001',time:'21:00',endTime:'21:00'}]}}],conflicts:globalThis.__attractionTest.conflicts};}`,
  "bailian": `export async function askBailianAgent(){throw Error('No model call expected');}`,
};
const vite = await createServer({configFile:false,server:{middlewareMode:true,hmr:false},optimizeDeps:{noDiscovery:true},logLevel:"error",
  resolve:{alias:{"@":process.cwd(),"cloudflare:workers":path.join(process.cwd(),"tests/fixtures/flight-agent-env.ts")}},
  plugins:[{name:"attraction-boundaries",enforce:"pre",resolveId(id){const key=Object.keys(mocks).find(key=>id===`./${key}`||id===`@/lib/travel/${key}`||id===path.join(process.cwd(),`lib/travel/${key}`));if(key)return"\0attraction:"+key;},load(id){return id.startsWith("\0attraction:")?mocks[id.slice(12)]:null;}}],
});
after(()=>vite.close());
const {searchPlanningAttractions,previewPlanningAttraction,PlanningAttractionInputSchema}=await vite.ssrLoadModule("/lib/travel/planning-attractions.ts");
const place=(patch={})=>({placeId:"place-new-001",name:"National Gallery Singapore",address:"1 St Andrew's Road, Singapore",location:{lat:1.29,lng:103.85},types:["museum","tourist_attraction"],primaryType:"museum",rating:4.6,userRatingCount:100,priceLevel:null,businessStatus:"OPERATIONAL",googleMapsUri:null,openingHours:null,...patch});
const handoff={dates:{days:3},preferences:{interests:["夜景"],avoid:[]}};
const draft=()=>({version:4,handoffId:"test-handoff",stage:"route",boardConfirmed:true,stayConfirmed:true,flightSelection:{mode:"none"},candidates:[{id:"place-old-001",placeId:"place-old-001"}],selectedPlaceIds:["place-old-001"],assignments:[{day:1,orderedCandidateIds:[]},{day:2,orderedCandidateIds:["place-old-001"],periodByCandidateId:{"place-old-001":"morning"}},{day:3,orderedCandidateIds:[]}],dayEstimates:[{day:2,metrics:{travelMinutes:30},scheduledDay:{stops:[{id:"hotel-start",placeId:"hotel-0001"},{id:"old-stop",placeId:"place-old-001"},{id:"hotel-end",placeId:"hotel-0001"}]}}]});
beforeEach(()=>{globalThis.__attractionTest={results:[place()],searches:[],calculations:[],conflicts:[]};});

test("search keeps real Singapore attractions despite different soft interests and excludes restaurants, shops, outside bounds and permanent closures",async()=>{
 globalThis.__attractionTest.results=[place(),place({placeId:"restaurant-001",types:["restaurant"],primaryType:"restaurant"}),place({placeId:"shop-00001",types:["store"],primaryType:"store"}),place({placeId:"foreign-001",location:{lat:20,lng:103}}),place({placeId:"closed-0001",businessStatus:"CLOSED_PERMANENTLY"})];
 const matches=await searchPlanningAttractions(handoff,"国家美术馆");assert.deepEqual(matches.map(p=>p.placeId),["place-new-001"]);assert.equal(globalThis.__attractionTest.calculations.length,0);
});
test("Day 2 preview changes a copy only, preserves Day 1/3 and supports 15-minute custom duration",async()=>{
 const original=draft(),snapshot=JSON.stringify(original);const input=PlanningAttractionInputSchema.parse({day:2,placeId:"place-new-001",minutes:15,anchor:{nodeId:"old-stop",placement:"after"},period:"morning"});
 const result=await previewPlanningAttraction(handoff,original,input);
 assert.equal(JSON.stringify(original),snapshot);assert.equal(result.preview.day,2);assert.equal(result.preview.feasible,true);assert.equal(result.proposed.scheduleOverrides[0].visitMinutesByPlaceId["place-new-001"],15);assert.deepEqual(result.proposed.assignments[0],original.assignments[0]);assert.deepEqual(result.proposed.assignments[2],original.assignments[2]);assert.deepEqual(globalThis.__attractionTest.calculations[0].options.days,[2]);assert.match(result.preview.checks.find(c=>c.status==="warning").message,/营业信息/);
});
test("a duplicate in another day is rejected before external lookup or schedule calculation",async()=>{
 const original=draft();original.assignments[2].orderedCandidateIds=["place-new-001"];
 await assert.rejects(()=>previewPlanningAttraction(handoff,original,{day:2,placeId:"place-new-001",minutes:90}),e=>e.code==="ATTRACTION_ALREADY_ASSIGNED"&&e.message.includes("Day 3"));assert.equal(globalThis.__attractionTest.calculations.length,0);
});
test("explicit exclusions require acknowledgment without silently rewriting preferences",async()=>{
 const intent={...handoff,preferences:{...handoff.preferences,avoid:["博物馆"]}};const result=await previewPlanningAttraction(intent,draft(),{day:2,placeId:"place-new-001",minutes:90});assert.equal(result.preview.requiresAcknowledgement,true);assert.deepEqual(intent.preferences.avoid,["博物馆"]);
});
test("known opening or hard-boundary conflicts block confirmation; unknown hours alone do not",async()=>{
 globalThis.__attractionTest.conflicts=[{day:2,message:"场馆已闭馆，不能容纳完整参观。"}];const result=await previewPlanningAttraction(handoff,draft(),{day:2,placeId:"place-new-001",minutes:90});assert.equal(result.preview.feasible,false);assert.match(result.preview.message,/闭馆/);
});
test("preview fingerprint changes after saved draft version changes and invalid boundary anchors are rejected",async()=>{
 const original=draft(),input={day:2,placeId:"place-new-001",minutes:90};const a=await previewPlanningAttraction(handoff,original,input),b=await previewPlanningAttraction(handoff,{...original,version:5},input);assert.notEqual(a.preview.fingerprint,b.preview.fingerprint);
 await assert.rejects(()=>previewPlanningAttraction(handoff,original,{...input,anchor:{nodeId:"hotel-start",placement:"before"}}),e=>e.code==="ATTRACTION_OUTSIDE_WINDOW");
});
