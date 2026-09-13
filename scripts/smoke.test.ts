import { describe, expect, it } from 'vitest';
import { STOP_CEILING_MS, withoutEmpty } from './processes.mjs';
import { CLIENT_REQUEST_MS, HEALTH_REQUEST_MS, LIVEKIT_STUB, SMOKE_APP_KEY, gameServerEnv, goEngineEnv, smokeClient, smokeStartOptions, startChild, timedFetch, waitChildHealth, waitHealth } from './smoke.mjs';

// Родительское окружение «как после .env»: настоящие ключи LiveKit и OpenAI и чужие настройки сервера.
const parent = {
  PATH: '/usr/bin',
  LIVEKIT_URL: 'wss://real.example',
  LIVEKIT_API_KEY: 'real-key',
  LIVEKIT_API_SECRET: 'real-secret',
  LIVEKIT_EXTRA: 'real-extra',
  OPENAI_API_KEY: 'real-openai',
  APP_KEY: 'real-app-key',
  ENGINE_KEY: 'real-engine-key',
  KATAGO_BIN: '/opt/katago',
  KATAGO_MODEL: '',
  MAX_SESSIONS: '1',
  SESSION_TTL_MS: '5',
  PORT: '8787',
};

describe('smoke: окружение game-server (D-0001)', () => {
  it('LIVEKIT_* — всегда заглушки, а не значения из process.env', () => {
    const env = gameServerEnv(parent, { port: 18787, dataDir: '/tmp/x' });
    expect(env.LIVEKIT_URL).toBe(LIVEKIT_STUB.LIVEKIT_URL);
    expect(env.LIVEKIT_API_KEY).toBe(LIVEKIT_STUB.LIVEKIT_API_KEY);
    expect(env.LIVEKIT_API_SECRET).toBe(LIVEKIT_STUB.LIVEKIT_API_SECRET);
    expect(env.LIVEKIT_URL).toMatch(/\.invalid$/);
    expect(env).not.toHaveProperty('LIVEKIT_EXTRA');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    for (const value of Object.values(env)) expect(value).not.toMatch(/^real-/);
  });

  it('то же для --real и для настоящего process.env', () => {
    const real = gameServerEnv(parent, { port: 1, dataDir: '/tmp/x', real: true, engineUrl: 'http://127.0.0.1:18788', engineKey: 'smoke-engine' });
    expect(real.LIVEKIT_URL).toBe(LIVEKIT_STUB.LIVEKIT_URL);
    expect(real.ENGINE_KEY).toBe('smoke-engine'); // ключ движка свой: оба процесса запускает smoke
    expect(real.FAKE_ENGINE).toBeUndefined();
    const fromProcess = gameServerEnv(process.env, { port: 1, dataDir: '/tmp/x' });
    expect(fromProcess.LIVEKIT_API_SECRET).toBe(LIVEKIT_STUB.LIVEKIT_API_SECRET);
  });

  it('свои ключ, порт, каталог и фейковый движок; чужие пределы сессий не протекают', () => {
    const env = gameServerEnv(parent, { port: 18787, dataDir: '/tmp/x' });
    expect(env).toMatchObject({ APP_KEY: SMOKE_APP_KEY, PORT: '18787', HOST: '127.0.0.1', DATA_DIR: '/tmp/x', FAKE_ENGINE: '1' });
    expect(env).not.toHaveProperty('ENGINE_KEY');
    expect(env).not.toHaveProperty('MAX_SESSIONS');
    expect(env).not.toHaveProperty('SESSION_TTL_MS');
    expect(env).not.toHaveProperty('KATAGO_MODEL');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('go-engine в --real получает KATAGO_* и свой порт, но не ключи LiveKit', () => {
    const env = goEngineEnv(parent, { port: 18788, engineKey: 'smoke-engine' });
    expect(env).toMatchObject({ KATAGO_BIN: '/opt/katago', ENGINE_KEY: 'smoke-engine', ENGINE_PORT: '18788', ENGINE_HOST: '127.0.0.1' });
    expect(env).not.toHaveProperty('KATAGO_MODEL');
    expect(env).not.toHaveProperty('LIVEKIT_API_SECRET');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('processes', () => {
  it('пустые значения детям не передаются', () => {
    expect(withoutEmpty({ A: '', B: '  ', C: 'x', D: undefined })).toEqual({ C: 'x' });
  });

  it('потолок остановки дольше дедлайна game-server SHUTDOWN_MS (25 с)', async () => {
    const { SHUTDOWN_MS } = await import('../apps/game-server/src/start-server.ts');
    expect(STOP_CEILING_MS).toBeGreaterThan(SHUTDOWN_MS);
  });
});

// Часы и сон подделаны: время идёт только когда ожидание «спит».
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const okResponse = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200 });

describe('smoke: ожидание /health', () => {
  it('ребёнок уже вышел — ни одного запроса, сразу false', async () => {
    const c = clock();
    const calls: string[] = [];
    const result = await waitHealth('http://h/health', 30_000, {
      gone: () => true,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return okResponse();
      },
      now: c.now,
      sleep: c.sleep,
    });
    expect(result).toBe(false);
    expect(calls).toEqual([]);
    expect(c.sleeps).toEqual([]);
  });

  it('ребёнок вышел во время опроса — ожидание прерывается, а не идёт до потолка', async () => {
    const c = clock();
    let exited = false;
    let calls = 0;
    const result = await waitHealth('http://h/health', 310_000, {
      gone: () => exited,
      fetchImpl: async () => {
        calls++;
        if (calls === 2) exited = true; // процесс завершился, пока шёл второй запрос
        throw new TypeError('fetch failed');
      },
      now: c.now,
      sleep: c.sleep,
    });
    expect(result).toBe(false);
    expect(calls).toBe(2);
    expect(c.sleeps).toEqual([300]); // один сон между попытками, после выхода — ни одного
  });

  it('waitChildHealth: настоящий ребёнок с кодом 3 — ожидание прерывается по его выходу, без таймеров', async () => {
    const { spawn } = await import('node:child_process');
    const { hasExited } = await import('./processes.mjs');
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    let calls = 0;
    const result = await waitChildHealth(child, 'http://h/health', 310_000, {
      fetchImpl: async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
      now: () => 0, // потолок не наступает никогда: выйти можно только по выходу ребёнка
      sleep: () => (hasExited(child) ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve(undefined)))),
    });
    expect(result).toBe(false);
    expect(child.exitCode).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('waitChildHealth: вышедший по сигналу ребёнок — ни одного запроса; живой — опрос и pred', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return okResponse({ ok: false });
    };
    const c = clock();
    expect(await waitChildHealth({ exitCode: null, signalCode: 'SIGKILL' }, 'http://h/health', 30_000, { fetchImpl, now: c.now, sleep: c.sleep })).toBe(false);
    expect(calls).toBe(0);
    const d = clock();
    const alive = { exitCode: null, signalCode: null };
    expect(await waitChildHealth(alive, 'http://h/health', 600, { pred: (h) => (h as { ok?: boolean }).ok === true, fetchImpl, now: d.now, sleep: d.sleep })).toBe(false);
    expect(calls).toBe(2);
  });

  it('здоровый ответ с нужным телом — true; не то тело — опрос до потолка', async () => {
    const c = clock();
    expect(await waitHealth('http://h/health', 30_000, { fetchImpl: async () => okResponse(), now: c.now, sleep: c.sleep })).toBe(true);
    const d = clock();
    let calls = 0;
    const cold = await waitHealth('http://h/health', 1_000, {
      pred: (h) => (h as { ok?: boolean }).ok === true,
      fetchImpl: async () => {
        calls++;
        return okResponse({ ok: false });
      },
      now: d.now,
      sleep: d.sleep,
    });
    expect(cold).toBe(false);
    expect(calls).toBe(4); // попытки в 0, 300, 600 и 900 мс
    expect(d.now()).toBe(1_200);
  });

  it('у каждого запроса свой таймаут HEALTH_REQUEST_MS', async () => {
    const c = clock();
    const timeouts: number[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    let calls = 0;
    await waitHealth('http://h/health', 600, {
      fetchImpl: async (_url, init) => {
        signals.push(init?.signal);
        calls++;
        throw new TypeError('fetch failed');
      },
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
      now: c.now,
      sleep: c.sleep,
    });
    expect(calls).toBe(2);
    expect(timeouts).toEqual([HEALTH_REQUEST_MS, HEALTH_REQUEST_MS]);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it('таймауты запросов: меньше потолков ожидания и больше бюджетов сервера', () => {
    // Самый короткий потолок waitHealth — 10 с (сервер медленного клиента).
    expect(HEALTH_REQUEST_MS).toBeLessThan(10_000);
    // settled ждёт движок до 60 с; самый долгий бюджет вызова в game-server — клиент go-engine, 30 с.
    expect(CLIENT_REQUEST_MS).toBeLessThan(60_000);
    expect(CLIENT_REQUEST_MS).toBeGreaterThan(30_000);
  });
});

describe('smoke: fetch клиента с таймаутом', () => {
  it('запрос без сигнала получает AbortSignal.timeout(ms); остальные поля не теряются', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const made: number[] = [];
    const marker = new AbortController().signal;
    const f = timedFetch(
      CLIENT_REQUEST_MS,
      async (_url, init) => {
        seen.push(init);
        return okResponse();
      },
      (ms) => {
        made.push(ms);
        return marker;
      },
    );
    await f('http://h/api/games', { method: 'POST', body: '{}' });
    await f('http://h/api/games');
    expect(made).toEqual([CLIENT_REQUEST_MS, CLIENT_REQUEST_MS]);
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{}' });
    expect(seen[0]?.signal).toBe(marker);
    expect(seen[1]?.signal).toBe(marker);
  });

  it('свой сигнал вызывающего (поток SSE) остаётся: поток ограничен своим AbortController', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const made: number[] = [];
    const own = new AbortController().signal;
    const f = timedFetch(
      CLIENT_REQUEST_MS,
      async (_url, init) => {
        seen.push(init);
        return okResponse();
      },
      (ms) => {
        made.push(ms);
        return new AbortController().signal;
      },
    );
    await f('http://h/api/games/x/events', { signal: own });
    expect(seen[0]?.signal).toBe(own);
    expect(made).toEqual([]);
  });
});

describe('smoke: опции запуска детей', () => {
  it('POSIX: detached — killTree шлёт сигнал группе, KataGo не остаётся сиротой', () => {
    expect(smokeStartOptions('/repo', { A: '1' }, false)).toEqual({ cwd: '/repo', env: { A: '1' }, prefix: '  ', detached: true });
  });

  it('Windows: не detached (там дерево гасит taskkill /T)', () => {
    expect(smokeStartOptions('/repo', { A: '1' }, true)).toEqual({ cwd: '/repo', env: { A: '1' }, prefix: '  ', detached: false });
  });
});

describe('smoke: клиент и запуск детей', () => {
  it('smokeClient: ключ smoke и таймаут на каждый запрос операции', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = smokeClient('http://127.0.0.1:18787/', async (url, init) => {
      seen.push({ url: String(url), init });
      return okResponse({ games: [] });
    });
    await client.listGames();
    expect(seen[0]?.url).toBe('http://127.0.0.1:18787/api/games');
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.init?.headers).toMatchObject({ 'x-app-key': SMOKE_APP_KEY });
  });

  it('startChild: node с опциями smokeStartOptions', () => {
    const calls: unknown[][] = [];
    const child = startChild('game-server', ['apps/game-server/src/main.ts'], '/repo', { A: '1' }, (...args: unknown[]) => {
      calls.push(args);
      return { pid: 7 };
    });
    expect(child).toEqual({ pid: 7 });
    expect(calls).toEqual([['game-server', process.execPath, ['apps/game-server/src/main.ts'], smokeStartOptions('/repo', { A: '1' })]]);
  });
});
