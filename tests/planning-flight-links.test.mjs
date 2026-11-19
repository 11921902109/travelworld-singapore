import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
const vite = await createServer({configFile:false,server:{middlewareMode:true,hmr:false},resolve:{alias:{'@':process.cwd()}},optimizeDeps:{noDiscovery:true},logLevel:'error'});
after(()=>vite.close());
const {flightSearchLinkGroups}=await vite.ssrLoadModule('/lib/travel/planning-flight-links.ts');
const link=(url,patch={})=>({direction:'outbound',departureDate:'2026-12-20',url,source:'bailian_flyai',queriedAt:'2026-11-05T00:00:00Z',...patch});
test('equivalent transparent wrappers are grouped while the actual returned URL remains intact',()=>{
 const target='https://router.feizhu.com/ws/flight-a';
 const wrapper='https://router.feizhu.com/multi/webview?url='+encodeURIComponent(target);
 const result=flightSearchLinkGroups([link(wrapper),link(target),link(wrapper),link(target,{direction:'inbound'})],'outbound');
 assert.equal(result.length,1);assert.equal(result[0].links.length,1);assert.equal(result[0].links[0].url,wrapper);
});
test('different product, date and signed parameters remain distinct; untrusted entries are excluded',()=>{
 const url='https://router.feizhu.com/ws/flight-a';
 const result=flightSearchLinkGroups([link(url+'?sig=a'),link(url+'?sig=b'),link(url,{departureDate:'2026-12-21'}),link('https://example.com/flight'),link('https://router.feizhu.com/multi/webview?url=https%3A%2F%2Fevil.example')],'outbound');
 assert.equal(result.length,2);assert.equal(result[0].links.length,2);assert.equal(result[1].date,'2026-12-21');
 assert.equal(flightSearchLinkGroups(undefined,'outbound').length,0);
});
