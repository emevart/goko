// Только child Cloud probe. Установить до загрузки ws/SDK; не использовать в production.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class CloudProbeError extends Error {
  constructor(code) { super(code); this.name = 'CloudProbeError'; this.code = code; }
}
const deny = code => { throw new CloudProbeError(code); };
const proxyKeys = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
export function inheritedProxySettings(env = process.env) {
  return Object.fromEntries(proxyKeys.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

// Версия и проверенная форма SDK/ws — обязательный gate, никакого угадывания при drift.
export function verifyCloudLiveSDK(root) {
  try {
    const req = createRequire(join(root, 'apps/voice-agent/src/voice.ts'));
    const versions = {};
    for (const name of ['@livekit/agents', '@livekit/agents-plugin-openai']) {
      const entry = req.resolve(name);
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'));
      if (pkg.version !== '1.8.1') deny('CLOUD_SDK_DRIFT');
      versions[name] = pkg.version;
    }
    const entry = req.resolve('@livekit/agents-plugin-openai');
    const sdkReq = createRequire(entry);
    const ws = sdkReq.resolve('ws');
    if (JSON.parse(readFileSync(join(dirname(ws), 'package.json'), 'utf8')).version !== '8.21.3') deny('CLOUD_SDK_DRIFT');
    const expected = `new WebSocket(url, { headers: { 'User-Agent': 'LiveKit Agents', Authorization: \`Bearer \${this.opts.apiKey}\`, }, handshakeTimeout: this.opts.connOptions.timeoutMs, })`;
    const normalize = text => text.replace(/\s+/g, '').replaceAll('"', "'").replace(/,(?=[}])/g, '');
    for (const file of ['src/realtime/gpt_live_model.ts', 'dist/realtime/gpt_live_model.js']) {
      const source = readFileSync(join(dirname(entry), '..', file), 'utf8');
      const constructors = source.match(/new WebSocket\(url, \{[\s\S]*?\n\s*\}\)/g) ?? [];
      if (constructors.length !== 1 || normalize(constructors[0]) !== normalize(expected) || !/import WebSocket from ['"]ws['"]/.test(source)) deny('CLOUD_SDK_DRIFT');
    }
    if (!/import WebSocket from ['"]\.\/lib\/websocket\.js['"]/.test(readFileSync(join(dirname(ws), 'wrapper.mjs'), 'utf8'))) deny('CLOUD_SDK_DRIFT');
    const implementation = readFileSync(join(dirname(ws), 'lib/websocket.js'), 'utf8');
    if (!implementation.includes('const request = isSecure ? https.request : http.request;') || !implementation.includes('opts.createConnection || (isSecure ? tlsConnect : netConnect)')) deny('CLOUD_SDK_DRIFT');
    return { agents: '1.8.1', openai: '1.8.1', ws: '8.21.3' };
  } catch { deny('CLOUD_SDK_DRIFT'); }
}

let installed = false;
export function installCloudLiveTransport({ authorized = false, proxyEnv = inheritedProxySettings(), onFailure = () => {} } = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24) deny('CLOUD_UNSUPPORTED_NODE');
  if (!authorized || installed) deny('CLOUD_TRANSPORT_UNAUTHORIZED');
  // Только inherited HTTP(S) endpoints. NO_PROXY остаётся в agent и не исправляется здесь.
  const env = inheritedProxySettings(proxyEnv);
  const endpoints = [];
  for (const key of proxyKeys.slice(0, 4)) {
    if (!env[key]) continue;
    try {
      const url = new URL(env[key]);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || !['', '/'].includes(url.pathname)) deny('CLOUD_PROXY_INVALID');
      endpoints.push({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), tls: url.protocol === 'https:' });
    } catch { deny('CLOUD_PROXY_INVALID'); }
  }
  const proxyAgent = new https.Agent({ proxyEnv: env, keepAlive: false, maxSockets: 1 });
  const originals = { request: https.request, httpRequest: http.request, connect: net.connect, create: net.createConnection, socket: net.Socket.prototype.connect, tls: tls.connect, dns: dns.lookup, dnsPromises: dnsPromises.lookup };
  const trusted = new WeakSet();
  let closing = false;
  let restored = false;
  let handshakes = 0;
  const fail = code => { onFailure({ class: code }); deny(code); };
  const active = () => { if (closing) fail('CLOUD_CLOSING'); };
  // Node normalizeArgs передаёт Socket.connect [options, callback]. Другие shapes запрещены.
  function optionsOf(args) {
    if (args.length === 1 && Array.isArray(args[0])) return optionsOf(args[0].filter(value => value !== null && value !== undefined));
    const values = args.filter(value => typeof value !== 'function');
    if (values.length === 1 && values[0] && typeof values[0] === 'object' && !Array.isArray(values[0]) && !(values[0] instanceof URL)) return values[0];
    if (values.length >= 1 && values.length <= 2 && (typeof values[0] === 'number' || /^\d+$/.test(String(values[0]))) && (values[1] === undefined || typeof values[1] === 'string')) return { port: values[0], host: values[1] ?? 'localhost' };
    fail('CLOUD_SOCKET_SHAPE');
  }
  function endpoint(options, secure = false, internalTLS = false) {
    active();
    if (options.path !== undefined || options.socketPath !== undefined || options.socket !== undefined || options.rejectUnauthorized === false || (options.checkServerIdentity !== undefined && !(internalTLS && options.checkServerIdentity === tls.checkServerIdentity))) fail('CLOUD_DIRECT_BLOCKED');
    const host = options.hostname ?? options.host ?? 'localhost';
    if (options.hostname && options.host && options.hostname !== options.host) fail('CLOUD_DIRECT_BLOCKED');
    const port = Number(options.port);
    if (!endpoints.some(e => e.host === host && e.port === port && (!secure || e.tls))) fail('CLOUD_DIRECT_BLOCKED');
  }
  function mark(socket) { if (!(socket instanceof net.Socket)) fail('CLOUD_UNTRUSTED_SOCKET'); trusted.add(socket); return socket; }
  net.connect = function (...args) { endpoint(optionsOf(args)); return mark(originals.connect.apply(this, args)); };
  net.createConnection = function (...args) { endpoint(optionsOf(args)); return mark(originals.create.apply(this, args)); };
  let outerTLSDepth = 0;
  net.Socket.prototype.connect = function (...args) { endpoint(optionsOf(args), false, outerTLSDepth > 0 && this instanceof tls.TLSSocket); trusted.add(this); return originals.socket.apply(this, args); };
  tls.connect = function (...args) {
    active();
    const options = optionsOf(args);
    if (options.rejectUnauthorized === false || options.checkServerIdentity !== undefined) fail('CLOUD_TLS_UNSAFE');
    if (options.socket !== undefined) {
      const host = options.servername ?? options.hostname ?? options.host;
      if (!trusted.has(options.socket) || host !== 'api.openai.com' || (options.host !== undefined && options.host !== 'api.openai.com') || (options.hostname !== undefined && options.hostname !== 'api.openai.com') || (options.port !== undefined && Number(options.port) !== 443) || ![undefined, null, '/v1/live/sessions'].includes(options.path) || options.socketPath) fail('CLOUD_UNTRUSTED_SOCKET');
      return mark(originals.tls.apply(this, args));
    }
    endpoint(options, true);
    outerTLSDepth++;
    try { return mark(originals.tls.apply(this, args)); }
    finally { outerTLSDepth--; }
  };
  const checkDNS = host => { active(); if (!endpoints.some(e => e.host === host)) fail('CLOUD_DNS_BLOCKED'); };
  dns.lookup = function (host, ...args) { checkDNS(host); return originals.dns.call(this, host, ...args); };
  dnsPromises.lookup = function (host, ...args) { checkDNS(host); return originals.dnsPromises.call(this, host, ...args); };
  http.request = () => fail('CLOUD_HTTP_BLOCKED');
  https.request = function (...args) {
    active();
    if (handshakes) fail('CLOUD_HANDSHAKE_USED');
    if (args.length < 1 || args.length > 2 || (args.length === 2 && typeof args[1] !== 'function')) fail('CLOUD_REQUEST_SHAPE');
    const options = args[0];
    if (!options || typeof options !== 'object' || Array.isArray(options) || options instanceof URL) fail('CLOUD_REQUEST_SHAPE');
    const headers = options.headers;
    // Authorization даже не читается: исходный headers объект передаётся по identity.
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('CLOUD_REQUEST_BLOCKED');
    const names = Object.keys(headers);
    const field = name => { const keys = names.filter(k => k.toLowerCase() === name); return keys.length === 1 ? headers[keys[0]] : undefined; };
    if (names.some(k => k.toLowerCase() === 'host') || (options.host ?? options.hostname) !== 'api.openai.com' || (options.hostname && options.hostname !== 'api.openai.com') || Number(options.port) !== 443 || options.path !== '/v1/live/sessions' || options.method !== 'GET' || ![undefined, 'https:'].includes(options.protocol) || options.socketPath !== undefined || options.agent !== undefined || options.rejectUnauthorized === false || options.checkServerIdentity !== undefined || typeof field('connection') !== 'string' || !field('connection').split(',').some(v => v.trim().toLowerCase() === 'upgrade') || String(field('upgrade')).toLowerCase() !== 'websocket') fail('CLOUD_REQUEST_BLOCKED');
    // reserve до оригинала; отсутствие proxy и NO_PROXY могут только отказать.
    handshakes++;
    const request = originals.request.call(this, { ...options, agent: proxyAgent }, ...args.slice(1));
    request.on('response', response => { const status = response.statusCode; if (Number.isInteger(status)) onFailure({ class: 'CLOUD_HTTP_STATUS', status }); });
    request.on('error', error => onFailure(safeFailure(error)));
    return request;
  };
  installed = true;
  syncBuiltinESMExports();
  return {
    get handshakes() { return handshakes; },
    close() { if (closing) return; closing = true; proxyAgent.destroy(); },
    uninstall() {
      if (restored) return;
      this.close(); restored = true;
      https.request = originals.request; http.request = originals.httpRequest;
      net.connect = originals.connect; net.createConnection = originals.create; net.Socket.prototype.connect = originals.socket;
      tls.connect = originals.tls; dns.lookup = originals.dns; dnsPromises.lookup = originals.dnsPromises;
      installed = false; syncBuiltinESMExports();
    },
  };
}
const safeCodes = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID','ERR_PROXY_TUNNEL']);
export function safeFailure(error) {
  if (error instanceof CloudProbeError) return { class: error.code };
  const result = { class: safeCodes.has(error?.code) ? error.code : 'CLOUD_TRANSPORT_FAILED' };
  if (error?.code === 'ERR_PROXY_TUNNEL' && Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) result.status = error.statusCode;
  return result;
}
