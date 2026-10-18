import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const handlers = new Map(), entries = new Map();
let downloads = 0;
const cache = {
  match:async request => entries.get(request.url)?.clone(),
  put:async (request,response) => {entries.set(request.url,response);},
};
vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'), {
  URL, Response, setTimeout,
  location:{origin:'https://cache.test'},
  self:{addEventListener:(name,handler)=>handlers.set(name,handler)},
  caches:{open:async()=>cache,match:cache.match},
  fetch:async()=>{++downloads;return new Response('fresh asset');},
});
async function request(url, method='GET') {
  const pending=[];
  let response;
  const event={request:{url:'https://cache.test'+url,method,mode:'cors'},respondWith:promise=>{response=promise;},waitUntil:promise=>pending.push(promise)};
  handlers.get('fetch')(event);
  const resolved=response ? await response : null;
  await Promise.all(pending);
  return resolved;
}
const versioned = '/js/wallet.js?v=67';
entries.set('https://cache.test'+versioned,new Response('cached release'));
assert.equal(await (await request(versioned)).text(),'cached release');
assert.equal(downloads,0,'Returning users do not download their already cached version while login is pending');
assert.equal(await (await request('/js/earn.js?v=new')).text(),'fresh asset');
assert.equal(downloads,1);
assert.equal(await (await request('/js/earn.js?v=new')).text(),'fresh asset');
assert.equal(downloads,1);
entries.set('https://cache.test/assets/preview.png',new Response('old image'));
assert.equal(await (await request('/assets/preview.png')).text(),'old image');
assert.equal(downloads,2,'Unversioned assets still refresh in the background');
assert.equal(await entries.get('https://cache.test/assets/preview.png').clone().text(),'fresh asset');
assert.equal(await request('/api/wallet/session'),null);
assert.equal(await request('/api/wallet/login-sign','POST'),null);
assert.equal(downloads,2,'Authentication and API traffic is never handled by the static cache');
console.log('PASS: cached release skips network; new version downloads once; unversioned assets update; API/signature requests bypass cache');
