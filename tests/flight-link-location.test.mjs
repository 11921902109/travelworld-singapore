import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFeizhuBookingUrl, firstFeizhuBookingUrl } from "../lib/travel/feizhu-link.ts";
import { normalizeFlightLocation } from "../lib/travel/flight-location.ts";

test("returned supplier links accept trusted wrappers and reject external or obfuscated destinations",()=>{
  const direct="https://router.feizhu.com/ws/real";
  const wrapped="https://router.feizhu.com/multi/webview?url="+encodeURIComponent(direct);
  assert.equal(normalizeFeizhuBookingUrl(direct),direct);
  assert.equal(normalizeFeizhuBookingUrl(wrapped),wrapped);
  assert.equal(normalizeFeizhuBookingUrl(`[${direct}](${direct})`),direct);
  assert.equal(firstFeizhuBookingUrl("invalid",direct),direct);
  const withCredentials = new URL(direct);
  withCredentials.username = "test-user";
  withCredentials.password = "test-password";
  for(const url of ["http://router.feizhu.com/ws/real","https://router.feizhu.com.evil.test/ws/real",withCredentials.href,`https://router.feizhu.com/?url=${encodeURIComponent("https://evil.test")}`,`https://router.feizhu.com/#/web?url=${encodeURIComponent("javascript:alert(1)")}`,"https://router.feizhu.com/?url=%256aavascript%253Aalert(1)","https://router.feizhu.com/?url=%252F%252Fevil.test"]) assert.equal(normalizeFeizhuBookingUrl(url),null,url);
});

test("known names normalize to Chinese without guessing codes or broadening an airport into a city",()=>{
  assert.deepEqual(normalizeFlightLocation(" Singapore "),{input:"Singapore",name:"新加坡",kind:"city",normalized:true});
  assert.deepEqual(normalizeFlightLocation("温州机场"),{input:"温州机场",name:"温州龙湾国际机场",kind:"airport",normalized:true});
  assert.equal(normalizeFlightLocation("Changi Airport").name,"新加坡樟宜机场");
  assert.deepEqual(normalizeFlightLocation("Unspecified Local Airstrip"),{input:"Unspecified Local Airstrip",name:"Unspecified Local Airstrip",kind:"unspecified",normalized:false});
});
