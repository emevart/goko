import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomAgentDispatch, TokenVerifier } from 'livekit-server-sdk';
import { type ApiError, GameSettings, createClient, humanText, parseSseStream } from '@goko/protocol';
import { fakeFetch } from '@goko/protocol/testing';
import { EventEmitter, getEventListeners } from 'node:events';
import { serve } from '@hono/node-server';
import { type AppDeps, InFlight, SSE_QUEUE_LIMIT, createApp } from './app.ts';
import { type Engine, createEngineClient } from './engine-client.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import type { RoomCreator } from './livekit.ts';
import { GameService } from './service.ts';
import { SessionManager } from './sessions.ts';
import { type GuardedService, closeWithin, guardService, memoryStore, track } from './test-helpers.ts';

const KEY = 'app-secret';
const LK = { url: 'wss://lk.test', apiKey: 'devkey', apiSecret: 'secret-of-at-least-32-characters-long', agentName: 'goko-dev', tokenTtlSeconds: 3600 };
const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const }, settings: { boardSize: 9 as const } };
const HUMAN_ONLY = { black: { controller: 'human' as const }, white: { controller: 'human' as const }, settings: { boardSize: 9 as const } };
const MIN = 60_000;

let opened: GuardedService[] = [];
beforeEach(async () => {
  opened = [];
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { service, startsAfterClose } of opened) {
    await closeWithin(service);
    expect(startsAfterClose(), 'startTask после close').toBe(0);
  }
});

type RoomCall = { name: string; emptyTimeout: number; departureTimeout: number; agents: RoomAgentDispatch[] };

function fakeRooms(fail?: Error): RoomCreator & { calls: RoomCall[] } {
  const calls: RoomCall[] = [];
  return {
    calls,
    createRoom: async (options) => {
      calls.push(options as RoomCall);
      if (fail) throw fail;
      return {};
    },
  };
}

type MakeOptions = {
  script?: string[];
  maxSessions?: number;
  ttlMs?: number;
  now?: () => number;
  heartbeatMs?: number | 'default';
  rooms?: RoomCreator & { calls: RoomCall[] };
  livekit?: Partial<AppDeps['livekit']>;
  closing?: AbortSignal;
  delayMs?: number;
  engine?: Engine;
  inFlight?: InFlight;
  engineKey?: string;
  rateLimits?: AppDeps['rateLimits'];
  trustProxy?: boolean;
  maxGamesPerClient?: number;
  // 'default' — не передавать флаг в createApp: проверка умолчания.
  sessionlessGames?: boolean | 'default';
};

async function make(opts: MakeOptions = {}) {
  const bus = new EventBus();
  const engine = createFakeEngine({ script: opts.script, delayMs: opts.delayMs });
  // Снапшоты в памяти: тесты ждут фоновый коммит по оборотам очереди, а настоящая запись на диск
  // под нагрузкой не укладывается ни в какое их число.
  const store = memoryStore();
  // Лимит на клиента по умолчанию высокий, а партии без сессии включены: прежние тесты создают партии
  // клиентом протокола без адреса сокета (общий ключ unknown) и через POST /api/games. Новые тесты задают оба явно.
  const service = new GameService({ store, engine: opts.engine ?? engine, bus, replyTimeoutMs: 500, maxGamesPerClient: opts.maxGamesPerClient ?? 1000 });
  opened.push(guardService(service));
  await service.init();
  const sessions = new SessionManager({ max: opts.maxSessions ?? 3, ttlMs: opts.ttlMs ?? 60_000, now: opts.now });
  const rooms = opts.rooms ?? fakeRooms();
  const logs: string[] = [];
  // heartbeat крупный: при 20 мс пинг SSE успевает раньше события и тест ловит ': ping'.
  const app = createApp({
    service,
    sessions,
    bus,
    appKey: KEY,
    livekit: { ...LK, ...opts.livekit },
    rooms,
    heartbeatMs: opts.heartbeatMs === 'default' ? undefined : (opts.heartbeatMs ?? 5_000),
    closing: opts.closing,
    inFlight: opts.inFlight,
    engineKey: opts.engineKey,
    rateLimits: opts.rateLimits,
    trustProxy: opts.trustProxy,
    sessionlessGames: opts.sessionlessGames === 'default' ? undefined : (opts.sessionlessGames ?? true),
    log: (line) => logs.push(line),
  });
  // Клиент протокола поверх app.request: без сети.
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input).replace('http://app.test', ''), init)) as unknown as typeof fetch;
  const client = createClient({ baseUrl: 'http://app.test', appKey: KEY, fetch: fetchFn });
  return { app, service, bus, client, sessions, rooms, logs, engine, store };
}

const decoder = new TextDecoder();

// Читает поток, пока накопленный текст не удовлетворит условию. Ожидание привязано к событию
// (приходу чанка), число чтений ограничено; конец потока — ошибка теста, а не зависание.
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pred: (text: string) => boolean, maxReads = 100): Promise<string> {
  let text = '';
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`поток закрылся раньше времени: ${text}`);
    text += decoder.decode(value);
    if (pred(text)) return text;
  }
  throw new Error(`условие не выполнилось за ${maxReads} чтений: ${text}`);
}

// Прокрутка очереди событий без часов, с потолком оборотов.
const untilTick = async (cond: () => boolean, turns = 1000): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('условие не выполнилось за отведённые обороты очереди');
};

// Ровно n оборотов очереди событий без условия: дать циклу потока дойти до застрявшей записи.
const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type CaughtError = { code: string; status: number; message: string; details?: Record<string, unknown> };

// Ошибка отклонённого промиса; успех — ошибка теста.
async function errorOf(promise: Promise<unknown>): Promise<CaughtError> {
  return promise.then(
    () => {
      throw new Error('ожидался отказ');
    },
    (e: unknown) => e as CaughtError,
  );
}

function streamOf(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('у ответа нет тела');
  return res.body.getReader();
}

describe('createApp: маршруты брифа', () => {
  it('без X-App-Key — 401 unauthorized; /health открыт', async () => {
    const { app } = await make();
    const res = await app.request('/api/games');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, games: 0, sessions: 0 });
  });

  it('создание сессии (D-0001, D-0011): комнату с агентом создаёт сервер, токен — roomJoin и право на свои атрибуты; session.game в потоке', async () => {
    const { client, app, rooms } = await make({ script: ['E5'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    const { session, livekit } = await client.createSession();
    expect(livekit.url).toBe(LK.url);
    // Часы заморожены и на проверке: иначе токен на час мог бы истечь по настоящим часам машины.
    const claims = await new TokenVerifier(LK.apiKey, LK.apiSecret).verify(livekit.token);
    vi.useRealTimers();
    expect(claims.video).toEqual({ room: session.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
    expect(claims.roomConfig).toBeUndefined();
    expect(claims.sub).toBe(`phone-${session.id}`);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(LK.tokenTtlSeconds);

    expect(rooms.calls).toHaveLength(1);
    expect(rooms.calls[0]?.name).toBe(session.room);
    expect(rooms.calls[0]?.emptyTimeout).toBe(300);
    expect(rooms.calls[0]?.departureTimeout).toBe(900);
    expect(rooms.calls[0]?.agents).toHaveLength(1);
    expect(rooms.calls[0]?.agents[0]?.agentName).toBe(LK.agentName);
    expect(JSON.parse(rooms.calls[0]?.agents[0]?.metadata ?? '')).toEqual({ sessionId: session.id });

    const created = await client.newGame(session.id, HUMAN_BLACK);
    expect(created.state.status).toBe('playing');

    // Поток сессии: первым session.game, затем state.updated cause sync.
    const ac = new AbortController();
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (!res.body) throw new Error('нет тела');
    const got: Array<{ type: string; gameId?: string; cause?: string; state?: { id: string } }> = [];
    for await (const data of parseSseStream(res.body)) {
      got.push(JSON.parse(data));
      if (got.length === 2) break;
    }
    ac.abort();
    expect(got.map((e) => e.type)).toEqual(['session.game', 'state.updated']);
    expect(got[0]?.gameId).toBe(created.state.id);
    expect(got[1]).toMatchObject({ cause: 'sync', state: { id: created.state.id } });
  });

  it('play по HTTP возвращает ход и ответ; ошибки протокола со статусами', async () => {
    const { client } = await make({ script: ['E5'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const res = await client.play(state.id, { coord: 'd4', via: 'tap' });
    expect(res.move.coord).toBe('D4');
    expect(res.reply?.coord).toBe('E5');
    // details доходят до клиента целиком: по ним агент объясняет отказ одной фразой.
    const illegal = await errorOf(client.play(state.id, { coord: 'E5' }));
    expect(illegal).toMatchObject({ code: 'illegal_move', status: 400 });
    expect(illegal.details).toEqual({ reason: 'occupied', coord: 'E5' });
    await expect(client.play(state.id, { coord: 'I5' })).rejects.toMatchObject({ code: 'invalid_coord', status: 400 });
    const conflict = await errorOf(client.play(state.id, { coord: 'C3', expectedRevision: 0 }));
    expect(conflict).toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(conflict.details).toEqual({ revision: 2 });
    await expect(client.getGame('nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(client.setRank(state.id, { color: 'W', rank: '99k' as never })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    const state2 = await client.getGame(state.id);
    expect(state2.moves).toHaveLength(2);
    expect((await client.listGames()).games[0]?.moveCount).toBe(2);
    expect((await client.setRank(state.id, { color: 'W', rank: '5k' })).state.seats.W.rank).toBe('5k');
  });

  it('лимит сессий — 429 limit_reached', async () => {
    const { client } = await make({ maxSessions: 1 });
    await client.createSession();
    const err = await errorOf(client.createSession());
    expect(err).toMatchObject({ code: 'limit_reached', status: 429 });
    expect(err.details).toEqual({ max: 1 });
  });

  it('поток партии: sync первым, затем события; при обрыве подписка снимается', async () => {
    const { app, client, bus, service } = await make({ script: ['E5'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const ac = new AbortController();
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = streamOf(res);
    const first = await readUntil(reader, (t) => t.includes('\n\n'));
    expect(first).toContain('event: state.updated');
    expect(JSON.parse(first.split('data: ')[1]?.trim() ?? '')).toMatchObject({ type: 'state.updated', cause: 'sync', by: 'system' });
    expect(bus.count(`game:${state.id}`)).toBe(1);

    await service.play(state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    const chunk = await readUntil(reader, (t) => t.includes('"cause":"play"'));
    expect(chunk).toContain('event: state.updated');

    ac.abort();
    await reader.cancel().catch(() => {});
    await untilTick(() => bus.count(`game:${state.id}`) === 0);
    expect(bus.count(`game:${state.id}`)).toBe(0);
  });

  it('undo, correct, pass, resign, analyze, score, ascii, sgf по маршрутам', async () => {
    const { client } = await make({ script: ['E5', 'F6', 'pass'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const id = state.id;
    await client.play(id, { coord: 'D4' });
    expect((await client.undo(id)).removed).toHaveLength(2);
    expect((await client.redo(id)).restored.map((m) => m.coord)).toEqual(['D4', 'E5']);
    await expect(client.redo(id)).rejects.toMatchObject({ code: 'nothing_to_redo', status: 409 });
    await client.undo(id);
    await client.play(id, { coord: 'C3' });
    expect((await client.correct(id, { coord: 'C4' })).reply?.coord).toBe('pass');
    expect((await client.analyze(id)).groups.length).toBeGreaterThan(0);
    expect((await client.score(id)).reason).toBe('score');
    // correct откатил C3 и F6 и поставил C4: в партии ровно C4 и ответ движка, а не четыре хода.
    expect((await client.getGame(id)).moves.map((m) => m.coord)).toEqual(['C4', 'pass']);
    expect(await client.ascii(id)).toContain('toPlay B');
    expect(await client.sgf(id)).toContain('SZ[9]');
    // Сдача за цвет Гоко — 400 bad_request с причиной not_your_seat; клиент поднимает details, humanText объясняет.
    const foreign = await client.resign(id, { color: 'W', via: 'voice' }).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ code: 'bad_request', status: 400, details: { reason: 'not_your_seat' } });
    expect(humanText((foreign as ApiError).code, (foreign as ApiError).details)).toBe('это не твой цвет');
    expect((await client.resign(id, { color: 'B', via: 'voice' })).state.result).toMatchObject({ winner: 'W', reason: 'resign' });
    await expect(client.pass(id)).rejects.toMatchObject({ code: 'game_finished', status: 409 });
  });
});

describe('createApp: X-App-Key, тела и ошибки', () => {
  it('/health считает партии и живые сессии', async () => {
    const { app, client } = await make();
    await client.createGame(HUMAN_ONLY);
    await client.createSession();
    expect(await (await app.request('/health')).json()).toEqual({ ok: true, games: 1, sessions: 1 });
  });

  it('неверный ключ любой длины — 401; ключ не попадает в ответ; пустой appKey не принимается', async () => {
    const { app, service } = await make();
    for (const header of ['app-secreT', 'app-secret-longer', 'a', '']) {
      const res = await app.request('/api/games', { headers: { 'x-app-key': header } });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text)).toEqual({ error: { code: 'unauthorized', message: 'missing or invalid X-App-Key' } });
    }
    expect((await app.request('/api/games', { headers: { 'x-app-key': KEY } })).status).toBe(200);
    const sessions = new SessionManager({ max: 1, ttlMs: 1000 });
    expect(() => createApp({ service, sessions, bus: new EventBus(), appKey: '', livekit: LK, rooms: fakeRooms() })).toThrow('createApp: empty appKey');
  });

  it('без ключа закрыты все маршруты /api, включая неизвестные и потоки', async () => {
    const { app } = await make();
    for (const [method, url] of [
      ['POST', '/api/sessions'],
      ['GET', '/api/sessions/x/events'],
      ['POST', '/api/games'],
      ['GET', '/api/nope'],
    ] as const) {
      expect((await app.request(url, { method })).status).toBe(401);
    }
  });

  it('пустое тело — {} со значениями по умолчанию; битый JSON — bad_request, а не молчаливый {}', async () => {
    const { app, client } = await make();
    const { state } = await client.createGame(HUMAN_ONLY);
    const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };
    const empty = await app.request(`/api/games/${state.id}/pass`, { method: 'POST', headers });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { move: { coord: string } }).move.coord).toBe('pass');
    const spaces = await app.request(`/api/games/${state.id}/undo`, { method: 'POST', headers, body: ' \n ' });
    expect(spaces.status).toBe(200);

    const broken = await app.request(`/api/games/${state.id}/play`, { method: 'POST', headers, body: '{"coord": "D4"' });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: unknown }).error).toMatchObject({ code: 'bad_request', message: 'request body is not JSON' });
    expect((await client.getGame(state.id)).moves).toHaveLength(0);
  });

  it('тело не по схеме — bad_request с issues; неизвестный маршрут — not_found', async () => {
    const { app } = await make();
    const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };
    const res = await app.request('/api/games', { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'robot' } }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; details: { issues: unknown[] } } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('request body does not match the schema');
    expect(body.error.details.issues.length).toBeGreaterThan(0);

    const missing = await app.request('/api/nope', { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'no route GET /api/nope' } });
  });

  it('непредвиденная ошибка — 500 internal без подробностей наружу, подробности в лог', async () => {
    const { app, service, logs } = await make();
    vi.spyOn(service, 'list').mockImplementation(() => {
      throw new Error('disk exploded at /secret/path');
    });
    const res = await app.request('/api/games', { headers: { 'x-app-key': KEY } });
    expect(res.status).toBe(500);
    // Тело сверяется целиком: ни стека, ни пути, ни details.
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal server error' } });
    expect(logs.some((l) => l.startsWith('[X] game-server:') && l.includes('disk exploded'))).toBe(true);
  });

  it('message ошибок по-английски на всех путях приложения и сервиса', async () => {
    const { app, client, service } = await make({ script: ['E5'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    await client.play(state.id, { coord: 'D4' });
    const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };
    const failures = [
      errorOf(client.play(state.id, { coord: 'E5' })),
      errorOf(client.play(state.id, { coord: 'I5' })),
      errorOf(client.play(state.id, { coord: 'C3', expectedRevision: 0 })),
      errorOf(client.getGame('nope')),
      errorOf(client.newGame('nope', HUMAN_ONLY)),
      errorOf(client.createGame({ black: { controller: 'external' }, white: { controller: 'human' } } as never)),
    ];
    const bodies = [
      await (await app.request('/api/games', { headers: { 'x-app-key': 'wrong' } })).json(),
      await (await app.request(`/api/games/${state.id}/play`, { method: 'POST', headers, body: '{' })).json(),
      await (await app.request('/api/games', { method: 'POST', headers, body: '{"black":1}' })).json(),
      await (await app.request('/api/nope', { headers })).json(),
    ] as Array<{ error: { message: string } }>;
    const messages = [...(await Promise.all(failures)).map((e) => e.message), ...bodies.map((b) => b.error.message)];
    expect(messages).toHaveLength(10);
    for (const message of messages) expect(message).toMatch(/^[ -~]+$/);
    await closeWithin(service);
  });

  it('ascii — text/plain, sgf — application/x-go-sgf', async () => {
    const { app, client } = await make();
    const { state } = await client.createGame(HUMAN_ONLY);
    const ascii = await app.request(`/api/games/${state.id}/ascii`, { headers: { 'x-app-key': KEY } });
    expect(ascii.headers.get('content-type')).toContain('text/plain');
    const sgf = await app.request(`/api/games/${state.id}/sgf`, { headers: { 'x-app-key': KEY } });
    expect(sgf.status).toBe(200);
    expect(sgf.headers.get('content-type')).toBe('application/x-go-sgf; charset=utf-8');
    expect(await sgf.text()).toContain('SZ[9]');
  });
});

describe('createApp: сессии и LiveKit', () => {
  it('отказ createRoom — 500 internal без секретов, место в лимите свободно', async () => {
    // SDK секреты в сообщение не кладёт, но строка лога не должна на это полагаться.
    const rooms = fakeRooms(new Error(`twirp: unauthenticated key=${LK.apiKey} secret=${LK.apiSecret} app=${KEY}`));
    const { client, sessions, logs } = await make({ maxSessions: 1, rooms });
    const err = await errorOf(client.createSession());
    expect(err).toMatchObject({ code: 'internal', status: 500, message: 'could not prepare the LiveKit room for the session' });
    expect(JSON.stringify(err)).not.toContain(LK.apiSecret);
    expect(rooms.calls).toHaveLength(1);
    expect(sessions.list()).toEqual([]);
    const line = logs.find((l) => l.startsWith('[X] game-server: сессия'));
    expect(line).toMatch(/не создана: twirp: unauthenticated key=\[скрыто\] secret=\[скрыто\] app=\[скрыто\]$/);
    for (const secret of [LK.apiKey, LK.apiSecret, KEY]) expect(logs.join('\n')).not.toContain(secret);
    // Место не утекло: при лимите 1 следующая сессия создаётся, как только LiveKit ответил.
    rooms.createRoom = async (options) => {
      rooms.calls.push(options as RoomCall);
      return {};
    };
    const ok = await client.createSession();
    expect(sessions.list().map((s) => s.id)).toEqual([ok.session.id]);
  });

  it('отказ mintToken — 500 internal, createRoom не вызывался, место свободно', async () => {
    const rooms = fakeRooms();
    const { client, sessions } = await make({ maxSessions: 1, rooms, livekit: { tokenTtlSeconds: 0 } });
    await expect(client.createSession()).rejects.toMatchObject({ code: 'internal', status: 500 });
    expect(rooms.calls).toHaveLength(0);
    expect(sessions.list()).toEqual([]);
  });

  it('лог отказа: ключ внутри секрета не оставляет куски секрета, пустой ключ не портит текст', async () => {
    // apiKey — подстрока apiSecret: если заменить его первым, в логе останутся части секрета.
    const overlapping = await make({ rooms: fakeRooms(new Error(`denied ${LK.apiSecret}`)), livekit: { apiKey: 'at-least' } });
    await expect(overlapping.client.createSession()).rejects.toMatchObject({ code: 'internal' });
    expect(overlapping.logs.find((l) => l.startsWith('[X] game-server: сессия'))).toMatch(/не создана: denied \[скрыто\]$/);
    // Пустой apiKey (createApp без проверки конфигурации): текст исключения доходит как есть.
    const empty = await make({ livekit: { apiKey: '' } });
    await expect(empty.client.createSession()).rejects.toMatchObject({ code: 'internal' });
    expect(empty.logs.find((l) => l.startsWith('[X] game-server: сессия'))).toMatch(/не создана: mintToken: empty apiKey$/);
  });

  it('новая партия в неизвестной сессии — not_found; поток неизвестной сессии и партии — not_found', async () => {
    const { client, app } = await make();
    await expect(client.newGame('nope', HUMAN_ONLY)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect((await app.request('/api/sessions/nope/events', { headers: { 'x-app-key': KEY } })).status).toBe(404);
    expect((await app.request('/api/games/nope/events', { headers: { 'x-app-key': KEY } })).status).toBe(404);
    expect((await client.listGames()).games).toEqual([]);
  });

  it('новая партия в сессии переключает currentGameId; поток сессии без партии ничего не шлёт первым', async () => {
    const { client, sessions, app, bus } = await make({ script: ['E5'] });
    const { session } = await client.createSession();
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    const reader = streamOf(res);
    // Подписки канала сессии: наблюдатель срока в приложении и сам поток.
    await untilTick(() => bus.count(`session:${session.id}`) === 2);
    const created = await client.newGame(session.id, HUMAN_BLACK);
    expect(sessions.get(session.id).currentGameId).toBe(created.state.id);
    const text = await readUntil(reader, (t) => t.includes('"cause":"new"'));
    expect(text.indexOf('event: session.game')).toBe(0);
    await reader.cancel();
  });

  it('поток сессии, открытый пока пишется снапшот новой партии: 200 и старая партия, после записи — новая', async () => {
    const { client, app, sessions, store } = await make();
    const { session } = await client.createSession();
    const old = await client.newGame(session.id, HUMAN_ONLY);
    const save = store.save.bind(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    vi.spyOn(store, 'save').mockImplementationOnce(async (state) => {
      held = true;
      await gate;
      return save(state);
    });
    const pending = client.newGame(session.id, HUMAN_ONLY);
    await untilTick(() => held);
    expect(sessions.get(session.id).currentGameId).toBe(old.state.id);
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    expect(res.status).toBe(200);
    const reader = streamOf(res);
    const first = await readUntil(reader, (t) => t.includes('\n\n'));
    expect(first).toContain('event: session.game');
    expect(first).toContain(`"gameId":"${old.state.id}"`);
    release();
    const created = await pending;
    const text = await readUntil(reader, (t) => t.includes(`"type":"session.game","gameId":"${created.state.id}"`));
    expect(text).toContain(created.state.id);
    expect(sessions.get(session.id).currentGameId).toBe(created.state.id);
    await reader.cancel();
  });

  it('отказ записи снапшота новой партии: POST 500, currentGameId прежний, поток сессии 200 со старой партией', async () => {
    const { client, app, sessions, store } = await make();
    const { session } = await client.createSession();
    const old = await client.newGame(session.id, HUMAN_ONLY);
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));
    const err = await errorOf(client.newGame(session.id, HUMAN_ONLY));
    expect(err).toMatchObject({ code: 'internal', status: 500 });
    expect(sessions.get(session.id).currentGameId).toBe(old.state.id);
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    expect(res.status).toBe(200);
    const reader = streamOf(res);
    const text = await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    expect(text.indexOf('event: session.game')).toBe(0);
    expect(text).toContain(`"gameId":"${old.state.id}"`);
    await reader.cancel();
  });

  it('currentGameId переключается по событию session.game: поток, открытый пока движок думает, шлёт новую партию', async () => {
    const { client, app, service, sessions, engine } = await make({ script: ['E5'], delayMs: 100 });
    const { session } = await client.createSession();
    const old = await client.newGame(session.id, HUMAN_ONLY);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Человек белыми: первым ходит движок, ответ POST ждёт его хода.
    const pending = client.newGame(session.id, { ...HUMAN_BLACK, black: { controller: 'engine', rank: '10k' }, white: { controller: 'human' } });
    await untilTick(() => service.list().length === 2);
    const fresh = service.list().find((g) => g.id !== old.state.id);
    if (!fresh) throw new Error('новой партии нет');
    expect(sessions.get(session.id).currentGameId).toBe(fresh.id);
    const reader = streamOf(await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } }));
    const first = await readUntil(reader, (t) => t.includes('\n\n'));
    expect(first).toContain(`"gameId":"${fresh.id}"`);
    await reader.cancel();
    await untilTick(() => engine.calls.genmove === 1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).firstMove?.coord).toBe('E5');
    expect(sessions.get(session.id).currentGameId).toBe(fresh.id);
  });

  it('две партии в сессии параллельно: currentGameId — последняя объявленная, а не последняя дождавшаяся', async () => {
    const { client, sessions, bus, engine } = await make({ script: ['E5'], delayMs: 100 });
    const { session } = await client.createSession();
    const announced: string[] = [];
    bus.subscribe(`session:${session.id}`, (e) => {
      if (e.type === 'session.game') announced.push(e.gameId);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = client.newGame(session.id, { ...HUMAN_BLACK, black: { controller: 'engine', rank: '10k' }, white: { controller: 'human' } });
    await untilTick(() => announced.length === 1);
    const quick = await client.newGame(session.id, HUMAN_ONLY);
    await untilTick(() => engine.calls.genmove === 1);
    await vi.advanceTimersByTimeAsync(100);
    const slowRes = await slow;
    expect(announced).toEqual([slowRes.state.id, quick.state.id]);
    expect(sessions.get(session.id).currentGameId).toBe(quick.state.id);
  });

  it('сессия истекла, пока движок думал над первым ходом: партия создана, ответ 200', async () => {
    let t = 0;
    const { client, sessions, engine } = await make({ script: ['E5'], delayMs: 100, ttlMs: MIN, now: () => t });
    const { session } = await client.createSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = client.newGame(session.id, { ...HUMAN_BLACK, black: { controller: 'engine', rank: '10k' }, white: { controller: 'human' } });
    await untilTick(() => engine.calls.genmove === 1);
    expect(sessions.get(session.id).currentGameId).not.toBeNull();
    t = 2 * MIN;
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).firstMove?.coord).toBe('E5');
  });

  it('операции сессии продлевают её срок: новая партия (даже с битым телом) и открытие потока', async () => {
    let t = 0;
    const { client, sessions, app } = await make({ ttlMs: 60 * MIN, now: () => t });
    const { session } = await client.createSession();
    t = 50 * MIN;
    await expect(client.newGame(session.id, { black: { controller: 'robot' } } as never)).rejects.toMatchObject({ code: 'bad_request' });
    t = 100 * MIN;
    expect(sessions.get(session.id).id).toBe(session.id);
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    await res.body?.cancel();
    t = 150 * MIN;
    expect(sessions.get(session.id).id).toBe(session.id);
    t = 211 * MIN; // без операций срок истекает
    expect(() => sessions.get(session.id)).toThrow();
  });

  it('два часа ходов по /api/games без обращений к /api/sessions — сессия жива; без событий истекает', async () => {
    let t = 0;
    const { client, sessions, bus } = await make({ script: ['E5', 'F6', 'G7', 'H8'], ttlMs: 60 * MIN, now: () => t });
    const { session } = await client.createSession();
    const { state } = await client.newGame(session.id, HUMAN_BLACK);
    for (const coord of ['D4', 'C3', 'B2', 'A1']) {
      t += 40 * MIN;
      await client.play(state.id, { coord });
    }
    expect(t).toBe(160 * MIN);
    expect(sessions.get(session.id).currentGameId).toBe(state.id);
    t += 61 * MIN;
    expect(() => sessions.get(session.id)).toThrow();
    // Наблюдатель истёкшей сессии снимается: события её партии больше не держат подписку.
    await client.play(state.id, { coord: 'J9' });
    expect(bus.count(`session:${session.id}`)).toBe(0);
  });

  it('наблюдатели истёкших сессий снимаются при создании новой сессии', async () => {
    let t = 0;
    const { client, bus } = await make({ ttlMs: MIN, now: () => t });
    const a = await client.createSession();
    expect(bus.count(`session:${a.session.id}`)).toBe(1);
    t = 2 * MIN;
    const b = await client.createSession();
    expect(bus.count(`session:${a.session.id}`)).toBe(0);
    expect(bus.count(`session:${b.session.id}`)).toBe(1);
  });

  it('события чужой сессии срок не продлевают', async () => {
    let t = 0;
    const { client, sessions } = await make({ script: ['E5'], ttlMs: 60 * MIN, now: () => t });
    const a = await client.createSession();
    const b = await client.createSession();
    const { state } = await client.newGame(b.session.id, HUMAN_BLACK);
    t = 40 * MIN;
    await client.play(state.id, { coord: 'D4' });
    t = 70 * MIN;
    expect(() => sessions.get(a.session.id)).toThrow();
    expect(sessions.get(b.session.id).id).toBe(b.session.id);
  });
});

describe('createApp: SSE, heartbeat и остановка', () => {
  it('heartbeat: пинг по таймеру, таймеры не копятся при потоке событий', async () => {
    const { app, client, bus } = await make({ heartbeatMs: 10_000 });
    const { state } = await client.createGame(HUMAN_ONLY);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    const reader = streamOf(res);
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    for (let i = 0; i < 20; i++) {
      bus.emit(`game:${state.id}`, { type: 'engine.thinking', gameId: state.id, color: i % 2 === 0 ? 'B' : 'W' });
      await readUntil(reader, (t) => t.includes('engine.thinking'));
    }
    await untilTick(() => vi.getTimerCount() === 1, 50);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    bus.emit(`game:${state.id}`, { type: 'engine.thinking', gameId: state.id, color: 'B' });
    const beforePing = await readUntil(reader, (t) => t.includes('engine.thinking'));
    expect(beforePing).not.toContain(': ping');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await readUntil(reader, (t) => t.includes(': ping'))).toBe(': ping\n\n');
    await reader.cancel();
    await untilTick(() => bus.count(`game:${state.id}`) === 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('открытый поток сессии держит её живой пингами; после закрытия потока срок истекает', async () => {
    let t = 0;
    const { app, client, sessions } = await make({ heartbeatMs: 20_000, ttlMs: 60_000, now: () => t });
    const { session } = await client.createSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    const reader = streamOf(res);
    for (let i = 0; i < 6; i++) {
      t += 20_000;
      await vi.advanceTimersByTimeAsync(20_000);
      await readUntil(reader, (text) => text.includes(': ping'));
    }
    expect(t).toBe(120_000);
    expect(sessions.get(session.id).id).toBe(session.id);
    // Закрытие потока между пингами срок не продлевает: последний пинг был на 120 с.
    t += 10_000;
    await reader.cancel();
    t = 120_000 + 60_001;
    expect(() => sessions.get(session.id)).toThrow();
  });

  it('сигнал остановки закрывает открытые потоки и снимает подписки; новые потоки сразу закрыты', async () => {
    const closing = new AbortController();
    const { app, client, bus } = await make({ closing: closing.signal });
    const { state } = await client.createGame(HUMAN_ONLY);
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    const reader = streamOf(res);
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    expect(bus.count(`game:${state.id}`)).toBe(1);
    closing.abort();
    expect((await reader.read()).done).toBe(true);
    expect(bus.count(`game:${state.id}`)).toBe(0);

    const late = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    expect(await late.text()).toBe('');
    expect(bus.count(`game:${state.id}`)).toBe(0);
  });

  it('heartbeat по умолчанию — 15 с', async () => {
    const { app, client } = await make({ heartbeatMs: 'default' });
    const { state } = await client.createGame(HUMAN_ONLY);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = streamOf(await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } }));
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    await untilTick(() => vi.getTimerCount() === 1);
    let pinged = false;
    const next = reader.read().then(() => {
      pinged = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(pinged).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(pinged).toBe(true);
    await reader.cancel();
  });

  it('закрытый поток снимает свой слушатель с сигнала остановки', async () => {
    const closing = new AbortController();
    const { app, client, bus } = await make({ closing: closing.signal });
    const { state } = await client.createGame(HUMAN_ONLY);
    const reader = streamOf(await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } }));
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(1);
    await reader.cancel();
    await untilTick(() => getEventListeners(closing.signal, 'abort').length === 0);
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(0);
    expect(bus.count(`game:${state.id}`)).toBe(0);
  });

  it('обрыв по сигналу запроса без чтения тела тоже снимает подписку', async () => {
    const { app, client, bus } = await make();
    const { state } = await client.createGame(HUMAN_ONLY);
    const ac = new AbortController();
    await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY }, signal: ac.signal });
    expect(bus.count(`game:${state.id}`)).toBe(1);
    ac.abort();
    await untilTick(() => bus.count(`game:${state.id}`) === 0);
    expect(bus.count(`game:${state.id}`)).toBe(0);
  });
});

describe('createApp: пакет 12b — пределы, сессии, серия повторов', () => {
  it('открытие потока партии и потока сессии перезапускает исчерпанную серию повторов (service.resume)', async () => {
    const { app, client, service } = await make();
    const resume = vi.spyOn(service, 'resume');
    const { session } = await client.createSession();
    const bare = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    await bare.body?.cancel();
    // Поток сессии без партии: перезапускать нечего.
    expect(resume).not.toHaveBeenCalled();
    const { state } = await client.newGame(session.id, HUMAN_ONLY);
    const game = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    await game.body?.cancel();
    expect(resume.mock.calls).toEqual([[state.id]]);
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } });
    await res.body?.cancel();
    expect(resume.mock.calls).toEqual([[state.id], [state.id]]);
    // Поток незнакомой партии — 404, и resume не зовётся.
    expect((await app.request('/api/games/nope/events', { headers: { 'x-app-key': KEY } })).status).toBe(404);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('поток сессии закрывается на пинге, когда сессия уже истекла; подписка снимается', async () => {
    let t = 0;
    const { app, client, sessions, bus } = await make({ heartbeatMs: 20_000, ttlMs: 60_000, now: () => t });
    const { session } = await client.createSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = streamOf(await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } }));
    t = 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    await readUntil(reader, (text) => text.includes(': ping'));
    // Сессию сносит sweep (например, лимит времени без пингов при заснувшем процессе).
    t = 20_000 + 60_001;
    expect(sessions.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    const { done, value } = await reader.read();
    expect({ done, text: value ? decoder.decode(value) : '' }).toEqual({ done: true, text: '' });
    // Остаётся наблюдатель срока: он снимается сам на первом событии канала.
    await untilTick(() => bus.count(`session:${session.id}`) === 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('поток сессии закрывается на событии, пришедшем после истечения сессии, и не пишет его', async () => {
    let t = 0;
    const { app, client, bus } = await make({ heartbeatMs: 20_000, ttlMs: 60_000, now: () => t });
    const { session } = await client.createSession();
    const reader = streamOf(await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } }));
    await untilTick(() => bus.count(`session:${session.id}`) === 2);
    t = 60_001;
    bus.emit(`session:${session.id}`, { type: 'engine.thinking', gameId: 'g1', color: 'B' });
    const { done, value } = await reader.read();
    expect({ done, text: value ? decoder.decode(value) : '' }).toEqual({ done: true, text: '' });
    await untilTick(() => bus.count(`session:${session.id}`) === 0);
  });

  it('живая сессия: поток на пинге не закрывается', async () => {
    let t = 0;
    const { app, client } = await make({ heartbeatMs: 20_000, ttlMs: 60_000, now: () => t });
    const { session } = await client.createSession();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = streamOf(await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY } }));
    // Ровно на границе срока сессия ещё жива (истекает строго позже ttl).
    t = 59_999;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await readUntil(reader, (text) => text.includes(': ping'))).toBe(': ping\n\n');
    await reader.cancel();
  });

  it('тело больше 64 КБ — bad_request с пределом в details, с content-length и без него; до разбора не доходит', async () => {
    const { app, service } = await make();
    const create = vi.spyOn(service, 'create');
    const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };
    const big = JSON.stringify({ ...HUMAN_ONLY, pad: 'x'.repeat(64 * 1024) });
    for (const extra of [{}, { 'content-length': String(Buffer.byteLength(big)) }] as Record<string, string>[]) {
      const res = await app.request('/api/games', { method: 'POST', headers: { ...headers, ...extra }, body: big });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'bad_request', message: 'request body is too large', details: { maxBytes: 65_536 } } });
    }
    expect(create).not.toHaveBeenCalled();
    // Ровно 64 КБ проходит к разбору тела.
    const exact = JSON.stringify(HUMAN_ONLY);
    const padded = exact + ' '.repeat(65_536 - Buffer.byteLength(exact));
    expect(Buffer.byteLength(padded)).toBe(65_536);
    const ok = await app.request('/api/games', { method: 'POST', headers, body: padded });
    expect(ok.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ZodError не из разбора тела — 500 internal, а не bad_request', async () => {
    const { app, service, logs } = await make();
    // Настоящий отказ schema.parse (ZodError, наследник Error) внутри сервиса, а не в разборе тела.
    vi.spyOn(service, 'list').mockImplementation(() => {
      GameSettings.parse({ boardSize: 7 });
      return [];
    });
    const res = await app.request('/api/games', { headers: { 'x-app-key': KEY } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'internal server error' } });
    expect(logs.some((l) => l.startsWith('[X] game-server:'))).toBe(true);
  });

  it('стек непредвиденной ошибки проходит через redact: секретов нет ни в одной строке лога', async () => {
    const { app, service, logs } = await make();
    vi.spyOn(service, 'list').mockImplementation(() => {
      const e = new Error('boom');
      e.stack = `Error: boom\n    at key ${KEY} secret ${LK.apiSecret} api ${LK.apiKey}`;
      throw e;
    });
    expect((await app.request('/api/games', { headers: { 'x-app-key': KEY } })).status).toBe(500);
    const line = logs.find((l) => l.startsWith('[X] game-server:')) ?? '';
    expect(line).toContain('at key [скрыто] secret [скрыто] api [скрыто]');
    for (const secret of [KEY, LK.apiSecret, LK.apiKey]) expect(line).not.toContain(secret);
  });

  it('ключ движка тоже вырезается из лога; пустой ключ (FAKE_ENGINE) текст не портит', async () => {
    const engineKey = 'engine-key-in-stack';
    const { app, service, logs } = await make({ engineKey });
    vi.spyOn(service, 'list').mockImplementation(() => {
      const e = new Error('boom');
      e.stack = `Error: boom at engine ${engineKey} with prefix ${engineKey}x`;
      throw e;
    });
    expect((await app.request('/api/games', { headers: { 'x-app-key': KEY } })).status).toBe(500);
    const line = logs.find((l) => l.startsWith('[X] game-server:')) ?? '';
    expect(line).toContain('at engine [скрыто] with prefix [скрыто]x');
    expect(line).not.toContain(engineKey);

    const fake = await make({ engineKey: '' });
    vi.spyOn(fake.service, 'list').mockImplementation(() => {
      const e = new Error('boom');
      e.stack = 'Error: boom at plain text';
      throw e;
    });
    expect((await fake.app.request('/api/games', { headers: { 'x-app-key': KEY } })).status).toBe(500);
    expect(fake.logs.find((l) => l.startsWith('[X] game-server:'))).toBe('[X] game-server: Error: boom at plain text');
  });

  it('медленный клиент: очередь потока больше SSE_QUEUE_LIMIT — поток закрывается, подписка снимается', async () => {
    const { app, client, bus } = await make();
    const { state } = await client.createGame(HUMAN_ONLY);
    const reader = streamOf(await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } }));
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    const channel = `game:${state.id}`;
    // Без чтения: очередь растёт синхронно, цикл потока между emit не успевает её разобрать.
    for (let i = 0; i < SSE_QUEUE_LIMIT; i++) bus.emit(channel, { type: 'engine.thinking', gameId: state.id, color: 'B' });
    expect(bus.count(channel)).toBe(1);
    bus.emit(channel, { type: 'engine.thinking', gameId: state.id, color: 'W' });
    expect(bus.count(channel)).toBe(0);
    // Поток доходит до конца, не написав всей очереди.
    let text = '';
    for (let i = 0; i < SSE_QUEUE_LIMIT + 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect((await reader.read()).done).toBe(true);
    expect(text.split('event: engine.thinking').length - 1).toBeLessThan(SSE_QUEUE_LIMIT);
  });

  it('медленный клиент, который не читает вовсе: предел очереди обрывает застрявшую запись, цикл потока выходит', async () => {
    const closing = new AbortController();
    const { app, client, bus } = await make({ closing: closing.signal });
    const { state } = await client.createGame(HUMAN_ONLY);
    const channel = `game:${state.id}`;
    // Тело не читается ни разу: запись в поток стоит на обратном давлении.
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    // Сначала несколько событий, чтобы цикл встал в записи, потом поток сверх предела.
    for (let i = 0; i < 5; i++) bus.emit(channel, { type: 'engine.thinking', gameId: state.id, color: 'B' });
    await turns(20);
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(1);
    for (let i = 0; i <= SSE_QUEUE_LIMIT; i++) bus.emit(channel, { type: 'engine.thinking', gameId: state.id, color: 'B' });
    expect(bus.count(channel)).toBe(0);
    // Цикл потока снимает слушатель сигнала остановки только на выходе: значит, запись не держит его.
    await untilTick(() => getEventListeners(closing.signal, 'abort').length === 0);
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(0);
    await res.body?.cancel();
  });

  it('остановка сервера при клиенте, который не читает: поток закрывается, а не ждёт разгрузки сокета', async () => {
    const closing = new AbortController();
    const { app, client, bus } = await make({ closing: closing.signal });
    const { state } = await client.createGame(HUMAN_ONLY);
    const channel = `game:${state.id}`;
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY } });
    // Несколько событий: запись встаёт на обратном давлении, очередь ниже предела.
    for (let i = 0; i < 5; i++) bus.emit(channel, { type: 'engine.thinking', gameId: state.id, color: 'B' });
    await turns(20);
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(1);
    closing.abort();
    await untilTick(() => getEventListeners(closing.signal, 'abort').length === 0);
    expect(bus.count(channel)).toBe(0);
    await res.body?.cancel();
  });

  it('SSE_QUEUE_LIMIT — 1000', () => {
    expect(SSE_QUEUE_LIMIT).toBe(1000);
  });

  it('сессия, созданная в обход POST /api/sessions, получает наблюдателя на маршрутах сессии, ровно одного', async () => {
    const { app, client, sessions, bus } = await make();
    const session = sessions.create();
    expect(bus.count(`session:${session.id}`)).toBe(0);
    const created = await client.newGame(session.id, HUMAN_ONLY);
    expect(sessions.get(session.id).currentGameId).toBe(created.state.id);
    expect(bus.count(`session:${session.id}`)).toBe(1);
    await client.newGame(session.id, HUMAN_ONLY);
    expect(bus.count(`session:${session.id}`)).toBe(1);
    const other = sessions.create();
    const res = await app.request(`/api/sessions/${other.id}/events`, { headers: { 'x-app-key': KEY } });
    const reader = streamOf(res);
    // Наблюдатель и сам поток.
    await untilTick(() => bus.count(`session:${other.id}`) === 2);
    const next = await client.newGame(other.id, HUMAN_ONLY);
    expect(sessions.get(other.id).currentGameId).toBe(next.state.id);
    await reader.cancel();
    await untilTick(() => bus.count(`session:${other.id}`) === 1);
  });
});

describe('createApp: круг правок 1 пакета 12b', () => {
  it('тело больше предела без ключа — 401: ключ проверяется раньше предела тела', async () => {
    const { app } = await make();
    const big = JSON.stringify({ ...HUMAN_ONLY, pad: 'x'.repeat(64 * 1024) });
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) };
    const res = await app.request('/api/games', { method: 'POST', headers, body: big });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('analyze и score: текст ошибки go-engine не уходит в HTTP-ответ, исходный текст — только в лог', async () => {
    const leak = `KataGo failed: /opt/katago/model.bin.gz at 10.1.2.3 with ${LK.apiSecret}`;
    const logged = 'KataGo failed: /opt/katago/model.bin.gz at 10.1.2.3 with [скрыто]';
    const fetch = fakeFetch([() => Response.json({ error: { code: 'bad_request', message: leak, details: { path: '/opt/katago' } } }, { status: 400 })]).fetch;
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch });
    const { app, client, logs } = await make({ engine });
    const { state } = await client.createGame(HUMAN_ONLY);
    for (const route of ['analyze', 'score']) {
      const res = await app.request(`/api/games/${state.id}/${route}`, { method: 'POST', headers: { 'x-app-key': KEY, 'content-type': 'application/json' }, body: '{}' });
      // bad_request go-engine — дефект нашей стороны: наружу internal, код go-engine только в тексте.
      expect(res.status, route).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text), route).toEqual({ error: { code: 'internal', message: 'engine error: bad_request' } });
      expect(text).not.toContain('/opt');
    }
    // В лог — через redact, как и прочие чужие тексты.
    const lines = logs.filter((l) => l.includes(logged));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.startsWith('[!] game-server:'))).toBe(true);
    expect(logs.some((l) => l.includes(LK.apiSecret))).toBe(false);
    // Обычная ApiError без cause (своя ошибка сервера) в лог не пишется.
    const before = logs.length;
    await expect(client.getGame('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.play(state.id, { coord: 'Z99' })).rejects.toMatchObject({ code: 'invalid_coord' });
    expect(logs.slice(before)).toEqual([]);
  });
});

describe('createApp: счётчик текущих запросов (остановка не рвёт ответы)', () => {
  const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };

  it('InFlight: idle сразу при нуле; ждёт, пока все запросы не вышли; все ожидающие просыпаются', async () => {
    const counter = new InFlight();
    expect(counter.size).toBe(0);
    const empty = track(counter.idle());
    await turns(1);
    expect(empty.settled).toBe(true);
    counter.enter();
    counter.enter();
    expect(counter.size).toBe(2);
    const first = track(counter.idle());
    const second = track(counter.idle());
    counter.leave();
    await turns(2);
    expect([first.settled, second.settled]).toEqual([false, false]);
    counter.leave();
    await turns(2);
    expect([first.settled, second.settled]).toEqual([true, true]);
    expect(counter.size).toBe(0);
    // Разбуженные ожидающие не просыпаются второй раз и не копятся.
    counter.enter();
    const third = track(counter.idle());
    counter.leave();
    await turns(2);
    expect(third.settled).toBe(true);
  });

  it('запрос считается, пока обработчик не ответил: удержанный analyze — 1, после ответа — 0', async () => {
    const inFlight = new InFlight();
    const { app, client, service } = await make({ inFlight });
    const { state } = await client.createGame(HUMAN_ONLY);
    expect(inFlight.size).toBe(0);
    let release: () => void = () => undefined;
    const analyze = service.analyze.bind(service);
    const held = vi.spyOn(service, 'analyze').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return analyze(...args);
    });
    const pending = Promise.resolve(app.request(`/api/games/${state.id}/analyze`, { method: 'POST', headers, body: '{}' }));
    await untilTick(() => held.mock.calls.length === 1);
    expect(inFlight.size).toBe(1);
    const idle = track(inFlight.idle());
    await turns(5);
    expect(idle.settled).toBe(false);
    release();
    expect((await pending).status).toBe(200);
    await untilTick(() => idle.settled);
    expect(inFlight.size).toBe(0);
  });

  it('ответы с ошибкой, 401 и /health тоже выходят из счёта', async () => {
    const inFlight = new InFlight();
    const { app } = await make({ inFlight });
    expect((await app.request('/api/games/nope')).status).toBe(401);
    expect((await app.request('/api/games/nope', { headers })).status).toBe(404);
    expect((await app.request('/api/games', { method: 'POST', headers, body: 'not json' })).status).toBe(400);
    expect((await app.request('/health')).status).toBe(200);
    expect(inFlight.size).toBe(0);
  });

  it('потоки SSE не считаются: открытый поток партии и сессии не держат счётчик', async () => {
    const inFlight = new InFlight();
    const { app, client, sessions } = await make({ inFlight });
    const { state } = await client.createGame(HUMAN_ONLY);
    const game = streamOf(await app.request(`/api/games/${state.id}/events`, { headers }));
    await readUntil(game, (t) => t.includes('"cause":"sync"'));
    const session = sessions.create();
    const sessionStream = await app.request(`/api/sessions/${session.id}/events`, { headers });
    expect(sessionStream.status).toBe(200);
    expect(inFlight.size).toBe(0);
    await game.cancel();
    await sessionStream.body?.cancel();
  });

  it('на сокете Node запрос выходит из счёта по close ответа, а не по возврату обработчика', async () => {
    const inFlight = new InFlight();
    const { app } = await make({ inFlight });
    const outgoing = new EventEmitter();
    const res = await app.fetch(new Request('http://app.test/health'), { outgoing });
    expect(res.status).toBe(200);
    // Ответ ещё не записан в сокет: обрыв соединений сейчас потерял бы его.
    expect(inFlight.size).toBe(1);
    // Ровно один слушатель: служебный слушатель раннего закрытия снят.
    expect(getEventListeners(outgoing, 'close')).toHaveLength(1);
    outgoing.emit('close');
    expect(inFlight.size).toBe(0);
    expect(getEventListeners(outgoing, 'close')).toHaveLength(0);
  });

  it('на сокете Node текстовые ответы (ascii) тоже ждут close: не только JSON', async () => {
    const inFlight = new InFlight();
    const { app, client } = await make({ inFlight });
    const { state } = await client.createGame(HUMAN_ONLY);
    const outgoing = new EventEmitter();
    const res = await app.fetch(new Request(`http://app.test/api/games/${state.id}/ascii`, { headers }), { outgoing });
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(inFlight.size).toBe(1);
    outgoing.emit('close');
    expect(inFlight.size).toBe(0);
  });

  it('на сокете Node: соединение закрылось раньше ответа — запрос всё равно выходит из счёта', async () => {
    const inFlight = new InFlight();
    const { app, client, service } = await make({ inFlight });
    const { state } = await client.createGame(HUMAN_ONLY);
    let release: () => void = () => undefined;
    const analyze = service.analyze.bind(service);
    const held = vi.spyOn(service, 'analyze').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return analyze(...args);
    });
    const outgoing = new EventEmitter();
    const pending = Promise.resolve(app.fetch(new Request(`http://app.test/api/games/${state.id}/analyze`, { method: 'POST', headers, body: '{}' }), { outgoing }));
    await untilTick(() => held.mock.calls.length === 1);
    expect(inFlight.size).toBe(1);
    outgoing.emit('close'); // клиент ушёл, пока сервис думал
    expect(inFlight.size).toBe(1);
    release();
    expect((await pending).status).toBe(200);
    await untilTick(() => inFlight.size === 0);
  });

  it('на сокете Node поток SSE выходит из счёта сразу, не дожидаясь close', async () => {
    const inFlight = new InFlight();
    const { app, client } = await make({ inFlight });
    const { state } = await client.createGame(HUMAN_ONLY);
    const outgoing = new EventEmitter();
    const res = await app.fetch(new Request(`http://app.test/api/games/${state.id}/events`, { headers }), { outgoing });
    expect(res.status).toBe(200);
    expect(inFlight.size).toBe(0);
    // Поток живёт долго: служебный слушатель close на ответе не остаётся.
    expect(getEventListeners(outgoing, 'close')).toHaveLength(0);
    await res.body?.cancel();
  });
});

describe('createApp: лимиты частоты (D-0012)', () => {
  const H = { 'x-app-key': KEY, 'content-type': 'application/json' };
  // Адрес сокета приходит в c.env.incoming от @hono/node-server; app.request принимает env третьим аргументом.
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  const loose = { limit: 10, windowMs: 10 * MIN };
  type Limited = { status: number; retryAfter: string | null; body: unknown };
  const limited = async (res: Response): Promise<Limited> => ({ status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() });

  it('по умолчанию 60 запросов в минуту на адрес: 61-й — 429 rate_limited с Retry-After; /health не в счёт; через минуту снова можно', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app } = await make();
    for (let i = 0; i < 60; i++) expect((await app.request('/api/games', { headers: H }, from('203.0.113.7'))).status, `запрос ${i + 1}`).toBe(200);
    expect((await app.request('/health', {}, from('203.0.113.7'))).status).toBe(200);
    vi.setSystemTime(Date.now() + 20_000);
    expect(await limited(await app.request('/api/games', { headers: H }, from('203.0.113.7')))).toEqual({
      status: 429,
      retryAfter: '40',
      body: { error: { code: 'rate_limited', message: 'too many requests, retry in 40 s', details: { retryAfterSeconds: 40 } } },
    });
    // Другой адрес — свой счёт.
    expect((await app.request('/api/games', { headers: H }, from('203.0.113.8'))).status).toBe(200);
    vi.setSystemTime(Date.now() + 40_000);
    expect((await app.request('/api/games', { headers: H }, from('203.0.113.7'))).status).toBe(200);
  });

  it('запрос без ключа тоже в счёте, и отказ по частоте раньше отказа по ключу', async () => {
    const { app, service } = await make({ rateLimits: { api: { limit: 2, windowMs: MIN }, create: loose } });
    const list = vi.spyOn(service, 'list');
    expect((await app.request('/api/games', {}, from('198.51.100.1'))).status).toBe(401);
    expect((await app.request('/api/nope', {}, from('198.51.100.1'))).status).toBe(401);
    expect((await app.request('/api/games', { headers: H }, from('198.51.100.1'))).status).toBe(429);
    expect((await app.request('/api/games', {}, from('198.51.100.1'))).status).toBe(429);
    expect(list).not.toHaveBeenCalled();
  });

  it('создание: POST /api/sessions, /api/games и /api/sessions/:sid/games — общие 10 за 10 минут на адрес, сверх общего предела', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, service } = await make({ ttlMs: 60 * MIN });
    const create = vi.spyOn(service, 'create');
    const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', headers: H, ...(body ? { body: JSON.stringify(body) } : {}) }, from('192.0.2.5'));
    const sids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await post('/api/sessions');
      expect(res.status).toBe(200);
      sids.push(((await res.json()) as { session: { id: string } }).session.id);
    }
    for (const sid of sids) expect((await post(`/api/sessions/${sid}/games`, HUMAN_ONLY)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await post('/api/games', HUMAN_ONLY)).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(7);
    vi.setSystemTime(Date.now() + 5 * MIN);
    for (const path of ['/api/games', `/api/sessions/${sids[0]}/games`, '/api/sessions']) {
      expect(await limited(await post(path, HUMAN_ONLY))).toMatchObject({ status: 429, retryAfter: '300', body: { error: { code: 'rate_limited', details: { retryAfterSeconds: 300 } } } });
    }
    expect(create).toHaveBeenCalledTimes(7);
    // Прочие маршруты, в том числе POST хода, предел создания не трогает.
    expect((await app.request('/api/games', { headers: H }, from('192.0.2.5'))).status).toBe(200);
    const first = service.list()[0];
    if (!first) throw new Error('нет партий');
    expect((await app.request(`/api/games/${first.id}/play`, { method: 'POST', headers: H, body: JSON.stringify({ coord: 'D4' }) }, from('192.0.2.5'))).status).toBe(200);
    // Другой адрес создаёт.
    expect((await app.request('/api/games', { method: 'POST', headers: H, body: JSON.stringify(HUMAN_ONLY) }, from('192.0.2.6'))).status).toBe(200);
    vi.setSystemTime(Date.now() + 5 * MIN);
    expect((await post('/api/games', HUMAN_ONLY)).status).toBe(200);
  });

  it('отказ общего предела не расходует предел создания', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app } = await make({ rateLimits: { api: { limit: 1, windowMs: MIN }, create: { limit: 2, windowMs: 10 * MIN } } });
    const post = () => app.request('/api/games', { method: 'POST', headers: H, body: JSON.stringify(HUMAN_ONLY) }, from('192.0.2.9'));
    expect((await post()).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(429);
    vi.setSystemTime(Date.now() + MIN);
    expect((await post()).status).toBe(200);
    vi.setSystemTime(Date.now() + MIN);
    expect(await limited(await post())).toMatchObject({ status: 429, retryAfter: '480' });
  });

  it('поток SSE считается один раз, при открытии; события потока в счёт не идут', async () => {
    // Клиент протокола ходит через app.request без адреса сокета: его пять запросов — в своём счёте.
    const { app, client } = await make({ rateLimits: { api: { limit: 5, windowMs: MIN }, create: loose } });
    const { state } = await client.createGame(HUMAN_ONLY);
    const res = await app.request(`/api/games/${state.id}/events`, { headers: H }, from('192.0.2.20'));
    expect(res.status).toBe(200);
    const reader = streamOf(res);
    await readUntil(reader, (t) => t.includes('"cause":"sync"'));
    for (const coord of ['D4', 'E5', 'F6']) await client.play(state.id, { coord });
    await readUntil(reader, (t) => t.includes('F6'));
    for (let i = 0; i < 4; i++) expect((await app.request('/api/games', { headers: H }, from('192.0.2.20'))).status).toBe(200);
    expect((await app.request(`/api/games/${state.id}/events`, { headers: H }, from('192.0.2.20'))).status).toBe(429);
    await reader.cancel();
  });

  it('X-Forwarded-For без TRUST_PROXY не влияет: счёт по адресу сокета', async () => {
    const { app } = await make({ rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': '1.1.1.1' } }, from('10.0.0.1'))).status).toBe(200);
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': '2.2.2.2' } }, from('10.0.0.1'))).status).toBe(429);
  });

  it('с TRUST_PROXY — последний адрес X-Forwarded-For (его дописал прокси); без заголовка — адрес сокета', async () => {
    const { app } = await make({ trustProxy: true, rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    const get = (xff: string[], socket = '127.0.0.1') => {
      const headers = new Headers(H);
      for (const v of xff) headers.append('x-forwarded-for', v);
      return app.request('/api/games', { headers }, from(socket));
    };
    // Клиент подставил чужой адрес первым, прокси дописал настоящий последним.
    expect((await get(['6.6.6.6, 203.0.113.50'])).status).toBe(200);
    expect((await get(['7.7.7.7, 203.0.113.50'])).status).toBe(429);
    expect((await get([' 203.0.113.51 '])).status).toBe(200);
    // Несколько заголовков склеиваются через запятую: последний адрес — из последнего.
    expect((await get(['9.9.9.9', '203.0.113.52'])).status).toBe(200);
    expect((await get(['203.0.113.52'])).status).toBe(429);
    // Без заголовка и с пустым последним адресом — адрес сокета прокси.
    expect((await get([])).status).toBe(200);
    expect((await get(['8.8.8.8, '])).status).toBe(429);
  });

  it('ключ по адресу: IPv6 — префикс /64, IPv4-mapped — как IPv4; и из X-Forwarded-For, и из сокета', async () => {
    const proxied = await make({ trustProxy: true, rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    const viaProxy = (xff: string) => proxied.app.request('/api/games', { headers: { ...H, 'x-forwarded-for': xff } }, from('127.0.0.1'));
    expect((await viaProxy('2001:db8:1:2::a')).status).toBe(200);
    expect((await viaProxy('2001:db8:1:2:ffff::b')).status).toBe(429);
    expect((await viaProxy('2001:db8:1:3::a')).status).toBe(200);
    expect((await viaProxy('::ffff:203.0.113.60')).status).toBe(200);
    expect((await viaProxy('203.0.113.60')).status).toBe(429);
    expect((await viaProxy('203.0.113.61')).status).toBe(200);

    const direct = await make({ rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    const bySocket = (address: string) => direct.app.request('/api/games', { headers: H }, from(address));
    expect((await bySocket('::ffff:192.0.2.77')).status).toBe(200);
    expect((await bySocket('192.0.2.77')).status).toBe(429);
    expect((await bySocket('2001:db8:5:6::1')).status).toBe(200);
    expect((await bySocket('2001:db8:5:6::2')).status).toBe(429);
    expect((await bySocket('2001:db8:5:7::1')).status).toBe(200);
  });

  it('длинный адрес из заголовка не раздувает память: ключ обрезан до 64 символов', async () => {
    const { app } = await make({ trustProxy: true, rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    const long = 'a'.repeat(64);
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': `${long}x` } }, from('127.0.0.1'))).status).toBe(200);
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': `${long}y` } }, from('127.0.0.1'))).status).toBe(429);
    // Отличие в 64-м символе ещё различает адреса: ключ режется ровно по 64, а не короче.
    const edge = 'b'.repeat(63);
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': `${edge}x` } }, from('127.0.0.1'))).status).toBe(200);
    expect((await app.request('/api/games', { headers: { ...H, 'x-forwarded-for': `${edge}y` } }, from('127.0.0.1'))).status).toBe(200);
  });

  it('на настоящем сокете счёт идёт по адресу соединения', async () => {
    const { app } = await make({ rateLimits: { api: { limit: 1, windowMs: MIN }, create: loose } });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    // Настоящий ввод-вывод: обороты цикла событий с потолком, без часов.
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100_000; i++) {
        if (cond()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('условие не выполнилось за отведённые обороты очереди');
    };
    try {
      await until(() => server.listening);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect((await fetch(`http://127.0.0.1:${port}/api/games`, { headers: H })).status).toBe(200);
      // Запрос без сокета — другой ключ; тот же адрес, что у настоящего соединения, — уже сверх предела.
      expect((await app.request('/api/games', { headers: H })).status).toBe(200);
      expect((await app.request('/api/games', { headers: H }, from('127.0.0.1'))).status).toBe(429);
      expect((await fetch(`http://127.0.0.1:${port}/api/games`, { headers: H })).status).toBe(429);
    } finally {
      server.close();
      if ('closeAllConnections' in server) server.closeAllConnections();
    }
  });
});

describe('createApp: партии только в сессии и не больше трёх незавершённых на клиента (D-0012)', () => {
  const H = { 'x-app-key': KEY, 'content-type': 'application/json' };
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  type App = Awaited<ReturnType<typeof make>>['app'];
  type ErrorJson = { error: { code: string; message: string; details?: Record<string, unknown> } };
  const post = (app: App, path: string, address: string, body?: unknown) =>
    app.request(path, { method: 'POST', headers: H, ...(body ? { body: JSON.stringify(body) } : {}) }, from(address));
  const sessionOf = async (app: App, address: string): Promise<string> => {
    const res = await post(app, '/api/sessions', address);
    expect(res.status).toBe(200);
    return ((await res.json()) as { session: { id: string } }).session.id;
  };
  const gameIn = async (app: App, sid: string, address: string): Promise<string> => {
    const res = await post(app, `/api/sessions/${sid}/games`, address, HUMAN_ONLY);
    expect(res.status).toBe(200);
    return ((await res.json()) as { state: { id: string } }).state.id;
  };

  it('новая партия в сессии бросает прежнюю: «Новая партия» подряд не упирается в лимит; возврат к брошенной проходит лимит клиента, лишний — 429 со scope client и своим текстом; сдача освобождает место', async () => {
    const { app } = await make({ maxGamesPerClient: 2, ttlMs: 60 * MIN });
    const sid = await sessionOf(app, '203.0.113.7');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await gameIn(app, sid, '203.0.113.7'));
    // Ход в брошенной возвращает её: с текущей это ровно лимит 2. Ход во второй брошенной — сверх лимита.
    expect((await post(app, `/api/games/${ids[0]}/play`, '203.0.113.7', { coord: 'D4' })).status).toBe(200);
    const refused = await post(app, `/api/games/${ids[1]}/play`, '203.0.113.7', { coord: 'D4' });
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as ErrorJson;
    expect(body.error).toEqual({ code: 'too_many_games', message: 'limit of 2 unfinished games per client reached', details: { max: 2, scope: 'client' } });
    expect(humanText(body.error.code, body.error.details)).toBe('у тебя слишком много незаконченных партий, новую можно начать позже');
    // Новая сессия того же телефона: счёт полон и для create.
    const again = await sessionOf(app, '203.0.113.7');
    expect((await post(app, `/api/sessions/${again}/games`, '203.0.113.7', HUMAN_ONLY)).status).toBe(429);
    const other = await sessionOf(app, '203.0.113.8');
    await gameIn(app, other, '203.0.113.8');
    expect((await post(app, `/api/games/${ids[0]}/resign`, '203.0.113.7', { color: 'B' })).status).toBe(200);
    expect((await post(app, `/api/games/${ids[1]}/play`, '203.0.113.7', { coord: 'D4' })).status).toBe(200);
  });

  it('партии сессии идут в счёт владельца сессии, даже когда их создаёт voice-agent со своего адреса', async () => {
    const { app } = await make({ maxGamesPerClient: 2, ttlMs: 60 * MIN });
    const agent = '172.18.0.5'; // адрес контейнера voice-agent в сети compose: мимо Caddy, без X-Forwarded-For
    const sid = await sessionOf(app, '198.51.100.20');
    const first = await gameIn(app, sid, agent);
    await gameIn(app, sid, '198.51.100.20');
    // Ход агента в первой, брошенной, партии возвращает её в счёт владельца: у него две.
    expect((await post(app, `/api/games/${first}/play`, agent, { coord: 'D4' })).status).toBe(200);
    const again = await sessionOf(app, '198.51.100.20');
    const refused = await post(app, `/api/sessions/${again}/games`, agent, HUMAN_ONLY);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as ErrorJson).error.details).toEqual({ max: 2, scope: 'client' });
    // Сессия другого телефона — свой счёт, хотя партии создаёт тот же агент.
    const other = await sessionOf(app, '198.51.100.21');
    await gameIn(app, other, agent);
  });

  it('владелец сессии за Caddy — последний адрес X-Forwarded-For при её создании', async () => {
    const { app } = await make({ trustProxy: true, maxGamesPerClient: 1, ttlMs: 60 * MIN });
    const sessionVia = async (xff: string): Promise<string> => {
      const res = await app.request('/api/sessions', { method: 'POST', headers: { ...H, 'x-forwarded-for': xff } }, from('127.0.0.1'));
      return ((await res.json()) as { session: { id: string } }).session.id;
    };
    const a = await sessionVia('6.6.6.6, 203.0.113.60');
    const b = await sessionVia('6.6.6.6, 203.0.113.61');
    const c = await sessionVia('7.7.7.7, 203.0.113.60');
    await gameIn(app, a, '172.18.0.5');
    // c — тот же телефон (последний адрес тот же): его счёт полон.
    expect((await post(app, `/api/sessions/${c}/games`, '172.18.0.5', HUMAN_ONLY)).status).toBe(429);
    // Владелец b — 203.0.113.61; по первому адресу X-Forwarded-For обе сессии делили бы счёт 6.6.6.6.
    await gameIn(app, b, '172.18.0.5');
  });

  it('возврат к брошенной через HTTP: поток сверх лимита открывается, но партию не возвращает; ход сверх лимита — 429', async () => {
    const { app } = await make({ maxGamesPerClient: 2, ttlMs: 60 * MIN });
    const phone = '203.0.113.9';
    const sid = await sessionOf(app, phone);
    const g0 = await gameIn(app, sid, phone);
    const g1 = await gameIn(app, sid, phone);
    await gameIn(app, sid, phone);
    const events = (id: string) => app.request(`/api/games/${id}/events`, { headers: { 'x-app-key': KEY } }, from(phone));
    // Поток g0 возвращает её: с текущей ровно 2. Поток g1 сверх лимита: смотреть можно, в счёт она не идёт.
    const s0 = await events(g0);
    expect(s0.status).toBe(200);
    await s0.body?.cancel();
    const s1 = await events(g1);
    expect(s1.status).toBe(200);
    const r1 = streamOf(s1);
    expect(await readUntil(r1, (t) => t.includes('"cause":"sync"'))).toContain(g1);
    await r1.cancel();
    const refused = await post(app, `/api/games/${g1}/play`, phone, { coord: 'D4' });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as ErrorJson).error.details).toEqual({ max: 2, scope: 'client' });
    expect(((await (await app.request(`/api/games/${g1}`, { headers: { 'x-app-key': KEY } }, from(phone))).json()) as { moves: unknown[] }).moves).toHaveLength(0);
    // Сдача g0 освобождает место: ход в g1 проходит.
    expect((await post(app, `/api/games/${g0}/resign`, phone, { color: 'B' })).status).toBe(200);
    expect((await post(app, `/api/games/${g1}/play`, phone, { coord: 'D4' })).status).toBe(200);
  });

  it('undo и correct партии, завершённой счётом, через HTTP проходят лимит владельца: сверх лимита — 429, партия завершена; после сдачи текущей undo возвращает её', async () => {
    const { app, service } = await make({ maxGamesPerClient: 1, ttlMs: 60 * MIN });
    const phone = '203.0.113.21';
    const sid = await sessionOf(app, phone);
    const g0 = await gameIn(app, sid, phone);
    expect((await post(app, `/api/games/${g0}/play`, phone, { coord: 'D4' })).status).toBe(200);
    expect((await post(app, `/api/games/${g0}/pass`, phone, {})).status).toBe(200);
    expect((await post(app, `/api/games/${g0}/pass`, phone, {})).status).toBe(200);
    await untilTick(() => service.get(g0).status === 'finished');
    const g1 = await gameIn(app, sid, phone);
    // Откат с другого адреса (агент) идёт в счёт владельца партии.
    for (const [path, body] of [[`/api/games/${g0}/undo`, {}], [`/api/games/${g0}/correct`, { coord: 'E5' }]] as const) {
      const refused = await post(app, path, '198.51.100.30', body);
      expect(refused.status, path).toBe(429);
      expect(((await refused.json()) as ErrorJson).error.details, path).toEqual({ max: 1, scope: 'client' });
    }
    expect(service.get(g0).status).toBe('finished');
    expect((await post(app, `/api/games/${g1}/resign`, phone, { color: 'B' })).status).toBe(200);
    const undone = await post(app, `/api/games/${g0}/undo`, '198.51.100.30', {});
    expect(undone.status).toBe(200);
    expect(service.get(g0).status).toBe('playing');
  });

  it('undo партии без владельца (создана до рестарта) идёт в счёт адреса запроса, и адрес записывается владельцем', async () => {
    const { app, service } = await make({ maxGamesPerClient: 1 });
    const g = (await service.create({ ...HUMAN_ONLY, waitForReply: false })).state.id;
    for (const path of ['play', 'pass', 'pass']) expect((await post(app, `/api/games/${g}/${path}`, '192.0.2.70', path === 'play' ? { coord: 'D4' } : {})).status).toBe(200);
    await untilTick(() => service.get(g).status === 'finished');
    expect((await post(app, '/api/games', '192.0.2.71', HUMAN_ONLY)).status).toBe(200);
    for (const [path, body] of [[`/api/games/${g}/undo`, {}], [`/api/games/${g}/correct`, { coord: 'E5' }]] as const) {
      const refused = await post(app, path, '192.0.2.71', body);
      expect(refused.status, path).toBe(429);
      expect(((await refused.json()) as ErrorJson).error.details, path).toEqual({ max: 1, scope: 'client' });
    }
    expect((await post(app, `/api/games/${g}/undo`, '192.0.2.72', {})).status).toBe(200);
    expect((await post(app, '/api/games', '192.0.2.72', HUMAN_ONLY)).status).toBe(429);
  });

  it('без sessionlessGames POST /api/games — 400 bad_request с reason sessionless_disabled до разбора тела; партия в сессии и чтение партии работают, список — 400 list_disabled', async () => {
    const { app, service } = await make({ sessionlessGames: false });
    const res = await post(app, '/api/games', '192.0.2.40', HUMAN_ONLY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorJson;
    expect(body).toEqual({ error: { code: 'bad_request', message: 'games are created only inside a session', details: { reason: 'sessionless_disabled' } } });
    expect(humanText(body.error.code, body.error.details)).toBe('партии создаются только внутри сессии');
    // Тело не разбирается: мусор получает тот же ответ, а не ошибку схемы.
    expect(await (await app.request('/api/games', { method: 'POST', headers: H, body: 'not json' }, from('192.0.2.40'))).json()).toEqual(body);
    expect(service.list()).toHaveLength(0);
    const sid = await sessionOf(app, '192.0.2.40');
    const created = await post(app, `/api/sessions/${sid}/games`, '192.0.2.40', HUMAN_ONLY);
    expect(created.status).toBe(200);
    const { state } = (await created.json()) as { state: { id: string } };
    expect((await app.request(`/api/games/${state.id}`, { headers: H }, from('192.0.2.40'))).status).toBe(200);
    // Список отдал бы id чужих партий: без флага его нет (D-0012).
    const list = await app.request('/api/games', { headers: H }, from('192.0.2.40'));
    expect(list.status).toBe(400);
    const listBody = (await list.json()) as ErrorJson;
    expect(listBody).toEqual({ error: { code: 'bad_request', message: 'the game list is available only with sessionless games enabled', details: { reason: 'list_disabled' } } });
    expect(humanText(listBody.error.code, listBody.error.details)).toBe('список партий недоступен');
  });

  it('с sessionlessGames POST /api/games создаёт партию, и она в счёте адреса; IPv6 одной /64 — один клиент', async () => {
    const { app } = await make({ sessionlessGames: true, maxGamesPerClient: 1 });
    expect((await post(app, '/api/games', '192.0.2.41', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '192.0.2.41', HUMAN_ONLY)).status).toBe(429);
    expect((await post(app, '/api/games', '192.0.2.42', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '2001:db8:5:6::1', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '2001:db8:5:6::2', HUMAN_ONLY)).status).toBe(429);
  });

  it('умолчание createApp — партии без сессии и список партий выключены', async () => {
    const { app } = await make({ sessionlessGames: 'default' });
    const res = await post(app, '/api/games', '192.0.2.60', HUMAN_ONLY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorJson).error.details).toEqual({ reason: 'sessionless_disabled' });
    const list = await app.request('/api/games', { headers: H }, from('192.0.2.60'));
    expect(list.status).toBe(400);
    expect(((await list.json()) as ErrorJson).error.details).toEqual({ reason: 'list_disabled' });
  });

  it('защитный путь: сессия без записанного владельца (не через POST /api/sessions, в prod недостижимо) — партии в счёт адреса запроса', async () => {
    const { app, sessions } = await make({ maxGamesPerClient: 1, ttlMs: 60 * MIN });
    const a = sessions.create().id;
    const b = sessions.create().id;
    await gameIn(app, a, '192.0.2.50');
    expect((await post(app, `/api/sessions/${b}/games`, '192.0.2.50', HUMAN_ONLY)).status).toBe(429);
    await gameIn(app, b, '192.0.2.51');
  });
});
