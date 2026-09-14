import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Color, type GameEvent, GameSettings, type GameState } from '@goko/protocol';
import { fakeFetch } from '@goko/protocol/testing';
import { type Engine, createEngineClient } from './engine-client.ts';
import { EventBus } from './events.ts';
import { type FakeEngine, createFakeEngine } from './fake-engine.ts';
import { applyMove, finishByScore, newGame, resign as resignGame } from './game.ts';
import {
  ANALYZE_BUDGET_MS,
  ENGINE_RETRY_DELAYS_MS,
  ENGINE_UNAVAILABLE_MESSAGE,
  FINISHED_RETENTION_MS,
  GameService,
  MAX_ACTIVE_GAMES,
  MAX_GAMES_PER_CLIENT,
  MAX_ID_ATTEMPTS,
  RETRIES_EXHAUSTED_MESSAGE,
  SCORE_BUDGET_MS,
  STALE_GAME_MS,
} from './service.ts';
import { SESSION_TTL_MS } from './sessions.ts';
import { GameStore, type SnapshotStore } from './store.ts';
import { type GuardedService, type MemoryStore, closeWithin, guardService, memoryMarks, memoryStore, track } from './test-helpers.ts';

let dir = '';
// Сервисы теста закрываются до удаления каталога: иначе фоновая задача движка
// пишет снапшот в уже снесённый каталог и роняет прогон необработанным отказом.
let opened: GuardedService[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-service-'));
  opened = [];
});
afterEach(async () => {
  // Тесты с управляемым временем возвращают настоящие таймеры до закрытия сервисов.
  vi.useRealTimers();
  try {
    for (const { service, startsAfterClose } of opened) {
      await closeWithin(service);
      expect(startsAfterClose(), 'startTask после close').toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const } };
// Партия без движка: задачу движка не поднимает, поэтому годится для тестов о времени.
const HUMAN_ONLY = { black: { controller: 'human' as const }, white: { controller: 'human' as const } };
const ENGINE_BLACK = { black: { controller: 'engine' as const, rank: '10k' as const }, white: { controller: 'human' as const } };
const S9 = { settings: { boardSize: 9 as const } };

// Серия повторов с одинаковыми паузами: для тестов, которым не важны сами паузы 5/10/20/40/60 с.
const delays = (ms: number): number[] => new Array<number>(5).fill(ms);

// Сервис на снапшотах в памяти (диск — только там, где тест проверяет файлы) и под guardService:
// afterEach закрывает его с потолком и проверяет, что после close не ставилось ни одной задачи.
async function make(engine: Engine, extra: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  const bus = new EventBus();
  const store = extra.store ?? memoryStore();
  const service = new GameService({ engine, bus, replyTimeoutMs: 500, retryDelaysMs: delays(20), ...extra, store });
  opened.push(guardService(service));
  await service.init();
  return { service, bus, store };
}

function record(bus: EventBus, channel: string): GameEvent[] {
  const out: GameEvent[] = [];
  bus.subscribe(channel, (e) => out.push(e));
  return out;
}

// Прокрутка микрозадач и ввода-вывода без движения часов: для тестов на фейковых таймерах.
const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
};

// Ожидание условия без часов: крутится только очередь событий, поэтому годится
// и на фейковых таймерах, где обычное опросное ожидание не сдвинулось бы с места.
const untilTick = async (cond: () => boolean, turns = 5000): Promise<void> => {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('условие не выполнилось за отведённые обороты очереди');
};

// Раздумье фейкового движка целиком: дождаться нужного по счёту вызова genmove и
// досчитать его задержку. Таймер задержки заводится внутри движка, поэтому до вызова
// двигать часы рано: сдвинутое раньше времени модельное время движок не увидит.
const thinkThrough = async (engine: FakeEngine, genmoveCalls: number, delayMs: number): Promise<void> => {
  await untilTick(() => engine.calls.genmove >= genmoveCalls);
  await vi.advanceTimersByTimeAsync(delayMs);
};

describe('GameService: партия человек против движка', () => {
  it('create -> play с ответом движка -> события -> снапшот', async () => {
    const engine = createFakeEngine({ script: ['E5'] });
    // Единственный тест сервиса на настоящем диске: все ожидания здесь — await операций, а не
    // обороты очереди, и ответ ждётся с таймаутом по умолчанию (8 с), а не 500 мс.
    const { service, bus, store } = await make(engine, { store: new GameStore(dir), replyTimeoutMs: undefined });
    const created = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    expect(created.state.toPlay).toBe('B');
    expect(created.firstMove).toBeUndefined();
    const events = record(bus, `game:${created.state.id}`);

    const res = await service.play(created.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    expect(res.move).toMatchObject({ n: 1, color: 'B', coord: 'D4' });
    expect(res.reply).toMatchObject({ n: 2, color: 'W', coord: 'E5' });
    expect(res.replyTimedOut).toBeUndefined();
    expect(res.state.moves).toHaveLength(2);
    expect(res.state.pendingEngineMove).toBe(false);
    expect(res.state.toPlay).toBe('B');

    expect(events.map((e) => e.type)).toEqual(['state.updated', 'engine.thinking', 'state.updated']);
    expect(events[0]).toMatchObject({ type: 'state.updated', cause: 'play', by: 'human', via: 'voice' });
    expect(events[2]).toMatchObject({ type: 'state.updated', cause: 'engine', by: 'engine' });
    const saved = await store.load();
    expect(saved[0]?.moves).toHaveLength(2);
  });

  it('признак humanFallback ответа движка доходит до события хода движка, у хода человека его нет', async () => {
    const inner = createFakeEngine({ script: ['E5', 'F6'] });
    const flags = [true, false];
    const searching: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), humanFallback: flags.shift() ?? false }) };
    const { service, bus } = await make(searching);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    await service.play(g.state.id, { coord: 'C3', waitForReply: true, via: 'voice' });
    const updates = events.filter((e) => e.type === 'state.updated');
    expect(updates.map((e) => [e.cause, 'humanFallback' in e ? e.humanFallback : 'нет'])).toEqual([
      ['play', 'нет'],
      ['engine', true],
      ['play', 'нет'],
      ['engine', false],
    ]);
  });

  it('движок ходит первым: create ждёт firstMove', async () => {
    const { service } = await make(createFakeEngine({ script: ['C3'] }));
    const created = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true });
    expect(created.firstMove).toMatchObject({ n: 1, color: 'B', coord: 'C3' });
    expect(created.state.toPlay).toBe('W');
  });

  it('create без ожидания ответа возвращается сразу, ход движка приходит позже', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['C3'], delayMs: 50 });
    const { service } = await make(engine);
    const created = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    expect(created.firstMove).toBeUndefined();
    expect(created.replyTimedOut).toBeUndefined();
    expect(created.state.moves).toHaveLength(0);
    await thinkThrough(engine, 1, 50);
    await untilTick(() => service.get(created.state.id).moves.length === 1);
  });

  it('create с медленным движком отдаёт replyTimedOut', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['C3'], delayMs: 200 });
    const { service } = await make(engine, { replyTimeoutMs: 30 });
    const creating = service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true });
    // Движок думает 200 мс, ожидание ответа кончается на 30-й: create возвращается по таймауту.
    await untilTick(() => engine.calls.genmove === 1);
    await vi.advanceTimersByTimeAsync(30);
    const created = await creating;
    expect(created.firstMove).toBeUndefined();
    expect(created.replyTimedOut).toBe(true);
    // Досчитываем раздумье движка, чтобы фоновая задача завершилась до close.
    await vi.advanceTimersByTimeAsync(170);
    await untilTick(() => service.get(created.state.id).moves.length === 1);
  });

  it('места по умолчанию: движку без ранга ставится 10k', async () => {
    const { service } = await make(createFakeEngine({ script: ['C3'] }));
    const created = await service.create({ black: { controller: 'human' }, white: { controller: 'engine' }, ...S9, waitForReply: true });
    expect(created.state.seats.W.rank).toBe('10k');
    expect(created.state.seats.B.rank).toBeUndefined();
  });

  it('session.game уходит в канал сессии раньше событий партии', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['C3'] }));
    const seen: GameEvent[] = [];
    bus.subscribe('session:s1', (e) => seen.push(e));
    const created = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true }, { sessionId: 's1' });
    expect(seen[0]).toEqual({ type: 'session.game', gameId: created.state.id });
    expect(seen[1]).toMatchObject({ type: 'state.updated', cause: 'new', by: 'system' });
  });

  it('два паса -> счёт -> finished, game.finished, result.reason score', async () => {
    const engine = createFakeEngine();
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    expect(res.reply?.coord).toBe('pass');
    await untilTick(() => service.get(g.state.id).status === 'finished');
    const state = service.get(g.state.id);
    expect(state.result).toMatchObject({ reason: 'score', winner: 'W', margin: 7.5 });
    expect(state.result?.score).toMatchObject({ areaB: 0, areaW: 0, komi: 7.5, dead: [] });
    expect(engine.calls.score).toBe(1);
    expect(events.some((e) => e.type === 'game.finished')).toBe(true);
    // Автосчёт публикуется причиной 'pass': отдельной причины спека не вводит.
    expect(events.flatMap((e) => (e.type === 'state.updated' ? [e.cause] : []))).toEqual(['pass', 'engine', 'pass']);
    await expect(service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
  });

  it('сдача человека: finished, game.finished, откат запрещён', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const r = await service.resign(g.state.id, { color: 'B', via: 'voice' });
    expect(r.state.status).toBe('finished');
    expect(r.state.result).toMatchObject({ winner: 'W', reason: 'resign' });
    expect(events.map((e) => e.type)).toEqual(['state.updated', 'game.finished']);
    expect(events[0]).toMatchObject({ cause: 'resign', via: 'voice' });
    await expect(service.undo(g.state.id, { via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
  });

  it('undo снимает пару ходов; при думающем движке — один и отменяет ответ', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5', 'F6'], delayMs: 150 });
    const { service } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const first = service.play(id, { coord: 'D4', waitForReply: true, via: 'api' }); // B D4, W E5
    // Таймер раздумья заводится внутри движка: до его вызова двигать часы рано.
    await untilTick(() => engine.calls.genmove === 1);
    await vi.advanceTimersByTimeAsync(150);
    await untilTick(() => service.get(id).moves.length === 2);
    await first;
    const u1 = await service.undo(id, { via: 'api' });
    expect(u1.removed.map((m) => m.coord)).toEqual(['E5', 'D4']);
    expect(u1.state.moves).toEqual([]);

    // Движок думает 150 мс, откат раньше: снимается только ход человека, ответ не применяется.
    const p = await service.play(id, { coord: 'C3', waitForReply: false, via: 'api' });
    expect(p.state.pendingEngineMove).toBe(true);
    const u2 = await service.undo(id, { via: 'api' });
    expect(u2.removed.map((m) => m.coord)).toEqual(['C3']);
    await untilTick(() => engine.calls.genmove === 2);
    await vi.advanceTimersByTimeAsync(150);
    await tick(5);
    // Движок додумал ход, но применять его к изменившейся ревизии не стал.
    expect(engine.calls.genmove).toBe(2);
    expect(service.get(id).moves).toEqual([]);
    expect(service.get(id).pendingEngineMove).toBe(false);
  });

  it('undo в finished по счёту возвращает playing и снова ждёт движок, если его ход', async () => {
    const { service } = await make(createFakeEngine({ script: ['pass', 'E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    // По сценарию ответ движка на D4 — pass; затем пас человека даёт два паса подряд.
    await untilTick(() => service.get(g.state.id).moves.length === 2);
    await service.pass(g.state.id, { waitForReply: false, via: 'api' });
    await untilTick(() => service.get(g.state.id).status === 'finished');
    const u = await service.undo(g.state.id, { via: 'api' });
    expect(u.removed.map((m) => m.coord)).toEqual(['pass', 'pass']);
    expect(u.state.status).toBe('playing');
    expect(u.state.toPlay).toBe('W');
    // Ход движка после отката: ставится заново, по сценарию E5.
    await untilTick(() => service.get(g.state.id).moves.length === 2);
    expect(service.get(g.state.id).moves[1]?.coord).toBe('E5');
  });

  it('correct за движок отвергается проверкой места', async () => {
    const { service } = await make(createFakeEngine({ script: ['C3'] }));
    // Движок ходит чёрными: откат его единственного хода возвращает очередь ему же,
    // и правка человека сыграла бы за движок.
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true });
    await expect(service.correct(g.state.id, { coord: 'D4', waitForReply: false, via: 'voice' })).rejects.toMatchObject({ code: 'not_your_turn' });
    expect(service.get(g.state.id).moves.map((m) => m.coord)).toEqual(['C3']);
  });

  it('correct атомарен: откат пары, новый ход, новый ответ, одно событие correct', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5', 'F6'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.correct(g.state.id, { coord: 'D5', waitForReply: true, via: 'voice' });
    expect(res.move).toMatchObject({ n: 1, coord: 'D5' });
    expect(res.reply).toMatchObject({ n: 2, coord: 'F6' });
    expect(res.state.moves.map((m) => m.coord)).toEqual(['D5', 'F6']);
    expect(events.flatMap((e) => (e.type === 'state.updated' ? [e.cause] : []))).toEqual(['correct', 'engine']);
  });

  // Спека, раздел о ревизии: каждый переход game.ts — ровно +1, а correct — два перехода (undo и ход)
  // в одном коммите, поэтому его state.updated показывает скачок +2. Клиенты не должны ждать шага 1.
  it('ревизия: play и ответ движка — по +1, correct — скачок +2 одним событием', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5', 'F6'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const r0 = g.state.revision;
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const res = await service.correct(g.state.id, { coord: 'D5', waitForReply: true, via: 'voice' });
    const steps = events.flatMap((e) => (e.type === 'state.updated' ? [[e.cause, e.state.revision - r0]] : []));
    expect(steps).toEqual([
      ['play', 1],
      ['engine', 2],
      ['correct', 4],
      ['engine', 5],
    ]);
    expect(res.state.revision - r0).toBe(5);
  });

  it('waitForReply с медленным движком: replyTimedOut, ход приходит событием', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5'], delayMs: 200 });
    const { service, bus } = await make(engine, { replyTimeoutMs: 50 });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const playing = service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    // Движок думает 200 мс, ожидание ответа кончается на 50-й.
    await thinkThrough(engine, 1, 50);
    const res = await playing;
    expect(res.replyTimedOut).toBe(true);
    expect(res.reply).toBeUndefined();
    await vi.advanceTimersByTimeAsync(150);
    await untilTick(() => service.get(g.state.id).moves.length === 2);
    expect(events.at(-1)).toMatchObject({ type: 'state.updated', cause: 'engine' });
  });

  it('waitForReply false возвращается сразу и без replyTimedOut', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 100 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(res.reply).toBeUndefined();
    expect(res.replyTimedOut).toBeUndefined();
    expect(res.state.moves).toHaveLength(1);
  });

  it('откат во время ожидания ответа — не таймаут: отдаётся свежее состояние', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 200 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    const pending = service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    // Ход человека уже применён, ответа движка ещё нет: часы для этого двигать не нужно.
    await untilTick(() => service.get(id).pendingEngineMove);
    await service.undo(id, { via: 'api' });
    const res = await pending;
    expect(res.replyTimedOut).toBeUndefined();
    expect(res.reply).toBeUndefined();
    expect(res.state.moves).toEqual([]);
  });

  it('revision_conflict при устаревшей expectedRevision', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    const rev = service.get(g.state.id).revision;
    await expect(service.play(g.state.id, { coord: 'C3', expectedRevision: rev - 1, waitForReply: true, via: 'api' })).rejects.toMatchObject({ code: 'revision_conflict', details: { revision: rev } });
    // Совпавшая ревизия проходит.
    const okRes = await service.play(g.state.id, { coord: 'C3', expectedRevision: rev, waitForReply: true, via: 'api' });
    expect(okRes.move.coord).toBe('C3');
    await expect(service.undo(g.state.id, { expectedRevision: 0, via: 'api' })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('not_found для чужого идентификатора', async () => {
    const { service } = await make(createFakeEngine());
    expect(() => service.get('nosuchgame')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('рестарт: партии загружаются из снапшотов, ожидающий ход движка доигрывается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = createFakeEngine({ script: ['E5'], delayMs: 100 });
    const first = await make(slow);
    const g = await first.service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await first.service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    const closing = first.service.close(); // ответ движка не успел
    // close обрывает раздумье сигналом: даже когда часы доходят до срока ответа, хода к закрытой партии нет.
    await thinkThrough(slow, 1, 100);
    await closing;

    const fast = createFakeEngine({ script: ['G7'], delayMs: 50 });
    // Тот же набор снапшотов: второй сервис читает то, что записал первый.
    const second = await make(fast, { store: first.store });
    expect(second.service.get(g.state.id).moves.map((m) => m.coord)).toEqual(['D4']);
    await thinkThrough(fast, 1, 50);
    await untilTick(() => second.service.get(g.state.id).moves.length === 2);
    expect(second.service.get(g.state.id).moves[1]?.coord).toBe('G7');
    expect(second.service.list()[0]).toMatchObject({ id: g.state.id, moveCount: 2, status: 'playing' });
  });

  it('list отдаёт партии новыми вперёд и с результатом', async () => {
    // Часы партии задаются явно: две партии подряд иначе попадают в одну миллисекунду
    // и порядок в list становится произвольным.
    let clock = Date.parse('2026-09-07T10:00:00.000Z');
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { now: () => new Date((clock += 1000)) });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const b = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.resign(a.state.id, { color: 'B', via: 'api' });
    const list = service.list();
    expect(list.map((x) => x.id)).toEqual([b.state.id, a.state.id]);
    // Время создания взято у переданных часов, а не у системных: иначе две партии
    // подряд легли бы в одну миллисекунду и порядок держался бы на удаче.
    // Сколько раз часы прочитаны (init — для срока хранения, create — ещё и для лимита), тесту не важно.
    expect(list.map((x) => x.createdAt)).toEqual([b.state.createdAt, a.state.createdAt]);
    expect(Date.parse(b.state.createdAt)).toBeGreaterThan(Date.parse(a.state.createdAt));
    expect(a.state.createdAt.startsWith('2026-09-07T10:00:')).toBe(true);
    expect(list[1]).toMatchObject({ result: { winner: 'W', reason: 'resign' }, moveCount: 0 });
    expect(list[0]?.result).toBeUndefined();
  });

  it('движок недоступен: событие error, партия не портится, потом ход всё же приходит', async () => {
    let fail = 2;
    const inner = createFakeEngine({ script: ['E5'] });
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        if (fail-- > 0) throw new Error('fetch failed');
        return inner.genmove(req);
      },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(10) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(res.replyTimedOut).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // Две неудачи подряд: ход приходит только после двух пауз перед повтором.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => service.get(g.state.id).moves.length === 2);
    expect(service.get(g.state.id).moves[1]?.coord).toBe('E5');
  });

  it('движок предложил нелегальный ход: в партию идёт пас, в лог — предупреждение', async () => {
    const lines: string[] = [];
    const { service } = await make(createFakeEngine({ script: ['D4'] }), { log: (l: string) => lines.push(l) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(res.reply?.coord).toBe('pass');
    expect(lines.some((l) => l.includes('D4'))).toBe(true);
  });

  it('счёт недоступен: партия остаётся playing до успешного повтора', async () => {
    let fail = 1;
    const inner = createFakeEngine();
    const flaky: Engine = {
      ...inner,
      score: async (req) => {
        if (fail-- > 0) throw new Error('score failed');
        return inner.score(req);
      },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(10) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    await vi.advanceTimersByTimeAsync(10); // пауза перед повтором счёта
    await untilTick(() => service.get(g.state.id).status === 'finished');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(service.get(g.state.id).result?.reason).toBe('score');
  });

  it('движок сдаётся после 60-го хода при winrate < 3 % и отставании > 25', async () => {
    const inner = createFakeEngine();
    const losing: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), winrateB: 0.99, scoreLeadB: 40 }) };
    const { service } = await make(losing);
    const g = await service.create({ ...HUMAN_BLACK, settings: { boardSize: 13 }, waitForReply: true });
    const id = g.state.id;
    // Ходы человека берём у второго фейкового движка: они легальны и не пасы (пас вёл бы к автосчёту).
    const human = createFakeEngine({ passAfterPass: false });
    for (let i = 0; i < 40; i++) {
      const s = service.get(id);
      if (s.status === 'finished') break;
      const mv = await human.genmove({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: s.moves.map((m) => [m.color, m.coord] as [Color, string]), rank: '10k' });
      await service.play(id, { coord: mv.move, waitForReply: true, via: 'api' });
    }
    const state = service.get(id);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ winner: 'B', reason: 'resign' });
    // Движок играет белыми и оценивает позицию на нечётной длине партии:
    // «после 60-го хода» — это ровно 61 ход на доске, ни ходом позже.
    expect(state.moves).toHaveLength(61);
  });

  it('движок не сдаётся, пока winrate выше порога', async () => {
    const inner = createFakeEngine();
    // Отставание по очкам есть, но winrate выше 3 %: сдачи быть не должно.
    const stubborn: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), winrateB: 0.9, scoreLeadB: 40 }) };
    const { service } = await make(stubborn);
    const g = await service.create({ ...HUMAN_BLACK, settings: { boardSize: 13 }, waitForReply: true });
    const id = g.state.id;
    const human = createFakeEngine({ passAfterPass: false });
    for (let i = 0; i < 35; i++) {
      const s = service.get(id);
      if (s.status === 'finished') break;
      const mv = await human.genmove({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: s.moves.map((m) => [m.color, m.coord] as [Color, string]), rank: '10k' });
      await service.play(id, { coord: mv.move, waitForReply: true, via: 'api' });
    }
    expect(service.get(id).status).toBe('playing');
    expect(service.get(id).moves.length).toBeGreaterThan(60);
  });

  it('движок не сдаётся, пока отставание меньше порога', async () => {
    const inner = createFakeEngine();
    // Winrate ниже порога, но отставание всего 10 очков.
    const stubborn: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), winrateB: 0.99, scoreLeadB: 10 }) };
    const { service } = await make(stubborn);
    const g = await service.create({ ...HUMAN_BLACK, settings: { boardSize: 13 }, waitForReply: true });
    const id = g.state.id;
    const human = createFakeEngine({ passAfterPass: false });
    for (let i = 0; i < 35; i++) {
      const s = service.get(id);
      if (s.status === 'finished') break;
      const mv = await human.genmove({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: s.moves.map((m) => [m.color, m.coord] as [Color, string]), rank: '10k' });
      await service.play(id, { coord: mv.move, waitForReply: true, via: 'api' });
    }
    expect(service.get(id).status).toBe('playing');
    expect(service.get(id).moves.length).toBeGreaterThan(60);
  });

  it('not_your_turn для хода за движок, unsupported_controller для external', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 100 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await expect(service.play(g.state.id, { coord: 'C3', color: 'W', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'not_your_turn' });
    await expect(service.create({ black: { controller: 'external' }, white: { controller: 'engine', rank: '10k' }, waitForReply: true })).rejects.toMatchObject({ code: 'unsupported_controller' });
    await expect(service.create({ black: { controller: 'human' }, white: { controller: 'external' }, waitForReply: true })).rejects.toMatchObject({ code: 'unsupported_controller' });
  });

  it('два места engine отклоняются при создании: unsupported_controller, партии и записи нет', async () => {
    const engine = createFakeEngine();
    const { service, store } = await make(engine);
    const err = service.create({ black: { controller: 'engine', rank: '10k' }, white: { controller: 'engine' }, ...S9, waitForReply: false });
    await expect(err).rejects.toMatchObject({ code: 'unsupported_controller', details: { black: 'engine', white: 'engine' } });
    expect(service.list()).toEqual([]);
    expect(await store.load()).toEqual([]);
    await tick(5);
    expect(engine.calls.genmove).toBe(0);
    // Одно место engine — как обычно, в любом порядке цветов.
    expect((await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false })).state.status).toBe('playing');
    expect((await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false })).state.status).toBe('playing');
  });

  it('analyze, score, ascii, sgf, setRank', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    const a = await service.analyze(id, { maxVisits: 50 });
    expect(a.ownership).toHaveLength(81);
    expect(a.groups.map((x) => x.stones)).toEqual([['D4'], ['E5']]);
    expect(a.groups[0]).toMatchObject({ color: 'B', liberties: 4, status: 'safe' });
    expect(a.topMoves.length).toBeGreaterThan(0);
    expect(a.visits).toBe(50);
    const sc = await service.score(id);
    expect(sc).toMatchObject({ reason: 'score', score: { areaB: 1, areaW: 1, komi: 7.5 } });
    expect(service.get(id).status).toBe('playing');
    const ascii = service.ascii(id);
    expect(ascii.split('\n')[0]).toMatch(/^# \w+ rev \d+ playing toPlay B moves 2$/);
    expect(ascii).toContain('(O)');
    expect(service.sgf(id)).toBe('(;FF[4]GM[1]CA[UTF-8]SZ[9]KM[7.5]RU[Chinese]PB[Human]PW[Goko 10k];B[df];W[ee])');
    const r = await service.setRank(id, { color: 'W', rank: '5k' });
    expect(r.state.seats.W.rank).toBe('5k');
    expect(service.sgf(id)).toContain('PW[Goko 5k]');
  });

  it('sgf: метка места и результат сдачи', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ black: { controller: 'human', label: 'Pavel' }, white: { controller: 'engine', rank: '3k' }, ...S9, waitForReply: true });
    await service.resign(g.state.id, { color: 'B', via: 'api' });
    const sgf = service.sgf(g.state.id);
    expect(sgf).toContain('PB[Pavel]');
    expect(sgf).toContain('PW[Goko 3k]');
    expect(sgf).toContain('RE[W+R]');
  });

  it('sgf по счёту несёт перевес', async () => {
    // Снапшоты в памяти и без ожидания ответа. Прежде тест писал три снапшота на диск и ждал ответа
    // до 500 мс настоящего времени, а конец партии ждал по числу оборотов очереди: под нагрузкой
    // запись на диск шла дольше, чем крутились обороты, и тест падал. Без ввода-вывода и таймеров
    // вся цепочка (пас, ответ движка, счёт, три коммита) — только микрозадачи.
    const store = memoryStore();
    const { service } = await make(createFakeEngine(), { store });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.pass(g.state.id, { waitForReply: false, via: 'api' });
    await untilTick(() => service.get(g.state.id).status === 'finished', 50);
    expect(store.saved.map((st) => st.status)).toEqual(['playing', 'playing', 'playing', 'finished']);
    expect(service.sgf(g.state.id)).toContain('RE[W+7.5]');
  });

  it('чужое изменение во время ожидания ответа не выдаётся за ход движка', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 200 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    const pending = service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    // Ход человека уже применён, ответа движка ещё нет: часы для этого двигать не нужно.
    await untilTick(() => service.get(id).pendingEngineMove);
    // setRank двигает ревизию, но ходом движка не является: ответом его выдавать нельзя.
    await service.setRank(id, { color: 'W', rank: '5k' });
    const res = await pending;
    expect(res.reply).toBeUndefined();
    expect(res.replyTimedOut).toBeUndefined();
  });

  it('движок ходит первым: сдача ровно после 60-го хода, не на 60-м', async () => {
    const inner = createFakeEngine();
    // Движок играет чёрными, поэтому оценивает позицию на чётной длине партии:
    // граница «после 60-го хода» отличима от «начиная с 60-го».
    const losing: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), winrateB: 0.01, scoreLeadB: -40 }) };
    const { service } = await make(losing);
    const g = await service.create({ ...ENGINE_BLACK, settings: { boardSize: 13 }, waitForReply: true });
    const id = g.state.id;
    const human = createFakeEngine({ passAfterPass: false });
    for (let i = 0; i < 40; i++) {
      const s = service.get(id);
      if (s.status === 'finished') break;
      const mv = await human.genmove({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: s.moves.map((m) => [m.color, m.coord] as [Color, string]), rank: '10k' });
      await service.play(id, { coord: mv.move, waitForReply: true, via: 'api' });
    }
    const state = service.get(id);
    expect(state.result).toMatchObject({ winner: 'W', reason: 'resign' });
    expect(state.moves).toHaveLength(62);
  });

  it('на одну партию идёт одна задача движка', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5', 'F6'], delayMs: 150 });
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    // Коммит во время раздумья не должен поднимать вторую задачу движка: ход,
    // придуманный для устаревшей ревизии, переигрывает та же самая задача.
    await service.setRank(id, { color: 'W', rank: '5k' });
    await thinkThrough(engine, 1, 150); // ход для устаревшей ревизии
    await thinkThrough(engine, 2, 150); // повтор той же задачей
    await untilTick(() => service.get(id).moves.length === 2);
    expect(events.filter((e) => e.type === 'engine.thinking')).toHaveLength(2);
    expect(engine.calls.genmove).toBe(2);
  });

  it('ход за движок разрешён вызывающему by engine', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 300 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    const res = await service.play(id, { coord: 'F6', color: 'W', waitForReply: false, via: 'api' }, 'engine');
    expect(res.move).toMatchObject({ n: 2, color: 'W', coord: 'F6' });
  });

  it('ход не своим цветом отвергается правилами партии, а не проверкой места', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 200 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    // Место чёрных — человек, но сейчас очередь белых: отказ приходит из applyMove.
    await expect(service.play(id, { coord: 'C3', color: 'B', waitForReply: false, via: 'api' })).rejects.toMatchObject({
      code: 'not_your_turn',
      message: 'it is white to play',
    });
  });

  it('game.finished публикуется один раз', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.resign(g.state.id, { color: 'B', via: 'api' });
    const events = record(bus, `game:${g.state.id}`);
    await service.setRank(g.state.id, { color: 'W', rank: '5k' });
    expect(events.filter((e) => e.type === 'game.finished')).toHaveLength(0);
  });

  it('после close новые коммиты не поднимают движок', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5'] });
    const { service } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await closeWithin(service);
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(res.state.pendingEngineMove).toBe(true);
    await tick(10);
    expect(engine.calls.genmove).toBe(0);
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });

  it('после close фоновые задачи не ставятся: вращение ловится счётчиком startTask, а не зависанием', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5'] });
    const { service } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const guarded = opened.at(-1);
    if (!guarded) throw new Error('сервис не под guardService');
    await closeWithin(service);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await tick(10);
    expect(guarded.startsAfterClose()).toBe(0);
    expect(engine.calls.genmove).toBe(0);
  });

  it('откат во время повтора счёта прекращает счёт', async () => {
    const inner = createFakeEngine();
    let scoreCalls = 0;
    const flaky: Engine = {
      ...inner,
      score: async () => {
        scoreCalls++;
        throw new Error('score failed');
      },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(80) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    await service.undo(g.state.id, { via: 'api' });
    // Три паузы повтора подряд: задача счёта должна была прекратиться на первой же.
    await vi.advanceTimersByTimeAsync(240);
    await tick(5);
    expect(scoreCalls).toBe(1);
    expect(service.get(g.state.id).status).toBe('playing');
  });

  it('движку уходит ранг его места', async () => {
    const inner = createFakeEngine({ script: ['E5', 'F6'] });
    const ranks: string[] = [];
    const spy: Engine = {
      ...inner,
      genmove: async (req) => {
        ranks.push(req.rank);
        return inner.genmove(req);
      },
    };
    const { service } = await make(spy);
    const g = await service.create({ black: { controller: 'human' }, white: { controller: 'engine', rank: '3k' }, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    await service.setRank(g.state.id, { color: 'W', rank: '7k' });
    await service.play(g.state.id, { coord: 'C3', waitForReply: true, via: 'api' });
    expect(ranks).toEqual(['3k', '7k']);
  });

  it('correct во время раздумья движка: ответ всё равно приходит', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5', 'F6'], delayMs: 120 });
    const { service } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => service.get(id).pendingEngineMove);
    const correcting = service.correct(id, { coord: 'D5', waitForReply: true, via: 'voice' });
    // Часы двигаются только после того, как исправление записано: иначе первое
    // раздумье успело бы примениться к ещё не изменившейся ревизии.
    await untilTick(() => service.get(id).moves.map((m) => m.coord).join() === 'D5');
    await vi.advanceTimersByTimeAsync(120); // первое раздумье кончается впустую
    await thinkThrough(engine, 2, 120);
    const res = await correcting;
    expect(res.reply).toMatchObject({ coord: 'F6' });
    expect(res.state.moves.map((m) => m.coord)).toEqual(['D5', 'F6']);
  });

  it('код ApiError движка попадает в событие error', async () => {
    const inner = createFakeEngine({ script: ['E5'] });
    let fail = 1;
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        if (fail-- > 0) throw new ApiError('engine_busy', 'queue is full');
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(10) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'engine_busy', message: 'queue is full' });
  });

  it('close останавливает движок: ожидающий получает состояние без ответа', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 100 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const pending = service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    await untilTick(() => service.get(g.state.id).pendingEngineMove);
    await closeWithin(service);
    const res = await pending;
    expect(res.reply).toBeUndefined();
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });
});

describe('GameService: фоновые задачи, дедлайны и мьютекс', () => {
  // Снапшот, который отдаёт управление и умеет падать или ждать на нужном ходе.
  function gatedStore(real: SnapshotStore, hook: (state: GameState) => Promise<void>): SnapshotStore {
    return {
      load: () => real.load(),
      save: async (state: GameState) => {
        await hook(state);
        return real.save(state);
      },
    } as unknown as GameStore;
  }

  it('отказ записи снапшота в фоновой задаче не роняет процесс, а уходит событием error', async () => {
    const real = memoryStore();
    // Падает ровно на коммите хода движка: этот коммит идёт из фоновой задачи,
    // которую никто не ждёт, поэтому неперехваченный отказ убил бы процесс.
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) throw new Error('disk is full');
    });
    const { service, bus } = await make(createFakeEngine({ script: ['E5'] }), { store });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toEqual({ type: 'error', gameId: g.state.id, code: 'internal', message: 'internal server error' });
    // Партия осталась на последнем удачно записанном состоянии.
    expect(service.get(g.state.id).moves).toHaveLength(1);
    await closeWithin(service);
  });

  it('сырое исключение фоновой задачи: наружу код и общий текст, путь к снапшоту только в лог', async () => {
    const real = memoryStore();
    const secretPath = path.join(dir, 'abc.json.4242.tmp');
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${secretPath}'`), { code: 'ENOSPC' });
    });
    const lines: string[] = [];
    const { service, bus } = await make(createFakeEngine({ script: ['E5'] }), { store, log: (l: string) => lines.push(l) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const gameEvents = record(bus, `game:${g.state.id}`);
    const sessionEvents = record(bus, 'session:s1');
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => gameEvents.some((e) => e.type === 'error'));
    const expected = { type: 'error', gameId: g.state.id, code: 'internal', message: 'internal server error' };
    expect(gameEvents.filter((e) => e.type === 'error')).toEqual([expected]);
    expect(sessionEvents.filter((e) => e.type === 'error')).toEqual([expected]);
    expect(JSON.stringify([...gameEvents, ...sessionEvents])).not.toContain('abc.json');
    expect(lines.some((l) => l.startsWith('[X]') && l.includes(secretPath))).toBe(true);
    await closeWithin(service);
  });

  it('сырое исключение движка: наружу engine_unavailable и общий текст, подробности в лог', async () => {
    let fail = 1;
    const inner = createFakeEngine({ script: ['E5'] });
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        if (fail-- > 0) throw new Error('connect ECONNREFUSED 10.0.0.7:8788');
        return inner.genmove(req);
      },
    };
    const lines: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service, bus } = await make(flaky, { store: memoryStore(), log: (l: string) => lines.push(l) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toEqual({ type: 'error', gameId: g.state.id, code: 'engine_unavailable', message: 'engine is unavailable' });
    expect(lines.some((l) => l.includes('ECONNREFUSED 10.0.0.7:8788'))).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    await untilTick(() => service.get(g.state.id).moves.length === 2);
  });

  it('код ApiError из фоновой задачи попадает в событие error как есть', async () => {
    const real = memoryStore();
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) throw new ApiError('bad_request', 'snapshot rejected');
    });
    const { service, bus } = await make(createFakeEngine({ script: ['E5'] }), { store });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    // Свой код ошибки не подменяется на internal: по нему вызывающий отличает
    // отказ движка от внутренней поломки.
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'bad_request', message: 'snapshot rejected' });
    await closeWithin(service);
  });

  it('close дожидается фоновой записи снапшота', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    let saved = false;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) {
        await new Promise<void>((r) => {
          release = r;
        });
        saved = true;
      }
    });
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { store });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => release !== undefined);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await tick(); // задача ещё пишет снапшот: close возвращаться не вправе
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(saved).toBe(true);
  });

  it('session.game уходит после записи снапшота: в момент события партия уже есть в сервисе', async () => {
    const { service, bus } = await make(createFakeEngine());
    const found: string[] = [];
    bus.subscribe('session:s1', (e) => {
      if (e.type === 'session.game') found.push(service.get(e.gameId).id);
    });
    const created = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: true }, { sessionId: 's1' });
    expect(found).toEqual([created.state.id]);
    // Коммиты с другой причиной session.game не шлют: ход в партии сессии — только state.updated.
    const seen = record(bus, 'session:s1');
    await service.play(created.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(seen.map((e) => e.type)).toEqual(['state.updated']);
  });

  it('отказ записи снапшота новой партии: session.game нет, create отклоняется', async () => {
    const real = memoryStore();
    let failed = false;
    const store = gatedStore(real, async () => {
      if (failed) return;
      failed = true;
      throw new Error('disk full');
    });
    const { service, bus } = await make(createFakeEngine(), { store });
    const seen = record(bus, 'session:s1');
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: true }, { sessionId: 's1' })).rejects.toThrow('disk full');
    expect(seen).toEqual([]);
    expect(service.list()).toEqual([]);
    // Следующая партия той же сессии объявляется как обычно.
    const created = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: true }, { sessionId: 's1' });
    expect(seen[0]).toEqual({ type: 'session.game', gameId: created.state.id });
  });

  it('отказ записи новой партии сессии не оставляет в памяти ни привязки к сессии, ни ожидающего первого хода', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async () => {
      if (failures-- > 0) throw new Error('disk full');
    });
    const engine = createFakeEngine({ script: ['C3'] });
    // replyTimeoutMs по умолчанию (8 с), часы стоят: ожидающий, оставшийся от отказа, никто не разбудил бы.
    const { service, bus } = await make(engine, { store, replyTimeoutMs: undefined });
    const seen = record(bus, 'session:s1');
    await expect(service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true }, { sessionId: 's1' })).rejects.toThrow('disk full');
    expect(service.internalSizes()).toEqual({ sessionsByGame: 0, currentGames: 0, clientGames: 0, waiters: 0, gaveUp: 0, taskAborts: 0, reopening: 0 });
    expect(seen).toEqual([]);
    expect(engine.calls.genmove).toBe(0);
    // Следующая партия той же сессии: объявляется, движок отвечает, ожидающий получает ход.
    const created = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true }, { sessionId: 's1' });
    expect(created.firstMove).toMatchObject({ coord: 'C3' });
    expect(seen[0]).toEqual({ type: 'session.game', gameId: created.state.id });
    // Задача движка к этому моменту может ещё не выйти: её сигнал в таблице не проверяется.
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 1, currentGames: 1, waiters: 0, gaveUp: 0 });
    await closeWithin(service);
    expect(service.internalSizes()).toEqual({ sessionsByGame: 1, currentGames: 1, clientGames: 0, waiters: 0, gaveUp: 0, taskAborts: 0, reopening: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ записи новой партии без сессии и без ожидания: память пуста, отказ тот же', async () => {
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async () => {
      if (failures-- > 0) throw new Error('disk full');
    });
    const { service } = await make(createFakeEngine(), { store });
    await expect(service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false })).rejects.toThrow('disk full');
    expect(service.internalSizes()).toEqual({ sessionsByGame: 0, currentGames: 0, clientGames: 0, waiters: 0, gaveUp: 0, taskAborts: 0, reopening: 0 });
    expect(service.list()).toEqual([]);
  });

  it('отказ записи хода с ожиданием ответа не оставляет ожидающего (play)', async () => {
    const real = memoryStore();
    let failNext = false;
    const store = { load: () => real.load(), save: async (state: GameState) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return real.save(state);
    } } as unknown as GameStore;
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { store, replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    failNext = true;
    await expect(service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' })).rejects.toThrow('disk full');
    expect(service.internalSizes().waiters).toBe(0);
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    expect(res.reply).toMatchObject({ coord: 'E5' });
    expect(service.internalSizes().waiters).toBe(0);
  });

  it('отказ записи correct снимает только своего ожидающего: ожидающий прежнего хода получает ответ движка', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failNext = false;
    const store = { load: () => real.load(), save: async (state: GameState) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return real.save(state);
    } } as unknown as GameStore;
    const engine = createFakeEngine({ script: ['E5'], delayMs: 100 });
    const { service } = await make(engine, { store, replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const playing = service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    await untilTick(() => engine.calls.genmove === 1);
    expect(service.internalSizes().waiters).toBe(1);
    failNext = true;
    await expect(service.correct(g.state.id, { coord: 'C3', waitForReply: true, via: 'voice' })).rejects.toThrow('disk full');
    expect(service.internalSizes().waiters).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    const res = await playing;
    expect(res.reply).toMatchObject({ coord: 'E5' });
    expect(service.internalSizes().waiters).toBe(0);
  });

  it('чужое изменение во время ожидания первого хода движка — не таймаут', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['C3'], delayMs: 300 }), { replyTimeoutMs: 3000 });
    let id = '';
    // session.game публикуется после записи снапшота, но до хода движка: идентификатор известен раньше возврата create.
    bus.subscribe('session:s1', (e) => {
      if (e.type === 'session.game') id = e.gameId;
    });
    const creating = service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true }, { sessionId: 's1' });
    await untilTick(() => {
      try {
        return id !== '' && service.get(id).pendingEngineMove;
      } catch {
        return false;
      }
    });
    await service.resign(id, { color: 'W', via: 'api' });
    const created = await creating;
    expect(created.firstMove).toBeUndefined();
    expect(created.replyTimedOut).toBeUndefined();
    expect(created.state.status).toBe('finished');
  });

  it('мьютекс партии: два хода подряд без ожидания применяются по очереди', async () => {
    const real = memoryStore();
    // Запись отдаёт управление: без мьютекса второй ход успел бы прочитать состояние
    // до коммита первого и переписал бы его.
    const store = gatedStore(real, async () => {
      await new Promise((r) => setImmediate(r));
    });
    const { service } = await make(createFakeEngine(), { store });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const [first, second] = await Promise.all([
      service.play(id, { coord: 'D4', waitForReply: false, via: 'api' }),
      service.play(id, { coord: 'E5', waitForReply: false, via: 'api' }),
    ]);
    expect(first.move).toMatchObject({ n: 1, color: 'B', coord: 'D4' });
    expect(second.move).toMatchObject({ n: 2, color: 'W', coord: 'E5' });
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['D4', 'E5']);
    expect(service.get(id).revision).toBe(2);
  });

  it('score не ждёт движок дольше 20 с, analyze — дольше 10 с', async () => {
    expect(SCORE_BUDGET_MS).toBe(20_000);
    expect(ANALYZE_BUDGET_MS).toBe(10_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    const stuck: Engine = { ...inner, score: () => new Promise(() => {}), analyze: () => new Promise(() => {}) };
    const { service } = await make(stuck);
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;

    const scoring = service.score(id);
    const scoringState = track(scoring);
    const scoreFails = expect(scoring).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 20000 ms' });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(scoringState.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await scoreFails;

    const analyzing = service.analyze(id, { maxVisits: 50 });
    const analyzingState = track(analyzing);
    const analyzeFails = expect(analyzing).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 10000 ms' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(analyzingState.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await analyzeFails;
  });

  it('бюджет ожидания задаётся вызывающим и не мешает быстрому ответу', async () => {
    const { service } = await make(createFakeEngine(), { scoreBudgetMs: 50, analyzeBudgetMs: 50 });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect((await service.score(g.state.id)).reason).toBe('score');
    expect((await service.analyze(g.state.id, { maxVisits: 50 })).visits).toBe(50);
  });

  it('create не ждёт ответа, когда первым ходит человек', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Часы стоят: ожидание ответа движка не смогло бы закончиться таймаутом.
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const created = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    expect(created.firstMove).toBeUndefined();
    expect(created.replyTimedOut).toBeUndefined();
    expect(created.state.pendingEngineMove).toBe(false);
  });

  it('topMoves — не больше пяти лучших ходов движка', async () => {
    const inner = createFakeEngine();
    const many: Engine = {
      ...inner,
      analyze: async () => ({
        visits: 50,
        winrateB: 0.5,
        scoreLeadB: 0,
        moveInfos: ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1'].map((coord, order) => ({ coord, winrateB: 0.5, scoreLeadB: 0, visits: 7 - order, order })),
        ownership: new Array<number>(81).fill(0),
      }),
    };
    const { service } = await make(many);
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const a = await service.analyze(g.state.id, { maxVisits: 50 });
    expect(a.topMoves.map((m) => m.coord)).toEqual(['A1', 'B1', 'C1', 'D1', 'E1']);
  });

  it('движку на ход уходит maxVisits 10', async () => {
    const inner = createFakeEngine({ script: ['E5'] });
    const visits: (number | undefined)[] = [];
    const spy: Engine = {
      ...inner,
      genmove: async (req) => {
        visits.push(req.maxVisits);
        return inner.genmove(req);
      },
    };
    const { service } = await make(spy);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(visits).toEqual([10]);
  });

  it('коми партии уходит движку и попадает в результат', async () => {
    const inner = createFakeEngine();
    const komis: number[] = [];
    const spy: Engine = {
      ...inner,
      genmove: async (req) => {
        komis.push(req.komi);
        return inner.genmove(req);
      },
      score: async (req) => {
        komis.push(req.komi);
        return inner.score(req);
      },
    };
    const { service } = await make(spy);
    const g = await service.create({ ...HUMAN_BLACK, settings: { boardSize: 9, komi: 6.5 }, waitForReply: true });
    await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    await untilTick(() => service.get(g.state.id).status === 'finished');
    expect(komis).toEqual([6.5, 6.5]);
    expect(service.get(g.state.id).result).toMatchObject({ winner: 'W', margin: 6.5 });
    expect(service.get(g.state.id).result?.score?.komi).toBe(6.5);
  });

  it('откат во время удачного счёта не завершает партию задним числом', async () => {
    const inner = createFakeEngine();
    let release: (() => void) | undefined;
    let answered = false;
    const gated: Engine = {
      ...inner,
      score: async (req) => {
        await new Promise<void>((r) => {
          release = r;
        });
        const r = await inner.score(req);
        answered = true;
        return r;
      },
    };
    const { service } = await make(gated);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.pass(id, { waitForReply: true, via: 'api' }); // пас человека и пас движка
    await untilTick(() => release !== undefined);
    // Откат, пока счёт ещё считается: применять его к новой ревизии нельзя.
    await service.undo(id, { via: 'api' });
    release?.();
    await untilTick(() => answered);
    await tick();
    // Барьер мьютекса: своей очереди задача счёта дождалась раньше этой операции,
    // поэтому после её возврата видно всё, что счёт успел сделать.
    await service.setRank(id, { color: 'W', rank: '5k' });
    expect(service.get(id).status).toBe('playing');
    expect(service.get(id).moves).toEqual([]);
    expect(service.get(id).result).toBeUndefined();
  });

  it('умолчание ожидания ответа — 8 с, по шагам таймера', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Движок думает дольше любого разумного ожидания: важно, когда вернётся play.
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 60_000 }), { replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const playing = service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    const state = track(playing);
    // Таймер ожидания заводится после записи снапшота: до этого двигать часы рано.
    await untilTick(() => service.get(id).moves.length === 1);
    await tick();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await playing).replyTimedOut).toBe(true);
    // Досчитываем раздумье движка, чтобы фоновая задача завершилась до close.
    await vi.advanceTimersByTimeAsync(60_000);
    await untilTick(() => service.get(id).moves.length === 2);
    expect(service.get(id).moves[1]?.coord).toBe('E5');
  });

  it('умолчание паузы перед повтором — 5 с, и close её не ждёт', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    let calls = 0;
    const down: Engine = {
      ...inner,
      genmove: async () => {
        calls++;
        throw new ApiError('engine_unavailable', 'engine is unreachable');
      },
    };
    const { service, bus } = await make(down, { retryDelaysMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await tick(10);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    await tick();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(calls).toBe(2);
    // Часы стоят: если бы close ждал паузу целиком, он не вернулся бы никогда.
    await closeWithin(service);
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });

  it('play не ждёт ответа, когда движку ходить не нужно', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Часы стоят: ожидание ответа в партии без движка не смогло бы закончиться таймаутом.
    const { service } = await make(createFakeEngine());
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(res.reply).toBeUndefined();
    expect(res.replyTimedOut).toBeUndefined();
  });

  it('движок без владения: анализ отдаёт нули по числу точек', async () => {
    const inner = createFakeEngine();
    const noOwnership: Engine = { ...inner, analyze: async () => ({ visits: 10, winrateB: 0.5, scoreLeadB: 0, moveInfos: [] }) };
    const { service } = await make(noOwnership);
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const a = await service.analyze(g.state.id, { maxVisits: 10 });
    expect(a.ownership).toHaveLength(81);
    expect(a.ownership.every((v) => v === 0)).toBe(true);
  });

  it('бюджеты ожидания берутся из настроек вызывающего', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service } = await make(createFakeEngine({ delayMs: 60_000 }), { scoreBudgetMs: 50, analyzeBudgetMs: 30 });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const scoreFails = expect(service.score(id)).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 50 ms' });
    await vi.advanceTimersByTimeAsync(50);
    await scoreFails;
    const analyzeFails = expect(service.analyze(id, { maxVisits: 50 })).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 30 ms' });
    await vi.advanceTimersByTimeAsync(30);
    await analyzeFails;
    // Досыпаем задержку фейкового движка, чтобы его промисы не остались в полёте.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('после ответа движка таймер бюджета снят', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service } = await make(createFakeEngine());
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.score(g.state.id);
    // Незакрытый бюджет держал бы событийный цикл ещё 15 с после ответа.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('откат во время паузы повтора прекращает ход движка', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let fail = 1;
    let calls = 0;
    const inner = createFakeEngine({ script: ['E5'] });
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        calls++;
        if (fail-- > 0) throw new ApiError('engine_unavailable', 'engine is unreachable');
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(100) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    // Пока задача спит перед повтором, ход человека откатан: движку ходить больше не нужно.
    await service.undo(id, { via: 'api' });
    await vi.advanceTimersByTimeAsync(100);
    await tick(5);
    expect(calls).toBe(1);
    expect(service.get(id).moves).toEqual([]);
  });

  it('close будит ожидающего, не дожидаясь таймаута ответа', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release: (() => void) | undefined;
    const inner = createFakeEngine({ script: ['E5'] });
    const gated: Engine = {
      ...inner,
      genmove: async (req) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return inner.genmove(req);
      },
    };
    const { service } = await make(gated, { replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const playing = service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    await untilTick(() => release !== undefined);
    // Часы стоят: ожидающего может снять только close, а не таймаут в 8 с.
    const closing = service.close();
    const res = await playing;
    expect(res.reply).toBeUndefined();
    release?.();
    await closing;
    expect(service.get(id).moves).toHaveLength(1);
  });

  it('после ответа движка таймер ожидания снят', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    // Незакрытый таймер ожидания висел бы ещё 8 с после пришедшего ответа.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close снимает таймер паузы перед повтором, а не только будит её', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'] });
    const down: Engine = {
      ...inner,
      genmove: async () => {
        throw new ApiError('engine_unavailable', 'engine is unreachable');
      },
    };
    const { service, bus } = await make(down, { retryDelaysMs: delays(1000) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    await closeWithin(service);
    // Разбуженная пауза обязана снять свой таймер: иначе он держал бы событийный
    // цикл ещё секунду после остановки сервера.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close дожидается задачи счёта', async () => {
    let release: (() => void) | undefined;
    let scored = false;
    const inner = createFakeEngine();
    const gated: Engine = {
      ...inner,
      score: async (req) => {
        await new Promise<void>((r) => {
          release = r;
        });
        const r = await inner.score(req);
        scored = true;
        return r;
      },
    };
    const { service } = await make(gated);
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => release !== undefined);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await tick(); // счёт ещё идёт: close возвращаться не вправе
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(scored).toBe(true);
    // Счёт досчитан уже после close: итог к закрытому сервису не применяется, как и ход движка.
    // После рестарта init снова поставит счёт по двум пасам.
    expect(service.get(id).status).toBe('playing');
    expect(service.get(id).result).toBeUndefined();
  });

  // Счёт с воротами на каждом вызове: тест сам отпускает вызовы по одному.
  function gatedScore() {
    const releases: (() => void)[] = [];
    const seenMoves: number[] = [];
    const inner = createFakeEngine();
    const engine: Engine = {
      ...inner,
      score: async (req) => {
        seenMoves.push(req.moves.length);
        await new Promise<void>((r) => {
          releases.push(r);
        });
        return inner.score(req);
      },
    };
    return { engine, releases, seenMoves };
  }

  it('коммит во время счёта: вторая задача не поднимается, счёт повторяется по новой ревизии', async () => {
    const { engine, releases, seenMoves } = gatedScore();
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.pass(id, { waitForReply: true, via: 'api' }); // пас человека и пас движка
    await untilTick(() => releases.length === 1);
    const events = record(bus, `game:${id}`);
    await service.setRank(id, { color: 'W', rank: '5k' });
    await tick(5);
    // Коммит во время счёта не поднимает вторую задачу счёта.
    expect(releases).toHaveLength(1);
    releases[0]?.();
    // Ревизия сменилась: результат отброшен, та же задача считает заново.
    await untilTick(() => releases.length === 2);
    expect(service.get(id).status).toBe('playing');
    releases[1]?.();
    await untilTick(() => service.get(id).status === 'finished');
    const state = service.get(id);
    expect(state.result?.reason).toBe('score');
    expect(state.seats.W.rank).toBe('5k');
    expect(seenMoves).toEqual([2, 2]);
    expect(events.filter((e) => e.type === 'game.finished')).toHaveLength(1);
  });

  it('третий пас во время счёта: счёт повторяется и партия завершается по последней позиции', async () => {
    const { engine, releases, seenMoves } = gatedScore();
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.pass(id, { waitForReply: true, via: 'api' });
    await untilTick(() => releases.length === 1);
    const events = record(bus, `game:${id}`);
    // Человек у доски говорит «пас» ещё раз, пока сервер считает.
    const third = await service.pass(id, { waitForReply: true, via: 'voice' });
    expect(third.state.consecutivePasses).toBe(3);
    expect(third.reply).toBeUndefined();
    await tick(5);
    expect(releases).toHaveLength(1);
    releases[0]?.();
    await untilTick(() => releases.length === 2);
    expect(service.get(id).status).toBe('playing');
    releases[1]?.();
    await untilTick(() => service.get(id).status === 'finished');
    expect(service.get(id).result?.reason).toBe('score');
    expect(service.get(id).moves).toHaveLength(3);
    expect(seenMoves).toEqual([2, 3]);
    expect(events.filter((e) => e.type === 'game.finished')).toHaveLength(1);
  });

  it('close раньше отказа движка: пауза перед повтором не начинается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let fail: ((e: Error) => void) | undefined;
    let calls = 0;
    const inner = createFakeEngine();
    const gated: Engine = {
      ...inner,
      genmove: () => {
        calls++;
        return new Promise((_, reject) => {
          fail = reject;
        });
      },
    };
    // Пауза по умолчанию — 5 с; часы стоят, поэтому начатую паузу не кончило бы ничто.
    const { service } = await make(gated, { retryDelaysMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => fail !== undefined);
    // Порядок остановки сервера: close приходит, пока запрос к движку в полёте.
    const closing = track(service.close());
    await tick();
    expect(closing.settled).toBe(false);
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    await untilTick(() => closing.settled);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close раньше отказа записи снапшота: пауза перед повтором не начинается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let fail: (() => void) | undefined;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) {
        await new Promise<void>((r) => {
          fail = r;
        });
        throw new Error('disk is full');
      }
    });
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { store, retryDelaysMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => fail !== undefined);
    const closing = track(service.close());
    await tick();
    expect(closing.settled).toBe(false);
    fail?.();
    await untilTick(() => closing.settled);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });

  it('ожидание ответа после close не ждёт таймаута', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { store: memoryStore(), replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await closeWithin(service);
    // Часы стоят: ответа движка после close не будет, и ждать его 8 с незачем.
    const playing = service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    const state = track(playing);
    await untilTick(() => state.settled);
    const res = await playing;
    expect(res.reply).toBeUndefined();
    expect(res.move.coord).toBe('D4');
  });

  it('отказ записи хода движка: ошибка видна, партия не расходится с диском и продолжается сама', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2 && failures-- > 0) throw new Error('disk is full');
    });
    const engine = createFakeEngine({ script: ['E5', 'E5'] });
    const { service, bus } = await make(engine, { store, retryDelaysMs: delays(1000), replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);

    // Человек сказал ход и ждёт ответа: отказ записи отпускает его сразу, не через 8 с.
    const playing = service.play(id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const playState = track(playing);
    await untilTick(() => playState.settled);
    const res = await playing;
    expect(res.reply).toBeUndefined();
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', gameId: id, code: 'internal', message: 'internal server error' }]);

    // Память и диск на одном и том же состоянии: ход человека есть, ответа движка нет.
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['D4']);
    expect((await real.load())[0]?.moves.map((m) => m.coord)).toEqual(['D4']);
    expect(service.get(id).pendingEngineMove).toBe(true);

    // Повтор после паузы, без отката и без сдачи: Гоко отвечает сам.
    await vi.advanceTimersByTimeAsync(999);
    await tick();
    expect(engine.calls.genmove).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => service.get(id).moves.length === 2);
    expect(engine.calls.genmove).toBe(2);
    expect((await real.load())[0]?.moves.map((m) => m.coord)).toEqual(['D4', 'E5']);
    expect(events.filter((e) => e.type === 'state.updated').at(-1)).toMatchObject({ cause: 'engine', by: 'engine' });

    // Партия идёт дальше обычным ходом человека.
    const next = await service.play(id, { coord: 'C3', waitForReply: false, via: 'voice' });
    expect(next.move).toMatchObject({ n: 3, coord: 'C3' });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('диск не чинится: каждый повтор — новое событие error, память не уходит вперёд диска', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) throw new Error('disk is full');
    });
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, retryDelaysMs: delays(1000) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.filter((e) => e.type === 'error').length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await untilTick(() => events.filter((e) => e.type === 'error').length === 2);
    expect(engine.calls.genmove).toBe(2);
    expect(service.get(id).moves).toHaveLength(1);
    expect((await real.load())[0]?.moves).toHaveLength(1);
    // Остановка во время паузы перед очередным повтором не ждёт её.
    await closeWithin(service);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ записи итога счёта: ошибка видна, счёт повторяется, партия завершается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.status === 'finished' && failures-- > 0) throw new Error('disk is full');
    });
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, retryDelaysMs: delays(1000) });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toEqual({ type: 'error', gameId: id, code: 'internal', message: 'internal server error' });
    expect(service.get(id).status).toBe('playing');
    expect((await real.load())[0]?.status).toBe('playing');
    await vi.advanceTimersByTimeAsync(1000);
    await untilTick(() => service.get(id).status === 'finished');
    expect(engine.calls.score).toBe(2);
    expect((await real.load())[0]?.status).toBe('finished');
  });

  it('бросивший лог не отменяет повтор: событие error, ожидающий снят, после паузы ход движка приходит', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2 && failures-- > 0) throw new Error('disk is full');
    });
    // Лог пишет в закрытый поток и бросает на каждой строке.
    const log = () => {
      throw new Error('log stream is closed');
    };
    // Второй E5 — ответ повтора: первый ход движка до диска не дошёл.
    const engine = createFakeEngine({ script: ['E5', 'E5'] });
    const { service, bus } = await make(engine, { store, log, retryDelaysMs: delays(1000), replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    // Ответ ждётся с таймаутом 8 с на стоящих часах: снять ожидающего может только обычный путь отказа.
    const playing = service.play(id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const settled = track(playing);
    await untilTick(() => settled.settled);
    expect((await playing).replyTimedOut).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', gameId: id, code: 'internal', message: 'internal server error' }]);
    await vi.advanceTimersByTimeAsync(1000);
    await untilTick(() => service.get(id).moves.length === 2);
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['D4', 'E5']);
  });

  it('бросивший лог не отменяет финал серии: одно retries_exhausted, отметка исчерпанной серии, повторов больше нет', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const log = () => {
      throw new Error('log stream is closed');
    };
    const engine: Engine = {
      ...createFakeEngine(),
      genmove: async () => {
        calls++;
        throw new ApiError('engine_unavailable', 'engine is unreachable');
      },
    };
    const { service, bus } = await make(engine, { log, retryDelaysMs: [10] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => events.some((e) => e.type === 'error' && e.code === 'retries_exhausted'));
    await tick(10);
    expect(events.flatMap((e) => (e.type === 'error' ? [e.code] : []))).toEqual(['engine_unavailable', 'retries_exhausted']);
    expect(service.internalSizes().gaveUp).toBe(1);
    expect(calls).toBe(2);
  });

  // Сейчас обработчик отказа бросить почти не может (лог обёрнут, bus глотает исключения слушателей),
  // поэтому бросок вызван нарочно: чтение паузы серии падает. Запись задачи обязана сниматься в finally,
  // иначе для партии больше не поставится ни одна задача и ход движка будет ждаться вечно.
  it('бросивший обработчик отказа не оставляет партию без задачи: следующий коммит ставит ход движка', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'] });
    let genmoves = 0;
    const engine: Engine = {
      ...inner,
      genmove: (req) => {
        genmoves++;
        if (genmoves === 1) return Promise.reject(new ApiError('engine_unavailable', 'engine is unreachable'));
        return inner.genmove(req);
      },
    };
    // Первые два чтения паузы бросают: в onFailure из runEngine и в onFailure из startTask.
    let brokenReads = 2;
    const retryDelaysMs = new Proxy([10], {
      get(target, key, receiver) {
        if (key === '0' && brokenReads-- > 0) throw new Error('retry delays are broken');
        return Reflect.get(target, key, receiver);
      },
    });
    const { service } = await make(engine, { retryDelaysMs });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => genmoves === 1 && brokenReads === 0);
    await tick(10);
    expect(service.get(id).moves).toHaveLength(1);
    // Коммит человека зовёт kick: задача ставится, только если запись прежней снята.
    await service.setRank(id, { color: 'W', rank: '5k' });
    await untilTick(() => service.get(id).moves.length === 2);
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['D4', 'E5']);
    expect(genmoves).toBe(2);
  });

  it('бросивший лог не мешает пасу вместо нелегального хода движка', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const log = () => {
      throw new Error('log stream is closed');
    };
    const errors: GameEvent[] = [];
    const { service, bus } = await make(createFakeEngine({ script: ['D4'] }), { log, replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    bus.subscribe(`game:${g.state.id}`, (e) => {
      if (e.type === 'error') errors.push(e);
    });
    // Часы стоят: ответ приходит только ходом движка, а не таймаутом ожидания.
    const playing = service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const settled = track(playing);
    await untilTick(() => settled.settled);
    expect((await playing).reply).toMatchObject({ coord: 'pass' });
    expect(errors).toEqual([]);
  });

  it('движок против движка: после хода задача ставится заново, партия идёт дальше одного хода', async () => {
    // Создать такую партию нельзя (unsupported_controller), но снапшот мог остаться с прежних версий:
    // «kick после любого исхода задачи» держит и его.
    const id = 'enginevsengine';
    const seed = newGame({ id, createdAt: '2026-09-07T10:00:00.000Z', settings: GameSettings.parse({ boardSize: 9 }), seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'engine', rank: '10k' } } });
    const engine = createFakeEngine({ script: ['C3', 'D4', 'E5', 'F6'] });
    // Часы сервиса — время снапшота: иначе партия старше порога и init не поставил бы ей задачу.
    const { service } = await make(engine, { store: memoryStore([seed]), now: () => new Date('2026-09-07T10:00:00.000Z') });
    // Коммит хода движка зовёт kick, пока запись задачи ещё в карте: следующий ход ставит только
    // kick после завершения задачи.
    await untilTick(() => service.get(id).moves.length >= 4);
    expect(service.get(id).moves.slice(0, 4).map((m) => `${m.color}${m.coord}`)).toEqual(['BC3', 'WD4', 'BE5', 'WF6']);
    await closeWithin(service);
    const after = service.get(id).moves.length;
    await tick(20);
    // После close kick ничего не ставит: партия замирает.
    expect(service.get(id).moves).toHaveLength(after);
  });

  it('отказ записи хода человека: ошибка у вызывающего, состояние не меняется, ход можно повторить', async () => {
    const real = memoryStore();
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 1 && failures-- > 0) throw new Error('disk is full');
    });
    const { service, bus } = await make(createFakeEngine(), { store });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await expect(service.play(id, { coord: 'D4', waitForReply: false, via: 'voice' })).rejects.toThrow('disk is full');
    expect(service.get(id).moves).toEqual([]);
    expect(events).toEqual([]);
    const res = await service.play(id, { coord: 'D4', waitForReply: false, via: 'voice' });
    expect(res.move).toMatchObject({ n: 1, coord: 'D4' });
    expect((await real.load())[0]?.moves).toHaveLength(1);
  });

  it('счёт не возобновляется, когда пасов осталось меньше двух', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const inner = createFakeEngine();
    const flaky: Engine = {
      ...inner,
      score: async () => {
        calls++;
        throw new Error('score failed');
      },
    };
    const { service, bus } = await make(flaky, { retryDelaysMs: delays(50) });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    // Исправление второго паса: пас остаётся один, и возобновлять счёт не на чем.
    await service.correct(id, { coord: 'pass', waitForReply: false, via: 'voice' });
    await vi.advanceTimersByTimeAsync(50);
    await tick(5);
    expect(calls).toBe(1);
    expect(service.get(id).consecutivePasses).toBe(1);
    expect(service.get(id).status).toBe('playing');
  });
});

describe('GameService: серия повторов фоновой задачи', () => {
  const unreachable = (onCall: () => void): Engine => ({
    ...createFakeEngine(),
    genmove: async () => {
      onCall();
      throw new ApiError('engine_unavailable', 'engine is unreachable');
    },
  });
  const errorsOf = (events: GameEvent[]) => events.filter((e) => e.type === 'error');
  const codes = (events: GameEvent[]) => events.flatMap((e) => (e.type === 'error' ? [e.code] : []));

  it('паузы 5/10/20/40/60 с, затем одно retries_exhausted; партия остаётся playing, повторов больше нет', async () => {
    expect(ENGINE_RETRY_DELAYS_MS).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const logs: string[] = [];
    const { service, bus } = await make(
      unreachable(() => calls++),
      { retryDelaysMs: undefined, log: (l) => logs.push(l) },
    );
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    for (const [i, ms] of [5_000, 10_000, 20_000, 40_000, 60_000].entries()) {
      await untilTick(() => errorsOf(events).length === i + 1);
      await vi.advanceTimersByTimeAsync(ms - 1);
      await tick(5);
      expect(calls, `пауза ${i + 1}`).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      await untilTick(() => calls === i + 2);
    }
    await untilTick(() => errorsOf(events).length === 6);
    const errors = errorsOf(events);
    expect(errors.slice(0, 5)).toEqual(new Array(5).fill({ type: 'error', gameId: id, code: 'engine_unavailable', message: 'engine is unreachable' }));
    expect(errors[5]).toEqual({ type: 'error', gameId: id, code: 'retries_exhausted', message: RETRIES_EXHAUSTED_MESSAGE });
    expect(RETRIES_EXHAUSTED_MESSAGE).toMatch(/^[\x20-\x7e]+$/);
    expect(logs.filter((l) => l.includes('gave up'))).toHaveLength(1);
    // Пауз больше нет, и часы, сдвинутые на десять минут, не поднимают движок.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    await tick(10);
    expect(calls).toBe(6);
    expect(errorsOf(events)).toHaveLength(6);
    expect(service.get(id).status).toBe('playing');
    expect(service.get(id).pendingEngineMove).toBe(true);
  });

  it('отказ записи снапшота считается в той же серии: после последней паузы одно retries_exhausted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (state.moves.length === 2) throw new Error('disk is full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, retryDelaysMs: [10, 20] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => errorsOf(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => errorsOf(events).length === 2);
    await vi.advanceTimersByTimeAsync(20);
    await untilTick(() => errorsOf(events).length === 3);
    expect(errorsOf(events).map((e) => (e.type === 'error' ? e.code : ''))).toEqual(['internal', 'internal', 'retries_exhausted']);
    await vi.advanceTimersByTimeAsync(10_000);
    await tick(10);
    expect(engine.calls.genmove).toBe(3);
    expect(errorsOf(events)).toHaveLength(3);
    // Сбой записи не блокирует ходы: человек может отменить свой ход.
    const undone = await service.undo(id, { via: 'voice' });
    expect(undone.state.moves).toEqual([]);
  });

  it('удачная задача обнуляет счёт: следующий отказ снова начинает с первой паузы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5', 'F6'] });
    let failNext = 1;
    let calls = 0;
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        calls++;
        if (failNext-- > 0) throw new ApiError('engine_unavailable', 'engine is unreachable');
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(flaky, { store: memoryStore(), retryDelaysMs: [10, 1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => service.get(id).moves.length === 2);
    failNext = 1;
    await service.play(id, { coord: 'C3', waitForReply: false, via: 'api' });
    await untilTick(() => errorsOf(events).length === 2);
    // Без обнуления это была бы вторая пауза серии (1000 мс) и ход не пришёл бы.
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => service.get(id).moves.length === 4);
    expect(errorsOf(events).every((e) => e.type === 'error' && e.code === 'engine_unavailable')).toBe(true);
  });

  // Путь без коммита человека между отказами: пас движка после отказа запускает счёт, и отказ счёта
  // считается уже новой серией — её начала не задаёт ни одно действие человека.
  it('удачный ход движка после отказа обнуляет счёт: отказ счёта после паса движка идёт с первой ступени', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    let genmoves = 0;
    let scores = 0;
    let failScore: ((e: unknown) => void) | undefined;
    const engine: Engine = {
      ...inner,
      genmove: (req) => {
        genmoves++;
        if (genmoves === 1) return Promise.reject(new ApiError('engine_unavailable', 'engine is unreachable'));
        return inner.genmove(req);
      },
      score: () => {
        scores++;
        if (scores > 1) return Promise.reject(new Error('score failed'));
        return new Promise((_, reject) => {
          failScore = reject;
        });
      },
    };
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [10, 1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => scores === 1);
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['pass', 'pass']);
    await tick(10);
    failScore?.(new Error('score failed'));
    await untilTick(() => codes(events).length === 2);
    // Первая ступень (10 мс), а не вторая (1000 мс): серия отказа хода движка кончилась его удачным ходом.
    await vi.advanceTimersByTimeAsync(9);
    await tick(10);
    expect(scores).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => scores === 2);
  });

  // Счёт, запущенный коммитом паса движка, может отказать раньше, чем задача движка дошла до конца.
  // Отказ счёта не должен ни унаследовать счёт серии хода движка, ни потерять свой при её завершении.
  it('отказ счёта сразу после паса движка: паузы первой и второй ступени по порядку, без наследства серии хода', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    let genmoves = 0;
    let scores = 0;
    const engine: Engine = {
      ...inner,
      genmove: (req) => {
        genmoves++;
        if (genmoves === 1) return Promise.reject(new ApiError('engine_unavailable', 'engine is unreachable'));
        return inner.genmove(req);
      },
      score: () => {
        scores++;
        return Promise.reject(new Error('score failed'));
      },
    };
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [10, 1000, 1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => scores === 1);
    await untilTick(() => codes(events).length === 2);
    await tick(10);
    // Первый отказ счёта — первая ступень (10 мс).
    await vi.advanceTimersByTimeAsync(9);
    await tick(10);
    expect(scores).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => scores === 2);
    await untilTick(() => codes(events).length === 3);
    await tick(10);
    // Второй отказ счёта — вторая ступень (1000 мс), а не снова первая.
    await vi.advanceTimersByTimeAsync(10);
    await tick(10);
    expect(scores).toBe(2);
    await vi.advanceTimersByTimeAsync(990);
    await untilTick(() => scores === 3);
  });

  // Движок ходит первым: любое действие человека приходится на ход движка.
  const restarts: [string, (service: GameService, id: string) => Promise<unknown>][] = [
    ['play (отклонён not_your_turn)', (s, id) => s.play(id, { coord: 'D4', waitForReply: false, via: 'voice' })],
    ['pass (отклонён not_your_turn)', (s, id) => s.pass(id, { waitForReply: false, via: 'voice' })],
    ['undo (отклонён nothing_to_undo)', (s, id) => s.undo(id, { via: 'voice' })],
    ['correct (отклонён nothing_to_undo)', (s, id) => s.correct(id, { coord: 'D4', waitForReply: false, via: 'voice' })],
    ['setRank', (s, id) => s.setRank(id, { color: 'B', rank: '5k' })],
    ['resume (открытие потока событий)', async (s, id) => s.resume(id)],
  ];
  for (const [name, act] of restarts) {
    it(`после retries_exhausted серию запускает заново действие человека: ${name}`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let calls = 0;
      const { service, bus } = await make(
        unreachable(() => calls++),
        { retryDelaysMs: [10] },
      );
      const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
      const id = g.state.id;
      const events = record(bus, `game:${id}`);
      await untilTick(() => calls === 1);
      await vi.advanceTimersByTimeAsync(10);
      // Первая ошибка ушла ещё внутри create, до подписки: считаем от финальной.
      await untilTick(() => codes(events).includes('retries_exhausted'));
      await tick(5);
      expect(calls).toBe(2);
      expect(codes(events)).toEqual(['retries_exhausted']);
      await act(service, id).catch(() => undefined);
      await untilTick(() => calls === 3);
      // Новая серия: снова пауза и повтор, а не сразу финальная ошибка.
      await untilTick(() => codes(events).length === 2);
      expect(codes(events)).toEqual(['retries_exhausted', 'engine_unavailable']);
      await vi.advanceTimersByTimeAsync(10);
      await untilTick(() => calls === 4);
      await untilTick(() => codes(events).length === 3);
      expect(codes(events)).toEqual(['retries_exhausted', 'engine_unavailable', 'retries_exhausted']);
    });
  }

  it('недоступный go-engine: событие error без текста исключения fetch, исходный текст — в логе', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const leak = 'connect ECONNREFUSED 10.1.2.3:8788 /opt/katago/secret';
    const f = fakeFetch([
      () => {
        throw new TypeError(leak);
      },
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const logs: string[] = [];
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [1000], log: (l) => logs.push(l) });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => f.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => errorsOf(events).length === 1);
    expect(errorsOf(events)).toEqual([{ type: 'error', gameId: g.state.id, code: 'engine_unavailable', message: 'engine is unreachable' }]);
    expect(logs.filter((l) => l.startsWith('[!] engine:') && l.includes(leak))).toHaveLength(1);
  });

  // Действие движка отклоняется или падает на записи: партия остаётся playing, и перезапуск серии
  // был бы виден лишним genmove. Удачная сдача движка задачу не ставит по самому состоянию, поэтому
  // resign проверяется через отказ записи.
  const byEngine: [string, string, (service: GameService, id: string) => Promise<unknown>][] = [
    ['undo', 'nothing_to_undo', (s, id) => s.undo(id, { via: 'api' }, 'engine')],
    ['play', 'invalid_coord', (s, id) => s.play(id, { coord: 'Z99', waitForReply: false, via: 'api' }, 'engine')],
    ['correct', 'nothing_to_undo', (s, id) => s.correct(id, { coord: 'D4', waitForReply: false, via: 'api' }, 'engine')],
    ['resign (отказ записи)', 'disk is full', (s, id) => s.resign(id, { color: 'B', via: 'api' }, 'engine')],
  ];
  for (const [name, reason, act] of byEngine) {
    it(`действие не человека (by engine) после retries_exhausted серию не перезапускает: ${name}`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let calls = 0;
      const real = memoryStore();
      const store = {
        load: () => real.load(),
        save: async (state: GameState) => {
          if (state.status === 'finished') throw new Error('disk is full');
          return real.save(state);
        },
      } as unknown as GameStore;
      const { service, bus } = await make(
        unreachable(() => calls++),
        { store, retryDelaysMs: [10] },
      );
      const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
      const id = g.state.id;
      const events = record(bus, `game:${id}`);
      await untilTick(() => calls === 1);
      await vi.advanceTimersByTimeAsync(10);
      await untilTick(() => codes(events).includes('retries_exhausted'));
      const err = await act(service, id).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : undefined;
      expect(code).toBe(reason);
      expect(service.get(id).status).toBe('playing');
      await tick(10);
      expect(calls).toBe(2);
      expect(service.internalSizes().gaveUp).toBe(1);
    });
  }

  // Правило счёта серии: удачный коммит человека обнуляет счёт, отказ по устаревшей ревизии его не
  // двигает. Поэтому после correct во время раздумья следующий отказ идёт с первой ступени.
  it('correct во время раздумья обнуляет счёт серии, устаревший отказ его не двигает: следующая пауза снова первая', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    let fail: ((e: unknown) => void) | undefined;
    const engine: Engine = {
      ...createFakeEngine(),
      genmove: () => {
        calls++;
        if (calls === 2) {
          return new Promise((_, reject) => {
            fail = reject;
          });
        }
        return Promise.reject(new ApiError('engine_unavailable', 'engine is unreachable'));
      },
    };
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [10, 1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => calls === 2);
    // Пока движок думает над D4, человек исправляет ход: ревизия меняется.
    await service.correct(id, { coord: 'C3', waitForReply: false, via: 'voice' });
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    await untilTick(() => codes(events).length === 2);
    await tick(5);
    expect(calls).toBe(3);
    // Счёт обнулён коммитом correct, устаревший отказ не посчитан: пауза снова 10 мс, а не 1000.
    await vi.advanceTimersByTimeAsync(9);
    await tick(10);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => calls === 4);
  });

  it('отклонённое действие человека счёт серии не обнуляет: следующий отказ идёт со второй ступени', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    let fail: ((e: unknown) => void) | undefined;
    const engine: Engine = {
      ...createFakeEngine(),
      genmove: () => {
        calls++;
        if (calls === 2) {
          return new Promise((_, reject) => {
            fail = reject;
          });
        }
        return Promise.reject(new ApiError('engine_unavailable', 'engine is unreachable'));
      },
    };
    const real = memoryStore();
    let diskFull = false;
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (diskFull) throw new Error('disk is full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service, bus } = await make(engine, { store, retryDelaysMs: [10, 1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => calls === 2);
    await expect(service.play(id, { coord: 'E5', waitForReply: false, via: 'voice' })).rejects.toMatchObject({ code: 'not_your_turn' });
    await expect(service.correct(id, { coord: 'Z99', waitForReply: false, via: 'voice' })).rejects.toMatchObject({ code: 'invalid_coord' });
    // Отказ записи — тоже отклонённое действие: коммита не было, счёт прежний.
    diskFull = true;
    await expect(service.setRank(id, { color: 'W', rank: '5k' })).rejects.toThrow('disk is full');
    diskFull = false;
    expect(service.get(id).moves.map((m) => m.coord)).toEqual(['D4']);
    expect(service.get(id).seats.W.rank).toBe('10k');
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    await untilTick(() => codes(events).length === 2);
    // Второй отказ той же ревизии: пауза 1000 мс.
    await vi.advanceTimersByTimeAsync(10);
    await tick(10);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(990);
    await untilTick(() => calls === 3);
  });

  it('устаревший отказ движка не снимает ожидающего новой ревизии: correct с ожиданием получает ответ второго genmove', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'] });
    let calls = 0;
    let fail: ((e: unknown) => void) | undefined;
    const engine: Engine = {
      ...inner,
      genmove: (req) => {
        calls++;
        if (calls === 1) {
          return new Promise((_, reject) => {
            fail = reject;
          });
        }
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [1000] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    const corrected = service.correct(id, { coord: 'C3', waitForReply: true, via: 'voice' });
    await untilTick(() => service.get(id).moves.at(-1)?.coord === 'C3');
    expect(service.internalSizes().waiters).toBe(1);
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    const res = await corrected;
    expect(res.move).toMatchObject({ color: 'B', coord: 'C3' });
    expect(res.reply).toMatchObject({ color: 'W', coord: 'E5' });
    expect(res.replyTimedOut).toBeUndefined();
    expect(calls).toBe(2);
    expect(errorsOf(events)).toEqual([]);
    expect(service.internalSizes().waiters).toBe(0);
  });

  it('setRank во время счёта обнуляет счёт серии, устаревший отказ его не двигает: следующая пауза снова первая', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    let fail: ((e: unknown) => void) | undefined;
    const engine: Engine = {
      ...createFakeEngine(),
      score: () => {
        calls++;
        if (calls === 2) {
          return new Promise((_, reject) => {
            fail = reject;
          });
        }
        return Promise.reject(new Error('score failed'));
      },
    };
    const { service, bus } = await make(engine, { store: memoryStore(), retryDelaysMs: [10, 1000] });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => calls === 2);
    // Пока движок считает, меняется ранг: ревизия другая, два паса остаются.
    await service.setRank(id, { color: 'W', rank: '5k' });
    fail?.(new Error('score failed'));
    await untilTick(() => codes(events).length === 2);
    await tick(5);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(9);
    await tick(10);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await untilTick(() => calls === 4);
  });

  it('отказы записи: после retries_exhausted и resume серия снова начинается с первой паузы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (state.moves.length === 2) throw new Error('disk is full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, retryDelaysMs: [10, 20] });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).length === 2);
    await vi.advanceTimersByTimeAsync(20);
    await untilTick(() => codes(events).includes('retries_exhausted'));
    service.resume(id);
    await untilTick(() => codes(events).length === 4);
    await tick(5);
    // Новая серия: первая пауза 10 мс, а не сразу финал.
    expect(codes(events)).toEqual(['internal', 'internal', 'retries_exhausted', 'internal']);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).length === 5);
    expect(codes(events)[4]).toBe('internal');
  });

  it('счёт после двух пасов: серия кончается retries_exhausted, счёт больше не зовётся до действия человека', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const flaky: Engine = {
      ...createFakeEngine(),
      score: async () => {
        calls++;
        throw new Error('score failed');
      },
    };
    const { service, bus } = await make(flaky, { store: memoryStore(), retryDelaysMs: [10] });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => codes(events).length === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).includes('retries_exhausted'));
    await vi.advanceTimersByTimeAsync(10_000);
    await tick(10);
    expect(calls).toBe(2);
    expect(codes(events)).toEqual(['engine_unavailable', 'retries_exhausted']);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.get(id).status).toBe('playing');
    service.resume(id);
    await untilTick(() => calls === 3);
  });

  it('финальная ошибка отпускает ожидающего ответа: correct во время последней паузы не ждёт таймаута', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const { service } = await make(
      unreachable(() => calls++),
      { store: memoryStore(), retryDelaysMs: [1000], replyTimeoutMs: undefined },
    );
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    await tick(5);
    // Идёт единственная пауза серии; исправление ставит ожидающего ответа на новую ревизию.
    const correcting = service.correct(id, { coord: 'C3', waitForReply: true, via: 'voice' });
    const state = track(correcting);
    await tick(10);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    // Часы дальше не идут: без releaseWaiters на финале correct ждал бы 8 с.
    await untilTick(() => state.settled);
    const res = await correcting;
    expect(calls).toBe(2);
    expect(res).toMatchObject({ move: { coord: 'C3' }, replyTimedOut: true });
  });

  it('сдача человека после retries_exhausted: движок не зовётся, в потоке только сдача, пауз нет (PB1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const { service, bus } = await make(
      unreachable(() => calls++),
      { store: memoryStore(), retryDelaysMs: [10] },
    );
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await untilTick(() => calls === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).includes('retries_exhausted'));
    await tick(5);
    expect(calls).toBe(2);
    expect(service.internalSizes().gaveUp).toBe(1);
    const before = events.length;
    await service.resign(id, { color: 'W', via: 'voice' });
    expect(service.internalSizes().gaveUp).toBe(0);
    await tick(10);
    await vi.advanceTimersByTimeAsync(10_000);
    await tick(10);
    expect(events.slice(before).map((e) => e.type)).toEqual(['state.updated', 'game.finished']);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ записи сдачи после retries_exhausted перезапускает серию: партия осталась playing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const real = memoryStore();
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (state.status === 'finished') throw new Error('disk is full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service, bus } = await make(
      unreachable(() => calls++),
      { store, retryDelaysMs: [10] },
    );
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await untilTick(() => calls === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).includes('retries_exhausted'));
    await tick(5);
    await expect(service.resign(id, { color: 'W', via: 'voice' })).rejects.toThrow('disk is full');
    expect(service.get(id).status).toBe('playing');
    await untilTick(() => calls === 3);
    await untilTick(() => codes(events).length === 2);
    expect(codes(events)).toEqual(['retries_exhausted', 'engine_unavailable']);
  });

  it('отказ движка по устаревшей ревизии не считается: сдача во время раздумья — без error и без паузы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let fail: ((e: unknown) => void) | undefined;
    let calls = 0;
    const thinking: Engine = {
      ...createFakeEngine(),
      genmove: () => {
        calls++;
        return new Promise((_, reject) => {
          fail = reject;
        });
      },
    };
    const { service, bus } = await make(thinking, { store: memoryStore(), retryDelaysMs: [10] });
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await untilTick(() => calls === 1);
    await service.resign(id, { color: 'W', via: 'voice' });
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    await tick(10);
    expect(codes(events)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
  });

  it('отказ счёта по устаревшей ревизии не считается: undo второго паса во время счёта — без error и без паузы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let fail: ((e: unknown) => void) | undefined;
    let calls = 0;
    const scoring: Engine = {
      ...createFakeEngine(),
      score: () => {
        calls++;
        return new Promise((_, reject) => {
          fail = reject;
        });
      },
    };
    const { service, bus } = await make(scoring, { store: memoryStore(), retryDelaysMs: [10] });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => calls === 1);
    await service.undo(id, { via: 'voice' });
    fail?.(new Error('score failed'));
    await tick(10);
    expect(codes(events)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toBe(1);
  });

  it('отказ движка, пришедший после close, не шлёт событие error', async () => {
    let fail: ((e: unknown) => void) | undefined;
    let calls = 0;
    const thinking: Engine = {
      ...createFakeEngine(),
      genmove: () => {
        calls++;
        return new Promise((_, reject) => {
          fail = reject;
        });
      },
    };
    const logs: string[] = [];
    const { service, bus } = await make(thinking, { store: memoryStore(), retryDelaysMs: [10], log: (l) => logs.push(l) });
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await untilTick(() => calls === 1);
    const closing = service.close();
    fail?.(new ApiError('engine_unavailable', 'engine is unreachable'));
    await closing;
    expect(codes(events)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('resume во время серии ничего не добавляет, для незнакомой партии не бросает', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const { service, bus } = await make(
      unreachable(() => calls++),
      { retryDelaysMs: [1000, 1000] },
    );
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await untilTick(() => calls === 1);
    await tick(5);
    service.resume(id);
    expect(() => service.resume('nosuchgame')).not.toThrow();
    await tick(10);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await untilTick(() => calls === 2);
    await tick(10);
    // Серия идёт своим ходом: второй отказ — обычная ошибка, до финальной ещё одна пауза.
    expect(codes(events)).toEqual(['engine_unavailable']);
  });

  it('после close действие человека не поднимает серию и не заводит пауз', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    const { service, bus } = await make(
      unreachable(() => calls++),
      { retryDelaysMs: [10] },
    );
    const g = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await untilTick(() => calls === 1);
    await vi.advanceTimersByTimeAsync(10);
    await untilTick(() => codes(events).includes('retries_exhausted'));
    await closeWithin(service);
    service.resume(id);
    await service.setRank(id, { color: 'B', rank: '5k' });
    await tick(10);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const errorEvents = (events: GameEvent[]) => events.filter((e) => e.type === 'error');

// Широкое ревью ветки stage0: отмена вызовов движка (B1), поток сессии только текущей партии (B2),
// лимит партий и чистка старых снапшотов (B5), проверка места при сдаче (B7), занятый id.
describe('GameService: бюджеты и отмена вызовов движка (B1)', () => {
  // Движок, чьи вызовы висят до отмены и записывают сигнал: отмена — единственный способ их закончить.
  function abortable() {
    const signals: { op: string; signal: AbortSignal | undefined }[] = [];
    const hangUntilAbort = <T>(op: string, signal: AbortSignal | undefined): Promise<T> =>
      new Promise<T>((_, reject) => {
        signals.push({ op, signal });
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const engine: Engine = {
      genmove: (_req, signal) => hangUntilAbort('genmove', signal),
      analyze: (_req, signal) => hangUntilAbort('analyze', signal),
      score: (_req, signal) => hangUntilAbort('score', signal),
    };
    return { engine, signals };
  }

  it('по дедлайну бюджета вызов движка получает abort, не раньше; отказ — engine_busy, таймеров не остаётся', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, signals } = abortable();
    const { service } = await make(engine, { scoreBudgetMs: 100, analyzeBudgetMs: 50 });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;

    const scoring = service.score(id);
    const scoreFails = expect(scoring).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 100 ms' });
    await untilTick(() => signals.length === 1);
    expect(signals[0]).toMatchObject({ op: 'score' });
    await vi.advanceTimersByTimeAsync(99);
    expect(signals[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await scoreFails;
    expect(signals[0]?.signal?.aborted).toBe(true);

    const analyzing = service.analyze(id, { maxVisits: 50 });
    const analyzeFails = expect(analyzing).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 50 ms' });
    await untilTick(() => signals.length === 2);
    expect(signals[1]).toMatchObject({ op: 'analyze' });
    await vi.advanceTimersByTimeAsync(49);
    expect(signals[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await analyzeFails;
    expect(signals[1]?.signal?.aborted).toBe(true);
    await tick();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('быстрый ответ движка: сигнал вызова не отменяется и после дедлайна', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    const signals: (AbortSignal | undefined)[] = [];
    const engine: Engine = {
      ...inner,
      score: (req, signal) => {
        signals.push(signal);
        return inner.score(req, signal);
      },
    };
    const { service } = await make(engine, { scoreBudgetMs: 100 });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.score(g.state.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('автосчёт не запускает второй score, пока первый вызов движка жив', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const releases: (() => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const inner = createFakeEngine();
    const engine: Engine = {
      ...inner,
      score: async (req, signal) => {
        signals.push(signal);
        await new Promise<void>((r) => releases.push(r));
        return inner.score(req);
      },
    };
    const { service, bus } = await make(engine, { scoreBudgetMs: 100, retryDelaysMs: delays(10) });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => releases.length === 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(signals[0]?.aborted).toBe(true);
    // Отказ по бюджету сразу идёт в серию: событие error не ждёт, пока движок осядет.
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(errorEvents(events)).toEqual([{ type: 'error', gameId: id, code: 'engine_busy', message: 'engine did not respond within 100 ms' }]);
    // Пауза серии (10 мс) давно прошла, но первый вызов движка ещё не осел: второго счёта нет.
    await vi.advanceTimersByTimeAsync(1_000);
    await tick(10);
    expect(releases).toHaveLength(1);
    // Первый вызов осел, его поздний результат не применяется: партия не завершена, идёт второй счёт.
    releases[0]?.();
    await untilTick(() => releases.length === 2);
    expect(service.get(id).status).toBe('playing');
    releases[1]?.();
    await untilTick(() => service.get(id).status === 'finished');
    expect(signals[1]?.aborted).toBe(false);
  });

  it('ход движка получает сигнал задачи; close обрывает раздумье, а не ждёт его', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, signals } = abortable();
    const { service } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => signals.length === 1);
    expect(signals[0]).toMatchObject({ op: 'genmove' });
    expect(signals[0]?.signal?.aborted).toBe(false);
    await closeWithin(service);
    expect(signals[0]?.signal?.aborted).toBe(true);
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });
});

describe('GameService: поток сессии только текущей партии (B2)', () => {
  // Событие относится к партии id: у событий без gameId (game.finished) принадлежность не видна — это провал.
  const belongsTo = (e: GameEvent, id: string): boolean => {
    switch (e.type) {
      case 'session.game':
      case 'engine.thinking':
      case 'error':
        return e.gameId === id;
      case 'state.updated':
        return e.state.id === id;
      default:
        return false;
    }
  };

  it('движок думает в A, в сессии создаётся B: раздумье A отменено, в поток сессии не приходит ни одно событие A', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5', 'F6'], delayMs: 1_000 });
    const signals: AbortSignal[] = [];
    const engine: Engine = {
      ...inner,
      genmove: (req, signal) => {
        if (signal) signals.push(signal);
        return inner.genmove(req, signal);
      },
    };
    const { service, bus } = await make(engine, { replyTimeoutMs: undefined });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    const session = record(bus, 'session:s1');
    const gameA = record(bus, `game:${aId}`);
    const playing = service.play(aId, { coord: 'D4', waitForReply: true, via: 'voice' });
    const playState = track(playing);
    await untilTick(() => signals.length === 1);
    expect(session.map((e) => e.type)).toEqual(['state.updated', 'engine.thinking']);
    expect(session[1]).toEqual({ type: 'engine.thinking', gameId: aId, color: 'W' });

    const b = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const bId = b.state.id;
    expect(signals[0]?.aborted).toBe(true);
    // Ожидающий ответа в A отпущен сразу, а не через 8 с: ответа в A больше не будет.
    await untilTick(() => playState.settled);
    expect((await playing).replyTimedOut).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await tick(5);
    const switched = session.findIndex((e) => e.type === 'session.game' && e.gameId === bId);
    expect(switched).toBe(2);
    expect(session.slice(switched).every((e) => belongsTo(e, bId))).toBe(true);
    // Статус A не меняется, новых статусов нет; отмена тихая: ни error, ни повторов.
    expect(service.get(aId)).toMatchObject({ status: 'playing', pendingEngineMove: true });
    expect(service.get(aId).moves).toHaveLength(1);
    expect(inner.calls.genmove).toBe(1);
    expect(gameA.filter((e) => e.type === 'error')).toEqual([]);

    // Человек вернулся к A (открыл её поток): движок доигрывает ход, но только в канал A.
    service.resume(aId);
    await thinkThrough(inner, 2, 1_000);
    await untilTick(() => service.get(aId).moves.length === 2);
    expect(gameA.at(-1)).toMatchObject({ type: 'state.updated', cause: 'engine' });
    expect(session.slice(switched).every((e) => belongsTo(e, bId))).toBe(true);
    // B продолжает говорить в поток сессии.
    await service.play(bId, { coord: 'C3', waitForReply: false, via: 'api' });
    expect(session.at(-1)).toMatchObject({ type: 'state.updated', cause: 'play' });
    expect(belongsTo(session.at(-1) as GameEvent, bId)).toBe(true);
  });

  it('ответ движка A, пришедший после переключения, не применяется и в поток сессии не попадает', async () => {
    const releases: (() => void)[] = [];
    const inner = createFakeEngine({ script: ['E5'] });
    // Движок не слушает отмену: ответ приходит, когда тест отпустит.
    const engine: Engine = {
      ...inner,
      genmove: async (req) => {
        await new Promise<void>((r) => releases.push(r));
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(engine);
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    await service.play(aId, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => releases.length === 1);
    const b = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const session = record(bus, 'session:s1');
    const gameA = record(bus, `game:${aId}`);
    releases[0]?.();
    await tick(20);
    expect(session).toEqual([]);
    expect(gameA).toEqual([]);
    expect(service.get(aId).moves).toHaveLength(1);
    // Отменённая задача не перезапускается сама.
    expect(releases).toHaveLength(1);
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 1, currentGames: 1 });
    expect(service.get(b.state.id).status).toBe('playing');
  });

  it('после переключения ход человека в A уходит только в канал A; поток сессии получает события B', async () => {
    const { service, bus } = await make(createFakeEngine());
    const a = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const b = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const session = record(bus, 'session:s1');
    const gameA = record(bus, `game:${a.state.id}`);
    await service.play(a.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(gameA.map((e) => e.type)).toEqual(['state.updated']);
    expect(session).toEqual([]);
    await service.play(b.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(session).toHaveLength(1);
    expect(belongsTo(session[0] as GameEvent, b.state.id)).toBe(true);
  });

  it('партия другой сессии не отменяется и говорит в свою сессию', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'], delayMs: 1_000 });
    const { service, bus } = await make(inner);
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.play(a.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => inner.calls.genmove === 1);
    const s1 = record(bus, 'session:s1');
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    await vi.advanceTimersByTimeAsync(1_000);
    await untilTick(() => service.get(a.state.id).moves.length === 2);
    expect(s1.map((e) => e.type)).toEqual(['state.updated']);
  });

  it('отказ записи новой партии не переключает сессию и не отменяет текущую', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failNew = false;
    const store = {
      load: () => real.load(),
      remove: (id: string) => real.remove(id),
      save: async (state: GameState) => {
        if (failNew && state.moves.length === 0) throw new Error('disk full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const inner = createFakeEngine({ script: ['E5'], delayMs: 1_000 });
    const { service, bus } = await make(inner, { store });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.play(a.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => inner.calls.genmove === 1);
    const session = record(bus, 'session:s1');
    failNew = true;
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).rejects.toThrow('disk full');
    await vi.advanceTimersByTimeAsync(1_000);
    await untilTick(() => service.get(a.state.id).moves.length === 2);
    expect(session.map((e) => e.type)).toEqual(['state.updated']);
    expect(belongsTo(session[0] as GameEvent, a.state.id)).toBe(true);
  });

  it('forgetSession: привязки сессии снимаются, события её партии в канал сессии больше не идут', async () => {
    const { service, bus } = await make(createFakeEngine());
    const a = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 2, currentGames: 2 });
    const session = record(bus, 'session:s1');
    service.forgetSession('s1');
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 1, currentGames: 1 });
    await service.play(a.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(session).toEqual([]);
    service.forgetSession('s2');
    service.forgetSession('unknown');
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 0, currentGames: 0 });
  });

  it('forgetSession во время записи новой партии: session.game не шлётся, привязок не остаётся', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (state.revision === 0) await new Promise<void>((r) => (release = r));
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service, bus } = await make(createFakeEngine(), { store });
    const session = record(bus, 'session:s1');
    const creating = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => release !== undefined);
    service.forgetSession('s1');
    release?.();
    await creating;
    expect(session).toEqual([]);
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 0, currentGames: 0 });
  });

  it('сигналы фоновых задач не копятся: после хода движка и после отмены таблица пуста', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'], delayMs: 100 });
    const { service } = await make(inner);
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.play(a.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await thinkThrough(inner, 1, 100);
    await untilTick(() => service.get(a.state.id).moves.length === 2);
    await untilTick(() => service.internalSizes().taskAborts === 0);
    await service.play(a.state.id, { coord: 'C3', waitForReply: false, via: 'api' });
    await untilTick(() => inner.calls.genmove === 2);
    expect(service.internalSizes().taskAborts).toBe(1);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => service.internalSizes().taskAborts === 0);
  });

  it('автосчёт старой партии тоже отменяется: вызов score получает abort, событий error нет', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    const inner = createFakeEngine();
    const engine: Engine = {
      ...inner,
      score: (_req, signal) =>
        new Promise((_, reject) => {
          if (signal) signals.push(signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const { service, bus } = await make(engine, { scoreBudgetMs: 60_000 });
    const a = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    const gameA = record(bus, `game:${aId}`);
    await service.pass(aId, { waitForReply: false, via: 'api' });
    await service.pass(aId, { waitForReply: false, via: 'api' });
    await untilTick(() => signals.length === 1);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await tick(10);
    expect(signals).toHaveLength(1);
    expect(errorEvents(gameA)).toEqual([]);
    expect(service.get(aId).status).toBe('playing');
    await untilTick(() => service.internalSizes().taskAborts === 0);
  });
});

describe('GameService: отмена фоновой задачи в паузе серии и в очереди мьютекса (B2)', () => {
  it('отмена во время паузы после отказа движка: пауза обрывается сразу, resume ставит ход, не дожидаясь паузы', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine({ script: ['E5'] });
    let calls = 0;
    const engine: Engine = {
      ...inner,
      genmove: (req, signal) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('engine down'));
        return inner.genmove(req, signal);
      },
    };
    const { service, bus } = await make(engine, { retryDelaysMs: delays(60_000) });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    const gameA = record(bus, `game:${aId}`);
    await service.play(aId, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => errorEvents(gameA).length === 1);
    expect(vi.getTimerCount()).toBe(1);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await tick(5);
    expect(vi.getTimerCount()).toBe(0);
    service.resume(aId);
    await untilTick(() => service.get(aId).moves.length === 2);
    expect(calls).toBe(2);
    expect(errorEvents(gameA)).toHaveLength(1);
  });

  it('отмена во время паузы после отказа записи хода движка: пауза обрывается сразу, resume доигрывает ход', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let failEngineMove = 1;
    const store = {
      load: () => real.load(),
      remove: (id: string) => real.remove(id),
      save: async (state: GameState) => {
        if (state.moves.length === 2 && failEngineMove-- > 0) throw new Error('disk full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const inner = createFakeEngine({ script: ['E5', 'E5'] });
    const { service, bus } = await make(inner, { store, retryDelaysMs: delays(60_000) });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    const gameA = record(bus, `game:${aId}`);
    await service.play(aId, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => errorEvents(gameA).length === 1);
    expect(errorEvents(gameA)[0]).toMatchObject({ code: 'internal' });
    expect(vi.getTimerCount()).toBe(1);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await tick(5);
    expect(vi.getTimerCount()).toBe(0);
    service.resume(aId);
    await untilTick(() => service.get(aId).moves.length === 2);
    expect(inner.calls.genmove).toBe(2);
  });

  it('отмена раньше отказа записи хода движка: пауза после отказа не начинается, resume доигрывает ход', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = memoryStore();
    let rejectSave: ((e: Error) => void) | undefined;
    let gated = 1;
    const store = {
      load: () => real.load(),
      remove: (id: string) => real.remove(id),
      save: async (state: GameState) => {
        if (state.moves.length === 2 && gated-- > 0) await new Promise<void>((_, reject) => (rejectSave = reject));
        return real.save(state);
      },
    } as unknown as GameStore;
    const inner = createFakeEngine({ script: ['E5', 'E5'] });
    const { service } = await make(inner, { store, retryDelaysMs: delays(60_000) });
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    await service.play(aId, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => rejectSave !== undefined);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    rejectSave?.(new Error('disk full'));
    await tick(10);
    expect(vi.getTimerCount()).toBe(0);
    service.resume(aId);
    await untilTick(() => service.get(aId).moves.length === 2);
    expect(inner.calls.genmove).toBe(2);
  });

  it('итог счёта, дождавшийся мьютекса уже после отмены, не применяется, и второй счёт не начинается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    const releases: (() => void)[] = [];
    const engine: Engine = {
      ...inner,
      score: (req, signal) =>
        new Promise((resolve, reject) => {
          releases.push(() => resolve(inner.score(req)));
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    const real = memoryStore();
    let rejectSave: ((e: Error) => void) | undefined;
    const store = {
      load: () => real.load(),
      remove: (id: string) => real.remove(id),
      save: async (state: GameState) => {
        if (state.moves.length === 3) await new Promise<void>((_, reject) => (rejectSave = reject));
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service, bus } = await make(engine, { store, scoreBudgetMs: 60_000 });
    const a = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    const gameA = record(bus, `game:${aId}`);
    await service.pass(aId, { waitForReply: false, via: 'api' });
    await service.pass(aId, { waitForReply: false, via: 'api' });
    await untilTick(() => releases.length === 1);
    // Ход человека держит мьютекс партии: его запись висит, а потом откажет.
    const playFails = expect(service.play(aId, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toThrow('disk full');
    await untilTick(() => rejectSave !== undefined);
    // Счёт готов, но применяется только под мьютексом — после хода.
    releases[0]?.();
    await tick(5);
    // В сессии создаётся B: задача счёта A отменена, пока её итог ждёт мьютекса.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    rejectSave?.(new Error('disk full'));
    await playFails;
    await tick(10);
    // Ревизия после отказа хода та же, что у счёта, но задача отменена: итог отброшен, нового счёта нет.
    expect(service.get(aId)).toMatchObject({ status: 'playing', revision: a.state.revision + 2 });
    expect(releases).toHaveLength(1);
    expect(gameA.filter((e) => e.type === 'game.finished')).toEqual([]);
    await untilTick(() => service.internalSizes().taskAborts === 0);
  });

  it('движок, бросивший синхронно, — отказ движка в серии: engine_unavailable, а не internal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine: Engine = {
      ...createFakeEngine(),
      score: () => {
        throw new Error('sync failure at /secret/path');
      },
    };
    const lines: string[] = [];
    const { service, bus } = await make(engine, { retryDelaysMs: delays(60_000), log: (l) => lines.push(l) });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await expect(service.score(id)).rejects.toThrow('sync failure');
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => errorEvents(events).length === 1);
    expect(errorEvents(events)).toEqual([{ type: 'error', gameId: id, code: 'engine_unavailable', message: ENGINE_UNAVAILABLE_MESSAGE }]);
    expect(lines.filter((l) => l.startsWith('[!] engine:'))).toHaveLength(1);
  });

  it('отменённый сигнал не достаётся следующей задаче: счёт, поставленный пока отменённый ход движка ещё висит, идёт', async () => {
    const inner = createFakeEngine();
    const releases: (() => void)[] = [];
    // Ход движка не слушает отмену: отменённая задача остаётся в карте, пока тест её не отпустит.
    const engine: Engine = {
      ...inner,
      genmove: async (req) => {
        await new Promise<void>((r) => releases.push(r));
        return inner.genmove(req);
      },
    };
    const { service } = await make(engine);
    const a = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' });
    const aId = a.state.id;
    await service.pass(aId, { waitForReply: false, via: 'api' });
    await untilTick(() => releases.length === 1);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    service.resume(aId);
    // Пас за движок даёт второй пас подряд: задача счёта ставится, пока отменённый ход движка ещё в карте.
    await service.pass(aId, { color: 'W', waitForReply: false, via: 'api' }, 'engine');
    await untilTick(() => service.get(aId).status === 'finished');
    expect(service.get(aId).result).toMatchObject({ reason: 'score' });
    releases[0]?.();
    await untilTick(() => service.internalSizes().taskAborts === 0);
  });

  it('переключение с партии без фоновой задачи не метит её исчерпанной серией', async () => {
    const { service } = await make(createFakeEngine());
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    expect(service.internalSizes()).toMatchObject({ gaveUp: 0, taskAborts: 0 });
  });

  it('партия, уже опубликованная, но ещё не вышедшая из create, в лимите считается один раз', async () => {
    const ids = ['aaa1', 'bbb2'];
    const { service, bus } = await make(createFakeEngine(), { maxActiveGames: 2, newId: () => ids.shift() ?? 'zzz9' });
    let nested: Promise<unknown> | undefined;
    // Подписчик получает событие новой партии синхронно, до выхода create: второй create — в этот момент.
    bus.subscribe('game:aaa1', (e) => {
      if (e.type === 'state.updated' && e.cause === 'new') nested ??= service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(nested).toBeDefined();
    await expect(nested).resolves.toMatchObject({ state: { id: 'bbb2' } });
    expect(service.list()).toHaveLength(2);
  });
});

describe('GameService: лимит партий и старые снапшоты (B5)', () => {
  it('не больше maxActiveGames незавершённых партий: лишняя — too_many_games, завершённые не в счёт', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 2 });
    const a = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const refused = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_many_games', status: 429, details: { max: 2 } });
    expect(service.list()).toHaveLength(2);
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 0 });
    await service.resign(a.state.id, { color: 'B', via: 'api' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(service.list()).toHaveLength(3);
  });

  it('умолчание — 20 незавершённых партий', async () => {
    expect(MAX_ACTIVE_GAMES).toBe(20);
    const { service } = await make(createFakeEngine());
    for (let i = 0; i < 20; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 20 } });
  });

  it('create, ещё не записавший снапшот, уже занимает место в лимите; отказ записи место освобождает', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    let gated = 1;
    // Первая запись висит до release и отказывает, остальные проходят.
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (gated-- > 0) {
          await new Promise<void>((r) => (release = r));
          throw new Error('disk full');
        }
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service } = await make(createFakeEngine(), { store, maxActiveGames: 1 });
    const first = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const firstFails = expect(first).rejects.toThrow('disk full');
    await untilTick(() => release !== undefined);
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games' });
    release?.();
    await firstFails;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(service.list()).toHaveLength(1);
  });

  const DAY = 24 * 3600 * 1000;
  const NOW = new Date('2026-09-14T12:00:00.000Z');
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
  const seat = { B: { controller: 'human' as const }, W: { controller: 'human' as const } };
  const seedGame = (id: string, createdAgo: number, opts: { moveAgo?: number; finished?: boolean } = {}): GameState => {
    let state = newGame({ id, createdAt: at(createdAgo), settings: GameSettings.parse({ boardSize: 9 }), seats: seat });
    if (opts.moveAgo !== undefined) state = applyMove(state, 'B', 'D4', at(opts.moveAgo)).state;
    return opts.finished ? resignGame(state, 'W') : state;
  };

  it('init удаляет снапшоты завершённых партий старше 30 дней по последней активности', async () => {
    expect(FINISHED_RETENTION_MS).toBe(30 * DAY);
    const store = memoryStore([
      seedGame('oldfinished', 40 * DAY, { finished: true }),
      seedGame('oldmovefinished', 40 * DAY, { moveAgo: 31 * DAY, finished: true }),
      // Создана давно, но последний ход свежий: активность считается по ходу.
      seedGame('recentmove', 40 * DAY, { moveAgo: 29 * DAY, finished: true }),
      // Ровно 30 дней — ещё не старше.
      seedGame('boundary', 30 * DAY, { finished: true }),
      seedGame('justover', 30 * DAY + 1, { finished: true }),
      // Незавершённая партия не удаляется, сколько бы ей ни было.
      seedGame('oldplaying', 400 * DAY),
    ]);
    const { service } = await make(createFakeEngine(), { store, now: () => NOW });
    expect(store.removed).toEqual(['oldfinished', 'oldmovefinished', 'justover']);
    expect(service.list().map((g) => g.id).sort()).toEqual(['boundary', 'oldplaying', 'recentmove']);
    expect((await store.load()).map((g) => g.id).sort()).toEqual(['boundary', 'oldplaying', 'recentmove']);
  });

  it('отказ удаления старого снапшота: строка [!] в лог, партия из памяти убрана, init не падает', async () => {
    const real = memoryStore([seedGame('old1', 40 * DAY, { finished: true }), seedGame('old2', 40 * DAY, { finished: true }), seedGame('fresh', DAY)]);
    const store = {
      load: () => real.load(),
      save: (state: GameState) => real.save(state),
      remove: async (id: string) => {
        if (id === 'old1') throw new Error('EPERM /secret/path');
        return real.remove(id);
      },
    } as unknown as GameStore;
    const lines: string[] = [];
    const { service } = await make(createFakeEngine(), { store, now: () => NOW, log: (l) => lines.push(l) });
    expect(service.list().map((g) => g.id)).toEqual(['fresh']);
    expect(real.removed).toEqual(['old2']);
    expect(lines.filter((l) => l.startsWith('[!]') && l.includes('old1'))).toHaveLength(1);
  });

  const HOUR = 3600 * 1000;
  const seedEngineGame = (id: string, createdAgo: number): GameState =>
    newGame({ id, createdAt: at(createdAgo), settings: GameSettings.parse({ boardSize: 9 }), seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } } });
  // Два паса подряд: партия ждёт автосчёта.
  const seedPassed = (id: string, passAgo: number): GameState => {
    const created = newGame({ id, createdAt: at(DAY), settings: GameSettings.parse({ boardSize: 9 }), seats: seat });
    return applyMove(applyMove(created, 'B', 'pass', at(passAgo)).state, 'W', 'pass', at(passAgo)).state;
  };

  it('незавершённая партия без активности дольше STALE_GAME_MS в лимите не считается; порог — последняя активность в момент create', async () => {
    expect(STALE_GAME_MS).toBe(SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(2 * HOUR);
    let clock = NOW.getTime();
    const store = memoryStore([
      seedGame('stale', 3 * DAY),
      // Последний ход чуть старше порога.
      seedGame('stalemove', 3 * DAY, { moveAgo: 2 * HOUR + 1 }),
      // Ровно на пороге — ещё не устарела.
      seedGame('edge', 2 * HOUR),
      // Создана давно, но ход свежий: активность по ходу.
      seedGame('moved', 3 * DAY, { moveAgo: HOUR }),
    ]);
    const { service } = await make(createFakeEngine(), { store, now: () => new Date(clock), maxActiveGames: 3 });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 3 } });
    // Часы ушли на час: edge и moved устарели уже во время работы сервера.
    clock += HOUR + 1;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games' });
    expect(service.list()).toHaveLength(7);
  });

  it('не больше MAX_GAMES_PER_CLIENT незавершённых партий на клиента: лишняя — too_many_games со scope client; другой клиент и create без клиента не в счёте; сдача освобождает место', async () => {
    expect(MAX_GAMES_PER_CLIENT).toBe(3);
    const { service } = await make(createFakeEngine());
    const mine = { clientKey: '203.0.113.7' };
    const first = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    const refused = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { ...mine, sessionId: 's1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_many_games', status: 429, message: 'limit of 3 unfinished games per client reached', details: { max: 3, scope: 'client' } });
    expect(service.list()).toHaveLength(3);
    // Отказ не привязал партию к сессии и не сделал её текущей: её не было.
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 0, currentGames: 0 });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: '203.0.113.8' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.resign(first.state.id, { color: 'B', via: 'api' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    expect(service.list()).toHaveLength(6);
  });

  it('общий лимит проверяется раньше лимита на клиента: без scope', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1, maxGamesPerClient: 1 });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    const refused = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'too_many_games', details: { max: 1 } });
    expect((refused as ApiError).details).not.toHaveProperty('scope');
  });

  it('create клиента, ещё не записавший снапшот, уже в его счёте; отказ записи место освобождает', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    let gated = 1;
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (gated-- > 0) {
          await new Promise<void>((r) => (release = r));
          throw new Error('disk full');
        }
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const first = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    const firstFails = expect(first).rejects.toThrow('disk full');
    await untilTick(() => release !== undefined);
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 1, scope: 'client' } });
    // Другой клиент в это время создаёт: пишущийся create занимает место только своего клиента.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c2' });
    release?.();
    await firstFails;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    expect(service.list()).toHaveLength(2);
  });

  it('брошенная партия клиента в его счёте не идёт; ход в ней возвращает её в счёт', async () => {
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { now: () => new Date(clock), maxGamesPerClient: 2 });
    const old = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games' });
    clock += STALE_GAME_MS + 1;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await service.play(old.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { scope: 'client' } });
    expect(service.list()).toHaveLength(3);
  });

  it('новая партия в сессии бросает прежнюю незавершённую: в общем лимите её нет, а текущая партия сессии не мешает своей замене', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 2 });
    for (let i = 0; i < 4; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    // В счёте текущая партия s1 и партия без сессии: лимит полон, в новой сессии партия не создаётся.
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    // Новая партия s1 заменит текущую, и та станет брошенной: create проходит и при полном лимите.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    expect(service.list()).toHaveLength(6);
  });

  it('брошенная сменой партия не в счёте клиента; текущие партии других сессий того же клиента — в счёте', async () => {
    const { service } = await make(createFakeEngine(), { maxGamesPerClient: 2 });
    for (let i = 0; i < 3; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1', clientKey: 'c1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2', clientKey: 'c1' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's3', clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2, scope: 'client' } });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2', clientKey: 'c1' });
    expect(service.list()).toHaveLength(5);
  });

  it('возврат к брошенной сменой партии в пределах лимита — ход в ней или открытие её потока (resume) — возвращает её в счёт', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 3 });
    const create = () => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    const b = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    // a и b брошены, в счёте одна текущая. Ход в a и поток b возвращают обе: с текущей лимит 3 полон.
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    service.resume(b);
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games', details: { max: 3 } });
    await service.resign(a, { color: 'B', via: 'api' });
    await create();
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games' });
    expect(service.list()).toHaveLength(4);
  });

  it('отметка брошенной сменой партии переживает рестарт: после init партия не в лимите и без задачи; возврат снимает отметку, ставит задачу и возвращает партию в счёт', async () => {
    const store = memoryStore();
    const marks = memoryMarks();
    // Первый запуск: движок не отвечает, пока задачу не отменят.
    const silent: Engine = {
      ...createFakeEngine(),
      genmove: (_req, signal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    };
    const first = await make(silent, { store, marks });
    const a = (await first.service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await first.service.play(a, { coord: 'D4', waitForReply: false, via: 'voice' });
    // Сданная партия при смене не отмечается: она завершена, а не брошена.
    const done = (await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' })).state.id;
    await first.service.resign(done, { color: 'B', via: 'api' });
    await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    // Новая партия s1: раздумье в a отменено, a брошена.
    await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await first.service.close();
    expect([...marks.ids]).toEqual([a]);

    const engine = createFakeEngine({ script: ['E5'] });
    const second = await make(engine, { store, marks, maxActiveGames: 3 });
    const create = () => second.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await tick(20);
    expect(engine.calls).toMatchObject({ genmove: 0 });
    expect(second.service.get(a)).toMatchObject({ status: 'playing', pendingEngineMove: true });
    // В счёте две текущие партии сессий; будь a в счёте, лимит 3 был бы уже полон.
    const extra = await create();
    await second.service.resign(extra.state.id, { color: 'B', via: 'api' });
    second.service.resume(a);
    await untilTick(() => second.service.get(a).moves.length === 2);
    await untilTick(() => marks.ids.size === 0);
    // a снова в счёте: с двумя текущими партиями сессий лимит 3 полон.
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games', details: { max: 3 } });
  });

  it('отказ записи отметки — строка [!] в лог; в памяти партия всё равно брошена', async () => {
    const logs: string[] = [];
    const marks = {
      ...memoryMarks(),
      markAbandoned: async () => {
        throw new Error('disk full');
      },
    };
    const { service } = await make(createFakeEngine(), { marks, maxActiveGames: 2, log: (line: string) => logs.push(line) });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => logs.length > 0);
    expect(logs).toEqual([`[!] could not mark game ${a} as abandoned: disk full`]);
    // a не в счёте: в новой сессии место есть.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    expect(service.list()).toHaveLength(3);
  });

  it('init снимает отметки завершённой и удалённой партии; отметка идущей остаётся и действует', async () => {
    const store = memoryStore([seedGame('playing1', HOUR), seedGame('finished1', HOUR, { finished: true })]);
    const marks = memoryMarks();
    for (const id of ['finished1', 'gone1', 'playing1']) marks.ids.add(id);
    const { service } = await make(createFakeEngine(), { store, marks, now: () => NOW, maxActiveGames: 1 });
    await untilTick(() => marks.ids.size === 1);
    expect([...marks.ids]).toEqual(['playing1']);
    // playing1 брошена: лимит 1 свободен.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
  });

  it('записи отметок идут по очереди: снятие ждёт отметку; close ждёт последнюю запись', async () => {
    const base = memoryMarks();
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const marks = {
      ...base,
      markAbandoned: async (id: string) => {
        calls.push(`mark ${id}`);
        await new Promise<void>((r) => (release = r));
        await base.markAbandoned(id);
      },
      clearAbandoned: async (id: string) => {
        calls.push(`clear ${id}`);
        await base.clearAbandoned(id);
      },
    };
    const { service } = await make(createFakeEngine(), { marks });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => release !== undefined);
    service.resume(a);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await tick(20);
    expect(calls).toEqual([`mark ${a}`]);
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(calls).toEqual([`mark ${a}`, `clear ${a}`]);
    expect(base.ids.size).toBe(0);
  });

  it('действие человека в неброшенной партии отметок на диске не трогает; действие от имени движка брошенную партию не возвращает', async () => {
    const base = memoryMarks();
    const cleared: string[] = [];
    const marks = {
      ...base,
      clearAbandoned: async (id: string) => {
        cleared.push(id);
        await base.clearAbandoned(id);
      },
    };
    const { service } = await make(createFakeEngine(), { marks, maxActiveGames: 3 });
    const create = (sessionId: string) => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId });
    const a = (await create('s1')).state.id;
    const b = (await create('s2')).state.id;
    await service.play(b, { coord: 'D4', waitForReply: false, via: 'api' });
    service.resume(b);
    await create('s1');
    // a брошена; undo от имени движка её не возвращает: в счёте две текущие партии, место для третьей есть.
    await expect(service.undo(a, { via: 'api' }, 'engine')).rejects.toBeInstanceOf(ApiError);
    await create('s3');
    await service.close();
    expect(cleared).toEqual([]);
    expect([...base.ids]).toEqual([a]);
  });

  it('счёт клиентов не держит лишних записей: отказавший create и завершённая партия уходят; пишущийся create без клиента в счёт клиента не идёт', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    let hang = 1;
    let fail = 0;
    // Первая запись висит до release и отказывает; следующая запись отказывает, когда fail > 0.
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (hang-- > 0) {
          await new Promise<void>((r) => (release = r));
          throw new Error('disk full');
        }
        if (fail-- > 0) throw new Error('disk full');
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const pending = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const pendingFails = expect(pending).rejects.toThrow('disk full');
    await untilTick(() => release !== undefined);
    const mine = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    release?.();
    await pendingFails;
    expect(service.internalSizes()).toMatchObject({ clientGames: 1 });
    fail = 1;
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c2' })).rejects.toThrow('disk full');
    expect(service.internalSizes()).toMatchObject({ clientGames: 1 });
    await service.resign(mine.state.id, { color: 'B', via: 'api' });
    // Проверка лимита c3 вычищает запись завершённой партии c1.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c3' });
    expect(service.internalSizes()).toMatchObject({ clientGames: 1 });
  });

  it('обход из ревью закрыт: 20 партий подряд в сессии и возврат ко всем брошенным не занимают общий лимит — возврат проходит лимит клиента', async () => {
    const marks = memoryMarks();
    const { service } = await make(createFakeEngine(), { marks });
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_GAMES; i++) ids.push((await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1', clientKey: 'A' })).state.id);
    const nth = (i: number): string => {
      const id = ids[i];
      if (id === undefined) throw new Error(`нет партии ${i}`);
      return id;
    };
    // Открытие потоков всех брошенных: с текущей партией клиент A доходит ровно до 3, остальные остаются брошенными.
    for (const id of ids.slice(0, -1)) service.resume(id);
    await untilTick(() => !marks.ids.has(nth(0)) && !marks.ids.has(nth(1)) && marks.ids.size === MAX_ACTIVE_GAMES - 3);
    expect([...marks.ids].sort()).toEqual(ids.slice(2, -1).sort());
    // Ход в брошенной сверх лимита отклонён до операции: партия не меняется и остаётся брошенной.
    const refused = await service.play(nth(5), { coord: 'D4', waitForReply: false, via: 'api' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_many_games', status: 429, details: { max: MAX_GAMES_PER_CLIENT, scope: 'client' } });
    expect(service.get(nth(5)).moves).toHaveLength(0);
    // Другой клиент в новой сессии создаёт партию: общий лимит не занят.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2', clientKey: 'B' });
    await service.close();
    expect(marks.ids.has(nth(5))).toBe(true);
  });

  it('возврат сверх общего лимита: поток оставляет партию брошенной и после рестарта, действие — 429 без scope; освободилось место — возврат снимает отметку', async () => {
    const store = memoryStore();
    const marks = memoryMarks();
    const first = await make(createFakeEngine(), { store, marks, maxActiveGames: 2 });
    const inS1 = async () => (await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    const a = await inS1();
    const b = await inS1();
    await inS1();
    // a и b брошены, в счёте текущая; возврат a доводит счёт ровно до 2, возврат b уже сверх лимита.
    first.service.resume(a);
    first.service.resume(b);
    const refused = await first.service.play(b, { coord: 'D4', waitForReply: false, via: 'api' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'too_many_games', status: 429, details: { max: 2 } });
    expect((refused as ApiError).details).not.toHaveProperty('scope');
    expect(first.service.get(b).moves).toHaveLength(0);
    await first.service.close();
    expect([...marks.ids]).toEqual([b]);

    const second = await make(createFakeEngine(), { store, marks, maxActiveGames: 2 });
    second.service.resume(b);
    await expect(second.service.play(b, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    await second.service.resign(a, { color: 'B', via: 'api' });
    await second.service.play(b, { coord: 'D4', waitForReply: false, via: 'api' });
    await second.service.close();
    expect([...marks.ids]).toEqual([]);
  });

  it('возврат сверх лимита не ставит брошенной партии задачу движка — ни потоком, ни отклонённым действием; в пределах лимита поток ставит', async () => {
    let calls = 0;
    // Движок не отвечает, пока задачу не отменят: считаем только вызовы.
    const silent: Engine = {
      ...createFakeEngine(),
      genmove: (_req, signal) => {
        calls++;
        return new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    };
    const { service } = await make(silent, { maxActiveGames: 2 });
    const a = (await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await untilTick(() => calls === 1);
    // Смена партии отменяет раздумье в a и бросает её; партия без сессии заполняет лимит 2.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    const other = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    service.resume(a);
    await expect(service.resign(a, { color: 'W', via: 'api' })).rejects.toMatchObject({ code: 'too_many_games' });
    await tick(20);
    expect(calls).toBe(1);
    expect(service.get(a)).toMatchObject({ status: 'playing', pendingEngineMove: true });
    await service.resign(other, { color: 'B', via: 'api' });
    service.resume(a);
    await untilTick(() => calls === 2);
  });

  it('возврат проверяет общий лимит раньше лимита клиента; граница — ровно maxActiveGames', async () => {
    const small = await make(createFakeEngine(), { maxActiveGames: 2, maxGamesPerClient: 1 });
    const a = (await small.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1', clientKey: 'A' })).state.id;
    await small.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1', clientKey: 'A' });
    await small.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'B' });
    // Полны оба лимита: отказ — общий, без scope.
    const refused = await small.service.play(a, { coord: 'D4', waitForReply: false, via: 'api' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    expect((refused as ApiError).details).not.toHaveProperty('scope');

    // Умолчание 20: три сессии разных клиентов, по брошенной партии в каждой, и 15 партий без сессии.
    const { service } = await make(createFakeEngine());
    const abandoned: string[] = [];
    for (const [sid, client] of [['s1', 'A'], ['s2', 'B'], ['s3', 'C']]) {
      abandoned.push((await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: sid, clientKey: client })).state.id);
      await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: sid, clientKey: client });
    }
    for (let i = 0; i < 15; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: `other${i}` });
    const [x, y, z] = abandoned;
    if (x === undefined || y === undefined || z === undefined) throw new Error('нет брошенных партий');
    // 18 в счёте: 19-я и ровно 20-я возвращаются, 21-я — отказ общего лимита.
    await service.play(x, { coord: 'D4', waitForReply: false, via: 'api' });
    await service.play(y, { coord: 'D4', waitForReply: false, via: 'api' });
    await expect(service.play(z, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: MAX_ACTIVE_GAMES } });
  });

  it('обход через устаревание закрыт: партии, накопленные по 3 за порог STALE_GAME_MS, возвращаются в счёт не больше лимита клиента', async () => {
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { now: () => new Date(clock) });
    const ids: string[] = [];
    // Каждый круг: три партии клиента A, затем порог — все устарели и в счёте не идут.
    while (ids.length < MAX_ACTIVE_GAMES) {
      for (let i = 0; i < MAX_GAMES_PER_CLIENT && ids.length < MAX_ACTIVE_GAMES; i++) ids.push((await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).state.id);
      clock += STALE_GAME_MS + 1;
    }
    const plays = await Promise.allSettled(ids.map((id) => service.play(id, { coord: 'D4', waitForReply: false, via: 'api' })));
    expect(plays.filter((p) => p.status === 'fulfilled')).toHaveLength(MAX_GAMES_PER_CLIENT);
    const rejected = plays.flatMap((p) => (p.status === 'rejected' ? [p.reason] : []));
    expect(rejected).toHaveLength(MAX_ACTIVE_GAMES - MAX_GAMES_PER_CLIENT);
    for (const reason of rejected) expect(reason).toMatchObject({ code: 'too_many_games', details: { max: MAX_GAMES_PER_CLIENT, scope: 'client' } });
    expect(service.list().filter((g) => g.moveCount > 0)).toHaveLength(MAX_GAMES_PER_CLIENT);
    // Другой клиент создаёт партию: общий лимит не занят.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'B' });
  });

  it('возврат к устаревшей партии в пределах лимита: она снова в счёте с момента возврата и устаревает через STALE_GAME_MS без активности', async () => {
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { now: () => new Date(clock), maxActiveGames: 2, maxGamesPerClient: 1 });
    const old = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).state.id;
    clock += STALE_GAME_MS + 1;
    const other = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    // Открытие потока — возврат без хода: old снова в счёте, в том числе клиента A.
    service.resume(old);
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    await service.resign(other, { color: 'B', via: 'api' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).rejects.toMatchObject({ details: { scope: 'client' } });
    // Ровно STALE_GAME_MS после возврата — ещё в счёте, на 1 мс позже — устарела снова.
    clock += STALE_GAME_MS;
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).rejects.toMatchObject({ details: { scope: 'client' } });
    clock += 1;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' });
    // Ход в вернувшейся устаревшей партии проходит лимиты заново: клиент A занят новой партией.
    await expect(service.play(old, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toMatchObject({ details: { max: 1, scope: 'client' } });
  });

  it('возврат к устаревшей партии без отметки на диск отметок не пишет; к завершённой старой партии лимит не применяется — game_finished, а не 429', async () => {
    const base = memoryMarks();
    const cleared: string[] = [];
    const marks = {
      ...base,
      clearAbandoned: async (id: string) => {
        cleared.push(id);
        await base.clearAbandoned(id);
      },
    };
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { marks, now: () => new Date(clock), maxActiveGames: 1 });
    const done = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    await service.resign(done, { color: 'B', via: 'api' });
    const stale = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    clock += STALE_GAME_MS + 1;
    service.resume(stale);
    await service.play(stale, { coord: 'D4', waitForReply: false, via: 'api' });
    // Лимит полон вернувшейся stale; старая завершённая партия отвечает своим отказом.
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toMatchObject({ code: 'too_many_games' });
    await expect(service.play(done, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
    await service.close();
    expect(cleared).toEqual([]);
  });

  it('устаревшая партия сверх лимита: поток не ставит задачу движка, действие — 429; в пределах лимита поток ставит задачу', async () => {
    const engine = createFakeEngine({ script: ['E5'] });
    const store = memoryStore([seedEngineGame('staleengine', STALE_GAME_MS + 1)]);
    const { service } = await make(engine, { store, now: () => NOW, maxActiveGames: 1, maxGamesPerClient: 1 });
    const fresh = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    service.resume('staleengine');
    await expect(service.resign('staleengine', { color: 'W', via: 'api' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 1 } });
    await tick(20);
    expect(engine.calls).toMatchObject({ genmove: 0 });
    expect(service.get('staleengine')).toMatchObject({ status: 'playing', moves: [] });
    await service.resign(fresh, { color: 'B', via: 'api' });
    service.resume('staleengine');
    await untilTick(() => service.get('staleengine').moves.length === 1);
  });

  it('граница STALE_GAME_MS ровно: активная партия при полном лимите принимает действия, устаревшая на 1 мс — 429', async () => {
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { now: () => new Date(clock), maxActiveGames: 3 });
    const create = async () => (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    const a = await create();
    const b = await create();
    // Ровно на пороге a и b ещё в счёте: с c лимит 3 полон, а ход в активной a проходит.
    clock += STALE_GAME_MS;
    await create();
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games' });
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    // Через 1 мс b устарела: лимит снова полон с d, и возврат к b отклонён.
    clock += 1;
    await create();
    await expect(service.play(b, { coord: 'D4', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 3 } });
    expect(service.get(b).moves).toHaveLength(0);
  });

  // Партия завершается счётом: ход, пас, пас, затем автосчёт.
  const finishByPasses = async (service: GameService, id: string): Promise<void> => {
    await service.play(id, { coord: 'D4', waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => service.get(id).status === 'finished');
  };

  it('обход через undo закрыт: «счёт → новая партия в сессии → undo прежней» по кругу возвращает в счёт не больше лимита клиента; владелец завершённой партии помнится', async () => {
    const { service } = await make(createFakeEngine());
    const phone = { clientKey: 'phone' };
    // undo идёт с адреса агента: в счёт идёт владелец партии, а не адрес запроса.
    const agent = { clientKey: 'agent' };
    const create = () => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { ...phone, sessionId: 's1' });
    let current = (await create()).state.id;
    const refusals: unknown[] = [];
    for (let i = 0; i < MAX_ACTIVE_GAMES + 1; i++) {
      await finishByPasses(service, current);
      const next = (await create()).state.id;
      await service.undo(current, { via: 'api' }, 'human', agent).catch((e: unknown) => refusals.push(e));
      current = next;
    }
    const counted = service.list().filter((g) => g.status === 'playing');
    expect(counted).toHaveLength(MAX_GAMES_PER_CLIENT);
    expect(refusals).toHaveLength(MAX_ACTIVE_GAMES + 1 - (MAX_GAMES_PER_CLIENT - 1));
    for (const reason of refusals) expect(reason).toMatchObject({ code: 'too_many_games', details: { max: MAX_GAMES_PER_CLIENT, scope: 'client' } });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { ...phone, sessionId: 's2' })).rejects.toMatchObject({ details: { scope: 'client' } });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'other', sessionId: 's3' });
  });

  it('undo и correct завершённой счётом партии сверх лимита — 429 до операции, партия не меняется; в пределах лимита undo возвращает её в счёт', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 2, maxGamesPerClient: 1 });
    const old = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).state.id;
    await finishByPasses(service, old);
    const finished = service.get(old);
    const mine = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).state.id;
    await expect(service.undo(old, { via: 'api' }, 'human', { clientKey: 'A' })).rejects.toMatchObject({ code: 'too_many_games', status: 429, details: { max: 1, scope: 'client' } });
    await expect(service.correct(old, { coord: 'E5', waitForReply: false, via: 'api' }, 'human', { clientKey: 'A' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 1, scope: 'client' } });
    const other = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'B' })).state.id;
    // Общий лимит проверяется первым: отказ без scope.
    await expect(service.undo(old, { via: 'api' }, 'human', { clientKey: 'A' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    await expect(service.undo(old, { via: 'api' }, 'human', { clientKey: 'A' })).rejects.not.toHaveProperty('details.scope');
    expect(service.get(old)).toBe(finished);
    await service.resign(other, { color: 'B', via: 'api' });
    await service.resign(mine, { color: 'B', via: 'api' });
    const undone = await service.undo(old, { via: 'api' }, 'human', { clientKey: 'A' });
    expect(undone.state).toMatchObject({ status: 'playing', moves: [{ coord: 'D4' }] });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).rejects.toMatchObject({ details: { scope: 'client' } });
  });

  it('correct завершённой счётом партии в пределах лимита проходит и возвращает её в счёт; партия без владельца (до рестарта) идёт в счёт адреса запроса', async () => {
    const store = memoryStore([seedPassed('scored', HOUR)]);
    const { service } = await make(createFakeEngine(), { store, now: () => NOW, maxGamesPerClient: 1 });
    await untilTick(() => service.get('scored').status === 'finished');
    const res = await service.correct('scored', { coord: 'E5', waitForReply: false, via: 'api' }, 'human', { clientKey: 'A' });
    expect(res.state.status).toBe('playing');
    // Адрес запроса записан владельцем: у A место занято, у B свободно.
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).rejects.toMatchObject({ details: { scope: 'client' } });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'B' });
  });

  it('undo сданной партии лимит не проходит: game_finished, а не 429', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1 });
    const done = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    await service.play(done, { coord: 'D4', waitForReply: false, via: 'api' });
    await service.resign(done, { color: 'B', via: 'api' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await expect(service.undo(done, { via: 'api' }, 'human', { clientKey: 'A' })).rejects.toMatchObject({ code: 'game_finished' });
  });

  it('действия без отката в завершённой счётом партии лимит не проходят: ход и пас — game_finished, смена ранга проходит', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1 });
    const scored = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    await finishByPasses(service, scored);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await expect(service.play(scored, { coord: 'E5', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
    await expect(service.pass(scored, { waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
    const ranked = await service.setRank(scored, { color: 'B', rank: '5k' });
    expect(ranked.state).toMatchObject({ status: 'finished', result: { reason: 'score' } });
  });

  it('открываемая откатом партия в счёте с проверки: одновременные create и второй undo на границе лимита отклонены', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1 });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    await finishByPasses(service, a);
    const b = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).state.id;
    await finishByPasses(service, b);
    const results = await Promise.allSettled([
      service.undo(a, { via: 'api' }, 'human', { clientKey: 'A' }),
      service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }),
      service.undo(b, { via: 'api' }, 'human', { clientKey: 'B' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(service.list().filter((g) => g.status === 'playing').map((g) => g.id)).toEqual([a]);
    // Отказ отката не оставляет партию в счёте: после сдачи a место свободно.
    await service.resign(a, { color: 'B', via: 'api' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
  });

  it('два одновременных undo одной завершённой счётом партии на границе лимита: оба проходят, партия себе не мешает', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1, maxGamesPerClient: 1 });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'A' })).state.id;
    await finishByPasses(service, a);
    const results = await Promise.allSettled([service.undo(a, { via: 'api' }, 'human', { clientKey: 'A' }), service.undo(a, { via: 'api' }, 'human', { clientKey: 'A' })]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(service.get(a)).toMatchObject({ status: 'playing', moves: [] });
  });

  // Снапшоты в памяти с воротами: запись состояния, для которого hold вернул true, ждёт отпускания. gates — по порядку
  // задержанных записей; hold меняется по ходу теста, чтобы держать только нужную запись.
  const gatedSaves = () => {
    const real = memoryStore();
    const gates: Array<() => void> = [];
    const control: { hold?: (state: GameState) => boolean } = {};
    const store: SnapshotStore = {
      ...real,
      save: async (state: GameState) => {
        if (control.hold?.(state)) await new Promise<void>((r) => gates.push(r));
        return real.save(state);
      },
    };
    return { store, gates, control };
  };
  const A = { clientKey: 'A' };
  const createA = (service: GameService) => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, A);
  const REFUSED_A = { code: 'too_many_games', details: { max: 1, scope: 'client' } };

  it('удержание открываемой откатом партии снимает только сам откат: rank в очереди перед undo партию из счёта не выводит, и в окно записи undo create владельца и undo другой партии — 429', async () => {
    const { store, gates, control } = gatedSaves();
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const a = (await createA(service)).state.id;
    await finishByPasses(service, a);
    const b = (await createA(service)).state.id;
    await finishByPasses(service, b);
    control.hold = (state) => state.id === a;
    // rank держит мьютекс a своей записью; undo прошёл проверку при запросе и ждёт очереди.
    const ranking = service.setRank(a, { color: 'B', rank: '5k' });
    const undoing = service.undo(a, { via: 'api' }, 'human', A);
    await untilTick(() => gates.length === 1);
    gates[0]?.();
    await ranking;
    // Запись самого undo: в памяти a ещё завершена, но в счёте с момента проверки.
    await untilTick(() => gates.length === 2);
    await expect(createA(service)).rejects.toMatchObject(REFUSED_A);
    await expect(service.undo(b, { via: 'api' }, 'human', A)).rejects.toMatchObject(REFUSED_A);
    gates[1]?.();
    await undoing;
    expect(service.get(a).status).toBe('playing');
    expect(service.get(b).status).toBe('finished');
    expect(gates).toHaveLength(2);
    // Удержание снято вместе с операцией: после сдачи a место свободно.
    control.hold = undefined;
    await service.resign(a, { color: 'B', via: 'api' });
    await createA(service);
    expect(service.internalSizes().reopening).toBe(0);
  });

  it('неудачный undo (revision_conflict) в очереди перед удачным чужое удержание не снимает: в окно записи удачного undo create владельца — 429', async () => {
    const { store, gates, control } = gatedSaves();
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const a = (await createA(service)).state.id;
    await finishByPasses(service, a);
    control.hold = (state) => state.id === a;
    const bad = service.undo(a, { via: 'api', expectedRevision: service.get(a).revision + 1 }, 'human', A);
    const good = service.undo(a, { via: 'api' }, 'human', A);
    await expect(bad).rejects.toMatchObject({ code: 'revision_conflict' });
    await untilTick(() => gates.length === 1);
    await expect(createA(service)).rejects.toMatchObject(REFUSED_A);
    gates[0]?.();
    await good;
    expect(service.get(a).status).toBe('playing');
    expect(gates).toHaveLength(1);
    expect(service.internalSizes().reopening).toBe(0);
  });

  it('undo, пришедший во время записи итога автосчёта: откат проверяется под мьютексом по свежему состоянию — при полном счёте владельца 429, партия остаётся завершённой', async () => {
    const { store, gates, control } = gatedSaves();
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const a = (await createA(service)).state.id;
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    await service.pass(a, { waitForReply: false, via: 'api' });
    control.hold = (state) => state.id === a && state.status === 'finished';
    await service.pass(a, { waitForReply: false, via: 'api' });
    await untilTick(() => gates.length === 1);
    // Итог пишется: в памяти a ещё идёт и в счёте, проверять при запросе нечего. rank и undo встают в очередь за счётом.
    control.hold = (state) => state.id === a;
    const ranking = service.setRank(a, { color: 'B', rank: '5k' });
    const undoing = service.undo(a, { via: 'api' }, 'human', A);
    gates[0]?.();
    await untilTick(() => gates.length === 2);
    // a завершена счётом и вне счёта, rank пишет её снапшот: create владельца занимает его единственное место.
    const fresh = (await createA(service)).state.id;
    control.hold = undefined;
    gates[1]?.();
    await ranking;
    await expect(undoing).rejects.toMatchObject({ ...REFUSED_A, status: 429 });
    expect(service.get(a)).toMatchObject({ status: 'finished', result: { reason: 'score' }, seats: { B: { rank: '5k' } } });
    expect(gates).toHaveLength(2);
    await service.resign(fresh, { color: 'B', via: 'api' });
    expect((await service.undo(a, { via: 'api' }, 'human', A)).state.status).toBe('playing');
    expect(service.internalSizes().reopening).toBe(0);
  });

  it('undo во время записи итога автосчёта в пределах лимита: открываемая партия в счёте с проверки под мьютексом до записи — параллельный create владельца отклонён', async () => {
    const { store, gates, control } = gatedSaves();
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const a = (await createA(service)).state.id;
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    await service.pass(a, { waitForReply: false, via: 'api' });
    control.hold = (state) => state.id === a && state.status === 'finished';
    await service.pass(a, { waitForReply: false, via: 'api' });
    await untilTick(() => gates.length === 1);
    const undoing = service.undo(a, { via: 'api' }, 'human', A);
    control.hold = (state) => state.id === a;
    gates[0]?.();
    // Запись undo: в памяти a завершена счётом, но откат уже прошёл проверку под мьютексом и держит её в счёте.
    await untilTick(() => gates.length === 2);
    await expect(createA(service)).rejects.toMatchObject(REFUSED_A);
    control.hold = undefined;
    gates[1]?.();
    await undoing;
    expect(service.get(a)).toMatchObject({ status: 'playing', moves: [{ coord: 'D4' }] });
    await expect(createA(service)).rejects.toMatchObject(REFUSED_A);
    expect(service.internalSizes().reopening).toBe(0);
  });

  it('действие, ждавшее очереди, пока партию бросила смена в сессии, под мьютексом не проверяется и отметку не снимает: проверка и снятие — при запросе; следующий возврат проходит проверку и снимает её', async () => {
    const { store, gates, control } = gatedSaves();
    const marks = memoryMarks();
    const { service } = await make(createFakeEngine(), { store, marks, maxGamesPerClient: 1 });
    const inS1 = () => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { ...A, sessionId: 's1' });
    const a = (await inS1()).state.id;
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    control.hold = (state) => state.id === a;
    const ranking = service.setRank(a, { color: 'B', rank: '5k' });
    const undoing = service.undo(a, { via: 'api' }, 'human', A);
    await untilTick(() => gates.length === 1);
    // Новая партия сессии бросает a, пока undo ждёт очереди: у A в счёте только она.
    const b = (await inS1()).state.id;
    await untilTick(() => marks.ids.has(a));
    gates[0]?.();
    await ranking;
    await untilTick(() => gates.length === 2);
    gates[1]?.();
    await undoing;
    expect(service.get(a)).toMatchObject({ status: 'playing', moves: [] });
    expect(marks.ids.has(a)).toBe(true);
    await service.resign(b, { color: 'B', via: 'api' });
    control.hold = undefined;
    // a вне счёта: место A свободно. Ход в a — возврат: сверх лимита 429, в пределах — отметка снята.
    const c = (await createA(service)).state.id;
    await expect(service.play(a, { coord: 'E5', waitForReply: false, via: 'api' })).rejects.toMatchObject(REFUSED_A);
    await service.resign(c, { color: 'B', via: 'api' });
    await service.play(a, { coord: 'E5', waitForReply: false, via: 'api' });
    await untilTick(() => !marks.ids.has(a));
    await expect(createA(service)).rejects.toMatchObject(REFUSED_A);
  });

  it('откат от имени движка лимиты не проходит и под мьютексом: undo by engine завершённой счётом партии при полном счёте владельца открывает её', async () => {
    const { service } = await make(createFakeEngine(), { maxGamesPerClient: 1 });
    const a = (await createA(service)).state.id;
    await finishByPasses(service, a);
    await createA(service);
    const undone = await service.undo(a, { via: 'api' }, 'engine', A);
    expect(undone.state).toMatchObject({ status: 'playing', moves: [{ coord: 'D4' }] });
  });

  it('close дожидается и записи отметки, поставленной во время close', async () => {
    const base = memoryMarks();
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>((r) => gates.push(r));
    const marks = {
      ...base,
      markAbandoned: async (id: string) => {
        await gate();
        await base.markAbandoned(id);
      },
      clearAbandoned: async (id: string) => {
        await gate();
        await base.clearAbandoned(id);
      },
    };
    const { service } = await make(createFakeEngine(), { marks });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => gates.length === 1);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await tick(5);
    // Обработчик запроса, дошедший до сервиса во время close: возврат к a ставит снятие отметки в очередь.
    service.resume(a);
    gates[0]?.();
    await untilTick(() => gates.length === 2);
    await tick(20);
    expect(closed).toBe(false);
    gates[1]?.();
    await closing;
    expect(base.ids.size).toBe(0);
  });

  it('init не ставит фоновую задачу устаревшей партии, свежей — ставит; порог берётся из staleGameMs', async () => {
    const engine = createFakeEngine({ script: ['E5'] });
    const store = memoryStore([
      seedEngineGame('staleengine', 10 * 60_000 + 1),
      seedPassed('stalescore', 10 * 60_000 + 1),
      seedGame('stalehuman', DAY),
      seedGame('stalefinished', DAY, { finished: true }),
      // Завершена счётом: два паса в ходах остались, но задача ей не нужна.
      finishByScore(seedPassed('stalescored', DAY), { winner: 'B', margin: 0.5, reason: 'score' }),
      seedEngineGame('freshengine', 10 * 60_000),
      seedPassed('freshscore', 60_000),
    ]);
    const { service } = await make(engine, { store, now: () => NOW, staleGameMs: 10 * 60_000 });
    await untilTick(() => service.get('freshengine').moves.length === 1 && service.get('freshscore').status === 'finished');
    await tick(20);
    expect(engine.calls).toMatchObject({ genmove: 1, score: 1 });
    expect(service.get('staleengine')).toMatchObject({ moves: [], pendingEngineMove: true, status: 'playing' });
    expect(service.get('stalescore')).toMatchObject({ status: 'playing', consecutivePasses: 2 });
    // Отмечены, как отменённые, только партии, которым init поставил бы задачу.
    expect(service.internalSizes()).toMatchObject({ gaveUp: 2, taskAborts: 0 });
  });

  it('задачу устаревшей партии ставит открытие её потока (resume) или действие человека, как после отмены', async () => {
    const engine = createFakeEngine({ script: ['E5', 'F5'] });
    const store = memoryStore([seedEngineGame('bystream', DAY), seedEngineGame('byaction', DAY), seedPassed('scorebystream', DAY)]);
    const { service } = await make(engine, { store, now: () => NOW });
    await tick(20);
    expect(engine.calls).toMatchObject({ genmove: 0, score: 0 });
    service.resume('bystream');
    await untilTick(() => service.get('bystream').moves.length === 1);
    // Ход человека на ходе Гоко отклоняется, но задачу всё равно ставит.
    await expect(service.play('byaction', { coord: 'D4', waitForReply: false, via: 'voice' })).rejects.toMatchObject({ code: 'not_your_turn' });
    await untilTick(() => service.get('byaction').moves.length === 1);
    service.resume('scorebystream');
    await untilTick(() => service.get('scorebystream').status === 'finished');
    expect(engine.calls).toMatchObject({ genmove: 2, score: 1 });
    expect(service.internalSizes().gaveUp).toBe(0);
  });
});

describe('GameService: сдача проверяет место (B7) и занятый id', () => {
  it('сдача за место движка — bad_request с причиной not_your_seat, и на ходе человека, и на ходе Гоко; партия не меняется; движок сдаётся сам', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const engine = createFakeEngine({ script: ['E5'], delayMs: 100 });
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    // Ход человека: отказ связан с местом, а не с очередью хода.
    const refused = await service.resign(g.state.id, { color: 'W', via: 'voice' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'bad_request', status: 400, details: { reason: 'not_your_seat' } });
    expect(events).toEqual([]);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'voice' });
    // Ход Гоко: тот же отказ.
    await expect(service.resign(g.state.id, { color: 'W', via: 'voice' })).rejects.toMatchObject({ code: 'bad_request', details: { reason: 'not_your_seat' } });
    await thinkThrough(engine, 1, 100);
    await untilTick(() => service.get(g.state.id).moves.length === 2);
    // Сдачи не было: только ход человека, раздумье и ответ Гоко.
    expect(events.map((e) => (e.type === 'state.updated' ? e.cause : e.type))).toEqual(['play', 'engine.thinking', 'engine']);
    expect(service.get(g.state.id).status).toBe('playing');
    const byEngine = await service.resign(g.state.id, { color: 'W', via: 'api' }, 'engine');
    expect(byEngine.state.result).toMatchObject({ winner: 'B', reason: 'resign' });
  });

  it('сдача за место external (снапшот стадии 2) — unsupported_controller, партия не меняется', async () => {
    const seed = newGame({ id: 'withexternal', createdAt: new Date().toISOString(), settings: GameSettings.parse({ boardSize: 9 }), seats: { B: { controller: 'human' }, W: { controller: 'external' } } });
    const { service } = await make(createFakeEngine(), { store: memoryStore([seed]) });
    await expect(service.resign('withexternal', { color: 'W', via: 'api' })).rejects.toMatchObject({ code: 'unsupported_controller', status: 400 });
    expect(service.get('withexternal')).toMatchObject({ status: 'playing', revision: 0 });
    expect((await service.resign('withexternal', { color: 'B', via: 'api' })).state.result).toMatchObject({ winner: 'W', reason: 'resign' });
  });

  it('сдача своего места проходит, как и раньше', async () => {
    const { service } = await make(createFakeEngine());
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect((await service.resign(g.state.id, { color: 'W', via: 'api' })).state.result).toMatchObject({ winner: 'B', reason: 'resign' });
  });

  it('create перегенерирует id, если он уже занят партией', async () => {
    const ids = ['aaa1', 'aaa1', 'aaa1', 'bbb2'];
    const { service, store } = await make(createFakeEngine(), { newId: () => ids.shift() ?? 'zzz9' });
    const first = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(first.state.id).toBe('aaa1');
    const second = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(second.state.id).toBe('bbb2');
    expect(service.get('aaa1').moves).toEqual([]);
    expect((store as MemoryStore).saved.map((s) => s.id)).toEqual(['aaa1', 'bbb2']);
  });

  it('create перегенерирует id, занятый ещё не записанной партией', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (state.id === 'aaa1') await new Promise<void>((r) => (release = r));
        return real.save(state);
      },
    } as unknown as GameStore;
    const ids = ['aaa1', 'aaa1', 'bbb2'];
    const { service } = await make(createFakeEngine(), { store, newId: () => ids.shift() ?? 'zzz9' });
    const first = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await untilTick(() => release !== undefined);
    const second = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    expect(second.state.id).toBe('bbb2');
    release?.();
    expect((await first).state.id).toBe('aaa1');
  });

  it('генератор, который отдаёт только занятые id, не зацикливает create: internal после конечного числа попыток', async () => {
    let calls = 0;
    const { service } = await make(createFakeEngine(), {
      newId: () => {
        calls++;
        return 'aaa1';
      },
    });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const before = calls;
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false })).rejects.toThrow('could not generate a free game id');
    expect(calls - before).toBe(MAX_ID_ATTEMPTS);
    expect(service.list()).toHaveLength(1);
  });
});
