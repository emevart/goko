import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import type { GameService, GameServiceDeps } from './service.ts';
import { GameService as RealGameService } from './service.ts';
import type { RoomCreator } from './livekit.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import { GameStore } from './store.ts';
import { INIT_EXIT_CODE, type Listen, SHUTDOWN_MS, type StartDeps, createListen, startServer } from './start-server.ts';

const SECRET = 'secret-of-at-least-32-characters-long';
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

let dir = '';
let opened: GameService[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-start-'));
  opened = [];
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const service of opened) await service.close();
  await rm(dir, { recursive: true, force: true });
});

type Recorder = {
  events: string[];
  exits: number[];
  logs: string[];
  listens: Array<{ port: number; hostname: string }>;
  handlers: Map<string, () => void>;
  roomOptions: Array<{ url: string; apiKey: string; apiSecret: string }>;
  serviceDeps: GameServiceDeps[];
  rooms: Array<{ name: string; agents: Array<{ agentName: string }> }>;
  exited: Promise<number>;
  // Управление остановкой: закрытие сервера и сервиса завершаются, когда тест скажет.
  finishServerClose: () => void;
  finishServiceClose: () => void;
};

const BASE_ENV = {
  APP_KEY: 'app-key-value',
  LIVEKIT_URL: 'wss://lk.test',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: SECRET,
  FAKE_ENGINE: '1',
};

type HarnessOptions = {
  holdServerClose?: boolean;
  holdServiceClose?: boolean;
  initNoop?: boolean;
  // service.init отклоняется этой ошибкой.
  initFails?: Error;
  // service.close отклоняется (после настоящего закрытия).
  serviceCloseFails?: boolean;
  // createRoom отклоняется.
  roomsFail?: boolean;
  // Вызывается в момент server.close: тест проверяет, что остановка к этому времени уже объявлена.
  onServerClose?: (app: Parameters<Listen>[0]) => void;
  // Ошибка сокета при listen (EADDRINUSE и т. п.).
  listenError?: Error;
  // Ошибка сокета уже после готовности (EMFILE на accept и т. п.).
  errorAfterReady?: Error;
  // Как боевой сервер с застрявшим соединением: server.close завершается только после closeAllConnections.
  stuckConnection?: boolean;
};

function harness(opts: HarnessOptions = {}): { deps: StartDeps; rec: Recorder } {
  let onExit: (code: number) => void = () => undefined;
  let serverDone: (() => void) | null = null;
  let serviceDone: (() => void) | null = null;
  const rec: Recorder = {
    events: [],
    exits: [],
    logs: [],
    listens: [],
    handlers: new Map(),
    roomOptions: [],
    serviceDeps: [],
    rooms: [],
    exited: new Promise<number>((resolve) => {
      onExit = resolve;
    }),
    finishServerClose: () => serverDone?.(),
    finishServiceClose: () => serviceDone?.(),
  };
  const deps: StartDeps = {
    env: { ...BASE_ENV, DATA_DIR: dir },
    listen: (app, port, hostname, onReady, onError) => {
      rec.events.push('listen');
      rec.listens.push({ port, hostname });
      if (opts.listenError) onError(opts.listenError);
      else onReady({ address: hostname, port });
      if (opts.errorAfterReady) onError(opts.errorAfterReady);
      let stuckDone: (() => void) | null = null;
      return {
        close: (done) => {
          rec.events.push('server.close');
          opts.onServerClose?.(app);
          if (opts.holdServerClose) serverDone = done;
          else if (opts.stuckConnection) stuckDone = done;
          else done();
        },
        closeAllConnections: () => {
          rec.events.push('server.closeAllConnections');
          stuckDone?.();
        },
      };
    },
    on: (signal, handler) => {
      rec.handlers.set(signal, handler);
    },
    exit: (code) => {
      rec.exits.push(code);
      rec.events.push(`exit ${code}`);
      onExit(code);
    },
    log: (line) => rec.logs.push(line),
    createRooms: (options) => {
      rec.roomOptions.push(options);
      const rooms: RoomCreator = {
        createRoom: async (o) => {
          rec.rooms.push(o as never);
          if (opts.roomsFail) throw new Error('twirp: room service unavailable');
          return {};
        },
      };
      return rooms;
    },
    createService: (serviceDeps) => {
      rec.serviceDeps.push(serviceDeps);
      const service = new RealGameService(serviceDeps);
      opened.push(service);
      if (opts.initNoop) vi.spyOn(service, 'init').mockResolvedValue(undefined);
      if (opts.initFails) vi.spyOn(service, 'init').mockRejectedValue(opts.initFails);
      const close = service.close.bind(service);
      vi.spyOn(service, 'close').mockImplementation(async () => {
        // Удержание заводится до первого await: тест может отпустить его сразу после события.
        const hold = opts.holdServiceClose ? new Promise<void>((resolve) => (serviceDone = resolve)) : Promise.resolve();
        rec.events.push('service.close');
        await close();
        await hold;
        if (opts.serviceCloseFails) throw Object.assign(new Error('store: flush failed'), { code: 'EIO' });
      });
      return service;
    },
  };
  return { deps, rec };
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const free = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(free));
    });
  });

const say = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

const untilTick = async (cond: () => boolean, turns = 1000): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('условие не выполнилось за отведённые обороты очереди');
};

describe('startServer: конфигурация из env', () => {
  it('без обязательных переменных — [X] с именами и код 2, ничего не запускается', async () => {
    const { deps, rec } = harness();
    const started = await startServer({ ...deps, env: {} });
    expect(started).toBeNull();
    expect(rec.exits).toEqual([2]);
    expect(rec.events).toEqual(['exit 2']);
    expect(rec.serviceDeps).toEqual([]);
    expect(rec.roomOptions).toEqual([]);
    expect(rec.handlers.size).toBe(0);
    expect(rec.logs).toEqual([
      '[X] game-server: нужна переменная APP_KEY (см. infra/.env.example)',
      '[X] game-server: нужна переменная LIVEKIT_URL (см. infra/.env.example)',
      '[X] game-server: нужна переменная LIVEKIT_API_KEY (см. infra/.env.example)',
      '[X] game-server: нужна переменная LIVEKIT_API_SECRET (см. infra/.env.example)',
      '[X] game-server: нужна переменная ENGINE_KEY (см. infra/.env.example)',
    ]);
  });

  it('каждая обязательная переменная по отдельности: пустая или из пробелов — отказ по имени', async () => {
    for (const name of ['APP_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const) {
      for (const value of ['', '  ']) {
        const { deps, rec } = harness();
        expect(await startServer({ ...deps, env: { ...deps.env, [name]: value } })).toBeNull();
        expect(rec.exits).toEqual([2]);
        expect(rec.logs).toEqual([`[X] game-server: нужна переменная ${name} (см. infra/.env.example)`]);
      }
    }
  });

  it('пустые ключи LiveKit в env сервера не подменяются process.env: отказ до любых вызовов SDK, значения не печатаются', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    vi.stubEnv('APP_KEY', 'stubbed-app-key');
    vi.stubEnv('LIVEKIT_URL', 'wss://lk.test');
    vi.stubEnv('FAKE_ENGINE', '1');
    const { deps, rec } = harness();
    // env не передан: берётся process.env.
    expect(await startServer({ ...deps, env: undefined })).toBeNull();
    expect(rec.exits).toEqual([2]);
    expect(rec.roomOptions).toEqual([]);
    expect(rec.serviceDeps).toEqual([]);
    expect(rec.logs).toEqual([
      '[X] game-server: нужна переменная LIVEKIT_API_KEY (см. infra/.env.example)',
      '[X] game-server: нужна переменная LIVEKIT_API_SECRET (см. infra/.env.example)',
    ]);
    expect(rec.logs.join('\n')).not.toContain('stubbed-app-key');
  });

  it('LIVEKIT_URL не ws(s) и не http(s) или не адрес — [X] без значения', async () => {
    for (const value of ['lk.test', 'ftp://lk.test', 'wss//lk.test', 'https://']) {
      const { deps, rec } = harness();
      expect(await startServer({ ...deps, env: { ...deps.env, LIVEKIT_URL: value } })).toBeNull();
      expect(rec.exits).toEqual([2]);
      expect(rec.logs).toEqual(['[X] game-server: LIVEKIT_URL должна быть адресом ws://, wss://, http:// или https://']);
      expect(rec.roomOptions).toEqual([]);
    }
    for (const value of ['ws://127.0.0.1:7880', 'http://lk.test', 'https://lk.test']) {
      const { deps, rec } = harness({ initNoop: true });
      say();
      expect(await startServer({ ...deps, env: { ...deps.env, LIVEKIT_URL: value } })).not.toBeNull();
      expect(rec.exits).toEqual([]);
      expect(rec.roomOptions[0]?.url).toBe(value);
    }
  });

  it('числа: не положительное целое — [X] с именем переменной, код 2, значение не печатается', async () => {
    const bad: Array<[string, string, string]> = [
      ['MAX_SESSIONS', '0', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '-1', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '3x', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '1.5', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '1e3', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '007', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['MAX_SESSIONS', '99999999999999999999', 'MAX_SESSIONS должна быть целым числом от 1'],
      ['SESSION_TTL_MS', '2h', 'SESSION_TTL_MS должна быть целым числом от 1000'],
      ['SESSION_TTL_MS', '999', 'SESSION_TTL_MS должна быть целым числом от 1000'],
      ['PORT', '0', 'PORT должна быть целым числом от 1 до 65535'],
      ['PORT', '65536', 'PORT должна быть целым числом от 1 до 65535'],
      ['PORT', 'http', 'PORT должна быть целым числом от 1 до 65535'],
    ];
    for (const [name, value, message] of bad) {
      const { deps, rec } = harness();
      expect(await startServer({ ...deps, env: { ...deps.env, [name]: value } })).toBeNull();
      expect(rec.exits).toEqual([2]);
      expect(rec.logs).toEqual([`[X] game-server: ${message}`]);
      expect(rec.serviceDeps).toEqual([]);
    }
  });

  it('все ошибки конфигурации печатаются разом', async () => {
    const { deps, rec } = harness();
    expect(await startServer({ ...deps, env: { ...deps.env, APP_KEY: '', PORT: '0', MAX_SESSIONS: 'x' } })).toBeNull();
    expect(rec.exits).toEqual([2]);
    expect(rec.logs).toEqual([
      '[X] game-server: нужна переменная APP_KEY (см. infra/.env.example)',
      '[X] game-server: MAX_SESSIONS должна быть целым числом от 1',
      '[X] game-server: PORT должна быть целым числом от 1 до 65535',
    ]);
  });

  it('границы чисел допустимы: 1, 1000, 65535; TTL токена — целые секунды TTL сессии вниз', async () => {
    say();
    const { deps, rec } = harness();
    const started = await startServer({ ...deps, env: { ...deps.env, MAX_SESSIONS: '1', SESSION_TTL_MS: '2999', PORT: '65535' } });
    if (!started) throw new Error('сервер не запустился');
    expect(rec.exits).toEqual([]);
    expect(rec.listens).toEqual([{ port: 65535, hostname: '127.0.0.1' }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const res = await started.app.request('/api/sessions', { method: 'POST', headers: { 'x-app-key': BASE_ENV.APP_KEY } });
    expect(res.status).toBe(200);
    const { livekit } = (await res.json()) as { livekit: { token: string } };
    const claims = await new TokenVerifier(BASE_ENV.LIVEKIT_API_KEY, SECRET).verify(livekit.token);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(2);
    // MAX_SESSIONS=1: вторая сессия упирается в лимит.
    expect((await started.app.request('/api/sessions', { method: 'POST', headers: { 'x-app-key': BASE_ENV.APP_KEY } })).status).toBe(429);
    const ttl1000 = harness();
    expect(await startServer({ ...ttl1000.deps, env: { ...ttl1000.deps.env, SESSION_TTL_MS: '1000' } })).not.toBeNull();
    expect(ttl1000.rec.exits).toEqual([]);
  });

  it('умолчания: порт 8787, хост 127.0.0.1, 3 сессии, TTL 2 ч, агент goko, данные в data/games от корня', async () => {
    say();
    const { deps, rec } = harness({ initNoop: true });
    const env = { ...BASE_ENV, PORT: '', HOST: '', AGENT_NAME: '', DATA_DIR: '', MAX_SESSIONS: '', SESSION_TTL_MS: '' };
    const started = await startServer({ ...deps, env });
    if (!started) throw new Error('сервер не запустился');
    expect(rec.listens).toEqual([{ port: 8787, hostname: '127.0.0.1' }]);
    expect(rec.serviceDeps[0]?.store.dir).toBe(path.join(REPO_ROOT, 'data/games'));
    expect(rec.roomOptions).toEqual([{ url: 'wss://lk.test', apiKey: 'devkey', apiSecret: SECRET }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    const headers = { 'x-app-key': BASE_ENV.APP_KEY };
    const first = (await (await started.app.request('/api/sessions', { method: 'POST', headers })).json()) as { session: { room: string }; livekit: { url: string; token: string } };
    expect(first.livekit.url).toBe('wss://lk.test');
    const claims = await new TokenVerifier(BASE_ENV.LIVEKIT_API_KEY, SECRET).verify(first.livekit.token);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(7200);
    expect(rec.rooms[0]?.name).toBe(first.session.room);
    expect(rec.rooms[0]?.agents[0]?.agentName).toBe('goko');
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(429);
    // Ключ приложения из env действительно закрывает /api.
    expect((await started.app.request('/api/games', { headers: { 'x-app-key': 'wrong' } })).status).toBe(401);
  });

  it('переменные с умолчанием из пробелов — то же, что пустые: умолчания', async () => {
    say();
    const { deps, rec } = harness({ initNoop: true });
    const blank = '  ';
    const env = { ...BASE_ENV, PORT: blank, HOST: blank, AGENT_NAME: blank, DATA_DIR: blank, MAX_SESSIONS: blank, SESSION_TTL_MS: blank, ENGINE_URL: blank };
    const started = await startServer({ ...deps, env });
    if (!started) throw new Error('сервер не запустился');
    expect(rec.exits).toEqual([]);
    expect(rec.listens).toEqual([{ port: 8787, hostname: '127.0.0.1' }]);
    expect(rec.serviceDeps[0]?.store.dir).toBe(path.join(REPO_ROOT, 'data/games'));
    vi.useFakeTimers({ toFake: ['Date'] });
    const headers = { 'x-app-key': BASE_ENV.APP_KEY };
    const first = (await (await started.app.request('/api/sessions', { method: 'POST', headers })).json()) as { livekit: { token: string } };
    const claims = await new TokenVerifier(BASE_ENV.LIVEKIT_API_KEY, SECRET).verify(first.livekit.token);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(7200);
    expect(rec.rooms[0]?.agents[0]?.agentName).toBe('goko');
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(429);
  });

  it('значения из env: порт, хост, агент, каталог данных, лимит; сессии истекают по SESSION_TTL_MS', async () => {
    say();
    const { deps, rec } = harness();
    const env = { ...deps.env, PORT: '18787', HOST: '0.0.0.0', AGENT_NAME: 'goko-dev', MAX_SESSIONS: '2', SESSION_TTL_MS: '60000' };
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = await startServer({ ...deps, env });
    if (!started) throw new Error('сервер не запустился');
    expect(rec.listens).toEqual([{ port: 18787, hostname: '0.0.0.0' }]);
    expect(rec.serviceDeps[0]?.store.dir).toBe(dir);
    expect(rec.serviceDeps[0]?.log).toBe(deps.log);
    const headers = { 'x-app-key': BASE_ENV.APP_KEY };
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect(rec.rooms[0]?.agents[0]?.agentName).toBe('goko-dev');
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(429);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await started.app.request('/api/sessions', { method: 'POST', headers })).status).toBe(200);
  });

  it('истёкшая сессия снимает привязки своих партий в сервисе', async () => {
    say();
    const { deps, rec } = harness();
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = await startServer({ ...deps, env: { ...deps.env, SESSION_TTL_MS: '60000' } });
    if (!started) throw new Error('сервер не запустился');
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    const created = await started.app.request('/api/sessions', { method: 'POST', headers });
    const { session } = (await created.json()) as { session: { id: string } };
    const body = JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' }, settings: { boardSize: 9 } });
    expect((await started.app.request(`/api/sessions/${session.id}/games`, { method: 'POST', headers, body })).status).toBe(200);
    expect(started.service.internalSizes()).toMatchObject({ sessionsByGame: 1, currentGames: 1 });
    const forget = vi.spyOn(started.service, 'forgetSession');
    vi.setSystemTime(Date.now() + 60_001);
    expect(started.sessions.list()).toEqual([]);
    expect(forget.mock.calls).toEqual([[session.id]]);
    expect(started.service.internalSizes()).toMatchObject({ sessionsByGame: 0, currentGames: 0 });
    expect(rec.serviceDeps).toHaveLength(1);
  });

  it('FAKE_ENGINE=1: фейковый движок, ENGINE_KEY не нужен, строка [!]; иначе клиент go-engine с ENGINE_URL и ENGINE_KEY', async () => {
    say();
    const fake = harness();
    const started = await startServer(fake.deps);
    if (!started) throw new Error('сервер не запустился');
    expect(fake.rec.logs).toContain('[!] game-server: FAKE_ENGINE=1, ходы случайные, KataGo не используется');
    expect((fake.rec.serviceDeps[0]?.engine as { calls?: unknown }).calls).toBeDefined();

    for (const flag of [undefined, '0', 'true']) {
      const real = harness();
      const env: Record<string, string | undefined> = { ...real.deps.env, FAKE_ENGINE: flag };
      expect(await startServer({ ...real.deps, env })).toBeNull();
      expect(real.rec.logs).toEqual(['[X] game-server: нужна переменная ENGINE_KEY (см. infra/.env.example)']);
    }

    const seen: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init.headers).get('x-engine-key') });
      return new Response(JSON.stringify({ move: 'D4', winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [], humanFallback: false, ms: 1 }), { status: 200 });
    });
    for (const [url, expected] of [
      [undefined, 'http://127.0.0.1:8788/v1/genmove'],
      ['', 'http://127.0.0.1:8788/v1/genmove'],
      ['http://engine.test:9000', 'http://engine.test:9000/v1/genmove'],
    ] as const) {
      const real = harness();
      const env: Record<string, string | undefined> = { ...real.deps.env, FAKE_ENGINE: undefined, ENGINE_KEY: 'engine-key-value', ENGINE_URL: url };
      expect(await startServer({ ...real.deps, env })).not.toBeNull();
      expect(real.rec.logs.some((l) => l.includes('FAKE_ENGINE'))).toBe(false);
      const engine = real.rec.serviceDeps[0]?.engine;
      if (!engine) throw new Error('нет движка');
      seen.length = 0;
      await engine.genmove({ boardSize: 9, rules: 'chinese', komi: 7.5, moves: [], rank: '10k', maxVisits: 10 });
      expect(seen).toEqual([{ url: expected, key: 'engine-key-value' }]);
    }
  });

  it('[OK] после listen: адрес, порт и число партий, без значений секретов', async () => {
    const log = say();
    const { deps } = harness();
    await startServer({ ...deps, env: { ...deps.env, PORT: '18000', ENGINE_URL: 'http://engine-url-value' } });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(['[OK] game-server на http://127.0.0.1:18000; партий 0; движок fake']);
    const all = lines.join('\n');
    for (const secret of [BASE_ENV.APP_KEY, SECRET, 'engine-url-value']) expect(all).not.toContain(secret);
  });
});

describe('startServer: данные и строка готовности', () => {
  it('партии из DATA_DIR загружаются до listen', async () => {
    const seed = new RealGameService({ store: new GameStore(dir), engine: createFakeEngine(), bus: new EventBus() });
    opened.push(seed);
    await seed.init();
    const { state } = await seed.create({ black: { controller: 'human' }, white: { controller: 'human' }, waitForReply: true });
    const log = say();
    const { deps } = harness();
    const started = await startServer(deps);
    if (!started) throw new Error('сервер не запустился');
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(['[OK] game-server на http://127.0.0.1:8787; партий 1; движок fake']);
    expect(started.service.get(state.id).id).toBe(state.id);
  });

  it('с настоящим движком строка готовности называет go-engine, не адрес', async () => {
    const log = say();
    const { deps } = harness();
    await startServer({ ...deps, env: { ...deps.env, FAKE_ENGINE: undefined, ENGINE_KEY: 'engine-key-value', ENGINE_URL: 'http://engine-url-value' } });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(['[OK] game-server на http://127.0.0.1:8787; партий 0; движок go-engine']);
  });
});

describe('startServer: лог приложения и ошибки сокета', () => {
  it('лог приложения — лог сервера: отказ LiveKit при создании сессии попадает в лог', async () => {
    say();
    const { deps, rec } = harness({ roomsFail: true });
    const started = await startServer(deps);
    if (!started) throw new Error('сервер не запустился');
    const res = await started.app.request('/api/sessions', { method: 'POST', headers: { 'x-app-key': BASE_ENV.APP_KEY } });
    expect(res.status).toBe(500);
    expect(rec.logs.some((l) => l.startsWith('[X] game-server: сессия') && l.includes('room service unavailable'))).toBe(true);
  });

  it('ошибка сокета после готовности — другой текст [X] с кодом, выход 1', async () => {
    const log = say();
    const error = Object.assign(new Error('accept EMFILE listen-host-value'), { code: 'EMFILE' });
    const { deps, rec } = harness({ errorAfterReady: error });
    expect(await startServer({ ...deps, env: { ...deps.env, HOST: 'listen-host-value' } })).not.toBeNull();
    expect(log.mock.calls.map((c) => String(c[0]).startsWith('[OK]'))).toEqual([true]);
    expect(rec.logs.filter((l) => l.startsWith('[X]'))).toEqual(['[X] game-server: ошибка сокета сервера (EMFILE)']);
    expect(rec.exits).toEqual([1]);
    expect(rec.logs.join('\n')).not.toContain('listen-host-value');
  });

  it('ошибка listen (порт занят) — [X] с кодом ошибки без адреса, выход 1, без [OK]', async () => {
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error('listen EADDRINUSE: address already in use listen-host-value:18787'), { code: 'EADDRINUSE' }), '[X] game-server: не удалось слушать порт (EADDRINUSE)'],
      [new Error('listen failed at listen-host-value'), '[X] game-server: не удалось слушать порт (без кода)'],
    ];
    for (const [error, line] of cases) {
      const log = say();
      const { deps, rec } = harness({ listenError: error });
      expect(await startServer({ ...deps, env: { ...deps.env, HOST: 'listen-host-value', PORT: '18787' } })).not.toBeNull();
      expect(rec.exits).toEqual([1]);
      expect(rec.logs.filter((l) => l.startsWith('[X]'))).toEqual([line]);
      expect(rec.logs.join('\n')).not.toContain('listen-host-value');
      expect(log.mock.calls).toEqual([]);
      log.mockRestore();
    }
  });
});

describe('startServer: шов createListen', () => {
  it('hostname и port уходят в serve, адрес готовности — фактический адрес сокета, close зовёт done, ошибка сокета — в onError', async () => {
    const calls: Array<{ port: number; hostname: string; fetch: unknown }> = [];
    let closed = 0;
    const errorListeners: Array<(e: Error) => void> = [];
    let onListen: ((i: { address: string; port: number }) => void) | null = null;
    const serveFn = ((options: { port: number; hostname: string; fetch: unknown }, cb: (i: { address: string; port: number }) => void) => {
      calls.push(options);
      onListen = cb;
      return {
        close: (done: () => void) => {
          closed++;
          done();
        },
        on: (event: string, listener: (e: Error) => void) => {
          if (event === 'error') errorListeners.push(listener);
        },
      };
    }) as unknown as Parameters<typeof createListen>[0];
    const listen = createListen(serveFn);
    const app = { fetch: () => new Response('') } as unknown as Parameters<Listen>[0];
    const ready: Array<{ address: string; port: number }> = [];
    const errors: Error[] = [];
    const handle = listen(app, 18787, 'localhost', (i) => ready.push(i), (e) => errors.push(e));
    expect(calls).toEqual([{ port: 18787, hostname: 'localhost', fetch: app.fetch }]);
    expect(ready).toEqual([]);
    (onListen as ((i: { address: string; port: number }) => void) | null)?.({ address: '::1', port: 18787 });
    expect(ready).toEqual([{ address: '::1', port: 18787 }]);
    const boom = new Error('EACCES');
    for (const l of errorListeners) l(boom);
    expect(errors).toEqual([boom]);
    let done = 0;
    handle.close(() => done++);
    expect(closed).toBe(1);
    expect(done).toBe(1);
  });

  it('closeAllConnections уходит в сервер; у сервера без метода (http2) — без исключения', () => {
    let dropped = 0;
    const make = (withMethod: boolean) =>
      ((_options: unknown, _cb: unknown) => ({
        close: (done: () => void) => done(),
        on: () => undefined,
        ...(withMethod ? { closeAllConnections: () => void dropped++ } : {}),
      })) as unknown as Parameters<typeof createListen>[0];
    const app = { fetch: () => new Response('') } as unknown as Parameters<Listen>[0];
    const handle = createListen(make(true))(app, 1, 'localhost', () => undefined, () => undefined);
    expect(dropped).toBe(0);
    handle.closeAllConnections();
    expect(dropped).toBe(1);
    const bare = createListen(make(false))(app, 1, 'localhost', () => undefined, () => undefined);
    expect(() => bare.closeAllConnections()).not.toThrow();
  });
});

describe('startServer: остановка', () => {
  it('сигнал: server.close, затем service.close, выход 0 только после обоих', async () => {
    say();
    const { deps, rec } = harness({ holdServerClose: true, holdServiceClose: true });
    expect(await startServer(deps)).not.toBeNull();
    expect([...rec.handlers.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    rec.handlers.get('SIGTERM')?.();
    await untilTick(() => rec.events.includes('service.close'));
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close']);
    rec.finishServiceClose();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(rec.exits).toEqual([]); // сервер ещё закрывается
    rec.finishServerClose();
    expect(await rec.exited).toBe(0);
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close', 'server.closeAllConnections', 'exit 0']);
  });

  it('застрявшее соединение: после server.close и service.close — closeAllConnections, выход 0 до дедлайна', async () => {
    say();
    const { deps, rec } = harness({ stuckConnection: true, holdServiceClose: true });
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGTERM')?.();
    await untilTick(() => rec.events.includes('service.close'));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    // Пока сервис закрывается, соединения не рвутся: текущие запросы успевают получить ответ.
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close']);
    rec.finishServiceClose();
    // Время не продвигается: выход приходит от closeAllConnections, а не от дедлайна.
    await untilTick(() => rec.exits.length > 0);
    expect(rec.exits).toEqual([0]);
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close', 'server.closeAllConnections', 'exit 0']);
    expect(vi.getTimerCount()).toBe(0);
    expect(rec.logs.some((l) => l.includes('выход без ожидания'))).toBe(false);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS * 2);
    expect(rec.exits).toEqual([0]);
  });

  it('застрявшее соединение при отказе service.close — closeAllConnections всё равно, выход 0', async () => {
    say();
    const { deps, rec } = harness({ stuckConnection: true, serviceCloseFails: true });
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGINT')?.();
    await untilTick(() => rec.exits.length > 0);
    expect(rec.exits).toEqual([0]);
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close', 'server.closeAllConnections', 'exit 0']);
  });

  it('запрос, удержанный в сервисе во время сигнала, получает 200; соединения рвутся только после ответа, выход 0', async () => {
    say();
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    const { deps, rec } = harness({ stuckConnection: true });
    const started = await startServer(deps);
    if (!started) throw new Error('сервер не запустился');
    const created = await started.app.request('/api/games', { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' } }) });
    const gameId = ((await created.json()) as { state: { id: string } }).state.id;
    let release: () => void = () => undefined;
    const analyze = started.service.analyze.bind(started.service);
    const held = vi.spyOn(started.service, 'analyze').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      const result = await analyze(...args);
      rec.events.push('analyze.done');
      return result;
    });
    const pending = Promise.resolve(started.app.request(`/api/games/${gameId}/analyze`, { method: 'POST', headers, body: '{}' }));
    await untilTick(() => held.mock.calls.length === 1);
    rec.handlers.get('SIGTERM')?.();
    await untilTick(() => rec.events.includes('service.close'));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    // Сервис закрыт, но запрос ещё в обработчике: соединения не рвутся, выхода нет.
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close']);
    expect(rec.exits).toEqual([]);
    release();
    expect((await pending).status).toBe(200);
    await untilTick(() => rec.exits.length > 0);
    expect(rec.exits).toEqual([0]);
    expect(rec.events).toEqual(['listen', 'server.close', 'service.close', 'analyze.done', 'server.closeAllConnections', 'exit 0']);
  });

  it('боевой listen: запрос, удержанный в сервисе во время сигнала, получает 200 по сокету, затем выход 0', async () => {
    const port = await freePort();
    const ready = new Promise<void>((resolve) => {
      vi.spyOn(console, 'log').mockImplementation(() => resolve());
    });
    const { deps, rec } = harness();
    const started = await startServer({ ...deps, listen: undefined, env: { ...deps.env, PORT: String(port), HOST: '127.0.0.1' } });
    if (!started) throw new Error('сервер не запустился');
    await ready;
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    const created = await fetch(`${base}/api/games`, { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' } }), signal: AbortSignal.timeout(5_000) });
    const gameId = ((await created.json()) as { state: { id: string } }).state.id;
    let release: () => void = () => undefined;
    const analyze = started.service.analyze.bind(started.service);
    const held = vi.spyOn(started.service, 'analyze').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return analyze(...args);
    });
    const pending = fetch(`${base}/api/games/${gameId}/analyze`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) });
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    rec.handlers.get('SIGTERM')?.();
    await untilTick(() => rec.events.includes('service.close'));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(rec.exits).toEqual([]);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { winrateB?: unknown }).winrateB).toBeDefined();
    expect(await rec.exited).toBe(0);
  }, 20_000);

  it('сервис висит и соединение застряло: ровно один выход 1 по дедлайну, второго выхода нет', async () => {
    say();
    const { deps, rec } = harness({ stuckConnection: true, holdServiceClose: true });
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGINT')?.();
    await untilTick(() => rec.events.includes('service.close'));
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS - 1);
    expect(rec.exits).toEqual([]);
    expect(rec.events).not.toContain('server.closeAllConnections');
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.exits).toEqual([1]);
    // Сервис дозакрылся уже после дедлайна: соединения рвутся, но второго выхода нет.
    rec.finishServiceClose();
    await untilTick(() => rec.events.includes('server.closeAllConnections'));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS * 2);
    expect(rec.exits).toEqual([1]);
  });

  it('потоки SSE закрыты раньше closeAllConnections: остановка объявлена до обрыва соединений', async () => {
    say();
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    const { deps, rec } = harness({ stuckConnection: true });
    const started = await startServer(deps);
    if (!started) throw new Error('сервер не запустился');
    const created = await started.app.request('/api/games', { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' } }) });
    const gameId = ((await created.json()) as { state: { id: string } }).state.id;
    const res = await started.app.request(`/api/games/${gameId}/events`, { headers });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('нет тела');
    await reader.read();
    rec.handlers.get('SIGINT')?.();
    void reader.read().then((r) => {
      rec.events.push(`sse.done ${r.done}`);
    });
    // Ожидание по оборотам очереди: если поток не закрылся или выхода нет, тест падает на
    // утверждении, а не по таймауту vitest.
    await untilTick(() => rec.exits.length > 0 && rec.events.includes('sse.done true'), 5000);
    expect(rec.exits).toEqual([0]);
    expect(rec.events.indexOf('sse.done true')).toBeGreaterThan(-1);
    expect(rec.events.indexOf('sse.done true')).toBeLessThan(rec.events.indexOf('server.closeAllConnections'));
  });

  it('сигнал закрывает открытые потоки SSE до server.close: иначе server.close ждал бы их до дедлайна', async () => {
    say();
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    let gameId = '';
    let lateBody: Promise<string> | null = null;
    // Боевой server.close ждёт открытых соединений, фейковый нет. Поэтому в момент close проверяется,
    // что остановка уже объявлена: поток, открытый сейчас, закрывается сразу и пуст.
    const { deps, rec } = harness({
      onServerClose: (app) => {
        lateBody = Promise.resolve(app.request(`/api/games/${gameId}/events`, { headers })).then((r) => r.text());
      },
    });
    const started = await startServer(deps);
    if (!started) throw new Error('сервер не запустился');
    const created = await started.app.request('/api/games', { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' } }) });
    gameId = ((await created.json()) as { state: { id: string } }).state.id;
    const res = await started.app.request(`/api/games/${gameId}/events`, { headers });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('нет тела');
    await reader.read();
    rec.handlers.get('SIGINT')?.();
    if (!lateBody) throw new Error('server.close не вызван');
    expect(await lateBody).toBe('');
    expect((await reader.read()).done).toBe(true);
    expect(await rec.exited).toBe(0);
  });

  it('остановка ограничена по времени: зависший service.close — выход 1 с [!] через SHUTDOWN_MS', async () => {
    say();
    const { deps, rec } = harness({ holdServiceClose: true });
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGINT')?.();
    await untilTick(() => rec.events.includes('service.close'));
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS - 1);
    expect(rec.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(rec.exits).toEqual([1]);
    expect(rec.logs).toContain(`[!] game-server: остановка дольше ${SHUTDOWN_MS} мс, выход без ожидания`);
    expect(SHUTDOWN_MS).toBe(25_000);
  });

  it('отказ service.close — выход 0 без ожидания дедлайна, таймер снят', async () => {
    say();
    const { deps, rec } = harness({ serviceCloseFails: true });
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGTERM')?.();
    // Время не продвигается: выход приходит сам, а не по дедлайну. Ожидание по оборотам очереди:
    // если выхода нет вовсе, тест падает на утверждении, а не по таймауту.
    await untilTick(() => rec.exits.length > 0);
    expect(rec.exits).toEqual([0]);
    // Сервер без застрявших соединений закрылся сам: обрыв соединений может прийти и после выхода.
    expect(rec.events.filter((e) => e !== 'server.closeAllConnections')).toEqual(['listen', 'server.close', 'service.close', 'exit 0']);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS * 2);
    expect(rec.exits).toEqual([0]);
  });

  it('штатная остановка снимает таймер дедлайна: второго выхода нет', async () => {
    say();
    const { deps, rec } = harness();
    expect(await startServer(deps)).not.toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGINT')?.();
    expect(await rec.exited).toBe(0);
    await untilTick(() => vi.getTimerCount() === 0, 100);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_MS * 2);
    expect(rec.exits).toEqual([0]);
  });

  it('повторный сигнал — немедленный выход 1', async () => {
    say();
    const { deps, rec } = harness({ holdServiceClose: true });
    expect(await startServer(deps)).not.toBeNull();
    // Фейковые таймеры до первого сигнала: дедлайн не остаётся настоящим таймером в воркере.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rec.handlers.get('SIGINT')?.();
    expect(vi.getTimerCount()).toBe(1);
    expect(rec.exits).toEqual([]);
    rec.handlers.get('SIGTERM')?.();
    expect(rec.exits).toEqual([1]);
    expect(rec.logs).toContain('[!] game-server: повторный сигнал, выход без ожидания');
  });

  it('боевой listen поднимает сервер на порту, отвечает по HTTP и закрывается по сигналу', async () => {
    const port = await freePort();
    // Строка готовности ждётся событием (вызовом console.log), без опроса. Адрес 127.0.0.1 — без DNS;
    // адрес сокета вместо HOST проверяет тест шва createListen.
    const ready = new Promise<string>((resolve) => {
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => resolve(String(line)));
    });
    const { deps, rec } = harness();
    await startServer({ ...deps, listen: undefined, env: { ...deps.env, PORT: String(port), HOST: '127.0.0.1' } });
    expect(await ready).toBe(`[OK] game-server на http://127.0.0.1:${port}; партий 0; движок fake`);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
    expect(await health.json()).toEqual({ ok: true, games: 0, sessions: 0 });
    rec.handlers.get('SIGINT')?.();
    expect(await rec.exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
  }, 20_000);
});

describe('startServer: пакет 12b — ENGINE_URL, отказ init, отказ close', () => {
  it('ENGINE_URL не http(s) или не адрес — [X] без значения, код 2, сервис не создаётся', async () => {
    const real = { FAKE_ENGINE: undefined, ENGINE_KEY: 'engine-key-value' };
    for (const value of ['engine.test:9000', 'ftp://engine.test', 'ws://engine.test', 'http//engine.test', 'https://']) {
      const { deps, rec } = harness();
      expect(await startServer({ ...deps, env: { ...deps.env, ...real, ENGINE_URL: value } })).toBeNull();
      expect(rec.exits).toEqual([2]);
      expect(rec.logs).toEqual(['[X] game-server: ENGINE_URL должна быть адресом http:// или https://']);
      expect(rec.serviceDeps).toEqual([]);
      expect(rec.events).toEqual(['exit 2']);
    }
    for (const value of ['http://engine.test:9000', 'https://engine.test', 'HTTP://127.0.0.1:8788']) {
      say();
      const { deps, rec } = harness({ initNoop: true });
      expect(await startServer({ ...deps, env: { ...deps.env, ...real, ENGINE_URL: value } })).not.toBeNull();
      expect(rec.exits).toEqual([]);
    }
  });

  it('ENGINE_URL не проверяется при FAKE_ENGINE=1: движок не используется', async () => {
    say();
    const { deps, rec } = harness({ initNoop: true });
    expect(await startServer({ ...deps, env: { ...deps.env, ENGINE_URL: 'not a url' } })).not.toBeNull();
    expect(rec.exits).toEqual([]);
  });

  it('ошибка ENGINE_URL печатается вместе с прочими ошибками конфигурации', async () => {
    const { deps, rec } = harness();
    expect(await startServer({ ...deps, env: { ...deps.env, FAKE_ENGINE: undefined, ENGINE_URL: 'x', PORT: '0' } })).toBeNull();
    expect(rec.logs).toEqual([
      '[X] game-server: нужна переменная ENGINE_KEY (см. infra/.env.example)',
      '[X] game-server: ENGINE_URL должна быть адресом http:// или https://',
      '[X] game-server: PORT должна быть целым числом от 1 до 65535',
    ]);
  });

  it('отказ service.init — [X] с кодом ошибки без пути, выход INIT_EXIT_CODE, ничего не слушает', async () => {
    const log = say();
    const error = Object.assign(new Error(`EACCES: permission denied, scandir '${'/data-dir-value'}'`), { code: 'EACCES' });
    const { deps, rec } = harness({ initFails: error });
    expect(await startServer({ ...deps, env: { ...deps.env, DATA_DIR: '/data-dir-value' } })).toBeNull();
    expect(rec.logs.filter((l) => l.startsWith('[X]'))).toEqual(['[X] game-server: не удалось загрузить партии (EACCES)']);
    expect(rec.exits).toEqual([INIT_EXIT_CODE]);
    expect(INIT_EXIT_CODE).toBe(1);
    expect(rec.events).toEqual([`exit ${INIT_EXIT_CODE}`]);
    expect(rec.roomOptions).toEqual([]);
    expect(rec.handlers.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(rec.logs.join('\n')).not.toContain('data-dir-value');
  });

  it('отказ service.init без кода ошибки — [X] «без кода»', async () => {
    const { deps, rec } = harness({ initFails: new Error('snapshot is broken') });
    expect(await startServer(deps)).toBeNull();
    expect(rec.logs.filter((l) => l.startsWith('[X]'))).toEqual(['[X] game-server: не удалось загрузить партии (без кода)']);
    expect(rec.exits).toEqual([1]);
  });

  it('отказ service.close — строка [!] с кодом, выход всё равно 0', async () => {
    say();
    const { deps, rec } = harness({ serviceCloseFails: true });
    expect(await startServer(deps)).not.toBeNull();
    rec.handlers.get('SIGTERM')?.();
    expect(await rec.exited).toBe(0);
    expect(rec.logs.filter((l) => !l.includes('FAKE_ENGINE'))).toEqual(['[!] game-server: service.close завершился ошибкой (EIO)']);
  });

  it('штатная остановка — без строки [!]', async () => {
    say();
    const { deps, rec } = harness();
    expect(await startServer(deps)).not.toBeNull();
    rec.handlers.get('SIGTERM')?.();
    expect(await rec.exited).toBe(0);
    expect(rec.logs.filter((l) => l.startsWith('[!]') || l.startsWith('[X]'))).toEqual(['[!] game-server: FAKE_ENGINE=1, ходы случайные, KataGo не используется']);
  });
});
