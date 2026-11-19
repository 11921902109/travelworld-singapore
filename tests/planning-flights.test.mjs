import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  resolve: { alias: { "@": process.cwd() } },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});
after(() => vite.close());
const { parseFlightAgentResponse } = await vite.ssrLoadModule("/lib/travel/planning-flights.ts");

const base = {
  queriedAt: "2026-10-31T09:00:00.000Z",
  outboundDates: ["2026-12-19", "2026-12-20"],
  inboundDates: ["2026-12-23", "2026-12-24"],
  requiredArrivalDate: "2026-12-20",
  travelers: { total: 2, adults: 2, children: null, seniors: null },
  preferences: { arrivalBefore: null, departureAfter: null },
};

function offer(departureLocal, arrivalLocal, flightNumber, bookingUrl) {
  return {
    origin: "温州龙湾国际机场",
    destination: "新加坡樟宜机场",
    departureLocal,
    arrivalLocal,
    airline: "东航",
    flightNumber,
    price: { amount: 2296, currency: "CNY" },
    bookingUrl,
  };
}

test("12 月 19 日出发且 20 日抵达的航班保留；20 日出发查询失败不抹掉它", () => {
  const url = "https://router.feizhu.com/multi/webview?url=https%3A%2F%2Frouter.feizhu.com%2Fws%2F2q13l6";
  const text = `根据查询结果，12 月 20 日出发日查询失败。\n${JSON.stringify({
    queries: [
      { direction: "outbound", departureDate: "2026-12-19", status: "success", errorCode: null },
      { direction: "outbound", departureDate: "2026-12-20", status: "error", errorCode: "TOOL_ERROR" },
      { direction: "inbound", departureDate: "2026-12-23", status: "error", errorCode: null },
      { direction: "inbound", departureDate: "2026-12-24", status: "success", errorCode: null },
    ],
    outbound: [
      offer("2026-12-19T12:00:00", "2026-12-19T22:15:00", "MF8040+MF885", url),
      offer("2026-12-19T19:45:00", "2026-12-20T05:30:00", "MU9662+MU2047", ` ${url} `),
    ],
    inbound: [{ ...offer("2026-12-24T22:55:00", "2026-12-25T10:00:00", "CA678+CA8567", null), origin: "新加坡樟宜机场", destination: "温州龙湾国际机场", priceBasis: "per_person" }],
  })}`;
  const result = parseFlightAgentResponse({ ...base, text });

  assert.equal(result.outbound.length, 1);
  assert.equal(result.outbound[0].departureLocal, "2026-12-19T19:45");
  assert.equal(result.outbound[0].arrivalLocal, "2026-12-20T05:30");
  assert.equal(result.outbound[0].bookingUrl, url);
  assert.equal(result.queryOutcomes.find((item) => item.departureDate === "2026-12-20" && item.direction === "outbound").status, "failed");
  assert.equal(result.queryOutcomes.find((item) => item.departureDate === "2026-12-19" && item.direction === "outbound").status, "available");
  assert.equal(result.rejected.find((item) => item.reason === "wrong_arrival_date").count, 1);
  assert.equal(result.inbound[0].priceBasis, "per_person");
});

test("没有逐日期报告时不编造接口失败状态，安全提取同址 Markdown 预订链接", () => {
  const url = "https://router.feizhu.com/ws/2q13l6";
  const result = parseFlightAgentResponse({
    ...base,
    text: JSON.stringify({ outbound: [offer("2026-12-19T19:45", "2026-12-20T05:30", "MU9662+MU2047", `[${url}](${url})`)], inbound: [] }),
  });

  assert.equal(result.outbound[0].bookingUrl, url);
  assert.equal(result.queryOutcomes.find((item) => item.departureDate === "2026-12-20" && item.direction === "outbound").status, "unknown");
  assert.equal(result.inbound.length, 0);
  assert.equal(result.status, "available");
});


test("reported error codes retain bounded diagnostic punctuation without accepting markup", () => {
  const parse = (errorCode) => parseFlightAgentResponse({ ...base, text: JSON.stringify({ queries: [{ direction: "inbound", departureDate: "2026-12-23", status: "error", errorCode }], outbound: [], inbound: [] }) });
  assert.equal(parse("search-flight:status1").queryOutcomes.find((item) => item.direction === "inbound").errorCode, "search-flight:status1");
  assert.equal(parse("<script>private tool log</script>").queryOutcomes.find((item) => item.direction === "inbound").errorCode, null);
});

test("a scoped parser ignores unsolicited other-direction offers and reports only requested dates", () => {
  const result = parseFlightAgentResponse({ ...base, outboundDates: [], inboundDates: ["2026-12-23"], text: JSON.stringify({
    queries: [{ direction: "outbound", departureDate: "2026-12-20", status: "success" }, { direction: "inbound", departureDate: "2026-12-23", status: "error", errorCode: "search-flight:status1" }],
    outbound: [offer("2026-12-20T06:30", "2026-12-20T15:00", "OLD123", "https://router.feizhu.com/ws/offer")], inbound: [],
  }) });
  assert.deepEqual(result.outbound, []);
  assert.equal(result.queryOutcomes.length, 1);
  assert.equal(result.queryOutcomes[0].direction, "inbound");
  assert.equal(result.queryOutcomes[0].status, "failed");
});


test("Chinese reported errors survive as bounded messages and do not fabricate links or no-ticket results", () => {
  const result = parseFlightAgentResponse({ ...base, outboundDates: [], inboundDates: ["2026-12-23"], text: JSON.stringify({
    queries: [{direction:"inbound",departureDate:"2026-12-23",status:"error",errorCode:"搜索机票低价行业失败"}], outbound: [], inbound: [],
  }) });
  assert.equal(result.queryOutcomes[0].status,"failed");
  assert.equal(result.queryOutcomes[0].errorCode,null);
  assert.equal(result.queryOutcomes[0].reportedErrorMessage,"搜索机票低价行业失败");
  assert.deepEqual(result.inbound,[]);
  assert.deepEqual(result.rejected,[]);
  assert.deepEqual(result.searchLinks,[]);
  const sensitive = parseFlightAgentResponse({ ...base, text: JSON.stringify({ queries: [{direction:"inbound",departureDate:"2026-12-23",status:"error",reportedErrorMessage:"api_key=should-not-be-displayed"}], outbound: [], inbound: [] }) });
  assert.equal(sensitive.queryOutcomes.find((x)=>x.direction==='inbound').reportedErrorMessage,"查询工具返回错误，详细信息已省略。");
});

test("a complete flight with only a real jumpUrl is retained without inventing a price", () => {
  const url="https://router.feizhu.com/ws/real-return";
  const result=parseFlightAgentResponse({ ...base, text:JSON.stringify({outbound:[],inbound:[{...offer("2026-12-23T18:00","2026-12-23T23:00","REAL123"),price:null,jumpUrl:url,origin:"新加坡樟宜机场",destination:"温州龙湾国际机场"}]}) });
  assert.equal(result.inbound.length,1);
  assert.equal(result.inbound[0].bookingUrl,url);
  assert.equal(result.inbound[0].price,null);
  assert.deepEqual(result.searchLinks,[]);
});

test("search-only jump links stay separate from selectable flights and are scoped to the requested direction", () => {
  const url="https://router.feizhu.com/ws/search-return";
  const result=parseFlightAgentResponse({ ...base, outboundDates:[], inboundDates:["2026-12-23"], text:JSON.stringify({outbound:[],inbound:[{jumpUrl:url}],searchLinks:[{direction:"outbound",departureDate:"2026-12-20",jumpUrl:url},{direction:"inbound",departureDate:"2026-12-23",jumpUrl:url}]}) });
  assert.equal(result.inbound.length,0);
  assert.equal(result.status,"unavailable");
  assert.equal(result.searchLinks.length,1);
  assert.equal(result.searchLinks[0].direction,"inbound");
  assert.equal(result.searchLinks[0].url,url);
  assert.equal(result.searchLinks[0].departureDate,"2026-12-23");
  assert.deepEqual(result.rejected,[]);
});

test("reported IANA zones are retained only when valid and absent zones are never guessed from airports", () => {
  const result=parseFlightAgentResponse({...base,text:JSON.stringify({outbound:[{...offer('2026-12-20T06:00','2026-12-20T12:00','ZONE123','https://router.feizhu.com/ws/zone'),departureTimeZone:'Asia/Shanghai',arrivalTimeZone:'not-a-zone'}],inbound:[]})});
  assert.equal(result.outbound[0].departureTimeZone,'Asia/Shanghai');assert.equal(result.outbound[0].arrivalTimeZone,null);
  const unknown=parseFlightAgentResponse({...base,text:JSON.stringify({outbound:[offer('2026-12-20T06:00','2026-12-20T12:00','ZONE456','https://router.feizhu.com/ws/zone')],inbound:[]})});
  assert.equal(unknown.outbound[0].departureTimeZone,null);
});
