import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomAgentDispatch, TokenVerifier } from 'livekit-server-sdk';
import { createClient, parseSseStream } from '@goko/protocol';
import { type AppDeps, createApp } from './app.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import type { RoomCreator } from './livekit.ts';
import { GameService } from './service.ts';
import { SessionManager } from './sessions.ts';
import { GameStore } from './store.ts';

const KEY = 'app-secret';
const LK = { url: 'wss://lk.test', apiKey: 'devkey', apiSecret: 'secret-of-at-least-32-characters-long', agentName: 'goko-dev', tokenTtlSeconds: 3600 };
const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const }, settings: { boardSize: 9 as const } };
const HUMAN_ONLY = { black: { controller: 'human' as const }, white: { controller: 'human' as const }, settings: { boardSize: 9 as const } };
const MIN = 60_000;

let dir = '';
let opened: GameService[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-app-'));
  opened = [];
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const service of opened) await service.close();
  await rm(dir, { recursive: true, force: true });
});

type RoomCall = { name: string; emptyTimeout: number; agents: RoomAgentDispatch[] };

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
};

async function make(opts: MakeOptions = {}) {
  const bus = new EventBus();
  const service = new GameService({ store: new GameStore(dir), engine: createFakeEngine({ script: opts.script }), bus, replyTimeoutMs: 500 });
  opened.push(service);
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
    log: (line) => logs.push(line),
  });
  // Клиент протокола поверх app.request: без сети.
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input).replace('http://app.test', ''), init)) as unknown as typeof fetch;
  const client = createClient({ baseUrl: 'http://app.test', appKey: KEY, fetch: fetchFn });
  return { app, service, bus, client, sessions, rooms, logs };
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

  it('создание сессии (D-0001): комнату с агентом создаёт сервер, токен только roomJoin; session.game в потоке', async () => {
    const { client, app, rooms } = await make({ script: ['E5'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    const { session, livekit } = await client.createSession();
    expect(livekit.url).toBe(LK.url);
    // Часы заморожены и на проверке: иначе токен на час мог бы истечь по настоящим часам машины.
    const claims = await new TokenVerifier(LK.apiKey, LK.apiSecret).verify(livekit.token);
    vi.useRealTimers();
    expect(claims.video).toEqual({ room: session.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    expect(claims.roomConfig).toBeUndefined();
    expect(claims.sub).toBe(`phone-${session.id}`);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(LK.tokenTtlSeconds);

    expect(rooms.calls).toHaveLength(1);
    expect(rooms.calls[0]?.name).toBe(session.room);
    expect(rooms.calls[0]?.emptyTimeout).toBe(300);
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
    await expect(client.play(state.id, { coord: 'E5' })).rejects.toMatchObject({ code: 'illegal_move', status: 400 });
    await expect(client.play(state.id, { coord: 'I5' })).rejects.toMatchObject({ code: 'invalid_coord', status: 400 });
    await expect(client.play(state.id, { coord: 'C3', expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
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
    await expect(client.createSession()).rejects.toMatchObject({ code: 'limit_reached', status: 429 });
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
    await client.play(id, { coord: 'C3' });
    expect((await client.correct(id, { coord: 'C4' })).reply?.coord).toBe('pass');
    expect((await client.analyze(id)).groups.length).toBeGreaterThan(0);
    expect((await client.score(id)).reason).toBe('score');
    // correct откатил C3 и F6 и поставил C4: в партии ровно C4 и ответ движка, а не четыре хода.
    expect((await client.getGame(id)).moves.map((m) => m.coord)).toEqual(['C4', 'pass']);
    expect(await client.ascii(id)).toContain('toPlay B');
    expect(await client.sgf(id)).toContain('SZ[9]');
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
      expect(JSON.parse(text)).toEqual({ error: { code: 'unauthorized', message: 'нет или неверный X-App-Key' } });
    }
    expect((await app.request('/api/games', { headers: { 'x-app-key': KEY } })).status).toBe(200);
    const sessions = new SessionManager({ max: 1, ttlMs: 1000 });
    expect(() => createApp({ service, sessions, bus: new EventBus(), appKey: '', livekit: LK, rooms: fakeRooms() })).toThrow('createApp: пустой appKey');
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
    expect(((await broken.json()) as { error: unknown }).error).toMatchObject({ code: 'bad_request', message: 'тело запроса не JSON' });
    expect((await client.getGame(state.id)).moves).toHaveLength(0);
  });

  it('тело не по схеме — bad_request с issues; неизвестный маршрут — not_found', async () => {
    const { app } = await make();
    const headers = { 'x-app-key': KEY, 'content-type': 'application/json' };
    const res = await app.request('/api/games', { method: 'POST', headers, body: JSON.stringify({ black: { controller: 'robot' } }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; details: { issues: unknown[] } } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('тело запроса не по схеме');
    expect(body.error.details.issues.length).toBeGreaterThan(0);

    const missing = await app.request('/api/nope', { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'нет маршрута GET /api/nope' } });
  });

  it('непредвиденная ошибка — 500 internal без подробностей наружу, подробности в лог', async () => {
    const { client, service, logs } = await make();
    vi.spyOn(service, 'list').mockImplementation(() => {
      throw new Error('disk exploded at /secret/path');
    });
    const err = await client.listGames().then(
      () => undefined,
      (e: unknown) => e as { code: string; status: number; message: string },
    );
    expect(err).toMatchObject({ code: 'internal', status: 500, message: 'внутренняя ошибка сервера' });
    expect(logs.some((l) => l.startsWith('[X] game-server:') && l.includes('disk exploded'))).toBe(true);
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
    const rooms = fakeRooms(new Error(`twirp: unauthenticated for ${LK.apiSecret}`));
    const { client, sessions, logs } = await make({ maxSessions: 1, rooms });
    const err = await client.createSession().then(
      () => undefined,
      (e: unknown) => e as { code: string; status: number; message: string },
    );
    expect(err).toMatchObject({ code: 'internal', status: 500, message: 'не удалось подготовить комнату LiveKit для сессии' });
    expect(JSON.stringify(err)).not.toContain(LK.apiSecret);
    expect(rooms.calls).toHaveLength(1);
    expect(sessions.list()).toEqual([]);
    expect(logs.some((l) => l.startsWith('[X] game-server: сессия') && l.includes('twirp'))).toBe(true);
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
      bus.emit(`game:${state.id}`, { type: 'engine.thinking', color: i % 2 === 0 ? 'B' : 'W' });
      await readUntil(reader, (t) => t.includes('engine.thinking'));
    }
    await untilTick(() => vi.getTimerCount() === 1, 50);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    bus.emit(`game:${state.id}`, { type: 'engine.thinking', color: 'B' });
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
