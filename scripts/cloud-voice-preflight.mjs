// Только офлайн-диагностика установленного SDK. Сеансы и API не запускаются.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const inconclusive = reason => ({ status: 'inconclusive', reason, networkCalls: 0 });

async function offlineChild() {
  const blocked = [];
  const marker = 'OFFLINE_SOCKET_BLOCKED';
  const deny = kind => (...args) => {
    const options = args.find(value => value && typeof value === 'object') ?? {};
    const host = options.host ?? options.hostname;
    blocked.push({ kind, destination: host === 'api.openai.com' ? 'provider'
      : host === '127.0.0.1' && Number(options.port) === 9 ? 'dummy-proxy' : 'other' });
    const error = new Error(marker);
    error.code = marker;
    throw error;
  };
  // До загрузки ws: ни фабрики, ни самый нижний Socket.connect не вызывают оригинал.
  net.Socket.prototype.connect = deny('socket');
  net.connect = deny('net');
  net.createConnection = deny('createConnection');
  tls.connect = deny('tls');
  dns.lookup = deny('dns.lookup');
  dnsPromises.lookup = deny('dnsPromises.lookup');

  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const workspace = createRequire(join(root, 'apps/voice-agent/src/voice.ts'));
  const entry = workspace.resolve('@livekit/agents-plugin-openai');
  const sdkRequire = createRequire(entry);
  const version = name => {
    const resolved = workspace.resolve(name);
    const pkg = JSON.parse(readFileSync(join(dirname(resolved), '../package.json'), 'utf8'));
    assert.equal(pkg.version, '1.8.1');
    return pkg.version;
  };
  const sdk = { agents: version('@livekit/agents'), openai: version('@livekit/agents-plugin-openai') };
  const wsEntry = sdkRequire.resolve('ws');
  sdk.ws = JSON.parse(readFileSync(join(dirname(wsEntry), 'package.json'), 'utf8')).version;
  assert.equal(sdk.ws, '8.21.3');
  // Source и исполняемый dist обязаны сохранять именно проверяемые options.
  // При обновлении SDK результат становится inconclusive вместо разрешения API.
  const expected = `new WebSocket(url, { headers: { 'User-Agent': 'LiveKit Agents', Authorization: \`Bearer \${this.opts.apiKey}\`, }, handshakeTimeout: this.opts.connOptions.timeoutMs, })`;
  const normalize = text => text.replace(/\s+/g, '').replaceAll('"', "'").replace(/,(?=[}])/g, '');
  for (const file of ['src/realtime/gpt_live_model.ts', 'dist/realtime/gpt_live_model.js']) {
    const source = readFileSync(join(dirname(entry), '..', file), 'utf8');
    const constructors = source.match(/new WebSocket\(url, \{[\s\S]*?\n\s*\}\)/g) ?? [];
    assert.equal(constructors.length, 1);
    assert.equal(normalize(constructors[0]), normalize(expected));
    assert.match(source, /import WebSocket from ['"]ws['"]/);
  }
  // SDK ESM wrapper использует тот же websocket.js, что CJS resolution.
  const wrapper = readFileSync(join(dirname(wsEntry), 'wrapper.mjs'), 'utf8');
  assert.match(wrapper, /import WebSocket from ['"]\.\/lib\/websocket\.js['"]/);
  const WebSocket = sdkRequire('ws');

  async function probe(agentOptions, expectedPath) {
    const start = blocked.length;
    let socket;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('offline_timeout')), 1_000);
        const finish = error => error?.code === marker ? resolve() : reject(new Error('unexpected_outcome'));
        try {
          // Только фиктивный timeout и публичный User-Agent; auth отсутствует.
          socket = new WebSocket('wss://api.openai.com/v1/live/sessions', {
            headers: { 'User-Agent': 'LiveKit Agents' }, handshakeTimeout: 10_000, ...agentOptions,
          });
          socket.on('error', finish);
          socket.on('open', () => reject(new Error('unexpected_open')));
        } catch (error) { finish(error); }
      });
      assert.deepEqual(blocked.slice(start), expectedPath);
    } finally {
      clearTimeout(timer);
      socket?.on('error', () => {});
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }
  await probe({}, [{ kind: 'tls', destination: 'provider' }]);
  await probe({ agent: https.globalAgent }, [{ kind: 'net', destination: 'dummy-proxy' }]);
  return { status: 'blocked_proxy_transport', node: process.version, sdk,
    paths: { stock: 'provider-direct', explicitAgent: 'proxy' }, networkCalls: 0 };
}

async function parent() {
  // Полное новое окружение: реальные proxy/key/CA/NODE_OPTIONS не читаются и не наследуются.
  const child = spawn(process.execPath, ['--use-env-proxy', script, '--offline-child'], {
    cwd: root, env: { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let unexpectedStderr = false;
  const stop = () => child.kill('SIGKILL');
  const ceiling = setTimeout(stop, 5_000);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8_000) stop(); });
    child.stderr.on('data', () => { unexpectedStderr = true; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0 || unexpectedStderr) throw new Error('child_failed');
    const result = JSON.parse(output);
    assert.equal(result.status, 'blocked_proxy_transport');
    assert.equal(result.networkCalls, 0);
    return result;
  } finally {
    clearTimeout(ceiling);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child.exitCode === null && !child.killed) stop();
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--offline-child')) {
    console.log(JSON.stringify(inconclusive('unsupported_argument')));
    process.exitCode = 2;
  } else if (Number(process.versions.node.split('.')[0]) !== 24) {
    console.log(JSON.stringify(inconclusive('unsupported_node')));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(args[0] === '--offline-child' ? await offlineChild() : await parent()));
  }
} catch {
  // Ошибки SDK/env не выводим: только безопасная классификация результата.
  console.log(JSON.stringify(inconclusive('offline_check_failed')));
  process.exitCode = 1;
}
