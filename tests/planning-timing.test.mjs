import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanningTiming, withPlanningTiming } from "../lib/travel/planning-timing.ts";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test("timing measures real async success and failure, sync failure, and final response once",async()=>{
  const messages=[];const original=console.info;console.info=value=>messages.push(value);
  try {
    const timing=createPlanningTiming("flights","search");
    timing.annotate({day:2,segment:1,version:3,cacheHit:true});
    assert.equal(await timing.measureAsync("context_read",async()=>{await delay(12);return 42;}),42);
    const failure=new Error("private token and prompt must not be logged");
    await assert.rejects(timing.measureAsync("agent_wait",async()=>{await delay(5);throw failure;}),error=>error===failure);
    assert.throws(()=>timing.measureSync("calculation",()=>{throw failure;}),error=>error===failure);
    const response=timing.response(new Response("ok",{status:202,headers:{"Server-Timing":"existing;dur=1"}}));
    timing.response(response);timing.finish(500);
    const p=timing.projection();
    assert.equal(p.statusCode,202);
    assert.ok(p.steps.find(x=>x.name==="context_read").durationMs>=8);
    assert.equal(p.steps.find(x=>x.name==="agent_wait").failures,1);
    assert.equal(p.steps.find(x=>x.name==="calculation").failures,1);
    assert.equal(p.steps.at(-1).name,"request_total");
    assert.equal(messages.length,1);
    assert.match(response.headers.get("Server-Timing"),/^existing;dur=1, context_read;dur=/);
    assert.equal(response.headers.get("X-Travel-Trace-Id"),p.traceId);
    assert.equal(response.headers.get("Server-Timing").match(/request_total/g).length,1);
    assert.ok(!JSON.stringify(p).includes(failure.message));
    assert.ok(!messages[0].includes(failure.message));
  } finally {console.info=original;}
});

test("timing strips unknown fields, names and private values rather than logging them",()=>{
  const messages=[];const original=console.info;console.info=value=>messages.push(value);
  try {
    const secret="private-user-origin-token-booking-url";
    const timing=createPlanningTiming(secret,secret);
    timing.setAction(secret);
    timing.annotate({day:99,segment:-1,version:2,cacheHit:false,prompt:secret,query:secret,origin:secret,token:secret,session:secret,bookingUrl:secret});
    timing.record(secret,20);
    timing.record("google_lookup",-1);
    timing.record("google_lookup",Number.NaN);
    const p=timing.finish(200);
    assert.equal(p.scope,"unknown");assert.equal(p.action,"unknown");
    assert.deepEqual(p.metadata,{version:2,cacheHit:false});
    assert.deepEqual(p.steps.map(x=>x.name),["request_total"]);
    assert.ok(!messages[0].includes(secret));
    const clone=timing.projection();clone.metadata.version=900;clone.steps[0].durationMs=900;
    assert.equal(timing.projection().metadata.version,2);
    assert.notEqual(timing.projection().steps[0].durationMs,900);
  } finally {console.info=original;}
});

test("wrapper finalizes an uncaught failure without logging its message",async()=>{
  const messages=[];const original=console.info;console.info=value=>messages.push(JSON.parse(value));
  try {
    await assert.rejects(withPlanningTiming("schedule","updateDay",async timing=>{await timing.measureAsync("calculation",async()=>{throw new Error("sensitive downstream payload");});}),/sensitive downstream payload/);
    assert.equal(messages.length,1);assert.equal(messages[0].statusCode,500);
    assert.equal(messages[0].steps.find(x=>x.name==="calculation").failures,1);
    assert.ok(!JSON.stringify(messages).includes("sensitive downstream payload"));
  } finally {console.info=original;}
});
