import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {ScheduleTimeEditor}=await vite.ssrLoadModule('/components/travel/planning/schedule-time-editor.tsx');
const {ScheduleStage}=await vite.ssrLoadModule('/components/travel/planning/schedule-stage.tsx');
const {ScheduleAttractionSearch}=await vite.ssrLoadModule('/components/travel/planning/schedule-attraction-search.tsx');
const {singleEndPlanningWindow}=await vite.ssrLoadModule('/lib/travel/planning-time-overrides.ts');
const noop=()=>{};
const days=[{day:1,date:'2026-12-20'},{day:2,date:'2026-12-21'}];
const stageActions={decisions:[],busy:false,onCalculate:noop,onDecide:noop,onConfirm:noop,onReviewBoard:noop,onUpdateDay:async()=>true,onPreviewMove:noop,onApplyMove:noop};
const estimate={day:2,date:'2026-12-21',sceneIds:['place-1'],dailyWindow:{start:'09:30',preferredReturn:'18:00',latestReturn:'20:00'},effectiveWindow:{start:'09:30',returnBy:'15:00'},scenes:[{candidateId:'place-1',name:'本地活动',period:'afternoon',preferredPeriod:'afternoon',regularOpeningHours:'09:00–19:00',selectedVisitMinutes:90}],metrics:{visitMinutes:90,foodMinutes:0,mealReserveMinutes:90,bufferMinutes:30,travelMinutes:70,pickupMinutes:8,freeMinutes:50,overtimeMinutes:0,actualReturnTime:'14:10',requestedReturnTime:'15:00',terminalKind:'airport',startTime:'09:30'},computedAt:'2026-11-05T00:00:00Z',notes:[]};
const journey={kind:'departure',milestones:[{id:'hotel-start',label:'酒店出发',localDateTime:'2026-12-21T09:30',timeZone:'Asia/Singapore',role:'hotel',source:'confirmed_conditions'},{id:'local-activities',label:'当地活动',localDateTime:null,timeZone:'Asia/Singapore',role:'activity',source:'schedule'},{id:'inbound-departure',label:'返程起飞 · 离开新加坡',localDateTime:'2026-12-21T18:00',timeZone:'Asia/Singapore',role:'flight',source:'user',airportReminderAt:'2026-12-21T15:00'},{id:'inbound-arrival',label:'返程抵达',localDateTime:'2026-12-22T01:00',timeZone:'Asia/Shanghai',role:'flight',source:'user'}],flightMinutes:420,groundMinutes:70,nextDayGroundMinutes:0,totalTransportMinutes:490,airportProcessMinutes:0,airportPreparationMinutes:180};
const editor=(value)=>renderToStaticMarkup(createElement(ScheduleTimeEditor,{estimate:value,busy:false,onSave:async()=>true,onDirtyChange:noop,onEditFlights:noop}));

const routeStop=(id,name,kind)=>({id,placeId:id,name,kind,verified:true,area:'',time:'09:30',endTime:'11:00',duration:'',x:0,y:0,note:''});
estimate.scheduledDay={id:'day-2',label:'Day 2',date:'12/21',weekday:'周一',theme:'',color:'#165c45',summary:'',stops:[routeStop('hotel-start','酒店出发','hotel'),routeStop('place-1','本地活动','sight'),routeStop('hotel-end','返回酒店','hotel')],legs:[{from:'hotel-start',to:'place-1',mode:'transit',minutes:35,distance:'2 km'},{from:'place-1',to:'hotel-end',mode:'transit',minutes:35,distance:'2 km'}]};
estimate.transport={status:'complete',totalMinutes:70,hotelMinutes:70,airportMinutes:0,includesHotelReturn:true,source:'google'};

test('ordinary days show one end field and retain a different legacy target until the user explicitly changes it',()=>{
 const html=editor(estimate);
 assert.equal((html.match(/type="time"/g)||[]).length,2);
 assert.match(html,/aria-expanded="false"[^>]*>时间修改<\/button>/);
 assert.match(html,/结束时间要求/);assert.match(html,/必须不晚于结束时间/);
 assert.match(html,/>结束时间<input/);assert.doesNotMatch(html,/>期望返店<input|>最晚返店<input/);
 assert.match(html,/希望 18:00、最晚 20:00/);
 const next=singleEndPlanningWindow(estimate.dailyWindow,'21:00');
 assert.equal(estimate.dailyWindow.preferredReturn,'18:00');assert.equal(estimate.dailyWindow.latestReturn,'20:00');
 assert.equal(next.preferredReturn,'21:00');assert.equal(next.latestReturn,'21:00');assert.equal(next.returnConstraint.strength,'hard');assert.equal(next.returnConstraint.source,'user');
 const soft=singleEndPlanningWindow({...estimate.dailyWindow,returnConstraint:{strength:'soft',source:'user'}},'19:00');assert.equal(soft.returnConstraint.strength,'soft');
});

test('departure day shows only a start-time input and keeps confirmed flight times read-only',()=>{
 const html=editor({...estimate,journey});
 assert.equal((html.match(/type="time"/g)||[]).length,1);
 assert.match(html,/>出发时间<input type="time"/);
 assert.doesNotMatch(html,/>结束时间<input|结束时间要求<select/);
 assert.match(html,/type="number"/);assert.match(html,/返程起飞/);assert.match(html,/返程抵达/);
 assert.match(html,/2026-12-21 18:00/);assert.match(html,/建议 2026-12-21 15:00 前到达/);assert.match(html,/2026-12-22 01:00/);
 assert.match(html,/Asia\/Shanghai 当地时间/);assert.match(html,/修改机票/);assert.doesNotMatch(html,/修改旅行条件/);
 assert.match(html,/>时间修改<\/button>/);assert.doesNotMatch(html,/>需要帮助<\/button>/);
 assert.match(html,/本日时段受航班约束/);
 assert.doesNotMatch(html,/>交通总时长（小时）<input/);assert.doesNotMatch(html,/>当地地面交通</);
});

test('arrival day shows only an end-time input and its strength, while a day with both flights shows neither',()=>{
 const arrival = editor({...estimate,day:1,journey:{...journey,kind:'arrival'}});
 assert.equal((arrival.match(/type="time"/g)||[]).length,1);
 assert.match(arrival,/>结束时间<input type="time"/);
 assert.match(arrival,/>结束时间要求<select/);
 assert.doesNotMatch(arrival,/>出发时间<input/);
 assert.match(arrival,/本日时段受航班约束/);

 const combined = editor({...estimate,day:1,journey:{...journey,kind:'arrival_departure'}});
 assert.doesNotMatch(combined,/type="time"|结束时间要求<select/);
 assert.match(combined,/type="number"/);
 assert.match(combined,/本日时段受航班约束/);
});

test('missing historic endpoints are visibly incomplete and never shown as a made-up flight duration',()=>{
 const incomplete={...journey,flightMinutes:null,totalTransportMinutes:null,milestones:journey.milestones.map(node=>node.id==='inbound-arrival'?{...node,localDateTime:null,timeZone:null}:node)};
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days,estimates:[{...estimate,journey:incomplete}]}));
 assert.match(html,/时刻待补充/);assert.match(html,/时区待补充/);assert.match(html,/航班行程 待补充/);assert.match(html,/到达机场截止 15:00/);
 assert.doesNotMatch(html,/航班行程 0/);assert.doesNotMatch(html,/已核实航班/);
});

test('old flight estimates require explicit recalculation while historic no-flight days keep their ordinary editor',()=>{
 const props={...stageActions,days:[days[0]],estimates:[{...estimate,...days[0]}]};
 const oldFlight=renderToStaticMarkup(createElement(ScheduleStage,{...props,flightMode:'manual'}));
 assert.match(oldFlight,/旧核算需按当前航班更新/);assert.match(oldFlight,/按当前航班重新核算/);assert.doesNotMatch(oldFlight,/type="time"/);
 assert.match(oldFlight,/disabled=""[^>]*>确认全程并准备地图/);
 const noFlight=renderToStaticMarkup(createElement(ScheduleStage,{...props,flightMode:'none'}));
 assert.doesNotMatch(noFlight,/旧核算需按当前航班更新/);assert.equal((noFlight.match(/type="time"/g)||[]).length,2);
});

test('a day with only a conflict is selectable, keeps other day panels mounted and blocks whole-trip confirmation',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{
   ...stageActions,
   days,
   estimates:[{...estimate,...days[0]}],
   conflicts:[{...days[1],code:'DAILY_WINDOW_TOO_SHORT',draftVersion:1,message:'测试截止冲突'}],
 }));
 assert.equal((html.match(/role="tab"/g)||[]).length,2);
 assert.match(html,/role="tab"[^>]*aria-selected="true"[^>]*><span>DAY 02/);
 assert.equal((html.match(/role="tabpanel"[^>]*hidden=""/g)||[]).length,1);
 assert.match(html,/测试截止冲突/);
 assert.match(html,/disabled=""[^>]*>确认全程并准备地图/);
});

test('a stale estimate from a different calendar date cannot make the current day ready',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{
   ...stageActions,
   days,
   estimates:[{...estimate,day:1,date:'2026-12-19'},estimate],
 }));
 assert.match(html,/role="tab"[^>]*aria-selected="true"[^>]*><span>DAY 01/);
 assert.match(html,/核对本日开放时间与交通余量/);
 assert.doesNotMatch(html,/2026-12-19/);
 assert.match(html,/查看下一天 · Day 2/);
 assert.match(html,/Day 1 · 待核算/);
 assert.doesNotMatch(html,/>确认全程并准备地图/);
});

test('ordinary navigation shows next day without offering whole-trip confirmation on the first date',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days,estimates:[{...estimate,...days[0]},estimate]}));
 assert.match(html,/查看下一天 · Day 2/);
 assert.match(html,/全程已核算 2\/2 天/);
 assert.doesNotMatch(html,/>确认全程并准备地图/);
});

test('a single-day trip confirms the whole trip only when server and local readiness agree',()=>{
 const props={...stageActions,days:[days[0]],estimates:[{...estimate,...days[0]}]};
 const ready=renderToStaticMarkup(createElement(ScheduleStage,{...props,scheduleReady:true}));
 assert.match(ready,/>确认全程并准备地图/);
 assert.doesNotMatch(ready,/disabled=""[^>]*>确认全程并准备地图/);
 assert.doesNotMatch(ready,/<button[^>]*>查看下一天/);
 const pending=renderToStaticMarkup(createElement(ScheduleStage,{...props,scheduleReady:false,pendingReviews:[{kind:'board',targetStage:'day_allocation',message:'地点与分天待复核'}]}));
 assert.match(pending,/地点与分天待复核/);
 assert.match(pending,/前往核对/);
 assert.match(pending,/disabled=""[^>]*>确认全程并准备地图/);
 const stale=renderToStaticMarkup(createElement(ScheduleStage,{...props,scheduleReady:false,staleScheduleDays:[1]}));
 assert.match(stale,/Day 1 · 待核算/);
 assert.match(stale,/重新核算本日/);
 assert.match(stale,/disabled=""[^>]*>确认全程并准备地图/);
});

test('ground transport has one complete headline and free allocation is not repeated in the summary',()=>{
 const value={...estimate,...days[0],transport:{status:'complete',totalMinutes:92,hotelMinutes:48,airportMinutes:44,includesHotelReturn:true,source:'google'},metrics:{...estimate.metrics,travelMinutes:92,personalMinutes:0,bufferMinutes:25,freeMinutes:153}};
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[value]}));
 assert.equal((html.match(/<dt>当地地面交通/g)||[]).length,1);
 assert.match(html,/<dd>约 1.53 小时<\/dd>/);
 assert.match(html,/机场接驳约 0.73 小时，已计入上述总量/);
 assert.doesNotMatch(html,/0.5 小时以上|<dt>个人活动预留|<small>尚未安排<\/small>/);
});

test('legacy payloads without saved route evidence cannot enable confirmation or allocate stale free time',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[{...estimate,...days[0],scheduledDay:undefined}]}));
 assert.match(html,/disabled=""[^>]*>确认全程并准备地图/);
 assert.match(html,/重新核算本日/);
 assert.doesNotMatch(html,/<button[^>]*>将剩余留给个人活动/);
});

test('daily editing and the summary have one reading order without an inner resizer',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[{...estimate,...days[0]}]}));
 const editorIndex=html.indexOf('aria-label="Day 1 时间设置"');
 const summaryIndex=html.indexOf('aria-label="Day 1 本日总结"');
 assert.ok(editorIndex>=0&&summaryIndex>editorIndex);
 assert.doesNotMatch(html,/role="separator"|恢复.*比例|60%/);
});

test('old or unavailable advice cannot advertise adding an activity',()=>{
 const advice={source:'planning_rules',version:2,summary:'当前有效建议',adjustment:{action:'optional_add',reason:'按当前空档可选择活动'},canSuggestAddition:true};
 const value={...estimate,...days[0],advice};
 const render=(extras={})=>renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[value],...extras}));
 assert.match(render(),/当前有效建议/);
 for(const extras of [{busy:true},{staleScheduleDays:[1]},{conflicts:[{...days[0],code:'DAILY_WINDOW_TOO_SHORT',draftVersion:1,message:'活动与截止冲突'}]},{estimates:[{...value,advice:{...advice,version:1}}]}]) {
   const html=render(extras);assert.doesNotMatch(html,/当前有效建议|按当前空档可选择活动/);
 }
 const conservative=render({estimates:[{...value,advice:{...advice,summary:'首末日保留余量',canSuggestAddition:false}}]});
 assert.match(conservative,/首末日保留余量/);
 assert.doesNotMatch(conservative,/增加一处活动|继续增加活动/);
});

test('each mounted day owns one draggable toolbox without permanently repeating per-node add controls',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days,estimates:[{...estimate,...days[0]},estimate],onSearchAttractions:async()=>[]}));
 assert.equal((html.match(/aria-label="添加本日安排"/g)||[]).length,2);
 assert.equal((html.match(/draggable="true"/g)||[]).length,6);
 for(const label of ['吃饭','休息','自定义','返回分天板','搜索景点并加入']) assert.match(html,new RegExp(label));
 assert.doesNotMatch(html,/放在这里 ·|＋插入安排|安排已有用餐|另外新增时间|行李处理方式|额外用餐预留|额外缓冲时间/);
});

test('daily summaries are separate and collapsed initially while stale warnings remain visible before them',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[{...estimate,...days[0]}],staleScheduleDays:[1]}));
 const summary=html.match(/<details[^>]*aria-label="Day 1 本日总结"[^>]*>/)?.[0];
 assert.ok(summary);assert.doesNotMatch(summary,/\sopen(?:=|\s|>)/);
 assert.ok(html.indexOf('当前安排已有变化，原结果需重新核算')<html.indexOf('aria-label="Day 1 本日总结"'));
 assert.match(html,/尚未分配<\/strong><span>待重新核算/);
 assert.doesNotMatch(html,/尚未分配<\/strong><span>约/);
});

test('local labels retain their saved titles details and duration and pending legacy labels have no fake location',()=>{
 const localBlocks=[
  {id:'meal-1',day:2,kind:'meal',title:'午餐随意吃',details:'到附近再决定',durationMinutes:40,source:'user',anchor:{nodeId:'place-1',placement:'after'}},
  {id:'rest-1',day:2,kind:'rest',title:'歇一会儿',durationMinutes:20,source:'user',anchor:{nodeId:'place-1',placement:'before'}},
  {id:'legacy-1',day:2,kind:'custom',title:'之前的自定义事项',durationMinutes:15,source:'legacy'},
 ];
 const html=editor({...estimate,localBlocks,scheduledLocalBlocks:[{...localBlocks[0],startTime:'13:00',endTime:'13:40'}]});
 assert.match(html,/吃饭安排：午餐随意吃/);assert.match(html,/到附近再决定/);assert.match(html,/预计 13:00–13:40/);
 assert.match(html,/休息安排：歇一会儿/);assert.match(html,/自定义安排：之前的自定义事项/);assert.match(html,/待放置/);
 assert.equal((html.match(/编辑／移动/g)||[]).length,3);assert.equal((html.match(/>删除<\/button>/g)||[]).length,3);
 assert.match(html,/待放置的安排/);assert.doesNotMatch(html,/额外缓冲时间|将剩余留给个人活动/);
});

test('first and last day timelines show grouped physical endpoints without duplicate generic hotel operations',()=>{
 const html=editor({...estimate,journey});
 assert.match(html,/aria-label="前往机场与返程"/);assert.match(html,/aria-label="下午游览"/);
 assert.match(html,/查看时间依据与来源/);assert.doesNotMatch(html,/当地出发点|酒店事务|只读 ·|不可修改 ·/);
 assert.equal((html.match(/>修改机票<\/button>/g)||[]).length,1);
});

test('attraction search is an explicit review flow and does not perform supplier work while rendering',()=>{
 let calls=0;
 const html=renderToStaticMarkup(createElement(ScheduleAttractionSearch,{day:2,days,estimates:[estimate],busy:false,blocked:false,onClose:noop,onSearchAttractions:async()=>{calls++;return[]},onPreviewAttraction:async()=>{calls++;return null},onConfirmAttraction:async()=>{calls++;return true}}));
 assert.equal(calls,0);assert.match(html,/景点名称<input type="search"/);assert.match(html,/确认前不会改变行程/);
 assert.match(html,/>搜索景点<\/button>/);assert.doesNotMatch(html,/>确认加入景点<\/button>/);
 assert.doesNotMatch(html,/搜索餐厅|增加餐厅/);
 const blocked=renderToStaticMarkup(createElement(ScheduleAttractionSearch,{day:2,days,estimates:[estimate],busy:false,blocked:true,onClose:noop,onSearchAttractions:async()=>[]}));
 assert.match(blocked,/请先保存各日尚未确认的安排/);assert.match(blocked,/disabled=""[^>]*>搜索景点<\/button>/);
});

test('whole-trip blockers stay outside the collapsed daily summary',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[{...estimate,...days[0],metrics:{...estimate.metrics,overtimeMinutes:30}}],pendingReviews:[{kind:'block',targetStage:'route',day:1,message:'有旧安排尚未选择位置'}],scheduleReady:false}));
 const summaryIndex=html.indexOf('aria-label="Day 1 本日总结"');
 const warningIndex=html.indexOf('上次核算预计超过');
 assert.ok(warningIndex>=0&&warningIndex<summaryIndex);
 assert.match(html,/有旧安排尚未选择位置/);assert.match(html,/disabled=""[^>]*>确认全程并准备地图/);
 assert.ok(html.lastIndexOf('有旧安排尚未选择位置')>html.lastIndexOf('</details>'));
});

test('saved manually overridden ground times are treated as stale and cannot confirm a map',()=>{
 const legacy={...estimate,...days[0],overrides:{day:1,travelTotalMinutes:120},
   metrics:{...estimate.metrics,travelMinutes:120,travelSource:'user'},
   transport:{...estimate.transport,totalMinutes:120,source:'user'}};
 const html=renderToStaticMarkup(createElement(ScheduleStage,{...stageActions,days:[days[0]],estimates:[legacy]}));
 assert.match(html,/当地地面交通<\/dt><dd>待重新核算/);
 assert.match(html,/上次核算采用手动时长约 2 小时，仅供参考/);
 assert.doesNotMatch(html,/交通总时长（小时）|预计可在截止前返店/);
 assert.match(html,/disabled=""[^>]*>确认全程并准备地图/);
 assert.doesNotMatch(html,/>需要帮助<\/button>/);
});
