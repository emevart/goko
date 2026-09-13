import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Color, type GameEvent, type GameState } from '@goko/protocol';
import type { Engine } from './engine-client.ts';
import { EventBus } from './events.ts';
import { type FakeEngine, createFakeEngine } from './fake-engine.ts';
import { GameService } from './service.ts';
import { GameStore } from './store.ts';
import { track } from './test-helpers.ts';

let dir = '';
// Сервисы теста закрываются до удаления каталога: иначе фоновая задача движка
// пишет снапшот в уже снесённый каталог и роняет прогон необработанным отказом.
let opened: GameService[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-service-'));
  opened = [];
});
afterEach(async () => {
  // Тесты с управляемым временем возвращают настоящие таймеры до закрытия сервисов.
  vi.useRealTimers();
  for (const service of opened) await service.close();
  await rm(dir, { recursive: true, force: true });
});

const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const } };
// Партия без движка: задачу движка не поднимает, поэтому годится для тестов о времени.
const HUMAN_ONLY = { black: { controller: 'human' as const }, white: { controller: 'human' as const } };
const ENGINE_BLACK = { black: { controller: 'engine' as const, rank: '10k' as const }, white: { controller: 'human' as const } };
const S9 = { settings: { boardSize: 9 as const } };

async function make(engine: Engine, extra: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  const bus = new EventBus();
  const store = new GameStore(dir);
  const service = new GameService({ store, engine, bus, replyTimeoutMs: 500, engineRetryMs: 20, ...extra });
  opened.push(service);
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
    const { service, bus, store } = await make(engine);
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
    // Раздумье досчитывается уже после close: ход к закрытой партии не применяется.
    await thinkThrough(slow, 1, 100);
    await closing;

    const fast = createFakeEngine({ script: ['G7'], delayMs: 50 });
    const second = await make(fast);
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
    expect(list.map((x) => x.createdAt)).toEqual(['2026-09-07T10:00:02.000Z', '2026-09-07T10:00:01.000Z']);
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
    const { service, bus } = await make(flaky, { engineRetryMs: 10 });
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
    const { service, bus } = await make(flaky, { engineRetryMs: 10 });
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
    const { service } = await make(createFakeEngine());
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    await untilTick(() => service.get(g.state.id).status === 'finished');
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
    await service.close();
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    expect(res.state.pendingEngineMove).toBe(true);
    await tick(10);
    expect(engine.calls.genmove).toBe(0);
    expect(service.get(g.state.id).moves).toHaveLength(1);
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
    const { service, bus } = await make(flaky, { engineRetryMs: 80 });
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
    const { service, bus } = await make(flaky, { engineRetryMs: 10 });
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
    await service.close();
    const res = await pending;
    expect(res.reply).toBeUndefined();
    expect(service.get(g.state.id).moves).toHaveLength(1);
  });
});

describe('GameService: фоновые задачи, дедлайны и мьютекс', () => {
  // Снапшот, который отдаёт управление и умеет падать или ждать на нужном ходе.
  function gatedStore(real: GameStore, hook: (state: GameState) => Promise<void>): GameStore {
    return {
      load: () => real.load(),
      save: async (state: GameState) => {
        await hook(state);
        return real.save(state);
      },
    } as unknown as GameStore;
  }

  it('отказ записи снапшота в фоновой задаче не роняет процесс, а уходит событием error', async () => {
    const real = new GameStore(dir);
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
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'internal', message: 'disk is full' });
    // Партия осталась на последнем удачно записанном состоянии.
    expect(service.get(g.state.id).moves).toHaveLength(1);
    await service.close();
  });

  it('код ApiError из фоновой задачи попадает в событие error как есть', async () => {
    const real = new GameStore(dir);
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
    await service.close();
  });

  it('close дожидается фоновой записи снапшота', async () => {
    const real = new GameStore(dir);
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

  it('чужое изменение во время ожидания первого хода движка — не таймаут', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['C3'], delayMs: 300 }), { replyTimeoutMs: 3000 });
    let id = '';
    // session.game публикуется до коммита, поэтому идентификатор известен раньше возврата create.
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
    const real = new GameStore(dir);
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

  it('score не ждёт движок дольше 15 с, analyze — дольше 10 с', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inner = createFakeEngine();
    const stuck: Engine = { ...inner, score: () => new Promise(() => {}), analyze: () => new Promise(() => {}) };
    const { service } = await make(stuck);
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;

    const scoring = service.score(id);
    const scoringState = track(scoring);
    const scoreFails = expect(scoring).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 15000 ms' });
    await vi.advanceTimersByTimeAsync(14_999);
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
    const { service, bus } = await make(down, { engineRetryMs: undefined });
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
    await service.close();
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
    const { service, bus } = await make(flaky, { engineRetryMs: 100 });
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
    const { service, bus } = await make(down, { engineRetryMs: 1000 });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const events = record(bus, `game:${g.state.id}`);
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    await service.close();
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
  });

  it('на партию идёт одна задача счёта', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const inner = createFakeEngine();
    const gated: Engine = {
      ...inner,
      score: async (req) => {
        calls++;
        await new Promise<void>((r) => {
          release = r;
        });
        return inner.score(req);
      },
    };
    const { service } = await make(gated);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.pass(id, { waitForReply: true, via: 'api' }); // пас человека и пас движка
    await untilTick(() => release !== undefined);
    // Коммит во время счёта не должен поднимать вторую задачу счёта.
    await service.setRank(id, { color: 'W', rank: '5k' });
    await tick(5);
    expect(calls).toBe(1);
    release?.();
    await tick(5);
    // Ревизия изменилась, пока счёт считался: результат к ней не применяется.
    expect(service.get(id).status).toBe('playing');
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
    const { service } = await make(gated, { engineRetryMs: undefined });
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
    const real = new GameStore(dir);
    let fail: (() => void) | undefined;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) {
        await new Promise<void>((r) => {
          fail = r;
        });
        throw new Error('disk is full');
      }
    });
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { store, engineRetryMs: undefined });
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
    const { service } = await make(createFakeEngine({ script: ['E5'] }), { replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    await service.close();
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
    const real = new GameStore(dir);
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2 && failures-- > 0) throw new Error('disk is full');
    });
    const engine = createFakeEngine({ script: ['E5', 'E5'] });
    const { service, bus } = await make(engine, { store, engineRetryMs: 1000, replyTimeoutMs: undefined });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);

    // Человек сказал ход и ждёт ответа: отказ записи отпускает его сразу, не через 8 с.
    const playing = service.play(id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const playState = track(playing);
    await untilTick(() => playState.settled);
    const res = await playing;
    expect(res.reply).toBeUndefined();
    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', code: 'internal', message: 'disk is full' }]);

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
    const real = new GameStore(dir);
    const store = gatedStore(real, async (state) => {
      if (state.moves.length === 2) throw new Error('disk is full');
    });
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, engineRetryMs: 1000 });
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
    await service.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ записи итога счёта: ошибка видна, счёт повторяется, партия завершается', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = new GameStore(dir);
    let failures = 1;
    const store = gatedStore(real, async (state) => {
      if (state.status === 'finished' && failures-- > 0) throw new Error('disk is full');
    });
    const engine = createFakeEngine();
    const { service, bus } = await make(engine, { store, engineRetryMs: 1000 });
    const g = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const id = g.state.id;
    const events = record(bus, `game:${id}`);
    await service.pass(id, { waitForReply: false, via: 'api' });
    await service.pass(id, { waitForReply: false, via: 'api' });
    await untilTick(() => events.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'internal', message: 'disk is full' });
    expect(service.get(id).status).toBe('playing');
    expect((await real.load())[0]?.status).toBe('playing');
    await vi.advanceTimersByTimeAsync(1000);
    await untilTick(() => service.get(id).status === 'finished');
    expect(engine.calls.score).toBe(2);
    expect((await real.load())[0]?.status).toBe('finished');
  });

  it('отказ записи хода человека: ошибка у вызывающего, состояние не меняется, ход можно повторить', async () => {
    const real = new GameStore(dir);
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
    const { service, bus } = await make(flaky, { engineRetryMs: 50 });
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
