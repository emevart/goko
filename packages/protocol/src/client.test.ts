import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ClientTimeoutError, HttpError, STREAM_IDLE_MS, StreamIdleError, createClient } from './index.ts';
import { CLIENT_TIMEOUTS } from './client.ts';
import { fakeFetch } from './test-helpers.ts';

const state = {
  id: 'g1',
  createdAt: '2026-09-07T10:00:00.000Z',
  revision: 1,
  settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
  seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
  status: 'playing',
  toPlay: 'W',
  moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: '2026-09-07T10:00:01.000Z' }],
  board: '.'.repeat(169),
  captures: { B: 0, W: 0 },
  ko: null,
  consecutivePasses: 0,
  pendingEngineMove: true,
  canRedo: false,
};

describe('createClient', () => {
  it('шлёт X-App-Key, JSON и разбирает ответ схемой', async () => {
    const f = fakeFetch(() => Response.json({ state, move: state.moves[0] }));
    const client = createClient({ baseUrl: 'http://api.test/', appKey: 'k', fetch: f.fetch });
    const res = await client.play('g1', { coord: 'D4', via: 'voice' });
    expect(res.move.coord).toBe('D4');
    expect(f.calls[0]?.url).toBe('http://api.test/api/games/g1/play');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect((f.calls[0]?.init.headers as Record<string, string>)['x-app-key']).toBe('k');
    expect((f.calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ coord: 'D4', via: 'voice' });
  });

  it('ошибка протокола -> ApiError с кодом', async () => {
    const f = fakeFetch(() => Response.json({ error: { code: 'illegal_move', message: 'занято', details: { reason: 'occupied' } } }, { status: 400 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    await expect(client.play('g1', { coord: 'D4' })).rejects.toMatchObject({ name: 'ApiError', code: 'illegal_move', status: 400, details: { reason: 'occupied' } });
  });

  it('не-протокольный ответ -> HttpError', async () => {
    const f = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const err = await client.getGame('g1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).body).toBe('bad gateway');
  });

  it('хвостовые слэши базового адреса срезаются все', async () => {
    const f = fakeFetch(() => Response.json(state));
    const client = createClient({ baseUrl: 'http://api.test//', appKey: 'k', fetch: f.fetch });
    await client.getGame('g1');
    expect(f.calls[0]?.url).toBe('http://api.test/api/games/g1');
  });

  it('ascii и sgf — текст, events — разобранные события', async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith('/ascii')) return new Response(' 1  .  .', { headers: { 'content-type': 'text/plain' } });
      const body = `event: state.updated\ndata: ${JSON.stringify({ type: 'state.updated', state, cause: 'sync', by: 'system' })}\n\nevent: engine.thinking\ndata: {"type":"engine.thinking","gameId":"g1","color":"W"}\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    expect(await client.ascii('g1')).toBe(' 1  .  .');
    const events = [];
    for await (const ev of client.events({ gameId: 'g1' })) events.push(ev.type);
    expect(events).toEqual(['state.updated', 'engine.thinking']);
    expect(f.calls[1]?.url).toBe('http://api.test/api/games/g1/events');
  });

  it('createSession и score по нужным маршрутам', async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith('/api/sessions')) return Response.json({ session: { id: 's1', room: 'goko-s1', currentGameId: null, createdAt: state.createdAt }, livekit: { url: 'wss://lk', token: 't' } });
      return Response.json({ winner: 'W', margin: 7.5, reason: 'score' });
    });
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    expect((await client.createSession()).session.room).toBe('goko-s1');
    expect((await client.score('g1')).winner).toBe('W');
    expect(f.calls[1]?.url).toBe('http://api.test/api/games/g1/score');
  });
});

// Таблица маршрутов: у каждого метода клиента проверены HTTP-метод, путь и тело.
// Идентификатор партии взят со слэшем — путь обязан его кодировать.
const move = { n: 1, color: 'B', coord: 'D4', captured: 0, at: '2026-09-07T10:00:01.000Z' };
const analysis = { gameId: 'g1', revision: 0, visits: 1, winrateB: 0.5, scoreLeadB: 0, topMoves: [], ownership: [], groups: [] };
const result = { winner: 'W', margin: 7.5, reason: 'score' };
const sessionResponse = {
  session: { id: 's1', room: 'goko-s1', currentGameId: null, createdAt: state.createdAt },
  livekit: { url: 'wss://lk', token: 't' },
};
const seats = { black: { controller: 'human' as const }, white: { controller: 'engine' as const } };

type Route = {
  name: string;
  run: (c: ReturnType<typeof createClient>) => Promise<unknown>;
  method: string | undefined;
  path: string;
  body: unknown;
  response: () => Response;
};

const routes: Route[] = [
  { name: 'createSession', run: (c) => c.createSession(), method: 'POST', path: '/api/sessions', body: {}, response: () => Response.json(sessionResponse) },
  { name: 'restartConversation', run: (c) => c.restartConversation('s 1', { requestId: 'restart-1' }), method: 'POST', path: '/api/sessions/s%201/conversation', body: { requestId: 'restart-1' }, response: () => Response.json(sessionResponse) },
  { name: 'newGame', run: (c) => c.newGame('s/1', seats), method: 'POST', path: '/api/sessions/s%2F1/games', body: seats, response: () => Response.json({ state }) },
  { name: 'createGame', run: (c) => c.createGame(seats), method: 'POST', path: '/api/games', body: seats, response: () => Response.json({ state }) },
  { name: 'getGame', run: (c) => c.getGame('g/1'), method: 'GET', path: '/api/games/g%2F1', body: undefined, response: () => Response.json(state) },
  { name: 'listGames', run: (c) => c.listGames(), method: 'GET', path: '/api/games', body: undefined, response: () => Response.json({ games: [] }) },
  { name: 'play', run: (c) => c.play('g/1', { coord: 'D4' }), method: 'POST', path: '/api/games/g%2F1/play', body: { coord: 'D4' }, response: () => Response.json({ state, move }) },
  { name: 'pass', run: (c) => c.pass('g/1'), method: 'POST', path: '/api/games/g%2F1/pass', body: {}, response: () => Response.json({ state, move }) },
  { name: 'resign', run: (c) => c.resign('g/1', { color: 'B' }), method: 'POST', path: '/api/games/g%2F1/resign', body: { color: 'B' }, response: () => Response.json({ state }) },
  { name: 'undo', run: (c) => c.undo('g/1'), method: 'POST', path: '/api/games/g%2F1/undo', body: {}, response: () => Response.json({ state, removed: [] }) },
  { name: 'correct', run: (c) => c.correct('g/1', { coord: 'D4' }), method: 'POST', path: '/api/games/g%2F1/correct', body: { coord: 'D4' }, response: () => Response.json({ state, move }) },
  { name: 'setRank', run: (c) => c.setRank('g/1', { color: 'W', rank: '10k' }), method: 'POST', path: '/api/games/g%2F1/rank', body: { color: 'W', rank: '10k' }, response: () => Response.json({ state }) },
  { name: 'analyze', run: (c) => c.analyze('g/1'), method: 'POST', path: '/api/games/g%2F1/analyze', body: {}, response: () => Response.json(analysis) },
  { name: 'score', run: (c) => c.score('g/1'), method: 'POST', path: '/api/games/g%2F1/score', body: {}, response: () => Response.json(result) },
  { name: 'ascii', run: (c) => c.ascii('g/1'), method: undefined, path: '/api/games/g%2F1/ascii', body: undefined, response: () => new Response('board') },
  { name: 'sgf', run: (c) => c.sgf('g/1'), method: undefined, path: '/api/games/g%2F1/sgf', body: undefined, response: () => new Response('(;GM[1])') },
];

describe('маршруты клиента', () => {
  it.each(routes)('$name: метод, путь, тело и ключ приложения', async (route) => {
    const f = fakeFetch(() => route.response());
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    await route.run(client);
    const call = f.calls[0];
    expect(f.calls).toHaveLength(1);
    expect(call?.url).toBe(`http://api.test${route.path}`);
    expect(call?.init.method).toBe(route.method);
    expect((call?.init.headers as Record<string, string> | undefined)?.['x-app-key']).toBe('k');
    // Без content-type Hono на сервере не разберёт тело запроса; текстовые маршруты его не шлют.
    const contentType = (call?.init.headers as Record<string, string> | undefined)?.['content-type'];
    expect(contentType).toBe(route.method === undefined ? undefined : 'application/json');
    const body = call?.init.body;
    if (route.body === undefined) expect(body).toBeUndefined();
    else expect(JSON.parse(String(body))).toEqual(route.body);
  });

  it.each(routes)('$name: ошибка протокола -> ApiError, чужое тело -> HttpError', async (route) => {
    const api = fakeFetch(() => Response.json({ error: { code: 'not_found', message: 'no game' } }, { status: 404 }));
    const clientApi = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: api.fetch });
    const errApi = await route.run(clientApi).catch((e: unknown) => e);
    expect(errApi).toBeInstanceOf(ApiError);
    expect((errApi as ApiError).code).toBe('not_found');

    const raw = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const clientRaw = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: raw.fetch });
    const errRaw = await route.run(clientRaw).catch((e: unknown) => e);
    expect(errRaw).toBeInstanceOf(HttpError);
    expect((errRaw as HttpError).status).toBe(502);
  });
});

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('events', () => {
  const oneEvent = 'event: engine.thinking\ndata: {"type":"engine.thinking","gameId":"g1","color":"W"}\n\n';

  it('путь сессии, ключ приложения, accept и signal', async () => {
    const f = fakeFetch(() => sseResponse(oneEvent));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    const seen = [];
    for await (const ev of client.events({ sessionId: 's/1' }, ac.signal)) seen.push(ev.type);
    expect(seen).toEqual(['engine.thinking']);
    const call = f.calls[0];
    expect(call?.url).toBe('http://api.test/api/sessions/s%2F1/events');
    const headers = call?.init.headers as Record<string, string> | undefined;
    expect(headers?.['x-app-key']).toBe('k');
    expect(headers?.['accept']).toBe('text/event-stream');
    // Сигнал запроса — свой: его отменяют и внешний signal, и сторож простоя (проверки ниже).
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('битый JSON и события не по схеме пропускаются', async () => {
    const body = 'data: not json\n\ndata: {"type":"unknown.kind"}\n\n' + oneEvent;
    const f = fakeFetch(() => sseResponse(body));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const seen = [];
    for await (const ev of client.events({ gameId: 'g1' })) seen.push(ev.type);
    expect(seen).toEqual(['engine.thinking']);
  });

  it('onUnknownEvent получает событие не по схеме, разбор продолжается', async () => {
    const body = 'data: {"type":"unknown.kind"}\n\n' + oneEvent;
    const f = fakeFetch(() => sseResponse(body));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const unknown: unknown[] = [];
    const errors: string[] = [];
    const seen = [];
    for await (const ev of client.events({ gameId: 'g1' }, undefined, (raw, error) => {
      unknown.push(raw);
      errors.push(error.name);
    })) {
      seen.push(ev.type);
    }
    expect(seen).toEqual(['engine.thinking']);
    expect(unknown).toEqual([{ type: 'unknown.kind' }]);
    expect(errors).toEqual(['ZodError']);
  });

  it('ошибка статуса -> ApiError, пустое тело -> HttpError', async () => {
    const api = fakeFetch(() => Response.json({ error: { code: 'not_found', message: 'no game' } }, { status: 404 }));
    const clientApi = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: api.fetch });
    const errApi = await clientApi.events({ gameId: 'g1' }).next().catch((e: unknown) => e);
    expect(errApi).toBeInstanceOf(ApiError);

    const empty = fakeFetch(() => new Response(null, { status: 204 }));
    const clientEmpty = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: empty.fetch });
    const errEmpty = await clientEmpty.events({ gameId: 'g1' }).next().catch((e: unknown) => e);
    expect(errEmpty).toBeInstanceOf(HttpError);
    expect((errEmpty as HttpError).message).toContain('empty SSE body');
  });
});

describe('разбор ответа схемой', () => {
  it('ответ не по схеме -> HttpError с исходной ошибкой в cause', async () => {
    const f = fakeFetch(() => Response.json({ state: { ...state, board: '.'.repeat(168) }, move }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const err = await client.play('g1', { coord: 'D4' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(200);
    expect((err as HttpError).body).toContain('"board"');
    expect(String((err as HttpError).cause)).toMatch(/board has 168 chars/);
  });

  it('успешный ответ не в JSON -> HttpError с исходной ошибкой в cause', async () => {
    const f = fakeFetch(() => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const err = await client.getGame('g1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(200);
    expect((err as HttpError).body).toBe('<html>proxy</html>');
    expect((err as HttpError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe('fakeFetch', () => {
  it('список обработчиков: по одному на вызов, последний повторяется', async () => {
    const f = fakeFetch([() => new Response('first'), () => new Response('second')]);
    expect(await (await f.fetch('u1')).text()).toBe('first');
    expect(await (await f.fetch('u2')).text()).toBe('second');
    expect(await (await f.fetch('u3')).text()).toBe('second');
    expect(f.calls.map((c) => c.url)).toEqual(['u1', 'u2', 'u3']);
  });

  it('вызов без init записывается с пустым объектом', async () => {
    const f = fakeFetch(() => new Response('ok'));
    await f.fetch('u1');
    expect(f.calls[0]?.init).toEqual({});
  });

  it('Request первым аргументом: url, метод и заголовки берутся из него', async () => {
    const f = fakeFetch(() => new Response('ok'));
    await f.fetch(new Request('http://api.test/api/games', { method: 'POST', headers: { 'x-app-key': 'k' }, body: '{}' }));
    const call = f.calls[0];
    expect(call?.url).toBe('http://api.test/api/games');
    expect(call?.init.method).toBe('POST');
    expect(new Headers(call?.init.headers).get('x-app-key')).toBe('k');
  });

  it('пустой список обработчиков — внятная ошибка', async () => {
    const f = fakeFetch([]);
    await expect(f.fetch('u1')).rejects.toThrow('fakeFetch: no handlers provided');
  });
});

// Ограничение по времени (B3): у каждой операции свой потолок, внешний signal отменяет вызов.
// Время ненастоящее: fake timers только для setTimeout/clearTimeout, ожидания через setImmediate.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// fetch, который никогда не отвечает сам, но реагирует на signal, как настоящий.
function hangingFetch(): { fetch: typeof globalThis.fetch; signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signals.push(signal);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  return { fetch: fetchFn as unknown as typeof globalThis.fetch, signals };
}

type Settled = { done: boolean; value?: unknown };

// Подписка на исход сразу при вызове: отказ во время перемотки таймеров не становится необработанным.
function capture(promise: Promise<unknown>): Settled {
  const out: Settled = { done: false };
  const settle = (value: unknown): void => {
    out.done = true;
    out.value = value;
  };
  promise.then(settle, settle);
  return out;
}

// Ждёт исхода не дольше заданного числа оборотов цикла событий.
async function settleWithin(out: Settled, ticks = 20): Promise<Settled> {
  for (let i = 0; i < ticks && !out.done; i++) await tick();
  return out;
}

type TimedRoute = {
  name: string;
  op: keyof typeof CLIENT_TIMEOUTS;
  run: (c: ReturnType<typeof createClient>, signal?: AbortSignal) => Promise<unknown>;
};

const timedRoutes: TimedRoute[] = [
  { name: 'createSession', op: 'create_session', run: (c, signal) => c.createSession({ signal }) },
  { name: 'restartConversation', op: 'restart_conversation', run: (c, signal) => c.restartConversation('s1', { requestId: 'r1' }, { signal }) },
  { name: 'newGame', op: 'session_new_game', run: (c, signal) => c.newGame('s1', seats, { signal }) },
  { name: 'createGame', op: 'create_game', run: (c, signal) => c.createGame(seats, { signal }) },
  { name: 'getGame', op: 'get_game', run: (c, signal) => c.getGame('g1', { signal }) },
  { name: 'listGames', op: 'list_games', run: (c, signal) => c.listGames({ signal }) },
  { name: 'play', op: 'play', run: (c, signal) => c.play('g1', { coord: 'D4' }, { signal }) },
  { name: 'pass', op: 'pass', run: (c, signal) => c.pass('g1', {}, { signal }) },
  { name: 'resign', op: 'resign', run: (c, signal) => c.resign('g1', { color: 'B' }, { signal }) },
  { name: 'undo', op: 'undo', run: (c, signal) => c.undo('g1', {}, { signal }) },
  { name: 'redo', op: 'redo', run: (c, signal) => c.redo('g1', {}, { signal }) },
  { name: 'correct', op: 'correct_last_move', run: (c, signal) => c.correct('g1', { coord: 'D4' }, { signal }) },
  { name: 'setRank', op: 'set_rank', run: (c, signal) => c.setRank('g1', { color: 'W', rank: '10k' }, { signal }) },
  { name: 'analyze', op: 'analyze', run: (c, signal) => c.analyze('g1', {}, { signal }) },
  { name: 'score', op: 'score', run: (c, signal) => c.score('g1', { signal }) },
  { name: 'ascii', op: 'render', run: (c, signal) => c.ascii('g1', { signal }) },
  { name: 'sgf', op: 'sgf', run: (c, signal) => c.sgf('g1', { signal }) },
];

describe('таймауты клиента', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('умолчания: создание сессии, play, pass, correct и новая партия 15 с, analyze 15 с, score 25 с, остальные 5 с', () => {
    expect(CLIENT_TIMEOUTS).toEqual({
      // Выше 10 с ожидания createRoom на сервере: клиент видит код сервера, а не свой таймаут.
      create_session: 15_000,
      restart_conversation: 15_000,
      session_new_game: 15_000,
      create_game: 15_000,
      get_game: 5_000,
      list_games: 5_000,
      play: 15_000,
      pass: 15_000,
      resign: 5_000,
      undo: 5_000,
      redo: 5_000,
      correct_last_move: 15_000,
      set_rank: 5_000,
      analyze: 15_000,
      score: 25_000,
      render: 5_000,
      sgf: 5_000,
    });
    expect(timedRoutes.map((r) => r.op).sort()).toEqual(Object.keys(CLIENT_TIMEOUTS).sort());
  });

  it.each(timedRoutes)('$name: без ответа — ClientTimeoutError ровно по своему умолчанию', async ({ op, run }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = hangingFetch();
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const pending = capture(run(client));
    const ms = CLIENT_TIMEOUTS[op];
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect((await settleWithin(pending, 5)).done).toBe(false);
    expect(f.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await settleWithin(pending);
    expect(out.done).toBe(true);
    expect(out.value).toBeInstanceOf(ClientTimeoutError);
    expect(out.value).toMatchObject({ name: 'ClientTimeoutError', code: 'client_timeout', operation: op, timeoutMs: ms });
    // Сигнал fetch тоже отменён: соединение не висит после таймаута.
    expect(f.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeoutMs из опций переопределяет умолчание только своей операции', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = hangingFetch();
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch, timeoutMs: { get_game: 100 } });
    const game = capture(client.getGame('g1'));
    const list = capture(client.listGames());
    await vi.advanceTimersByTimeAsync(100);
    expect((await settleWithin(game)).value).toMatchObject({ code: 'client_timeout', operation: 'get_game', timeoutMs: 100 });
    expect((await settleWithin(list, 5)).done).toBe(false);
    await vi.advanceTimersByTimeAsync(4_900);
    expect((await settleWithin(list)).value).toMatchObject({ code: 'client_timeout', operation: 'list_games', timeoutMs: 5_000 });
  });

  it('таймаут покрывает и чтение тела ответа', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Заголовки пришли сразу, тело не приходит никогда и на signal не реагирует.
    const f = fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch, timeoutMs: { get_game: 50, render: 50 } });
    const game = capture(client.getGame('g1'));
    const ascii = capture(client.ascii('g1'));
    await vi.advanceTimersByTimeAsync(50);
    expect((await settleWithin(game)).value).toMatchObject({ code: 'client_timeout', operation: 'get_game' });
    expect((await settleWithin(ascii)).value).toMatchObject({ code: 'client_timeout', operation: 'render' });
  });

  it('таймаут покрывает чтение тела ошибки', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 500 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch, timeoutMs: { get_game: 50 } });
    const game = capture(client.getGame('g1'));
    await vi.advanceTimersByTimeAsync(50);
    expect((await settleWithin(game)).value).toMatchObject({ code: 'client_timeout', operation: 'get_game' });
  });

  it('внешний signal: отмена отличима от таймаута и приходит с причиной сигнала', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = hangingFetch();
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    const pending = capture(client.play('g1', { coord: 'D4' }, { signal: ac.signal }));
    await tick();
    const reason = new Error('user left');
    ac.abort(reason);
    const out = await settleWithin(pending);
    expect(out.done).toBe(true);
    expect(out.value).toBe(reason);
    expect(out.value).not.toBeInstanceOf(ClientTimeoutError);
    expect(f.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // И после внешней отмены на внешнем сигнале не остаётся слушателя клиента.
    expect(getEventListeners(ac.signal, 'abort')).toEqual([]);
  });

  it('внешний signal отменяет и чтение тела, которое на signal не реагирует', async () => {
    const f = fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    const pending = capture(client.getGame('g1', { signal: ac.signal }));
    await tick();
    ac.abort();
    const out = await settleWithin(pending);
    expect(out.done).toBe(true);
    expect((out.value as Error).name).toBe('AbortError');
  });

  it('уже отменённый signal: fetch не вызывается', async () => {
    const f = hangingFetch();
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    ac.abort();
    const out = await settleWithin(capture(client.getGame('g1', { signal: ac.signal })));
    expect(out.done).toBe(true);
    expect((out.value as Error).name).toBe('AbortError');
    expect(f.signals).toHaveLength(0);
  });

  it('ответ до дедлайна снимает таймер', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fakeFetch(() => Response.json(state));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    expect((await client.getGame('g1')).id).toBe('g1');
    expect(vi.getTimerCount()).toBe(0);
    const failing = fakeFetch(() => Response.json({ error: { code: 'not_found', message: 'no game' } }, { status: 404 }));
    const clientFailing = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: failing.fetch });
    await expect(clientFailing.getGame('g1')).rejects.toBeInstanceOf(ApiError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('после вызова на сигнале запроса не остаётся слушателя отмены: ни после ответа, ни после ошибки', async () => {
    const f = fakeFetch([() => Response.json(state), () => Response.json({ error: { code: 'not_found', message: 'no game' } }, { status: 404 })]);
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    expect((await client.getGame('g1', { signal: ac.signal })).id).toBe('g1');
    await expect(client.getGame('g1')).rejects.toBeInstanceOf(ApiError);
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) expect(getEventListeners(call.init.signal as AbortSignal, 'abort')).toEqual([]);
  });

  it('долгоживущий внешний сигнал: слушатель снимается после ответа, ошибки и таймаута, AbortSignal.any не используется', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const any = vi.spyOn(AbortSignal, 'any');
    try {
      const f = fakeFetch([
        () => Response.json(state),
        () => Response.json({ error: { code: 'not_found', message: 'no game' } }, { status: 404 }),
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = call.init.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ]);
      const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch, timeoutMs: { get_game: 50 } });
      const session = new AbortController();
      expect((await client.getGame('g1', { signal: session.signal })).id).toBe('g1');
      expect(getEventListeners(session.signal, 'abort')).toEqual([]);
      await expect(client.getGame('g1', { signal: session.signal })).rejects.toBeInstanceOf(ApiError);
      expect(getEventListeners(session.signal, 'abort')).toEqual([]);
      const timed = capture(client.getGame('g1', { signal: session.signal }));
      await tick();
      // Пока вызов идёт, слушатель на внешнем сигнале ровно один.
      expect(getEventListeners(session.signal, 'abort')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(50);
      expect((await settleWithin(timed)).value).toMatchObject({ code: 'client_timeout', operation: 'get_game' });
      expect(getEventListeners(session.signal, 'abort')).toEqual([]);
      // Сигнал запроса отменён таймаутом, внешний — нет.
      expect(f.calls[2]?.init.signal?.aborted).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect(any).not.toHaveBeenCalled();
    } finally {
      any.mockRestore();
    }
  });

  it('отмена внешнего сигнала после вызова не трогает уже завершённый запрос', async () => {
    const f = fakeFetch(() => Response.json(state));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const session = new AbortController();
    expect((await client.getGame('g1', { signal: session.signal })).id).toBe('g1');
    session.abort();
    expect(f.calls[0]?.init.signal?.aborted).toBe(false);
  });

  it('ClientTimeoutError: английское сообщение для разработчика, код client_timeout', () => {
    const err = new ClientTimeoutError('score', 25_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('client timeout: score did not finish in 25000 ms');
    expect(err.code).toBe('client_timeout');
  });
});

// Тело SSE, которое пишет тест: push отправляет байты, cancelled — отменил ли клиент чтение.
function controlledBody() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = {
    cancelled: false,
    push: (s: string) => ctrl?.enqueue(new TextEncoder().encode(s)),
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
      cancel() {
        body.cancelled = true;
      },
    }),
  };
  return body;
}

// Полуоткрытый поток (сон телефона, смена сети, прокси, который не закрыл ответ): пинги сервера раз в 15 с
// перестают приходить, а соединение не рвётся. Сторож простоя превращает это в обрыв сети.
describe('сторож простоя потока событий', () => {
  const event = 'event: engine.thinking\ndata: {"type":"engine.thinking","gameId":"g1","color":"W"}\n\n';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('STREAM_IDLE_MS — 45 с, три пинга сервера', () => {
    expect(STREAM_IDLE_MS).toBe(45_000);
  });

  it('поток с пингами каждые 15 с не рвётся', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const f = fakeFetch(() => sseResponse(body.stream));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const stream = client.events({ sessionId: 's1' });
    const next = capture(stream.next());
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      body.push(': ping\n\n');
      await tick();
    }
    expect(next.done).toBe(false);
    expect(body.cancelled).toBe(false);
    expect(f.calls[0]?.init.signal?.aborted).toBe(false);
    body.push(event);
    expect((await settleWithin(next)).value).toMatchObject({ done: false, value: { type: 'engine.thinking' } });
    await stream.return(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('поток без байтов рвётся через 45 с после последнего байта ошибкой сети', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const f = fakeFetch(() => sseResponse(body.stream));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const stream = client.events({ sessionId: 's1' });
    const first = capture(stream.next());
    body.push(event);
    expect((await settleWithin(first)).value).toMatchObject({ value: { type: 'engine.thinking' } });
    const next = capture(stream.next());
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1);
    expect((await settleWithin(next, 5)).done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await settleWithin(next);
    expect(out.done).toBe(true);
    // Тот же род, что обрыв сети у fetch (TypeError): переподключение web и voice-agent срабатывает без изменений.
    expect(out.value).toBeInstanceOf(TypeError);
    expect(out.value).toBeInstanceOf(StreamIdleError);
    expect(out.value).toMatchObject({ name: 'StreamIdleError', idleMs: STREAM_IDLE_MS });
    // Соединение не висит: сигнал запроса отменён, тело отменено, таймеров не осталось.
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('заголовки не пришли за 45 с — та же ошибка простоя', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = hangingFetch();
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const next = capture(client.events({ gameId: 'g1' }).next());
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1);
    expect((await settleWithin(next, 5)).done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await settleWithin(next)).value).toBeInstanceOf(StreamIdleError);
    expect(f.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('пока вызывающий обрабатывает событие, простой не считается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const f = fakeFetch(() => sseResponse(body.stream));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const stream = client.events({ sessionId: 's1' });
    const first = capture(stream.next());
    body.push(event);
    expect((await settleWithin(first)).value).toMatchObject({ value: { type: 'engine.thinking' } });
    // Долгая реплика воркера: следующий next() зовут через минуту.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    const next = capture(stream.next());
    await vi.advanceTimersByTimeAsync(30_000);
    body.push(event);
    expect((await settleWithin(next)).value).toMatchObject({ done: false, value: { type: 'engine.thinking' } });
    expect(body.cancelled).toBe(false);
    await stream.return(undefined);
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('внешний abort не превращается в ошибку простоя', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = controlledBody();
    const f = fakeFetch(() => sseResponse(body.stream));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const ac = new AbortController();
    const next = capture(client.events({ sessionId: 's1' }, ac.signal).next());
    await vi.advanceTimersByTimeAsync(30_000);
    ac.abort();
    const out = await settleWithin(next);
    expect(out.done).toBe(true);
    expect((out.value as Error).name).toBe('AbortError');
    expect(out.value).not.toBeInstanceOf(StreamIdleError);
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, 'abort')).toEqual([]);
    // Уже отменённый signal: запрос не уходит.
    const again = await client.events({ sessionId: 's1' }, ac.signal).next().catch((e: unknown) => e);
    expect((again as Error).name).toBe('AbortError');
    expect(f.calls).toHaveLength(1);
  });

  it('отмена, пока вызывающий ждёт в теле цикла, затем next(): AbortError без необработанного отказа чтения', async () => {
    // Тело, как у undici: отмена сигнала запроса переводит поток в ошибку, и следующее чтение отклоняется.
    const f = fakeFetch((call) => {
      const signal = call.init.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(event));
          signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
        },
      });
      return sseResponse(stream);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
      const ac = new AbortController();
      const stream = client.events({ sessionId: 's1' }, ac.signal);
      expect((await stream.next()).value).toMatchObject({ type: 'engine.thinking' });
      // Вызывающий ждёт что-то своё, отмена приходит во время ожидания, цикл по signal не выходит и зовёт next().
      ac.abort();
      await tick();
      const out = await stream.next().catch((e: unknown) => e);
      expect((out as Error).name).toBe('AbortError');
      for (let i = 0; i < 5; i++) await tick();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('таймер и слушатель внешнего сигнала снимаются: конец потока, ошибка статуса, ранний выход', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ac = new AbortController();
    const whole = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: fakeFetch(() => sseResponse(event)).fetch });
    const seen = [];
    for await (const ev of whole.events({ sessionId: 's1' }, ac.signal)) seen.push(ev.type);
    expect(seen).toEqual(['engine.thinking']);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, 'abort')).toEqual([]);

    const missing = createClient({
      baseUrl: 'http://api.test',
      appKey: 'k',
      fetch: fakeFetch(() => Response.json({ error: { code: 'not_found', message: 'no session' } }, { status: 404 })).fetch,
    });
    await expect(missing.events({ sessionId: 's1' }, ac.signal).next()).rejects.toBeInstanceOf(ApiError);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, 'abort')).toEqual([]);

    const body = controlledBody();
    const early = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: fakeFetch(() => sseResponse(body.stream)).fetch });
    body.push(event);
    for await (const ev of early.events({ sessionId: 's1' }, ac.signal)) {
      expect(ev.type).toBe('engine.thinking');
      break;
    }
    expect(body.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ac.signal, 'abort')).toEqual([]);
  });
});
