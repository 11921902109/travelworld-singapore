import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},resolve:{alias:{"@":process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:"error"});
after(()=>vite.close());
const {ScheduleTimeEditor}=await vite.ssrLoadModule("/components/travel/planning/schedule-time-editor.tsx");
const {buildPlanningDayTimeline,planningTimelineClock}=await vite.ssrLoadModule("/lib/travel/planning-day-timeline.ts");
const {attractionCapacityAdvisory}=await vite.ssrLoadModule("/components/travel/planning/schedule-attraction-search.tsx");
const noop=()=>{};
const stop=(id,name,kind,time,endTime)=>({id,placeId:id,name,kind,verified:true,time,endTime,area:"",duration:"",note:"",x:0,y:0});
const base={day:1,date:"2026-12-20",sceneIds:["gallery-001"],dailyWindow:{start:"09:30",preferredReturn:"21:00",latestReturn:"21:00"},effectiveWindow:{start:"14:30",returnBy:"21:00"},
 metrics:{visitMinutes:180,foodMinutes:0,mealReserveMinutes:0,bufferMinutes:0,travelMinutes:40,pickupMinutes:0,freeMinutes:170,overtimeMinutes:0,actualReturnTime:"20:30",requestedReturnTime:"21:00",terminalKind:"hotel",startTime:"14:30"},computedAt:"2026-11-18T00:00:00Z",notes:[],
 scenes:[{candidateId:"gallery-001",name:"滨海湾花园",period:"evening",preferredPeriod:"afternoon",regularOpeningHours:"05:00–02:00",recommendedDuration:{minMinutes:120,maxMinutes:240,source:"ai_suggestion"},selectedVisitMinutes:180,durationReason:"两个温室展馆各需约60分钟，适合傍晚停留。"}],
 scheduledDay:{id:"day-1",label:"Day 1",date:"12/20",weekday:"周日",theme:"",color:"",summary:"",stops:[stop("hotel-start","Bugis 酒店","hotel","14:58","14:58"),stop("gallery-001","滨海湾花园","sight","18:16","21:16"),stop("hotel-end","返回 Bugis 酒店","hotel","21:36","21:36")],legs:[]},transport:{status:"complete",totalMinutes:40,hotelMinutes:40,airportMinutes:0,includesHotelReturn:true,source:"google"},localBlocks:[]};
const render=(estimate,extra={})=>renderToStaticMarkup(createElement(ScheduleTimeEditor,{estimate,busy:false,onSave:async()=>true,onDirtyChange:noop,onEditFlights:noop,onEditConditions:noop,...extra}));

test("arrival is a separate time element using stop.time while recommendation explanation and duration input remain",()=>{
 const html=render(base);
 assert.match(html,/<b>滨海湾花园<\/b><time[^>]*>预计约 18:16 到达<\/time>/);
 assert.doesNotMatch(html,/预计约 18:16–21:16|预计约 21:16 到达/);
 assert.match(html,/开放：05:00–02:00/);assert.match(html,/建议：2–4 小时/);assert.match(html,/两个温室展馆各需约60分钟，适合傍晚停留。/);assert.match(html,/aria-label="滨海湾花园停留小时"[^>]*value="3"/);
 assert.match(html,/>预计约 14:58 出发<\/time>/);assert.match(html,/>预计约 21:36 到达<\/time>/);
});
test("stale or missing estimates cannot advertise saved arrival clocks as current",()=>{
 const stale=render(base,{estimateStale:true});assert.match(stale,/到达时间待重新核算/);assert.doesNotMatch(stale,/预计约 18:16 到达/);
 const missing=render({...base,scheduledDay:undefined});assert.match(missing,/到达时间待核算/);
});
test("saved cross-midnight route clocks keep their day offset without altering the schedule",()=>{
 const late=stop("gallery-001","滨海湾花园","sight","26:17","27:17");
 const html=render({...base,scheduledDay:{...base.scheduledDay,stops:[base.scheduledDay.stops[0],late,base.scheduledDay.stops[2]]}});
 assert.match(html,/预计约 次日 02:17 到达/);assert.equal(late.time,"26:17");
 assert.equal(planningTimelineClock("2026-12-22 01:00"),"2026-12-22 01:00");
 assert.equal(planningTimelineClock("49:10"),"2 日后 01:10");
});
test("airport process finish is labelled without shifting the actual landing or changing stop identity",()=>{
 const airport=stop("day-1-airport-arrival","抵达 新加坡樟宜机场","other","14:30","14:30");
 const journey={kind:"arrival",airportProcessMinutes:120,airportPreparationMinutes:0,milestones:[{id:"outbound-departure",label:"去程起飞",localDateTime:"2026-12-20T07:00",timeZone:"Asia/Shanghai",role:"flight",source:"user",airportName:"上海浦东机场"},{id:"outbound-arrival",label:"抵达新加坡",localDateTime:"2026-12-20T12:30",timeZone:"Asia/Singapore",role:"flight",source:"user",airportName:"新加坡樟宜机场"},{id:"local-activities",label:"当地活动",localDateTime:null,timeZone:"Asia/Singapore",role:"activity",source:"schedule"}]};
 const value={...base,journey,scheduledDay:{...base.scheduledDay,stops:[airport,...base.scheduledDay.stops]}};const html=render(value);
 assert.match(html,/>2026-12-20 12:30<\/time>/);assert.match(html,/入境与取行李预留结束，可离开机场/);assert.match(html,/>预计约 14:30<\/time>/);assert.match(html,/约 2 小时用于入境检查及领取行李/);
 const node=buildPlanningDayTimeline(value).find(node=>node.kind==="place"&&node.stop?.id===airport.id);assert.equal(node.stop,airport);assert.equal(node.timingKind,"airport_process");assert.equal(airport.name,"抵达 新加坡樟宜机场");
});
test("overtime legacy estimates remain editable but are never described as normal saved success",()=>{
 const html=render({...base,overrides:{day:1},metrics:{...base.metrics,overtimeMinutes:172,freeMinutes:0}});assert.match(html,/截止约 2 小时 52 分钟/);assert.doesNotMatch(html,/>本日设置已保存</);
});
test("secondary hover and active colors override the generic solid-button rule while group clocks are emphasized",async()=>{
 const css=await readFile("components/travel/planning/schedule-time-editor.module.css","utf8");assert.match(css,/\.groupHeading small\{font-weight:700/);assert.match(css,/\.editor :is\(\.journeyActions,\.blockActions,\.addSight\) button:hover:not\(:disabled\)[^{]+\{background:#e5efe1;color:#214c36\}/);assert.match(css,/button:active:not\(:disabled\)[^{]+\{background:#d7e7d3;color:#193f2d\}/);
 assert.match(css,/\.editor button:disabled,\.editor button:disabled:hover,\.editor button:disabled:active\{background:#e1e9df;color:#617467/);
 assert.match(css,/\.editor :is\(input,select,textarea\):disabled\{background:#f0f2ec;color:#66766b/);
});
test("attraction capacity advice ignores stale free balance and leaves authoritative route review available",()=>{
 const littleFree={...base,metrics:{...base.metrics,freeMinutes:0}};
 assert.match(attractionCapacityAdvisory(littleFree,30),/重新核对停留、实际交通/);
 assert.match(attractionCapacityAdvisory(base,480),/初步容量提醒.*本日时间不足/);
 assert.match(attractionCapacityAdvisory(base,480,true),/余量待核算/);
 assert.match(attractionCapacityAdvisory(undefined,480),/不把旧余额当作可用时间/);
});
