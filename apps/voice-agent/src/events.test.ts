import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type EventsTarget, type GameEvent, type GameState, humanText, type Move, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { ERROR_REPEAT_MS, SESSION_EXPIRED_INSTRUCTIONS, type WatchHandle, handleEvent, watchSession } from './events.ts';
import { newAgentState, noteFinishRevision } from './state.ts';
import { fakeGame } from './testing/fake-client.ts';

const mv = (n: number, color: 'B' | 'W', coord: string): Move => ({ n, color, coord, captured: 0, at: 't' });
const upd = (state: GameState, extra: Partial<Extract<GameEvent, { type: 'state.updated' }>> = {}): GameEvent => ({
  type: 'state.updated',
  state,
  cause: 'play',
  by: 'human',
  ...extra,
});

describe('handleEvent: подключение и новые партии', () => {
  it('session.game запоминает партию и молчит', () => {
    const s = newAgentState('s1');
    s.lastTap = { cause: 'play', coord: 'D4' };
    s.awaitingReply = true;
    s.retriesExhausted = true;
    s.fallbackMove = 4;
    expect(handleEvent({ type: 'session.game', gameId: 'g1' }, s)).toBeNull();
    expect(s.gameId).toBe('g1');
    expect(s.lastTap).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.retriesExhausted).toBe(false);
    expect(s.fallbackMove).toBeNull();
  });
  it('sync после смены партии — «продолжаем», с цветом человека и чьим ходом', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    const text = handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(text).toContain('Продолжаем партию');
    expect(text).toContain('человек играет белыми');
    expect(text).toContain('сейчас ход человека');
    expect(text).toContain('позиция уже на доске');
    expect(text).toContain('Скажи вслух только: «Продолжаем партию, твой ход».');
    expect(s.gameId).toBe('g1');
    expect(s.humanColor).toBe('W');
  });
  it('живой поток: session.game, затем sync той же партии — «продолжаем»; переподключение к знакомой партии и sync после new молчат', () => {
    const s = newAgentState('s1');
    const g = fakeGame();
    // Порядок сервера (apps/game-server/src/app.ts): поток сессии открывается событиями session.game и sync.
    expect(handleEvent({ type: 'session.game', gameId: g.id }, s)).toBeNull();
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toContain('Продолжаем партию');
    expect(s.announceSync).toBeNull();
    // Обрыв и новое подключение к той же партии.
    expect(handleEvent({ type: 'session.game', gameId: g.id }, s)).toBeNull();
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
    // Новая партия в потоке: session.game и new; флаг снят событием new, sync при следующем подключении молчит.
    const g2 = fakeGame({ id: 'g2' });
    s.toolGames.add('g2');
    expect(handleEvent({ type: 'session.game', gameId: 'g2' }, s)).toBeNull();
    expect(s.announceSync).toBe('g2');
    expect(handleEvent(upd(g2, { cause: 'new', by: 'system' }), s)).toBeNull();
    expect(s.announceSync).toBeNull();
    expect(handleEvent({ type: 'session.game', gameId: 'g2' }, s)).toBeNull();
    expect(handleEvent(upd(g2, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('повторный sync той же партии молчит', () => {
    const s = newAgentState('s1');
    const g = fakeGame();
    handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('sync законченной партии молчит', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ status: 'finished', result: { winner: 'B', reason: 'resign' } });
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('new с экрана — реплика о новой партии; при ходе движка ждём его', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ id: 'g2', seats: { B: { controller: 'engine', rank: '5k' }, W: { controller: 'human' } }, toPlay: 'B', pendingEngineMove: true });
    // Сервер публикует new от имени system и без via — и для кнопки на экране, и для start_game.
    const text = handleEvent(upd(g, { cause: 'new', by: 'system' }), s);
    expect(text).toContain('начал новую партию с экрана');
    expect(text).toContain('человек играет белыми');
    expect(text).toContain('5 кю');
    expect(text).toContain('Первый ход твой, его назовёт следующее событие');
    expect(text).toContain('Скажи вслух только: «Новая партия: ты играешь белыми, я — 5 кю, мой ход первый».');
    expect(s.awaitingReply).toBe(true);
    expect(s.gameId).toBe('g2');
  });
  it('sync партии, сменившей уже известную, — тоже «продолжаем»', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    expect(handleEvent(upd(fakeGame({ id: 'g2' }), { cause: 'sync', by: 'system' }), s)).toContain('Продолжаем партию');
  });
  it('new с экрана, первый ход человека: движка не ждём, флаги прежней партии сброшены', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    s.lastTap = { cause: 'play', coord: 'D4' };
    const text = handleEvent(upd(fakeGame({ id: 'g2' }), { cause: 'new', by: 'system' }), s);
    expect(text).toContain('Первый ход человека');
    expect(text).toContain('Скажи вслух только: «Новая партия: ты играешь чёрными, я — 10 кю, твой ход».');
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
  });
  it('new партии из start_game молчит', () => {
    const s = newAgentState('s1');
    s.toolGames.add('g1');
    expect(handleEvent(upd(fakeGame(), { cause: 'new', by: 'system' }), s)).toBeNull();
  });
  it('new, пришедшее раньше ответа start_game, молчит и помечает партию', () => {
    const s = newAgentState('s1');
    s.startingGame = true;
    const g = fakeGame({ id: 'g3', seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, pendingEngineMove: true });
    expect(handleEvent(upd(g, { cause: 'new', by: 'system' }), s)).toBeNull();
    expect(s.toolGames.has('g3')).toBe(true);
    expect(s.awaitingReply).toBe(false);
  });
  it('партия двух людей (D-0005): sync без «твой ход», тап озвучивается сразу', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } }, toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    const text = handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(text).toContain('играют два человека');
    expect(text).toContain('сейчас ходят белые');
    expect(text).not.toContain('твой ход');
    expect(text).toContain('Скажи вслух только: «Продолжаем партию, ходят белые».');
    expect(s.humanColor).toBeNull();
    const tap = fakeGame({ ...g, moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 2 });
    expect(handleEvent(upd(tap, { cause: 'play', by: 'human', via: 'tap' }), s)).toBe('Человек тапом на экране сыграл ка десять, ход уже на доске. Скажи вслух только: «Ка десять».');
  });
});

describe('handleEvent: переподключение к той же партии (I1)', () => {
  const pending = () => fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
  const replied = () => fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 2 });
  const waiting = (flags: { awaitingReply?: boolean; lastTap?: boolean }) => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = flags.awaitingReply ?? false;
    s.lastTap = flags.lastTap ? { cause: 'play', coord: 'D4' } : null;
    return s;
  };

  it('session.game той же партии не трогает ожидание хода и fallbackMove; смена партии сбрасывает', () => {
    const s = waiting({ awaitingReply: true, lastTap: true });
    s.fallbackMove = 4;
    s.retriesExhausted = true;
    expect(handleEvent({ type: 'session.game', gameId: 'g1' }, s)).toBeNull();
    expect(s.awaitingReply).toBe(true);
    expect(s.lastTap).toEqual({ cause: 'play', coord: 'D4' });
    expect(s.fallbackMove).toBe(4);
    expect(s.retriesExhausted).toBe(false); // открытие потока перезапускает серию повторов (D-0006)
    expect(s.announceSync).toBeNull();
    expect(handleEvent({ type: 'session.game', gameId: 'g2' }, s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
    expect(s.fallbackMove).toBeNull();
  });
  it('обрыв во время раздумья движка: sync с pendingEngineMove сохраняет ожидание, ход движка озвучен', () => {
    const voice = waiting({ awaitingReply: true });
    handleEvent({ type: 'session.game', gameId: 'g1' }, voice);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), voice)).toBeNull();
    expect(voice.awaitingReply).toBe(true);
    expect(handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), voice)).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');

    const tap = waiting({ lastTap: true });
    handleEvent({ type: 'session.game', gameId: 'g1' }, tap);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), tap)).toBeNull();
    expect(tap.awaitingReply).toBe(false);
    expect(handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), tap)).toBe(
      'Человек тапом на экране сыграл дэ четыре, ход уже на доске. Твой ответ ка десять уже на доске. Скажи вслух только: «Ка десять».',
    );
  });
  it('sync с pendingEngineMove без флагов ставит ожидание: ход движка озвучивается обычной фразой', () => {
    const s = waiting({});
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(true);
    expect(handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), s)).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
  });
  it('движок сходил во время обрыва: sync называет ход один раз той же фразой, что событие хода, и снимает флаги', () => {
    for (const flags of [{ awaitingReply: true }, { lastTap: true }, { awaitingReply: true, lastTap: true }]) {
      const viaEngine = waiting(flags);
      const expected = handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), viaEngine);
      expect(expected).not.toBeNull();
      const s = waiting(flags);
      handleEvent({ type: 'session.game', gameId: 'g1' }, s);
      expect(handleEvent(upd(replied(), { cause: 'sync', by: 'system' }), s)).toBe(expected);
      expect(s.awaitingReply).toBe(false);
      expect(s.lastTap).toBeNull();
      handleEvent({ type: 'session.game', gameId: 'g1' }, s);
      expect(handleEvent(upd(replied(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    }
  });
  it('ждали ответа, а последний ход не движка (в разрыве сходил и человек): флаги сняты молча, чужой тап не приклеится', () => {
    const s = waiting({ awaitingReply: true, lastTap: true });
    const humanLast = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3')], toPlay: 'W', revision: 3 });
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(humanLast, { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
    const twoHumans = waiting({ awaitingReply: true });
    const g = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } }, moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], revision: 2 });
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), twoHumans)).toBeNull();
    expect(twoHumans.awaitingReply).toBe(false);
  });
  it('ждали ответа, а в разрыве отменили все ходы: sync пустой доски молча снимает флаги', () => {
    const s = waiting({ awaitingReply: true, lastTap: true });
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(fakeGame({ moves: [], toPlay: 'B', revision: 4 }), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
  });
  it('seenMove: каждый state.updated запоминает номер последнего хода партии, пустая доска — 0', () => {
    const s = waiting({});
    handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'voice' }), s);
    expect(s.seenMove).toEqual({ gameId: 'g1', n: 1 });
    handleEvent(upd(fakeGame({ moves: [], revision: 3 }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(s.seenMove).toEqual({ gameId: 'g1', n: 0 });
    const done = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'pass'), mv(3, 'B', 'pass')], status: 'finished', result: { winner: 'B', reason: 'resign' }, revision: 4 });
    handleEvent(upd(done, { cause: 'pass', by: 'human', via: 'voice' }), s);
    expect(s.seenMove).toEqual({ gameId: 'g1', n: 3 });
    handleEvent(upd(fakeGame({ id: 'g2', moves: [mv(1, 'B', 'C3')], revision: 1 }), { cause: 'sync', by: 'system' }), s);
    expect(s.seenMove).toEqual({ gameId: 'g2', n: 1 });
  });
  it('голосовой ход в полёте при переподключении: поток уже показал ход, sync того же хода ожидание не ставит — ход движка назовёт инструмент, а не событие', () => {
    const s = waiting({});
    expect(handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'voice' }), s)).toBeNull();
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), s)).toBeNull();
    // Движок ответил в разрыве, инструмент ещё ждёт: sync тоже молчит.
    const gap = waiting({});
    handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'voice' }), gap);
    handleEvent({ type: 'session.game', gameId: 'g1' }, gap);
    expect(handleEvent(upd(replied(), { cause: 'sync', by: 'system' }), gap)).toBeNull();
  });
  it('партия start_game, движок ходит первым: sync пустой доски, уже показанной потоком, ожидание не ставит', () => {
    const s = waiting({});
    s.toolGames.add('g1');
    const first = fakeGame({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, moves: [], pendingEngineMove: true, revision: 1 });
    expect(handleEvent(upd(first, { cause: 'new', by: 'system' }), s)).toBeNull(); // первый ход вернёт start_game
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(first, { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
  });
  it('с прежним ожиданием sync того же хода его не снимает: таймаут инструмента уже случился', () => {
    const s = waiting({});
    handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'voice' }), s);
    s.awaitingReply = true; // play вернул replyTimedOut
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(true);
    expect(handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), s)).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
  });
  it('ход человека в разрыве без прежнего ожидания: sync нового хода ставит ожидание, ход движка озвучен событием', () => {
    const s = waiting({});
    handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), s); // поток показал ход движка n=2
    expect(s.seenMove).toEqual({ gameId: 'g1', n: 2 });
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    const tapped = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3')], toPlay: 'W', pendingEngineMove: true, revision: 3 });
    expect(handleEvent(upd(tapped, { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(true);
    const answered = fakeGame({ moves: [...tapped.moves, mv(4, 'W', 'G7')], toPlay: 'B', revision: 4 });
    expect(handleEvent(upd(answered, { cause: 'engine', by: 'engine' }), s)).toBe('Твой ход гэ семь уже на доске. Скажи вслух только: «Гэ семь».');
  });
  it('отмена в разрыве, последним остался старый ход движка: sync молчит и снимает флаги', () => {
    for (const flags of [{ awaitingReply: true }, { lastTap: true }]) {
      const s = waiting(flags);
      const humanLast = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3')], toPlay: 'W', pendingEngineMove: true, revision: 3 });
      handleEvent(upd(humanLast, { cause: 'play', by: 'human', via: 'voice' }), s); // поток показал ход человека n=3
      handleEvent({ type: 'session.game', gameId: 'g1' }, s);
      expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 4 }), { cause: 'sync', by: 'system' }), s)).toBeNull();
      expect(s.awaitingReply).toBe(false);
      expect(s.lastTap).toBeNull();
    }
  });
  it('движок сходил в разрыве, но это ход, который поток уже показал: sync молчит (n не новее)', () => {
    const s = waiting({});
    handleEvent(upd(replied(), { cause: 'engine', by: 'engine' }), s);
    s.awaitingReply = true; // устаревший флаг
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(replied(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
  });
  it('тап в разрыве после ответа движка: названа координата свежего тапа по позиции, а не старый lastTap', () => {
    const moves = [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3')];
    // Движок успел ответить и на свежий тап: sync называет оба хода.
    const s = waiting({ lastTap: true });
    handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'tap' }), s); // тап D4, движок думает
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    const answered = fakeGame({ moves: [...moves, mv(4, 'W', 'G7')], toPlay: 'B', revision: 4 });
    expect(handleEvent(upd(answered, { cause: 'sync', by: 'system' }), s)).toBe(
      'Человек тапом на экране сыграл цэ три, ход уже на доске. Твой ответ гэ семь уже на доске. Скажи вслух только: «Гэ семь».',
    );
    // Движок ещё думает над свежим тапом: ожидание остаётся, событие хода назовёт свежий тап.
    const t = waiting({ lastTap: true });
    handleEvent(upd(pending(), { cause: 'play', by: 'human', via: 'tap' }), t);
    handleEvent({ type: 'session.game', gameId: 'g1' }, t);
    expect(handleEvent(upd(fakeGame({ moves, toPlay: 'W', pendingEngineMove: true, revision: 3 }), { cause: 'sync', by: 'system' }), t)).toBeNull();
    expect(handleEvent(upd(answered, { cause: 'engine', by: 'engine' }), t)).toBe(
      'Человек тапом на экране сыграл цэ три, ход уже на доске. Твой ответ гэ семь уже на доске. Скажи вслух только: «Гэ семь».',
    );
  });
  it('запись seenMove другой партии (партию сменил инструмент, session.game не менял gameId) не считается показанным ходом', () => {
    const s = waiting({});
    s.seenMove = { gameId: 'g0', n: 40 };
    handleEvent({ type: 'session.game', gameId: 'g1' }, s);
    expect(handleEvent(upd(pending(), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(true);
    const e = waiting({ awaitingReply: true });
    e.seenMove = { gameId: 'g0', n: 40 };
    expect(handleEvent(upd(replied(), { cause: 'sync', by: 'system' }), e)).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
  });
  it('устаревший тап при первом ходе движка: ход человека не из чего взять — фраза по запомненному тапу', () => {
    const s = waiting({ lastTap: true });
    const g = fakeGame({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, moves: [mv(1, 'B', 'K10')], toPlay: 'W', revision: 1 });
    expect(handleEvent(upd(g, { cause: 'engine', by: 'engine' }), s)).toBe(
      'Человек тапом на экране сыграл дэ четыре, ход уже на доске. Твой ответ ка десять уже на доске. Скажи вслух только: «Ка десять».',
    );
  });
  it('sync другой партии без session.game — «продолжаем», флаги прежней партии сняты', () => {
    const s = waiting({ awaitingReply: true, lastTap: true });
    const other = fakeGame({ id: 'g2', moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
    expect(handleEvent(upd(other, { cause: 'sync', by: 'system' }), s)).toContain('Продолжаем партию');
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
  });
});

describe('handleEvent: ходы', () => {
  it('тап с ответом движка: молчим на тап, говорим на ответ с обоими ходами', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const afterTap = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
    expect(handleEvent(upd(afterTap, { cause: 'play', by: 'human', via: 'tap' }), s)).toBeNull();
    expect(s.lastTap).toEqual({ cause: 'play', coord: 'D4' });
    const afterReply = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 2 });
    const text = handleEvent(upd(afterReply, { cause: 'engine', by: 'engine' }), s);
    expect(text).toContain('дэ четыре');
    expect(text).toContain('ка десять');
    expect(text).toBe('Человек тапом на экране сыграл дэ четыре, ход уже на доске. Твой ответ ка десять уже на доске. Скажи вслух только: «Ка десять».');
    expect(s.lastTap).toBeNull();
  });
  it('ответ движка на тап снимает и awaitingReply: следующий ход движка не озвучивается повторно', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    s.lastTap = { cause: 'play', coord: 'D4' };
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s)).toContain('на экране');
    expect(s.awaitingReply).toBe(false);
  });
  it('пас тапом и ответный пас', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'pass')], toPlay: 'W', pendingEngineMove: true }), { cause: 'pass', by: 'human', via: 'tap' }), s);
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'pass'), mv(2, 'W', 'pass')], toPlay: 'B' }), { cause: 'engine', by: 'engine' }), s);
    expect(text).toBe('Человек тапом на экране спасовал, пас уже записан. Твой ответ — пас, он уже сделан. Скажи вслух только: «Пас».');
    // Тап хода, движок пасует; тап паса, движок ходит.
    s.lastTap = { cause: 'play', coord: 'D4' };
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'pass')], toPlay: 'B' }), { cause: 'engine', by: 'engine' }), s)).toBe(
      'Человек тапом на экране сыграл дэ четыре, ход уже на доске. Твой ответ — пас, он уже сделан. Скажи вслух только: «Пас».',
    );
    s.lastTap = { cause: 'pass', coord: 'pass' };
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'pass'), mv(2, 'W', 'K10')], toPlay: 'B' }), { cause: 'engine', by: 'engine' }), s)).toBe(
      'Человек тапом на экране спасовал, пас уже записан. Твой ответ ка десять уже на доске. Скажи вслух только: «Ка десять».',
    );
  });
  it('тап без ответа движка (соперник external) озвучивается сразу', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const g = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'external' } }, moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: false });
    expect(handleEvent(upd(g, { cause: 'play', by: 'human', via: 'tap' }), s)).toBe('Человек тапом на экране сыграл дэ четыре, ход уже на доске. Скажи вслух только: «Дэ четыре».');
    expect(s.lastTap).toBeNull();
    const passed = fakeGame({ ...g, moves: [mv(1, 'B', 'pass')] });
    expect(handleEvent(upd(passed, { cause: 'pass', by: 'human', via: 'tap' }), s)).toBe('Человек тапом на экране спасовал, пас уже записан. Скажи вслух только: «Пас».');
  });
  it('голосовой ход и ответ на него молчат: их вернул инструмент', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], pendingEngineMove: true }), { cause: 'play', by: 'human', via: 'voice' }), s)).toBeNull();
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s)).toBeNull();
  });
  it('ход движка после таймаута инструмента озвучивается', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s);
    expect(text).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
    expect(s.awaitingReply).toBe(false);
    s.awaitingReply = true;
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'pass')] }), { cause: 'engine', by: 'engine' }), s)).toBe(
      'Твой ход — пас, он уже сделан. Скажи вслух только: «Пас».',
    );
  });
  it('humanFallback хода движка запоминается номером хода и снимается следующим обычным ходом (D-0007)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const two = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] });
    handleEvent(upd(two, { cause: 'engine', by: 'engine', humanFallback: true }), s);
    expect(s.fallbackMove).toBe(2);
    const four = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3'), mv(4, 'W', 'D10')] });
    handleEvent(upd(four, { cause: 'engine', by: 'engine', humanFallback: false }), s);
    expect(s.fallbackMove).toBe(2);
    // undo снял ходы 3–4 и 2 заменён новым ответом без humanFallback
    const replaced = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'G7')] });
    handleEvent(upd(replaced, { cause: 'engine', by: 'engine', humanFallback: false }), s);
    expect(s.fallbackMove).toBeNull();
  });
  it('state.updated законченной партии сбрасывает флаги и молчит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    s.lastTap = { cause: 'play', coord: 'D4' };
    const g = fakeGame({ status: 'finished', result: { winner: 'B', reason: 'resign' }, moves: [mv(1, 'B', 'D4')] });
    expect(handleEvent(upd(g, { cause: 'engine', by: 'engine' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
  });
  it('undo тапом', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    const text = handleEvent(upd(fakeGame({ toPlay: 'B' }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(text).toBe('Человек отменил последний ход кнопкой на экране, отмена уже на доске, сейчас ход человека. Скажи вслух только: «Ход отменён, твой ход».');
    expect(s.awaitingReply).toBe(false);
    const engineTurn = fakeGame({ toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    expect(handleEvent(upd(engineTurn, { cause: 'undo', by: 'human', via: 'tap' }), s)).toContain('Скажи вслух только: «Ход отменён».');
    const twoHumans = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } }, toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    expect(handleEvent(upd(twoHumans, { cause: 'undo', by: 'human', via: 'tap' }), s)).toContain('Скажи вслух только: «Ход отменён, ходят белые».');
  });
  it('ход внешнего соперника (стадия 2)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'play', by: 'external', via: 'api' }), s);
    expect(text).toBe('Соперник сыграл ка десять, ход уже на доске. Скажи вслух только: «Соперник: ка десять».');
    const passed = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'pass')] }), { cause: 'pass', by: 'external', via: 'api' }), s);
    expect(passed).toBe('Соперник спасовал, пас уже записан. Скажи вслух только: «Соперник: пас».');
  });
  it('sync и rank без смены партии молчат', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    expect(handleEvent(upd(fakeGame(), { cause: 'rank', by: 'human', via: 'voice' }), s)).toBeNull();
    expect(handleEvent(upd(fakeGame(), { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
});

describe('handleEvent: конец партии и ошибки', () => {
  it('game.finished объявляет результат один раз', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const ev: GameEvent = { type: 'game.finished', result: { winner: 'B', margin: 4.5, reason: 'score' } };
    expect(handleEvent(ev, s)).toBe('Партия окончена, итог уже записан: победа за тобой, разница 4,5 очка. Скажи вслух только: «Партия окончена: победа за тобой, разница 4,5 очка».');
    expect(s.announcedFinish).toBe('g1');
    expect(handleEvent(ev, s)).toBeNull();
  });
  it('game.finished после инструмента resign молчит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.announcedFinish = 'g1';
    expect(handleEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } }, s)).toBeNull();
  });
  it('game.finished кладёт итог и когда он уже объявлен; объявление сбрасывает флаги хода', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.announcedFinish = 'g1';
    const result = { winner: 'W' as const, reason: 'resign' as const };
    expect(handleEvent({ type: 'game.finished', result }, s)).toBeNull();
    expect(s.finished).toEqual({ gameId: 'g1', result });
    const s2 = newAgentState('s1');
    s2.gameId = 'g1';
    s2.awaitingReply = true;
    s2.lastTap = { cause: 'play', coord: 'D4' };
    expect(handleEvent({ type: 'game.finished', result }, s2)).not.toBeNull();
    expect(s2.awaitingReply).toBe(false);
    expect(s2.lastTap).toBeNull();
  });
  it('game.finished, пока pass ждёт итог: итог в state.finished, реплики нет (R2)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingFinish = 'g1';
    const result = { winner: 'W' as const, margin: 3.5, reason: 'score' as const };
    expect(handleEvent({ type: 'game.finished', result }, s)).toBeNull();
    expect(s.finished).toEqual({ gameId: 'g1', result });
    expect(s.announcedFinish).toBe('g1');
  });
  it('engine.thinking молчит; error не чаще раза в 30 с, текст по коду, без message', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    let t = 1_000_000;
    const now = () => t;
    expect(handleEvent({ type: 'engine.thinking', gameId: 'g1', color: 'W' }, s)).toBeNull();
    const first = handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now);
    expect(first).toBe(`Сбой на сервере: ${humanText('engine_unavailable')}; сервер повторит попытку сам. Скажи вслух только: «Сервер задумался, ещё немного».`);
    expect(first).not.toContain('engine is unavailable');
    t += ERROR_REPEAT_MS - 1;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now)).toBeNull();
    t += 2;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now)).not.toBeNull();
  });
  it('ERROR_REPEAT_MS — 30 с; ровно через 30 с ошибка снова озвучивается', () => {
    expect(ERROR_REPEAT_MS).toBe(30_000);
    const s = newAgentState('s1');
    s.gameId = 'g1';
    let t = 1_000_000;
    const now = () => t;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).not.toBeNull();
    t += ERROR_REPEAT_MS;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).not.toBeNull();
  });
  it('error до первого session.game (партия ещё неизвестна) не отсекается', () => {
    const s = newAgentState('s1');
    const now = () => 1_000_000;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s, now)).toContain(
      humanText('retries_exhausted'),
    );
    expect(s.retriesExhausted).toBe(true);
  });
  it('error чужой партии (гонка при смене) молчит и флаги не трогает', () => {
    const s = newAgentState('s1');
    s.gameId = 'g2';
    const now = () => 1_000_000;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s, now)).toBeNull();
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).toBeNull();
    expect(s.retriesExhausted).toBe(false);
    expect(s.lastErrorAt).toBe(0);
  });
  it('retries_exhausted озвучивается сразу, без «сервер повторит сам», и ставит флаг переоткрытия', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const now = () => 1_000_000;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).not.toBeNull();
    const text = handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s, now);
    expect(text).toContain(humanText('retries_exhausted'));
    expect(text).toContain('следующая реплика человека');
    expect(text).not.toContain('повторит попытку сам');
    expect(text).not.toContain('background task');
    expect(text).toBe(
      'Сервер перестал повторять попытки: движок не отвечает, нужно повторить; следующая реплика человека сама запустит новую попытку. Скажи вслух только: «Движок не отвечает. Скажи или напиши что-нибудь, и я попробую снова».',
    );
    expect(s.retriesExhausted).toBe(true);
  });
  it('отмена хода с экрана после итога: итог забыт, новый итог этой партии объявляется снова', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const first: GameEvent = { type: 'game.finished', result: { winner: 'B', margin: 4.5, reason: 'score' } };
    expect(handleEvent(first, s)).not.toBeNull();
    expect(s.finished).toEqual({ gameId: 'g1', result: first.result });
    const undone = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'B', status: 'playing' });
    expect(handleEvent(upd(undone, { cause: 'undo', by: 'human', via: 'tap' }), s)).toContain('отменил');
    expect(s.finished).toBeNull();
    expect(s.announcedFinish).toBeNull();
    const second: GameEvent = { type: 'game.finished', result: { winner: 'W', margin: 2.5, reason: 'score' } };
    expect(handleEvent(second, s)).toBe('Партия окончена, итог уже записан: победа за мной, разница 2,5 очка. Скажи вслух только: «Партия окончена: победа за мной, разница 2,5 очка».');
  });
  it('отмена голосом тоже забывает итог: ожидающий pass возьмёт новый, а не прежний', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.announcedFinish = 'g1';
    s.finished = { gameId: 'g1', result: { winner: 'B', margin: 4.5, reason: 'score' } };
    const undone = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'B' });
    // Событие отмены инструментом может обогнать его ответ: сброс не зависит от via.
    expect(handleEvent(upd(undone, { cause: 'undo', by: 'human', via: 'voice' }), s)).toBeNull();
    expect(s.finished).toBeNull();
    expect(s.announcedFinish).toBeNull();
    s.awaitingFinish = 'g1';
    const result = { winner: 'W' as const, margin: 1.5, reason: 'score' as const };
    expect(handleEvent({ type: 'game.finished', result }, s)).toBeNull();
    expect(s.finished).toEqual({ gameId: 'g1', result });
  });
  it('итог не забывается без отмены, при законченной партии и для другой партии', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const old = { gameId: 'g1', result: { winner: 'B' as const, reason: 'resign' as const } };
    s.announcedFinish = 'g1';
    s.finished = old;
    // Запоздавшее событие хода той же партии (партия ещё идёт) после resign инструментом: итог уже сказан.
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s);
    expect(s.announcedFinish).toBe('g1');
    expect(s.finished).toBe(old);
    expect(handleEvent({ type: 'game.finished', result: old.result }, s)).toBeNull();
    // Отмена, после которой партия всё ещё окончена.
    handleEvent(upd(fakeGame({ status: 'finished', result: old.result }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(s.announcedFinish).toBe('g1');
    expect(s.finished).toEqual(old);
    // Отмена в другой партии не трогает итог прежней.
    s.announcedFinish = 'g0';
    s.finished = { ...old, gameId: 'g0' };
    handleEvent(upd(fakeGame({ id: 'g1' }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(s.announcedFinish).toBe('g0');
    expect(s.finished).toEqual({ ...old, gameId: 'g0' });
  });
  it('устаревшее undo из очереди за репликой не стирает итог, записанный resign позже: ревизия отмены меньше', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    // resign инструментом ответил на ревизии 5, пока событие undo (ревизия 4) ждало конца реплики.
    s.announcedFinish = 'g1';
    noteFinishRevision(s, 'g1', 5);
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], revision: 4 }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(s.announcedFinish).toBe('g1');
    expect(handleEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } }, s)).toBeNull();
  });
  it('state.updated законченной партии запоминает ревизию итога; забывает его только отмена новее', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const result = { winner: 'B' as const, margin: 4.5, reason: 'score' as const };
    expect(handleEvent(upd(fakeGame({ status: 'finished', result, revision: 6 }), { cause: 'pass', by: 'engine' }), s)).toBeNull();
    expect(s.finishRevision).toEqual({ gameId: 'g1', revision: 6 });
    expect(handleEvent({ type: 'game.finished', result }, s)).not.toBeNull();
    handleEvent(upd(fakeGame({ revision: 5 }), { cause: 'undo', by: 'human', via: 'voice' }), s);
    expect(s.announcedFinish).toBe('g1');
    expect(s.finished).toEqual({ gameId: 'g1', result });
    handleEvent(upd(fakeGame({ revision: 7 }), { cause: 'undo', by: 'human', via: 'voice' }), s);
    expect(s.announcedFinish).toBeNull();
    expect(s.finished).toBeNull();
  });
  it('отмена в разрыве потока: sync знакомой идущей партии новее итога забывает итог, следующий game.finished объявлен', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const result = { winner: 'B' as const, margin: 4.5, reason: 'score' as const };
    handleEvent(upd(fakeGame({ status: 'finished', result, revision: 6 }), { cause: 'pass', by: 'engine' }), s);
    handleEvent({ type: 'game.finished', result }, s);
    expect(handleEvent({ type: 'session.game', gameId: 'g1' }, s)).toBeNull();
    expect(handleEvent(upd(fakeGame({ revision: 7, moves: [mv(1, 'B', 'D4')] }), { cause: 'sync', by: 'system' }), s)).toBeNull();
    expect(s.finished).toBeNull();
    expect(s.announcedFinish).toBeNull();
    expect(handleEvent({ type: 'game.finished', result: { winner: 'W', margin: 0.5, reason: 'score' } }, s)).toContain('Партия окончена');
  });
  it('итог цел при sync законченной партии, при sync не новее итога и при sync другой партии', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const result = { winner: 'B' as const, margin: 4.5, reason: 'score' as const };
    handleEvent(upd(fakeGame({ status: 'finished', result, revision: 6 }), { cause: 'pass', by: 'engine' }), s);
    handleEvent({ type: 'game.finished', result }, s);
    handleEvent(upd(fakeGame({ status: 'finished', result, revision: 6 }), { cause: 'sync', by: 'system' }), s);
    // Снимок sync снят до конца партии (ревизия не новее итога), а итог уже записан.
    handleEvent(upd(fakeGame({ revision: 5 }), { cause: 'sync', by: 'system' }), s);
    handleEvent(upd(fakeGame({ id: 'g2', revision: 9 }), { cause: 'sync', by: 'system' }), s);
    expect(s.finished).toEqual({ gameId: 'g1', result });
    expect(s.announcedFinish).toBe('g1');
  });
  it('любой state.updated снимает retriesExhausted: серию перезапустил коммит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.retriesExhausted = true;
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], pendingEngineMove: true }), { cause: 'play', by: 'human', via: 'tap' }), s);
    expect(s.retriesExhausted).toBe(false);
  });
});

describe('handleEvent: реплики событий — факт, а не просьба применить ход (D-0013)', () => {
  it('каждая реплика о ходе, отмене, партии, итоге и retries_exhausted говорит, что уже сделано, и что сказать вслух', () => {
    const texts: (string | null)[] = [];
    const s = () => {
      const st = newAgentState('s1');
      st.gameId = 'g1';
      return st;
    };
    const tapped = s();
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true }), { cause: 'play', by: 'human', via: 'tap' }), tapped);
    texts.push(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), tapped));
    const timedOut = s();
    timedOut.awaitingReply = true;
    texts.push(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), timedOut));
    const twoHumans = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } }, moves: [mv(1, 'B', 'D4')], toPlay: 'W' });
    texts.push(handleEvent(upd(twoHumans, { cause: 'play', by: 'human', via: 'tap' }), s()));
    texts.push(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'play', by: 'external', via: 'api' }), s()));
    texts.push(handleEvent(upd(fakeGame(), { cause: 'undo', by: 'human', via: 'tap' }), s()));
    texts.push(handleEvent(upd(fakeGame({ id: 'g2' }), { cause: 'new', by: 'system' }), s()));
    texts.push(handleEvent(upd(fakeGame({ id: 'g2', seats: { B: { controller: 'human' }, W: { controller: 'human' } } }), { cause: 'new', by: 'system' }), s()));
    texts.push(handleEvent(upd(fakeGame({ id: 'g3' }), { cause: 'sync', by: 'system' }), s()));
    texts.push(handleEvent({ type: 'game.finished', result: { winner: 'W', margin: 2.5, reason: 'score' } }, s()));
    texts.push(handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s(), () => 1));
    expect(texts).toHaveLength(10);
    for (const text of texts) {
      expect(text).not.toBeNull();
      expect(text).toMatch(/Скажи вслух только: «[^«»]+»\.$/);
      expect(text).not.toMatch(/Назови|Объяви|Скажи одну короткую фразу/);
      expect(text).toMatch(/уже (на доске|записан|сделан)|перестал повторять/);
    }
  });

  it('сбой сервера и конец сессии — тоже дословная реплика, без свободной формулировки (ревью M1)', () => {
    const st = newAgentState('s1');
    st.gameId = 'g1';
    const error = handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, st, () => 1_000_000);
    expect(SESSION_EXPIRED_INSTRUCTIONS).toBe(
      'Сессия на сервере закончилась: истекла или сервер перезапущен, эту игру отсюда не продолжить. Скажи вслух только: «Сессия закончилась, перезагрузи страницу».',
    );
    for (const text of [error, SESSION_EXPIRED_INSTRUCTIONS]) {
      expect(text).toMatch(/Скажи вслух только: «[^«»]+»\.$/);
      expect(text).not.toMatch(/Скажи одной фразой|Назови|Объяви/);
    }
  });
});

describe('watchSession', () => {
  it('озвучивает инструкции, переподключается после обрыва, останавливается по сигналу', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const spoken: string[] = [];
    const abort = new AbortController();
    let connects = 0;
    const targets: EventsTarget[] = []; // проверка после done: expect внутри генератора упал бы в цикл переподключения
    const client = {
      async *events(target: EventsTarget): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        targets.push(target);
        if (connects === 1) {
          yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
          throw new Error('socket hang up');
        }
        yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(spoken).toEqual(['Партия окончена, итог уже записан: победа за тобой: я сдался. Скажи вслух только: «Партия окончена: победа за тобой: я сдался».']);
    expect(connects).toBe(2);
    expect(targets).toEqual([{ sessionId: 's1' }, { sessionId: 's1' }]);
    expect(slept).toEqual([RETRY_MS[0]]);
  });
  it('пауза растёт 1, 2, 4, 8 с до потолка 15 с (R2)', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 8) {
          abort.abort();
          return;
        }
        throw new TypeError('fetch failed');
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
  it('соединение, прожившее 15 с, сбрасывает паузу к первой ступени', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 3) t += STABLE_CONNECTION_MS; // третье соединение жило долго и оборвалось
        if (connects === 4) {
          abort.abort();
          return;
        }
        yield { type: 'session.game', gameId: 'g1' };
        throw new Error('socket hang up');
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => t, sleep: async (ms) => void slept.push(ms) }).done;
    // Первое событие само по себе паузу не сбрасывает: сервер, который шлёт sync и рвёт поток, не крутит цикл раз в секунду.
    expect(slept).toEqual([1_000, 2_000, 1_000]);
  });
  it('rate_limited при открытии: пауза по Retry-After и blockedUntil для инструментов', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 2) {
          abort.abort();
          return;
        }
        throw new ApiError('rate_limited', 'too many requests, retry in 42 s', { retryAfterSeconds: 42 });
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(slept).toEqual([42_000]);
    expect(s.blockedUntil).toBe(42_000);
  });
  it('пауза не короче blockedUntil от инструментов: и при обрыве, и при rate_limited с меньшим Retry-After (D-0012)', async () => {
    const s = newAgentState('s1');
    s.blockedUntil = 90_000;
    const abort = new AbortController();
    let t = 10_000;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new TypeError('fetch failed');
        if (connects === 2) throw new ApiError('rate_limited', 'too many requests, retry in 42 s', { retryAfterSeconds: 42 });
        abort.abort();
      },
    };
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      t += 5_000; // часы идут, но меньше паузы: срок блокировки ещё не наступил
    };
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => t, sleep }).done;
    expect(slept).toEqual([80_000, 75_000]);
    expect(s.blockedUntil).toBe(90_000);
  });
  it('реплика человека после retries_exhausted не переоткрывает поток до blockedUntil; переоткрытое и сразу оборванное подключение — как обычный обрыв', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const logs: string[] = [];
    const slept: number[] = [];
    let t = 0;
    let connects = 0;
    // Поток дошёл до ожидания: отмена застаёт источник внутри чтения, как fetch у настоящего клиента.
    let waiting: () => void = () => {};
    const reachedWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) {
          yield { type: 'session.game', gameId: 'g1' };
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
          const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          waiting();
          await aborted;
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        if (connects === 2) throw new TypeError('fetch failed'); // переоткрытие не удалось, session.game не пришёл
        abort.abort();
      },
    };
    const watch = watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: () => {},
      log: (l) => void logs.push(l),
      now: () => t,
      sleep: async (ms) => void slept.push(ms),
    });
    await reachedWait;
    s.blockedUntil = 50_000;
    t = 49_999;
    watch.humanSpoke(); // запрос к game-server раньше срока Retry-After не шлём: поток живёт, флаг остаётся
    const deferred = '[!] voice-agent: реплика человека после retries_exhausted, но game-server просил подождать (rate_limited) ещё 1 с; поток переоткроет следующая реплика';
    expect(logs).toEqual([deferred]); // отложенное переоткрытие видно в логе (Minor 6)
    expect(s.retriesExhausted).toBe(true);
    t = 50_000;
    watch.humanSpoke();
    watch.humanSpoke(); // вторая реплика подряд не рвёт поток ещё раз
    await watch.done;
    expect(connects).toBe(3);
    expect(logs).toEqual([
      deferred,
      '[OK] voice-agent: реплика человека после retries_exhausted, переоткрываю поток сессии',
      '[!] voice-agent: поток сессии оборвался: TypeError: fetch failed',
    ]);
    expect(slept).toEqual([1_000]);
    expect(s.retriesExhausted).toBe(false);
  });
  it('обрыв во время раздумья движка: после переподключения ход движка озвучен (I1)', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true; // play голосом вернул replyTimedOut
    const abort = new AbortController();
    const spoken: string[] = [];
    let connects = 0;
    const pendingGame = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        yield { type: 'session.game', gameId: 'g1' };
        yield upd(pendingGame, { cause: 'sync', by: 'system' });
        if (connects === 1) throw new Error('socket hang up');
        yield upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], revision: 2 }), { cause: 'engine', by: 'engine' });
        abort.abort();
      },
    };
    await watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), now: () => 0, sleep: async () => {} }).done;
    expect(connects).toBe(2);
    expect(spoken).toEqual(['Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».']);
  });
  it('retries_exhausted, реплика человека, переоткрытие: ход движка, ради которого открывали поток, озвучен (D-0006, I1)', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    const abort = new AbortController();
    const spoken: string[] = [];
    let connects = 0;
    const pendingGame = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        yield { type: 'session.game', gameId: 'g1' };
        yield upd(pendingGame, { cause: 'sync', by: 'system' });
        if (connects === 1) {
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        yield upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], revision: 2 }), { cause: 'engine', by: 'engine' });
        abort.abort();
      },
    };
    let announced: () => void = () => {};
    const exhaustedSpoken = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const watch = watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => {
        spoken.push(t);
        announced();
      },
      now: () => 0,
      sleep: async () => {},
    });
    await exhaustedSpoken;
    watch.humanSpoke();
    await watch.done;
    expect(connects).toBe(2);
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toContain(humanText('retries_exhausted'));
    expect(spoken[1]).toBe('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
  });
  it('реплика человека во время паузы переподключения ничего не делает', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 2) {
          abort.abort();
          return;
        }
        yield { type: 'session.game', gameId: 'g1' };
        yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
        throw new TypeError('fetch failed');
      },
    };
    let watch: WatchHandle | null = null;
    const sleep = async (ms: number) => {
      slept.push(ms);
      watch?.humanSpoke();
    };
    watch = watchSession({ client, state: s, signal: abort.signal, speak: () => {}, log: (l) => void logs.push(l), now: () => 0, sleep });
    await watch.done;
    expect(connects).toBe(2);
    expect(slept).toEqual([1_000]);
    expect(logs).toEqual(['[!] voice-agent: поток сессии оборвался: TypeError: fetch failed']);
  });
  it('остановка сеанса обрывает живой поток: done завершается, без лога об обрыве и без паузы', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    let waiting: () => void = () => {};
    const reachedWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        yield { type: 'session.game', gameId: 'g1' };
        const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        waiting();
        await aborted;
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    };
    const watch = watchSession({ client, state: s, signal: abort.signal, speak: () => {}, log: (l) => void logs.push(l), now: () => 0, sleep: async (ms) => void slept.push(ms) });
    await reachedWait;
    abort.abort();
    await watch.done;
    expect(connects).toBe(1);
    expect(logs).toEqual([]);
    expect(slept).toEqual([]);
  });
  it('пауза rate_limited не короче Retry-After, даже если часы ушли, пока писали лог', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 2) {
          abort.abort();
          return;
        }
        throw new ApiError('rate_limited', 'too many requests, retry in 42 s', { retryAfterSeconds: 42 });
      },
    };
    const slept: number[] = [];
    const log = () => {
      t += 1_000;
    };
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, log, now: () => t, sleep: async (ms) => void slept.push(ms) }).done;
    expect(s.blockedUntil).toBe(42_000);
    expect(slept).toEqual([42_000]);
  });
  it('троттлинг ошибок в цикле — по часам опций, не по Date.now', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.lastErrorAt = 10_000;
    const abort = new AbortController();
    const spoken: string[] = [];
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        yield { type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' };
        abort.abort();
      },
    };
    await watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), now: () => 10_000 + ERROR_REPEAT_MS - 1, sleep: async () => {} }).done;
    expect(spoken).toEqual([]);
  });
  it('пауза по умолчанию ждёт ступень по таймеру и просыпается по остановке сеанса', async () => {
    vi.useFakeTimers();
    try {
      const s = newAgentState('s1');
      const abort = new AbortController();
      let connects = 0;
      const client = {
        async *events(): AsyncGenerator<GameEvent, void, undefined> {
          connects++;
          throw new TypeError('fetch failed');
        },
      };
      const watch = watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => 0 });
      await vi.advanceTimersByTimeAsync(RETRY_MS[0] - 1);
      expect(connects).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connects).toBe(2);
      // Идёт вторая пауза, 2 с: остановка будит её сразу и снимает таймер.
      abort.abort();
      await watch.done;
      expect(connects).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('ошибка speak не рвёт подключение: без переподключения и паузы, в логе [!]', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const abort = new AbortController();
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
        yield { type: 'error', gameId: 'g1', code: 'x', message: 'y' };
        abort.abort();
      },
    };
    const speak = () => {
      throw new Error('session closing');
    };
    await watchSession({ client, state: s, signal: abort.signal, speak, log: (l) => void logs.push(l), now: () => 1_000_000, sleep: async (ms) => void slept.push(ms) }).done;
    expect(connects).toBe(1);
    expect(slept).toEqual([]);
    expect(logs).toEqual(['[!] voice-agent: generateReply не удался: Error: session closing', '[!] voice-agent: generateReply не удался: Error: session closing']);
  });
  it('not_found (сессия истекла): одна реплика, лог и выход без переподключения', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const spoken: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        throw new ApiError('not_found', 'session not found');
      },
    };
    await watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => void spoken.push(t),
      log: (l) => void logs.push(l),
      sleep: async (ms) => void slept.push(ms),
    }).done;
    expect(connects).toBe(1);
    expect(spoken).toEqual([SESSION_EXPIRED_INSTRUCTIONS]);
    expect(slept).toEqual([]);
    expect(logs).toContain('[!] voice-agent: сессия не найдена (истекла или сервер перезапущен), поток закрыт');
    expect(abort.signal.aborted).toBe(false);
  });
  it('после retries_exhausted реплика человека переоткрывает поток сразу, без паузы (D-0006)', async () => {
    const s = newAgentState('s1');
    const spoken: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    const abort = new AbortController();
    let connects = 0;
    const targets: EventsTarget[] = [];
    const client = {
      async *events(target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        targets.push(target);
        if (connects === 1) {
          yield { type: 'session.game', gameId: 'g1' };
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
          // Живой поток молчит, пока его не оборвут.
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    // Реплика об исчерпанных повторах — явный сигнал теста вместо ожидания на реальных таймерах.
    let announced: () => void = () => {};
    const exhaustedSpoken = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const watch = watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => {
        spoken.push(t);
        announced();
      },
      log: (l) => void logs.push(l),
      sleep: async (ms) => void slept.push(ms),
    });
    watch.humanSpoke(); // до retries_exhausted — ничего не происходит
    await exhaustedSpoken;
    expect(s.retriesExhausted).toBe(true);
    watch.humanSpoke();
    watch.humanSpoke(); // вторая реплика подряд не рвёт поток ещё раз
    await watch.done;
    expect(connects).toBe(2);
    expect(targets).toEqual([{ sessionId: 's1' }, { sessionId: 's1' }]);
    expect(slept).toEqual([]);
    expect(s.retriesExhausted).toBe(false);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain(humanText('retries_exhausted'));
    expect(logs).toContain('[OK] voice-agent: реплика человека после retries_exhausted, переоткрываю поток сессии');
    expect(logs.some((l) => l.includes('оборвался'))).toBe(false);
  });
  it('отложенное до blockedUntil переоткрытие: секунды в логе округлены вверх, повторная реплика пишет снова', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const logs: string[] = [];
    let t = 0;
    let waiting: () => void = () => {};
    const reachedWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
        const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        waiting();
        await aborted;
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    };
    const watch = watchSession({ client, state: s, signal: abort.signal, speak: () => {}, log: (l) => void logs.push(l), now: () => t, sleep: async () => {} });
    await reachedWait;
    s.blockedUntil = 12_000;
    t = 1_400; // до срока 10,6 с: в логе 11
    watch.humanSpoke();
    t = 11_600; // 0,4 с: в логе 1, не 0
    watch.humanSpoke();
    abort.abort();
    await watch.done;
    const line = (sec: number) => `[!] voice-agent: реплика человека после retries_exhausted, но game-server просил подождать (rate_limited) ещё ${sec} с; поток переоткроет следующая реплика`;
    expect(logs).toEqual([line(11), line(1)]);
    expect(s.retriesExhausted).toBe(true);
  });
  it('исключение в обработке события — не обрыв потока: [X] в логе, событие пропущено, чтение продолжается', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const abort = new AbortController();
    const spoken: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects > 1) {
          abort.abort(); // ограничитель для кода до правки: там исключение рвало поток и цикл переподключался
          return;
        }
        const broken: GameEvent = {
          type: 'state.updated',
          cause: 'play',
          by: 'human',
          get state(): GameState {
            throw new Error('broken state');
          },
        };
        yield broken;
        yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
        abort.abort();
      },
    };
    await watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => void spoken.push(t),
      log: (l) => void logs.push(l),
      now: () => 0,
      sleep: async (ms) => void slept.push(ms),
    }).done;
    expect(connects).toBe(1);
    expect(slept).toEqual([]);
    expect(logs).toEqual(['[X] voice-agent: событие state.updated пропущено, обработка упала: Error: broken state']);
    expect(spoken).toEqual(['Партия окончена, итог уже записан: победа за тобой: я сдался. Скажи вслух только: «Партия окончена: победа за тобой: я сдался».']);
  });
  describe('зависшая реплика не держит остановку (Minor 2)', () => {
    // Несколько оборотов цикла событий без таймеров: успевают все микрозадачи после abort.
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const hangingSpeak = () => {
      let fail: (e: Error) => void = () => {};
      const calls: string[] = [];
      const speak = (t: string) => {
        calls.push(t);
        return new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
      };
      return { speak, calls, fail: (e: Error) => fail(e) };
    };
    const withRejectionProbe = async (body: (rejections: unknown[]) => Promise<void>) => {
      const rejections: unknown[] = [];
      const probe = (reason: unknown) => void rejections.push(reason);
      process.on('unhandledRejection', probe);
      try {
        await body(rejections);
      } finally {
        process.off('unhandledRejection', probe);
      }
    };
    const race = async (done: Promise<void>) => {
      let finished = false;
      void done.then(() => {
        finished = true;
      });
      await settle();
      return finished;
    };

    it('реплика в потоке висит: done завершается по сигналу, поздний отказ speak не становится unhandled rejection', async () => {
      await withRejectionProbe(async (rejections) => {
        const s = newAgentState('s1');
        s.gameId = 'g1';
        const abort = new AbortController();
        const { speak, calls, fail } = hangingSpeak();
        let connects = 0;
        const client = {
          async *events(): AsyncGenerator<GameEvent, void, undefined> {
            connects++;
            yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
            yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
          },
        };
        const logs: string[] = [];
        const watch = watchSession({ client, state: s, signal: abort.signal, speak, log: (l) => void logs.push(l), now: () => 0, sleep: async () => {} });
        await settle();
        expect(calls).toHaveLength(1);
        expect(await race(watch.done)).toBe(false); // без остановки ждём реплику, как раньше
        abort.abort();
        expect(await race(watch.done)).toBe(true);
        fail(new Error('session closed'));
        await settle();
        expect(rejections).toEqual([]);
        expect(logs).toEqual(['[!] voice-agent: generateReply не удался: Error: session closed']); // поздний отказ не потерян
        expect(connects).toBe(1);
      });
    });
    it('реплика not_found висит: done завершается по сигналу', async () => {
      await withRejectionProbe(async (rejections) => {
        const s = newAgentState('s1');
        const abort = new AbortController();
        const { speak, calls, fail } = hangingSpeak();
        const client = {
          async *events(): AsyncGenerator<GameEvent, void, undefined> {
            throw new ApiError('not_found', 'session not found');
          },
        };
        const watch = watchSession({ client, state: s, signal: abort.signal, speak, now: () => 0, sleep: async () => {} });
        await settle();
        expect(calls).toEqual([SESSION_EXPIRED_INSTRUCTIONS]);
        abort.abort();
        expect(await race(watch.done)).toBe(true);
        fail(new Error('session closed'));
        await settle();
        expect(rejections).toEqual([]);
      });
    });
    it('событие после остановки с зависшей репликой: done всё равно завершается', async () => {
      const s = newAgentState('s1');
      s.gameId = 'g1';
      const abort = new AbortController();
      const { speak, calls } = hangingSpeak();
      const client = {
        async *events(): AsyncGenerator<GameEvent, void, undefined> {
          abort.abort();
          yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } }; // источник ещё не заметил отмену
        },
      };
      const watch = watchSession({ client, state: s, signal: abort.signal, speak, now: () => 0, sleep: async () => {} });
      expect(await race(watch.done)).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(1);
    });
    it('каждая реплика снимает свой слушатель остановки: живой поток держит один слушатель подключения', async () => {
      const s = newAgentState('s1');
      const abort = new AbortController();
      const spoken: string[] = [];
      let waiting: () => void = () => {};
      const reachedWait = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const client = {
        async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
          for (let i = 0; i < 3; i++) yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
          const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          waiting();
          await aborted;
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      };
      const watch = watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), now: () => 0, sleep: async () => {} });
      await reachedWait;
      expect(spoken).toHaveLength(3);
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
      abort.abort();
      await watch.done;
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    });
  });
  it('ошибка speak не рвёт цикл', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const abort = new AbortController();
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
        yield { type: 'error', gameId: 'g1', code: 'x', message: 'y' };
        abort.abort();
      },
    };
    const spoken: string[] = [];
    await watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => {
        spoken.push(t);
        throw new Error('session closing');
      },
    }).done;
    expect(spoken.length).toBe(2);
  });
});
