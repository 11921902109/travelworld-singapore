import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conflictPresentation, minuteClock, readableMinutes, suggestedPeriodAdjustment } from '../lib/travel/planning-conflicts.ts';

const fixture=()=>({code:'period_conflict',day:1,date:'2026-12-20',draftVersion:5,placeId:'museum',placeName:'亚洲文明博物馆',message:'旧的长段说明',visitSource:'user',periodStrength:'soft',arrivalAt:'2026-12-20T12:00',arrivalSource:'user',airportReserveMinutes:120,hotelMinutes:45,routeMinutes:44,effectiveStartTime:'14:00',preferredStartTime:'09:30',openingHours:'10:00–19:00',suggestedDay:2,window:{reasonCode:'period_conflict',arrivalMinute:929,earliestVisitStart:929,visitMinutes:90,openingIntervals:[[600,1140]],latestFeasibleStart:1050,closingMinute:1140,missingMinutes:0,effectivePeriod:'morning'}});
test('period conflict recommends checking same afternoon without inventing a closing deficit',()=>{
 const conflict=fixture(),original=structuredClone(conflict),view=conflictPresentation(conflict);
 assert.equal(suggestedPeriodAdjustment(conflict),'afternoon');assert.match(view.conclusion,/15:29/);assert.match(view.conclusion,/当天.*下午/);assert.doesNotMatch(view.conclusion,/超过.*闭馆|不足.*参观/);assert.equal(view.advisory,true);
 assert.match(view.steps.find(step=>step.title==='机场事务').detail,/2 小时.*14:00.*不含地面交通/);
 assert.match(view.steps.find(step=>step.title==='前往场馆').detail,/44 分钟.*45 分钟.*15:29/);
 assert.match(view.steps.find(step=>step.title==='当前选择').detail,/1 小时 30 分钟.*你的设置/);
 assert.match(view.steps.find(step=>step.title==='抵达新加坡').detail,/你填写/);assert.deepEqual(conflict,original);
});
test('closing shortage and unknown opening never offer a same-day period escape',()=>{
 const conflict=fixture();conflict.code='arrival_too_late';conflict.window={...conflict.window,earliestVisitStart:1110,arrivalMinute:1110,missingMinutes:60};
 assert.equal(suggestedPeriodAdjustment(conflict),null);const view=conflictPresentation(conflict);assert.match(view.conclusion,/20:00.*19:00.*1 小时/);assert.equal(view.advisory,false);
 conflict.code='period_conflict';conflict.window.openingIntervals=[];assert.equal(suggestedPeriodAdjustment(conflict),null);
});
test('display durations use adjacent hours and minutes and clock rounding cannot render minute 60',()=>{
 assert.equal(readableMinutes(45),'45 分钟');assert.equal(readableMinutes(90),'1 小时 30 分钟');assert.equal(readableMinutes(120),'2 小时');assert.equal(readableMinutes(0),'0 分钟');assert.equal(minuteClock(959.8),'16:00');assert.equal(minuteClock(1440),'次日 00:00');
});
const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {ScheduleConflictCard,ScheduleMoveBatch,ScheduleMovePreviewResults}=await vite.ssrLoadModule('/components/travel/planning/schedule-conflict-card.tsx');
test('card prioritizes afternoon preview and groups evidence without duplicated old prose',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleConflictCard,{conflict:fixture(),busy:false,onSave:async()=>true,onReviewBoard:()=>{},onPreviewMove:async()=>null,onApplyMove:async()=>true}));
 assert.match(html,/<ol/);assert.doesNotMatch(html,/<dl|旧的长段说明|0\.75 小时|0\.73 小时/);assert.ok(html.indexOf('核对改到当天下午')<html.indexOf('核对移到后一天'));assert.match(html,/1 小时 30 分钟/);assert.match(html,/role="status"/);
 const hard=fixture();hard.periodStrength='hard';const hardHtml=renderToStaticMarkup(createElement(ScheduleConflictCard,{conflict:hard,busy:false,onSave:async()=>true,onReviewBoard:()=>{}}));assert.match(hardHtml,/固定要求，改变前须明确确认/);assert.match(hardHtml,/role="alert"/);
});

const pendingPlace = () => ({...fixture(),placeId:'second-place',placeName:'另一个上午地点'});
const resultPreview = (changes) => ({day:1,targetDay:1,placeId:'museum',feasible:false,fingerprint:'preview-test',
  message:'调整后仍有待处理的时间或开放问题。',days:[],conflicts:[pendingPlace()],...changes});
const renderPreview = (preview) => renderToStaticMarkup(createElement(ScheduleMovePreviewResults,{
  preview,originalPlaceName:'亚洲文明博物馆',
}));

test('same-day afternoon preview identifies the remaining stop rather than the original conflict',()=>{
  const html=renderPreview(resultPreview({targetPeriod:'afternoon',periodChange:{from:'morning',to:'afternoon',strength:'soft'}}));
  assert.match(html,/本次核算 · 仍需调整/);
  assert.match(html,/Day 1 · 仍需调整[\s\S]*另一个上午地点[\s\S]*15:29/);
  assert.doesNotMatch(html,/亚洲文明博物馆|Day 2/);
});

test('cross-day preview shows the source conflict and a passing target day with its estimate',()=>{
  const estimate={day:2,date:'2026-12-21',placeNames:['亚洲文明博物馆','Park View Square'],freeMinutes:570,returnTime:'12:46'};
  const html=renderPreview(resultPreview({targetDay:2,days:[estimate]}));
  assert.match(html,/Day 1 · 仍需调整[\s\S]*另一个上午地点[\s\S]*Day 2 · 已通过[\s\S]*9 小时 30 分钟[\s\S]*12:46/);
});

test('an estimate does not pass a day with unresolved opening hours or a missing result',()=>{
  const estimate={day:2,date:'2026-12-21',placeNames:['亚洲文明博物馆'],freeMinutes:570,returnTime:'12:46'};
  const warning={day:2,placeId:'museum',code:'OPENING_HOURS_UNKNOWN',message:'目标日开放信息尚未核实。',date:estimate.date,draftVersion:5};
  const html=renderPreview(resultPreview({targetDay:2,days:[estimate],conflicts:[warning]}));
  assert.match(html,/Day 1 · 尚无核算结果/);
  assert.match(html,/Day 2 · 仍需调整[\s\S]*亚洲文明博物馆[\s\S]*开放信息尚未核实/);
  assert.doesNotMatch(html,/Day 2 · 已通过|12:46/);
});

const chijmes = {...fixture(),placeId:'chijmes',placeName:'赞美广场'};
const artScience = {...fixture(),placeId:'artscience',placeName:'艺术科学博物馆'};
const travelDays = [{day:1,date:'2026-12-20'},{day:2,date:'2026-12-21'}];
const moveChijmes = {day:1,placeId:chijmes.placeId,placeName:chijmes.placeName,fromPeriod:'morning',targetDay:2};
const finishOnDay2 = {...travelDays[1],placeNames:['赞美广场','Park View Square'],freeMinutes:569,returnTime:'12:46'};
const batchPreview = (changes) => ({
  draftVersion:5,moves:[moveChijmes],affectedDays:[1,2],conflicts:[artScience],days:[finishOnDay2],
  feasible:false,fingerprint:'batch-test',message:'核算已完成',requiresAcknowledgement:false,...changes,
});
const renderBatch = (preview) => renderToStaticMarkup(createElement(ScheduleMoveBatch,{
  days:travelDays,moves:preview.moves,originals:[chijmes],preview,pending:null,busy:false,blocked:false,stale:false,
  error:'',nameOf:(issue)=>issue.placeName||'当天安排',onMove:()=>{},onRemove:()=>{},onRetry:()=>{},
  onApply:()=>{},onCancel:()=>{},onReviewBoard:()=>{},
}));

test('the batch keeps CHIJMES and renders move actions under the currently conflicting museum',()=>{
  const html=renderBatch(batchPreview());
  assert.match(html,/待确认调整[\s\S]*Day 1 上午 → Day 2 上午/);
  assert.match(html,/Day 1 · 仍需调整[\s\S]*艺术科学博物馆[\s\S]*15:29[\s\S]*拟改到 Day 1 下午并核对[\s\S]*为艺术科学博物馆选择其他日期和时段[\s\S]*Day 2 · 已通过[\s\S]*12:46/);
  assert.doesNotMatch(html,/确认全部调整/);
});

test('a passing batch asks for explicit acknowledgement before hard-period changes can be saved',()=>{
  const preview=batchPreview({
    moves:[{...moveChijmes,targetDay:1,targetPeriod:'afternoon',periodChange:{from:'morning',to:'afternoon',strength:'hard',evidence:'只能上午'}},{day:1,placeId:'artscience',placeName:'艺术科学博物馆',fromPeriod:'morning',targetDay:1,targetPeriod:'afternoon'}],
    conflicts:[],days:[{...travelDays[0],placeNames:['赞美广场','艺术科学博物馆'],freeMinutes:115,returnTime:'19:05'}],
    affectedDays:[1],feasible:true,requiresAcknowledgement:true,
  });
  assert.match(renderBatch(preview),/只能上午[\s\S]*Day 1 · 已通过[\s\S]*我同意[\s\S]*<button[^>]*disabled=""[^>]*>确认全部调整/);
});

test('provider evidence failures are pending and can be retried without dropping the move',()=>{
  const routeIssue={...travelDays[0],code:'ROUTE_EVIDENCE_UNAVAILABLE',draftVersion:5,message:'交通时间暂待核实'};
  assert.match(renderBatch(batchPreview({conflicts:[routeIssue]})),/待确认调整[\s\S]*赞美广场[\s\S]*Day 1 · 待核实[\s\S]*交通时间暂待核实[\s\S]*Day 2 · 已通过[\s\S]*重新核对待确认调整/);
});

test('a closed original venue can choose another date when no quick option applies',()=>{
  const closed={...chijmes,code:'closed_day',day:2,date:travelDays[1].date,suggestedDay:undefined,
    window:{...chijmes.window,reasonCode:'closed_day',openingIntervals:[]}};
  const html=renderToStaticMarkup(createElement(ScheduleConflictCard,{conflict:closed,busy:false,onSave:async()=>true,
    onReviewBoard:()=>{},travelDays,onStageMove:()=>{}}));
  assert.match(html,/选择其他日期和时段/);
  assert.doesNotMatch(html,/核对改到当天|核对移到后一天/);
});
