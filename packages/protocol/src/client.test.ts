import { describe, expect, it } from 'vitest';
import { ApiError, HttpError, createClient } from './index.ts';
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
      const body = `event: state.updated\ndata: ${JSON.stringify({ type: 'state.updated', state, cause: 'sync', by: 'system' })}\n\nevent: engine.thinking\ndata: {"type":"engine.thinking","color":"W"}\n\n`;
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
const analysis = { visits: 1, winrateB: 0.5, scoreLeadB: 0, topMoves: [], ownership: [], groups: [] };
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

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('events', () => {
  const oneEvent = 'event: engine.thinking\ndata: {"type":"engine.thinking","color":"W"}\n\n';

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
    expect(call?.init.signal).toBe(ac.signal);
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
