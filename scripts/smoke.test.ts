import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOP_CEILING_MS, withoutEmpty } from './processes.mjs';
import { CLIENT_TIMEOUTS } from '@goko/protocol';
import { API_RATE } from '../apps/game-server/src/rate-limit.ts';
import { CLIENT_REQUEST_MS, GAME_POLL_MS, HEALTH_REQUEST_MS, LIVEKIT_STUB, SMOKE_APP_KEY, gameServerEnv, goEngineEnv, smokeClient, smokeFinisher, smokeStartOptions, startChild, timedFetch, waitChildHealth, waitHealth } from './smoke.mjs';

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
    let callsAfterExit = 0;
    let t = 0;
    const result = await waitChildHealth(child, 'http://h/health', 310_000, {
      fetchImpl: async () => {
        calls++;
        if (hasExited(child)) callsAfterExit++;
        throw new TypeError('fetch failed');
      },
      now: () => t,
      // До выхода ребёнка сон ждёт его события, часы стоят. После выхода часы идут шагами: без
      // проверки выхода ожидание дошло бы до потолка сотнями пустых запросов, а не зависло.
      sleep: (ms) => {
        if (!hasExited(child)) return new Promise((resolve) => child.once('exit', () => resolve(undefined)));
        t += ms;
        return Promise.resolve();
      },
    });
    expect(result).toBe(false);
    expect(child.exitCode).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(callsAfterExit).toBe(0);
    expect(t).toBe(0); // после выхода не было ни одного сна
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
    // settled ждёт движок до 60 с; клиент протокола сам обрывает операцию раньше (самая долгая — score).
    expect(CLIENT_REQUEST_MS).toBeLessThan(60_000);
    expect(CLIENT_REQUEST_MS).toBeGreaterThan(Math.max(...Object.values(CLIENT_TIMEOUTS)));
  });

  it('опрос состояния партии укладывается в лимит частоты game-server с запасом на прочие запросы', () => {
    expect(Math.ceil(API_RATE.windowMs / GAME_POLL_MS)).toBeLessThanOrEqual((API_RATE.limit * 2) / 3);
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

describe('smoke: завершение по концу сценария и по сигналу', () => {
  // Остановка детей, которую тест отпускает сам; счётчик вызовов — чтобы видеть, что она одна.
  type HarnessOptions = {
    rmImpl?: (dir: string, o: { recursive: boolean; force: boolean }) => Promise<unknown>;
    dataDir?: string;
    stopAll?: () => Promise<void>;
    log?: (line: string) => void;
    fail?: (msg: string) => void;
  };
  function harness(opts: HarnessOptions = {}) {
    const events: string[] = [];
    const fails: string[] = [];
    const warns: string[] = [];
    const signals = new EventEmitter();
    let release = () => {};
    let stops = 0;
    let onExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      onExit = resolve;
    });
    const exits: number[] = [];
    const finish = smokeFinisher({
      stopAll: () => {
        stops++;
        events.push('stopAll');
        if (opts.stopAll) return opts.stopAll();
        return new Promise<void>((resolve) => {
          release = () => {
            events.push('stopped');
            resolve();
          };
        });
      },
      dataDir: opts.dataDir ?? '/tmp/goko-smoke-test',
      fail: (msg: string) => {
        fails.push(msg);
        events.push(`[X] ${msg}`);
        opts.fail?.(msg);
      },
      warn: (msg: string) => {
        warns.push(msg);
        events.push(`[!] ${msg}`);
      },
      failures: () => fails.length,
      log: (line: string) => {
        events.push(line);
        opts.log?.(line);
      },
      exit: (code: number) => {
        exits.push(code);
        events.push(`exit ${code}`);
        onExit(code);
      },
      signals,
      rmImpl:
        opts.rmImpl ??
        (async (dir, o) => {
          events.push(`rm ${dir} ${JSON.stringify(o)}`);
        }),
    });
    return { events, fails, warns, signals, exits, exited, finish, release: () => release(), stops: () => stops };
  }

  it('конец сценария без ошибок: дети остановлены, dataDir удалён, затем [OK] и код 0', async () => {
    const h = harness();
    const done = h.finish();
    expect(h.events).toEqual(['stopAll']);
    h.release();
    await done;
    expect(h.events).toEqual(['stopAll', 'stopped', 'rm /tmp/goko-smoke-test {"recursive":true,"force":true}', '[OK] smoke: все шаги прошли', 'exit 0']);
  });

  it('Ctrl+C во время финальной остановки — [X] и код 1; остановка по-прежнему одна', async () => {
    const h = harness();
    const done = h.finish();
    h.signals.emit('SIGINT');
    expect(h.fails).toEqual(['smoke: прерван сигналом SIGINT, останавливаю процессы']);
    expect(h.exits).toEqual([]);
    h.release();
    await done;
    await h.exited;
    expect(h.stops()).toBe(1);
    expect(h.exits).toEqual([1]);
    expect(h.events.slice(-2)).toEqual(['[X] smoke: ошибок 1', 'exit 1']);
  });

  it('сигнал посреди сценария: остановка, удаление настоящего dataDir и выход 1 — без участия сценария', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goko-smoke-finisher-'));
    await writeFile(path.join(dir, 'game.json'), '{}');
    const h = harness({ dataDir: dir, rmImpl: rm });
    h.signals.emit('SIGTERM');
    expect(h.events).toEqual(['[X] smoke: прерван сигналом SIGTERM, останавливаю процессы', 'stopAll']);
    h.release();
    expect(await h.exited).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(h.events.slice(-2)).toEqual(['[X] smoke: ошибок 1', 'exit 1']);
  });

  it('повторный Ctrl+C не бросает детей: обработчик остаётся, выход только после остановки с потолком', async () => {
    const h = harness();
    h.signals.emit('SIGINT');
    h.signals.emit('SIGINT');
    h.signals.emit('SIGTERM');
    expect(h.signals.listenerCount('SIGINT')).toBe(1);
    expect(h.signals.listenerCount('SIGTERM')).toBe(1);
    expect(h.stops()).toBe(1);
    expect(h.fails).toHaveLength(1);
    expect(h.warns).toEqual([
      `smoke: повторный сигнал SIGINT — дети уже останавливаются, жду не дольше ${STOP_CEILING_MS} мс, затем силой`,
      `smoke: повторный сигнал SIGTERM — дети уже останавливаются, жду не дольше ${STOP_CEILING_MS} мс, затем силой`,
    ]);
    expect(h.exits).toEqual([]);
    h.release();
    expect(await h.exited).toBe(1);
    // Конец сценария после сигнала ждёт ту же остановку, а не запускает вторую.
    await h.finish();
    expect(h.stops()).toBe(1);
    expect(h.exits).toEqual([1]);
  });

  it('отказ stopAll — ошибка: [X] с причиной, dataDir удалён, итог [X] и код 1', async () => {
    for (const stopAll of [() => Promise.reject(new Error('taskkill failed')), () => { throw new Error('taskkill failed'); }]) {
      const h = harness({ stopAll });
      await h.finish();
      expect(h.events).toEqual([
        'stopAll',
        '[X] smoke: остановка процессов завершилась ошибкой (taskkill failed)',
        'rm /tmp/goko-smoke-test {"recursive":true,"force":true}',
        '[X] smoke: ошибок 1',
        'exit 1',
      ]);
    }
  });

  it('исключение в итоговой строке: dataDir всё равно удалён и выход 1; finish отклоняется этой ошибкой', async () => {
    const boom = new Error('EPIPE');
    const h = harness({
      log: () => {
        throw boom;
      },
    });
    const done = h.finish();
    h.release();
    await expect(done).rejects.toBe(boom);
    expect(h.events).toEqual(['stopAll', 'stopped', 'rm /tmp/goko-smoke-test {"recursive":true,"force":true}', '[OK] smoke: все шаги прошли', 'exit 1']);
  });

  it('исключение в fail после отказа stopAll: dataDir удалён и выход 1', async () => {
    const boom = new Error('stdout closed');
    const h = harness({
      stopAll: () => Promise.reject(new Error('stuck')),
      fail: () => {
        throw boom;
      },
    });
    await expect(h.finish()).rejects.toBe(boom);
    expect(h.events.filter((e) => e.startsWith('rm ') || e.startsWith('exit'))).toEqual(['rm /tmp/goko-smoke-test {"recursive":true,"force":true}', 'exit 1']);
  });

  it('по сигналу исключение в итоговой строке не становится необработанным отклонением', async () => {
    const h = harness({
      log: () => {
        throw new Error('EPIPE');
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      h.signals.emit('SIGINT');
      h.release();
      expect(await h.exited).toBe(1);
      // Отклонение, если бы оно было, всплыло бы через оборот очереди событий.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('отказ удаления dataDir не мешает итогу и коду выхода', async () => {
    const h = harness({ rmImpl: async () => Promise.reject(new Error('EBUSY')) });
    const done = h.finish();
    h.release();
    await done;
    expect(h.exits).toEqual([0]);
  });
});
