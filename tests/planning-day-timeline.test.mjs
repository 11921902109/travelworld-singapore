import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {buildPlanningDayTimeline,planningFreeAllocation,allocateRemainingToPersonal}=await vite.ssrLoadModule('/lib/travel/planning-day-timeline.ts');
const {ScheduleTimeEditor}=await vite.ssrLoadModule('/components/travel/planning/schedule-time-editor.tsx');
const scene=(id,name,role='attraction')=>({candidateId:id,name,period:'afternoon',preferredPeriod:'afternoon',regularOpeningHours:'10:00–19:00',selectedVisitMinutes:90,recommendedMinutes:90,sceneRole:role});
const stop=(id,placeId,name,kind)=>({id,placeId,name,kind,area:'',time:'12:00',endTime:'13:30',duration:'90 分钟',x:0,y:0,verified:true,note:''});
const hotelStart=stop('hotel-start','hotel-1','原酒店','hotel');
const gallery=stop('gallery-stop','gallery-1','国家美术馆','sight');
const restaurant=stop('food-stop','food-1','已选餐厅','food');
const hotelEnd=stop('hotel-end','hotel-2','新酒店','hotel');
const stops=[hotelStart,gallery,restaurant,hotelEnd];
const legs=stops.slice(1).map((to,index)=>({from:stops[index].id,to:to.id,minutes:[20,12,35][index],mode:'taxi',distance:'1 km',timeSource:'google'}));
const scenes=[scene('gallery-1','国家美术馆'),scene('food-1','已选餐厅','restaurant_meal')];
const metrics={visitMinutes:90,foodMinutes:90,mealReserveMinutes:0,bufferMinutes:25,personalMinutes:0,openingWaitMinutes:0,logisticsMinutes:0,travelMinutes:67,pickupMinutes:0,freeMinutes:153,overtimeMinutes:0,actualReturnTime:'17:00',requestedReturnTime:'21:00',terminalKind:'hotel',startTime:'09:30'};
const estimate={day:2,date:'2027-03-02',sceneIds:['gallery-1','food-1'],scenes,scheduledDay:{stops,legs},metrics,dailyWindow:{start:'09:30',preferredReturn:'21:00',latestReturn:'21:00'},effectiveWindow:{start:'09:30',returnBy:'21:00'},computedAt:'2026-11-15T00:00:00Z',notes:[]};
const milestone=(id,label,localDateTime,role='flight')=>({id,label,localDateTime,role,timeZone:'Asia/Singapore',source:'user',...(id.endsWith('departure')?{airportReminderAt:'2027-03-01T04:00'}:{})});
const arrival={kind:'arrival',milestones:[milestone('outbound-departure','去程起飞','2027-03-01T07:00'),milestone('outbound-arrival','抵达新加坡','2027-03-01T12:30'),milestone('local-activities','当地活动',null,'activity'),milestone('hotel-return','返店目标','2027-03-01T21:00','hotel')],flightMinutes:330,groundMinutes:67,nextDayGroundMinutes:0,totalTransportMinutes:397,airportProcessMinutes:120,airportPreparationMinutes:180};
const noop=()=>{};
const editor=(value,props={})=>renderToStaticMarkup(createElement(ScheduleTimeEditor,{estimate:value,busy:false,onSave:async()=>true,onDirtyChange:noop,onEditFlights:noop,onEditConditions:noop,...props}));

test('daily timeline uses the actual stop order and matching identity, including a hotel change',()=>{
 const nodes=buildPlanningDayTimeline({...estimate,scenes:[scenes[1],scenes[0]]});
 assert.deepEqual(nodes.filter(node=>node.kind==='place').map(node=>node.stop.name),['原酒店','国家美术馆','已选餐厅','新酒店']);
 assert.deepEqual(nodes.filter(node=>node.kind==='place'&&node.scene).map(node=>node.scene.candidateId),['gallery-1','food-1']);
 assert.deepEqual(nodes.filter(node=>node.kind==='travel').map(node=>node.leg.minutes),[20,12,35]);
 assert.equal(nodes.filter(node=>node.kind==='flight').length,0);
 assert.equal(nodes.at(-1).label,'返回酒店');
});

test('first and single-day axes insert real flight endpoints around local activity without the old placeholder',()=>{
 const single={...arrival,kind:'arrival_departure',milestones:[...arrival.milestones.slice(0,3),milestone('inbound-departure','返程起飞','2027-03-01T22:00'),milestone('inbound-arrival','返程抵达','2027-03-02T03:00')]};
 const nodes=buildPlanningDayTimeline({...estimate,journey:single});
 assert.deepEqual(nodes.filter(node=>node.kind==='flight').map(node=>node.milestone.localDateTime),['2027-03-01T07:00','2027-03-01T12:30','2027-03-01T22:00','2027-03-02T03:00']);
 assert.equal(nodes.some(node=>node.id.includes('local-activities')),false);
 assert.equal(nodes[0].kind,'flight');assert.equal(nodes.at(-1).kind,'flight');
});

test('an absent leg remains unknown rather than creating a zero-minute route',()=>{
 const nodes=buildPlanningDayTimeline({...estimate,scheduledDay:{stops,legs:legs.slice(1)}});
 const first=nodes.find(node=>node.kind==='travel');
 assert.equal(first.leg,undefined);assert.equal(first.from,'原酒店');assert.equal(first.to,'国家美术馆');
 const html=editor({...estimate,scheduledDay:{stops,legs:[]}});
 assert.match(html,/交通待核实/);assert.match(html,/不能按零耗时处理/);
});

test('legacy estimates fall back to their confirmed scenes without making up route evidence',()=>{
 const {scheduledDay,...legacy}=estimate;
 const nodes=buildPlanningDayTimeline(legacy);
 assert.deepEqual(nodes.filter(node=>node.kind==='place'&&node.scene).map(node=>node.scene.candidateId),['gallery-1','food-1']);
 assert.equal(nodes.some(node=>node.kind==='travel'),false);
 assert.match(editor(legacy),/国家美术馆停留小时/);
});

test('ordinary days keep their timeline and time editor without a transport duration override',()=>{
 const html=editor(estimate);
 assert.match(html,/aria-label="本日行程时间轴"/);
 assert.equal((html.match(/type="time"/g)||[]).length,2);
 assert.match(html,/>时间修改<\/button>/);assert.doesNotMatch(html,/调整全天交通总时长|交通总时长（小时）/);
 assert.equal((html.match(/aria-label="国家美术馆停留小时"/g)||[]).length,1);
 assert.equal((html.match(/aria-label="已选餐厅停留小时"/g)||[]).length,1);
 assert.match(html,/已选餐厅/);assert.match(html,/保存并核算本日/);
 assert.doesNotMatch(html,/上午／下午地点、停留、用餐与休息安排在下方调整/);
});

test('fixed flight days preserve ticket times and reminders without adding a duplicate ground-total card',()=>{
 const html=editor({...estimate,day:1,journey:arrival});
 assert.equal((html.match(/type="time"/g)||[]).length,1);
 assert.match(html,/<label>结束时间<input type="time"/);
 assert.match(html,/2027-03-01 07:00/);assert.match(html,/2027-03-01 12:30/);assert.match(html,/建议 2027-03-01 04:00 前到达/);
 assert.match(html,/国家美术馆停留小时/);assert.match(html,/修改机票/);
 assert.doesNotMatch(html,/交通总时长（小时）|当地地面交通/);
 assert.match(html,/航班为已确认时刻，地面过程为预计/);
});

test('free allocation exposes one budget and does not add period gaps or mandatory waits',()=>{
 const allocation=planningFreeAllocation({...metrics,periodFreeMinutes:90,openingWaitMinutes:60,logisticsMinutes:45});
 assert.equal(allocation.totalMinutes,178);assert.equal(allocation.unallocatedMinutes,153);
 assert.equal(allocation.bufferMinutes,25);assert.equal(allocation.personalMinutes,0);
 const html=editor({...estimate,metrics:{...metrics,periodFreeMinutes:90,openingWaitMinutes:60,logisticsMinutes:45}});
 assert.equal((html.match(/aria-label="尚未分配时间"/g)||[]).length,1);
 assert.match(html,/尚未分配/);assert.match(html,/约 2.55 小时/);
 assert.doesNotMatch(html,/本组总量约|酒店及行李事务约|用餐预留（小时）|额外缓冲/);
 assert.match(html,/扣除必要交通和已安排活动后/);
});

test('moving 153 remaining minutes into personal allowance conserves the budget and can be reversed',()=>{
 const personal=allocateRemainingToPersonal(metrics);
 assert.equal(personal,153);
 const after={...metrics,personalMinutes:personal,freeMinutes:0};
 assert.equal(planningFreeAllocation(after).totalMinutes,planningFreeAllocation(metrics).totalMinutes);
 assert.equal(planningFreeAllocation(after).unallocatedMinutes,0);
 const reverse={...after,personalMinutes:0,freeMinutes:153};
 assert.deepEqual(planningFreeAllocation(reverse),planningFreeAllocation(metrics));
});

test('quick allocation refuses stale or edited results, overtime, and individual reserve overflow',()=>{
 assert.equal(allocateRemainingToPersonal(metrics,true),null);
 assert.equal(allocateRemainingToPersonal({...metrics,overtimeMinutes:10}),null);
 assert.equal(allocateRemainingToPersonal({...metrics,personalMinutes:400,freeMinutes:100}),null);
 assert.equal(allocateRemainingToPersonal({...metrics,freeMinutes:0}),null);
 assert.equal(allocateRemainingToPersonal({...metrics,personalMinutes:327}),480);
 const html=editor({...estimate,metrics:{...metrics,overtimeMinutes:10,freeMinutes:0}});
 assert.match(html,/剩余时间为零，请先调整本日安排/);assert.doesNotMatch(html,/将剩余留给个人活动/);
});

test('empty days still have a daily axis and retain free time without a fictional activity',()=>{
 const empty={...estimate,scenes:[],sceneIds:[],scheduledDay:{stops:[hotelStart,{...hotelEnd,placeId:hotelStart.placeId,name:hotelStart.name}],legs:[]},transport:{status:'complete',totalMinutes:0,noOuting:true},metrics:{...metrics,visitMinutes:0,foodMinutes:0,travelMinutes:0}};
 const html=editor(empty);
 assert.match(html,/本日行程时间轴/);assert.match(html,/本日未选景点/);assert.match(html,/尚未分配时间/);
 assert.doesNotMatch(html,/国家美术馆停留小时|已选餐厅停留小时|交通待核实/);
});

test('legacy culinary included meal controls remain inside their activity without restoring default reserves',()=>{
 const area=scene('area-1','熟食中心','culinary_area');
 const areaStop=stop('area-stop','area-1','熟食中心','sight');
 const value={...estimate,scenes:[area],scheduledDay:{stops:[hotelStart,areaStop,hotelEnd],legs:[]}};
 const html=editor(value);
 assert.equal((html.match(/aria-label="熟食中心已含用餐小时"/g)||[]).length,1);
 assert.match(html,/包含在地点停留内，只计一次/);
 assert.equal((html.match(/用餐预留（小时）/g)||[]).length,0);
});

test('stale day estimates cannot expose an allocatable old balance but still allow recalculation',()=>{
 const html=editor({...estimate,overrides:{day:2,extraBufferMinutes:25}},{estimateStale:true});
 assert.match(html,/尚未分配<\/strong><span>待重新核算/);
 assert.doesNotMatch(html,/本组总量约|约 2.55 小时|将剩余留给个人活动/);
 assert.match(html,/国家美术馆停留小时/);
 assert.doesNotMatch(html,/disabled=""[^>]*>保存并核算本日/);
});

test('a historic explicitly selected storage stop keeps its identity without restoring baggage-operation controls',()=>{
 const baggage=stop('day-2-baggage-collection','gallery-1','取回行李 · 美术馆寄存处','other');
 const value={...estimate,journey:{...arrival,kind:'departure'},overrides:{day:2,baggage:{mode:'other',handlingMinutes:20,placeId:'gallery-1',storagePlace:{placeId:'gallery-1',name:'美术馆寄存处',address:'实际地址',location:{lat:1.29,lng:103.85}}}},scheduledDay:{stops:[hotelStart,gallery,baggage,hotelEnd],legs:[]}};
 const nodes=buildPlanningDayTimeline(value);
 const node=nodes.find(item=>item.kind==='place'&&item.stop?.id===baggage.id);
 assert.equal(node.label,'已确认途经点');assert.equal(node.scene,undefined);
 const html=editor(value);
 assert.equal((html.match(/aria-label="国家美术馆停留小时"/g)||[]).length,1);
 assert.match(html,/取回行李 · 美术馆寄存处/);
 assert.doesNotMatch(html,/每次寄存／取物操作预留（分钟）|本日行李安排/);
 assert.doesNotMatch(editor(estimate),/本日行李安排/);
});
