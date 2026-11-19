import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const vite=await createServer({configFile:false,plugins:[react()],server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {FlightStage}=await vite.ssrLoadModule('/components/travel/planning/flight-stage.tsx');
const noop=()=>{};
const base={startDate:'2026-12-20',endDate:'2026-12-23',initialOrigin:'温州',travelers:{total:2,adults:2,children:null,seniors:null},busy:false,onSearch:noop,onSelect:noop,onManual:noop};
const searchBase={...base,selection:{mode:'quoted'}};
const link=(direction)=>({direction,departureDate:direction==='outbound'?base.startDate:base.endDate,url:`https://router.feizhu.com/ws/${direction}`,source:'bailian_flyai',queriedAt:'2026-11-05T00:00:00Z'});
const offer=(direction)=>({id:direction,direction,airline:'测试航空',flightNumber:'AB123',origin:'机场A',destination:'机场B',departureLocal:direction==='outbound'?'2026-12-20T06:00':'2026-12-23T10:00',arrivalLocal:direction==='outbound'?'2026-12-20T12:00':'2026-12-23T18:00',price:{display:'CNY 2000'},priceBasis:'per_person',bookingUrl:null});
test('real offers stay selectable while auxiliary links are collapsed and direction copy is accurate',()=>{
 const quotes={outbound:[offer('outbound')],inbound:[offer('inbound')],searchLinks:[link('outbound'),link('inbound')]};
 const html=renderToStaticMarkup(createElement(FlightStage,{...searchBase,quotes}));
 const details=[...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
 assert.equal(details.length,2);assert.ok(details.every((item)=>!item[1].includes('open')));
 assert.equal((html.match(/type="radio"/g)||[]).length,2);
 assert.equal((html.match(/更多飞猪查看入口/g)||[]).length,2);
 assert.equal((html.match(/去程按出发日查询，须在旅行首日抵达/g)||[]).length,1);
 assert.match(html,/返程按离开新加坡的出发日查询/);
 assert.doesNotMatch(html,/尚无可用于核算的具体航班/);
});

test('only verified CNY amounts are shown as yuan while foreign and unknown offers retain booking links',()=>{
 const quoted=(direction,price)=>({...offer(direction),price,bookingUrl:'https://router.feizhu.com/ws/real-flight'});
 const render=(price)=>renderToStaticMarkup(createElement(FlightStage,{...searchBase,quotes:{outbound:[quoted('outbound',price)],inbound:[],searchLinks:[]}}));
 const cny=render({amount:2296,currency:'CNY',display:'SGD 999'});
 assert.match(cny,/单人参考 ¥2296/);assert.doesNotMatch(cny,/SGD 999/);
 for(const price of [{amount:500,currency:'SGD',display:'¥500'},null,{amount:500,display:'¥500'}]){
  const html=render(price);
  assert.match(html,/暂无可核实的人民币参考价，价格以预订页为准/);
  assert.doesNotMatch(html,/¥500/);
  assert.match(html,/href="https:\/\/router.feizhu.com\/ws\/real-flight"/);
 }
});
test('link-only results open one auxiliary group and cannot be selected as confirmed flights',()=>{
 const html=renderToStaticMarkup(createElement(FlightStage,{...searchBase,quotes:{outbound:[],inbound:[],searchLinks:[link('outbound'),link('outbound')]}}));
 const details=[...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
 assert.equal(details.length,1);assert.match(details[0][1],/open/);
 assert.match(html,/这些链接不能直接选为已确认航班/);
 assert.equal((html.match(/type="radio"/g)||[]).length,0);
 assert.match(html,/disabled=""[^>]*>确认这组航班/);
});

test('first visit prefills four editable example times from the travel dates and requires confirmation',()=>{
 const html=renderToStaticMarkup(createElement(FlightStage,{...base,quotes:null}));
 assert.match(html,/role="tab" aria-selected="true"[^>]*>已订，填写时刻/);
 assert.equal((html.match(/role="tab"/g)||[]).length,2);
 assert.equal((html.match(/type="datetime-local"/g)||[]).length,4);
 for (const value of ['2026-12-20T07:00','2026-12-20T12:30','2026-12-23T20:00','2026-12-24T01:30','上海浦东国际机场 PVG','新加坡樟宜机场 SIN','Asia/Shanghai']) {
   assert.ok(html.includes(`value="${value}"`));
 }
 assert.match(html,/已按旅行日期填入示例，请按机票修改后确认/);
 assert.match(html,/disabled=""[^>]*>核验新加坡机场并保存已订时刻/);
 assert.doesNotMatch(html,/type="checkbox"[^>]*checked|无需航班/);
});

test('a one-day trip at the end of a year uses local calendar rollover in the return example',()=>{
 const html=renderToStaticMarkup(createElement(FlightStage,{...base,quotes:null,startDate:'2026-12-31',endDate:'2026-12-31'}));
 for (const value of ['2026-12-31T07:00','2026-12-31T12:30','2026-12-31T20:00','2027-01-01T01:30']) {
   assert.ok(html.includes(`value="${value}"`));
 }
});

test('legacy manual values survive reopening while absent endpoints remain empty',()=>{
 const html=renderToStaticMarkup(createElement(FlightStage,{...base,quotes:null,selection:{mode:'manual',arrivalAt:'2026-12-20T15:25',departureAt:'2026-12-23T23:45',arrivalAirportName:'新加坡樟宜机场',departureAirportName:'新加坡实里达机场'}}));
 assert.match(html,/value="2026-12-20T15:25"/);assert.match(html,/value="2026-12-23T23:45"/);
 assert.match(html,/value="新加坡实里达机场"/);
 assert.equal((html.match(/type="datetime-local"[^>]*value=""/g)||[]).length,2);
 assert.match(html,/原航班信息已保留/);
 assert.doesNotMatch(html,/已按旅行日期填入示例|上海浦东国际机场 PVG/);
});

test('complete saved manual journey restores its four exact dates, airports and time zones',()=>{
 const point=(localDateTime,timeZone,name)=>({localDateTime,timeZone,airport:{name}});
 const journey={source:'user',outbound:{source:'user',departure:point('2026-12-19T23:45','Asia/Tokyo','成田国际机场'),arrival:point('2026-12-20T06:30','Asia/Singapore','新加坡樟宜机场')},inbound:{source:'user',departure:point('2026-12-23T22:00','Asia/Singapore','新加坡樟宜机场'),arrival:point('2026-12-24T06:00','Asia/Tokyo','成田国际机场')}};
 const html=renderToStaticMarkup(createElement(FlightStage,{...base,quotes:null,selection:{mode:'manual',arrivalAt:'2026-12-20T06:30',departureAt:'2026-12-23T22:00',journey}}));
 for(const value of ['2026-12-19T23:45','2026-12-20T06:30','2026-12-23T22:00','2026-12-24T06:00','Asia/Tokyo','成田国际机场'])assert.ok(html.includes(`value="${value}"`));
 assert.doesNotMatch(html,/原航班信息已保留/);
});

test('historical none opens manual editing and search keeps the requested supplier notice',()=>{
 const legacy=renderToStaticMarkup(createElement(FlightStage,{...base,quotes:null,selection:{mode:'none'}}));
 assert.match(legacy,/role="tab" aria-selected="true"[^>]*>已订，填写时刻/);assert.doesNotMatch(legacy,/无需航班/);
 const search=renderToStaticMarkup(createElement(FlightStage,{...searchBase,quotes:{outbound:[],inbound:[]}}));
 assert.match(search,/因飞猪 API Skill 暂不支持，可能无法返回相关结果或存在 Bug，相关工作人员已知悉/);
 assert.doesNotMatch(search,/已记录在 README|无需航班/);
});
