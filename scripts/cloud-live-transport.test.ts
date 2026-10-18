import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Новый процесс нужен для настоящих CJS/ESM ws и восстановления builtin wrappers.
const node24 = Number(process.versions.node.split('.')[0]) === 24;
function offline(source: string, env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: source, cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    env: { HTTPS_PROXY: 'http://127.0.0.1:9', ...env },
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
const setup = `
import assert from 'node:assert/strict';
import https from 'node:https'; import http from 'node:http';
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns';
import dp from 'node:dns/promises';
let calls = []; let originals = 0;
const blocked = () => { const e = new Error('offline'); e.code='OFFLINE'; throw e; };
net.Socket.prototype.connect = function(...args) { calls.push('socket'); return blocked(); };
net.connect = net.createConnection = (...args) => { calls.push('proxy-net'); return blocked(); };
tls.connect = (...args) => { calls.push('proxy-tls'); return blocked(); };
dns.lookup = dp.lookup = () => { originals++; return blocked(); };
const {installCloudLiveTransport} = await import('./scripts/cloud-live-transport.mjs');
`;
describe.skipIf(!node24)('Cloud process transport: network=0', () => {
  it.each([['http://127.0.0.1:9', 'proxy-net'], ['https://127.0.0.1:9', 'proxy-tls']])('реальный ws ESM/CJS выбирает %s', (proxy, kind) => {
    expect(offline(setup + `
const {createRequire}=await import('node:module');
const req=createRequire(import.meta.url); const CJS=req('ws');
const ESM=(await import('ws')).default; assert.equal(CJS, ESM);
const adapter=installCloudLiveTransport({authorized:true});
try { new ESM('wss://api.openai.com/v1/live/sessions', {headers:{'User-Agent':'LiveKit Agents', Authorization:'Bearer OFFLINE_AUTH'}}); } catch(e) {assert.equal(e.code,'OFFLINE');}
assert.deepEqual(calls, ['${kind}']); assert.equal(originals,0);
adapter.uninstall(); adapter.uninstall();
console.log(JSON.stringify({calls, originals, attempts:adapter.handshakes}));`, { HTTPS_PROXY: proxy })).toEqual({ calls: [kind], originals: 0, attempts: 1 });
  });
  it.each([{ HTTPS_PROXY: '' }, { NO_PROXY: 'api.openai.com' }, { no_proxy: '*' }])('missing proxy/NO_PROXY блокируется до socket', (env) => {
    expect(offline(setup + `
const adapter=installCloudLiveTransport({authorized:true});
const WS=(await import('ws')).default;
assert.throws(()=>new WS('wss://api.openai.com/v1/live/sessions'), /CLOUD_/);
assert.deepEqual(calls,[]); adapter.uninstall();
console.log(JSON.stringify({network:originals,calls}));`, env)).toEqual({ network: 0, calls: [] });
  });
  it('narrow options, atomic one handshake, auth identity, no TLS weakening, cleanup', () => {
    expect(offline(setup + `
let accepted; let requests=0;
const fake = {on(){return this;}, once(){return this;}, destroy(){}};
https.request=(options)=>{requests++;accepted=options;return fake;};
const originalRequest=https.request; const originalConnect=net.connect;
const adapter=installCloudLiveTransport({authorized:true});
const headers={Connection:'Upgrade',Upgrade:'WebSocket', Authorization:'Bearer OFFLINE_AUTH'};
const opts={host:'api.openai.com',port:443,path:'/v1/live/sessions',method:'GET',headers};
for(const bad of [{host:'wrong.test'}, {hostname:'wrong.test'}, {port:444}, {path:'/v1/live/sessions?x=1'}, {method:'POST'}, {protocol:'http:'}, {socketPath:'/tmp/a'}, {rejectUnauthorized:false}, {headers:{...headers,host:'api.openai.com'}}, {headers:{Upgrade:'websocket'}}, {headers:{Connection:'Upgrade',Upgrade:'http'}}, {createConnection:undefined, agent:false}]) {
 assert.throws(()=>https.request({...opts,...bad}),/CLOUD_/);
}
assert.throws(()=>https.request('https://api.openai.com/v1/live/sessions'),/CLOUD_/);
assert.throws(()=>https.request(opts,{},()=>{}),/CLOUD_/);
assert.throws(()=>http.request(opts),/CLOUD_/); assert.equal(requests,0);
https.request(opts); assert.equal(accepted.headers,headers); assert.equal(accepted.headers.Authorization,'Bearer OFFLINE_AUTH');
assert.equal(accepted.agent.options.rejectUnauthorized,undefined);
assert.equal(accepted.agent.options.keepAlive,false);
assert.throws(()=>https.request(opts),/CLOUD_HANDSHAKE_USED/); assert.equal(requests,1);
adapter.close(); adapter.close(); assert.throws(()=>https.request(opts),/CLOUD_CLOSING/);
adapter.uninstall(); adapter.uninstall(); assert.equal(https.request,originalRequest); assert.equal(net.connect,originalConnect);
console.log(JSON.stringify({requests,network:originals}));`)).toEqual({ requests: 1, network: 0 });
  });
  it('socket/DNS guard, known proxy socket for inner TLS; no arbitrary existing socket', () => {
    expect(offline(setup + `
net.connect=net.createConnection=()=>new net.Socket();
net.Socket.prototype.connect=function(){return this;};
let tlsCalls=0; tls.connect=(opts)=>{assert.notEqual(opts.rejectUnauthorized,false);tlsCalls++;return new net.Socket();};
const adapter=installCloudLiveTransport({authorized:true});
for(const action of [()=>net.connect(443,'api.openai.com'),()=>new net.Socket().connect({host:'api.openai.com',port:443}),()=>tls.connect({host:'api.openai.com',port:443}),()=>tls.connect({socket:new net.Socket(),servername:'api.openai.com'}),()=>net.connect('/tmp/a'),()=>net.connect({host:'127.0.0.1',port:8}),()=>dns.lookup('api.openai.com'),()=>dp.lookup('api.openai.com')]) assert.throws(action,/CLOUD_/);
const socket=net.connect({host:'127.0.0.1',port:9});
tls.connect({socket,servername:'api.openai.com'});
assert.throws(()=>tls.connect({socket,servername:'wrong.test'}),/CLOUD_/);
assert.throws(()=>tls.connect({socket,servername:'api.openai.com',rejectUnauthorized:false}),/CLOUD_/);
new net.Socket().connect([ {host:'127.0.0.1',port:9}, null ]);
net.connect(9,'127.0.0.1');
assert.equal(tlsCalls,1);assert.equal(originals,0);adapter.uninstall();
console.log(JSON.stringify({tlsCalls,network:originals}));`)).toEqual({ tlsCalls: 1, network: 0 });
  });
  it('реальный Node CONNECT использует trusted proxy socket для inner TLS без сети',()=>{
    expect(offline(setup + `
let innerCalls=0; let outerCalls=0;
net.connect=net.createConnection=(options,cb)=>{
 outerCalls++; const socket=new net.Socket(); let response=true;
 socket.write=()=>true; socket.read=()=>{if(!response)return null;response=false;return Buffer.from('HTTP/1.1 200 Connection established\\r\\n\\r\\n');};
 queueMicrotask(()=>cb?.()); return socket;
};
tls.connect=(options,cb)=>{
 assert.equal(options.host,'api.openai.com');assert.ok(options.socket);assert.notEqual(options.rejectUnauthorized,false);innerCalls++;
 const socket=new net.Socket();queueMicrotask(()=>{const e=new Error('offline marker');e.code='ECONNRESET';socket.emit('error',e);});return socket;
};
const adapter=installCloudLiveTransport({authorized:true});const WS=(await import('ws')).default;
await new Promise((resolve,reject)=>{
 const ws=new WS('wss://api.openai.com/v1/live/sessions',{handshakeTimeout:100});
 ws.on('error',()=>resolve());ws.on('open',()=>reject(new Error('unexpected')));
});adapter.uninstall();assert.equal(innerCalls,1);assert.equal(outerCalls,1);
console.log(JSON.stringify({innerCalls,outerCalls,network:originals}));`)).toEqual({innerCalls:1,outerCalls:1,network:0});
  });
  it('concurrent handshakes admit one original; safe errors/statuses never include body or raw auth',()=>{
    expect(offline(setup+`
const {EventEmitter}=await import('node:events');const {safeFailure,verifyCloudLiveSDK}=await import('./scripts/cloud-live-transport.mjs');
let count=0;const req=new EventEmitter(); https.request=()=>{count++;return req;};
const failures=[];const adapter=installCloudLiveTransport({authorized:true,onFailure:value=>failures.push(value)});
const options={host:'api.openai.com',port:443,path:'/v1/live/sessions',method:'GET',headers:{Connection:'Upgrade',Upgrade:'websocket',Authorization:'PRIVATE'}};
const results=await Promise.allSettled([Promise.resolve().then(()=>https.request(options)),Promise.resolve().then(()=>https.request(options))]);
assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);assert.equal(count,1);
req.emit('response',{statusCode:403,body:'PRIVATE'});req.emit('error',Object.assign(new Error('PRIVATE'),{code:'ERR_PROXY_TUNNEL',statusCode:403,headers:{Authorization:'PRIVATE'}}));
assert.deepEqual(failures.slice(-2),[{class:'CLOUD_HTTP_STATUS',status:403},{class:'ERR_PROXY_TUNNEL',status:403}]);
assert.deepEqual(safeFailure(new Error('PRIVATE')),{class:'CLOUD_TRANSPORT_FAILED'});
assert.throws(()=>verifyCloudLiveSDK('/nonexistent'),/CLOUD_SDK_DRIFT/);
adapter.uninstall();console.log(JSON.stringify({count,failures:failures.slice(-2),network:originals}));`)).toEqual({count:1,failures:[{class:'CLOUD_HTTP_STATUS',status:403},{class:'ERR_PROXY_TUNNEL',status:403}],network:0});
  });
  it('настоящий outer tls.connect сохраняет Node default checker до intercepted Socket.connect',()=>{
    expect(offline(`
import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';import dns from 'node:dns';import dp from 'node:dns/promises';
let sockets=0;let network=0;
net.Socket.prototype.connect=function(args){const opts=Array.isArray(args)?args[0]:args;assert.equal(opts.checkServerIdentity,tls.checkServerIdentity);assert.notEqual(opts.rejectUnauthorized,false);sockets++;const error=new Error('offline');error.code='OFFLINE';throw error;};
dns.lookup=dp.lookup=()=>{network++;throw new Error('unexpected DNS');};
const {installCloudLiveTransport}=await import('./scripts/cloud-live-transport.mjs');const adapter=installCloudLiveTransport({authorized:true});
const WS=(await import('ws')).default;assert.throws(()=>new WS('wss://api.openai.com/v1/live/sessions'),e=>e.code==='OFFLINE');
assert.throws(()=>tls.connect({host:'127.0.0.1',port:9,checkServerIdentity:()=>undefined}),/CLOUD_TLS_UNSAFE/);
assert.throws(()=>tls.connect({host:'127.0.0.1',port:9,rejectUnauthorized:false}),/CLOUD_TLS_UNSAFE/);
assert.equal(sockets,1);assert.equal(network,0);adapter.uninstall();console.log(JSON.stringify({sockets,network}));`,{HTTPS_PROXY:'https://127.0.0.1:9'})).toEqual({sockets:1,network:0});
  });
});
