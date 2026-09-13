import { describe, expect, it } from 'vitest';
import { GameState } from '@goko/protocol';
import { applyMove, finishByScore, newGame, positionOf, rebuild, resign, setRank, undo } from './game.ts';
import { errorOf } from './test-helpers.ts';

const T = '2026-09-07T10:00:00.000Z';

function fresh(overrides: Partial<Parameters<typeof newGame>[0]> = {}): GameState {
  return newGame({
    id: 'g1',
    createdAt: T,
    settings: { boardSize: 9, rules: 'chinese', komi: 7.5 },
    seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
    ...overrides,
  });
}

// Последовательность ходов через applyMove; цвет берётся из toPlay.
function playAll(state: GameState, coords: string[]): GameState {
  let s = state;
  for (const c of coords) s = applyMove(s, s.toPlay, c, T).state;
  return s;
}

// Последний ход как значение: `!` в проекте запрещён, пустой список — ошибка теста.
function lastMove(state: GameState) {
  const move = state.moves.at(-1);
  if (move === undefined) throw new Error('expected at least one move');
  return move;
}

describe('newGame', () => {
  it('пустая доска, ход чёрных, движок на ходу только если чёрные — engine', () => {
    const s = fresh();
    expect(s.board).toBe('.'.repeat(81));
    expect(s).toMatchObject({ revision: 0, status: 'playing', toPlay: 'B', moves: [], ko: null, consecutivePasses: 0, pendingEngineMove: false, captures: { B: 0, W: 0 } });
    const e = fresh({ seats: { B: { controller: 'engine', rank: '5k' }, W: { controller: 'human' } } });
    expect(e.pendingEngineMove).toBe(true);
  });
});

describe('applyMove', () => {
  it('ставит камень, нумерует ход, меняет очередь, поднимает revision, нормализует координату', () => {
    // Кириллическая `е` — гомоглиф латинской `E` и лежит в CYRILLIC_TO_LATIN; `Д` в карте нет.
    const { state, move } = applyMove(fresh(), 'B', 'е 5', T);
    expect(move).toEqual({ n: 1, color: 'B', coord: 'E5', captured: 0, at: T });
    expect(state.board.charAt(4 * 9 + 4)).toBe('B');
    expect(state).toMatchObject({ toPlay: 'W', revision: 1, pendingEngineMove: true, consecutivePasses: 0 });
    expect(state.moves).toHaveLength(1);
  });

  it('не правит исходное состояние на месте', () => {
    const before = fresh();
    const snapshot = structuredClone(before);
    applyMove(before, 'B', 'D4', T);
    expect(before).toEqual(snapshot);
  });

  it('собранное состояние проходит схему GameState', () => {
    const s = playAll(fresh(), ['D4', 'pass']);
    expect(GameState.parse(s)).toMatchObject({ id: 'g1', revision: 2 });
    // Контроль самой проверки: доска не той длины схему не проходит.
    expect(GameState.safeParse({ ...s, board: s.board.slice(1) }).success).toBe(false);
  });

  it('все переходы дают состояние, проходящее схему GameState', () => {
    const start = fresh();
    const played = playAll(start, ['D4', 'E5', 'F6', 'G7']);
    const twoPasses = playAll(fresh(), ['D4', 'pass', 'pass']);
    const cases: Record<string, GameState> = {
      newGame: start,
      undo: undo(played).state,
      finishByScore: finishByScore(twoPasses, { winner: 'W', margin: 7.5, reason: 'score' }),
      resign: resign(played, 'B'),
      setRank: setRank(played, 'W', '3k'),
      rebuild: rebuild(played, played.moves.slice(0, 2)),
    };
    for (const [name, value] of Object.entries(cases)) {
      expect(GameState.safeParse(value), name).toMatchObject({ success: true });
      // Контроль самой проверки: доска не той длины схему не проходит.
      expect(GameState.safeParse({ ...value, board: value.board.slice(1) }).success, name).toBe(false);
    }
  });

  it('pass считает подряд идущие пасы и не трогает доску', () => {
    const s1 = applyMove(fresh(), 'B', 'pass', T).state;
    expect(s1.consecutivePasses).toBe(1);
    const s2 = applyMove(s1, 'W', 'pass', T).state;
    expect(s2.consecutivePasses).toBe(2);
    expect(s2.board).toBe('.'.repeat(81));
    // Партия не завершается здесь: это делает сервис после счёта.
    expect(s2.status).toBe('playing');
  });

  it('ход после паса обнуляет счётчик пасов', () => {
    const s = playAll(fresh(), ['pass', 'D4']);
    expect(s.consecutivePasses).toBe(0);
  });

  it('после двух пасов ход движка не ставится, даже если очередь его', () => {
    const s = playAll(fresh(), ['pass', 'pass']);
    expect(s.toPlay).toBe('B');
    expect(s.pendingEngineMove).toBe(false);
    // Очередь белых-движка после двух пасов: ход движка всё равно не ставится, ждём счёта.
    const w = playAll(fresh(), ['D4', 'pass', 'pass']);
    expect(w.toPlay).toBe('W');
    expect(w.seats.W.controller).toBe('engine');
    expect(w.consecutivePasses).toBe(2);
    expect(w.pendingEngineMove).toBe(false);
  });

  it('ошибки: не твой ход, партия окончена, плохая координата, занято', () => {
    const s = fresh();
    expect(errorOf(() => applyMove(s, 'W', 'D4', T))).toMatchObject({ code: 'not_your_turn', status: 409 });
    expect(errorOf(() => applyMove(s, 'B', 'I4', T))).toMatchObject({ code: 'invalid_coord', status: 400 });
    const s1 = applyMove(s, 'B', 'D4', T).state;
    // message — английский текст для разработчика; русскую фразу клиент строит по reason (humanText).
    expect(errorOf(() => applyMove(s1, 'W', 'D4', T))).toMatchObject({ code: 'illegal_move', message: 'illegal move D4: occupied', details: { reason: 'occupied', coord: 'D4' } });
    const done = resign(s1, 'W');
    expect(errorOf(() => applyMove(done, 'B', 'E5', T))).toMatchObject({ code: 'game_finished', status: 409 });
  });

  it('нумерация ходов идёт подряд от единицы, цвета чередуются', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6']);
    expect(s.moves.map((m) => m.n)).toEqual([1, 2, 3]);
    expect(s.moves.map((m) => m.color)).toEqual(['B', 'W', 'B']);
    expect(s.revision).toBe(3);
  });

  it('захват записывается в ход и в captures, ко попадает в состояние строкой', () => {
    // 9×9: чёрные D5 D3 C4 вокруг пустой D4, белые E5 E3 F4 вокруг пустой E4;
    // чёрные ходят E4 (одно дыхание — D4), белые ходят D4 и снимают E4, возникает ко.
    const s = playAll(fresh(), ['D5', 'E5', 'D3', 'E3', 'C4', 'F4', 'E4', 'D4']);
    // Последний ход белых D4 снял чёрный E4: одиночный камень с одним дыханием.
    expect(lastMove(s)).toMatchObject({ color: 'W', coord: 'D4', captured: 1 });
    expect(s.captures).toEqual({ B: 0, W: 1 });
    expect(s.ko).toBe('E4');
    expect(positionOf(s).ko).toBe(3 * 9 + 4);
    expect(errorOf(() => applyMove(s, 'B', 'E4', T))).toMatchObject({ code: 'illegal_move', details: { reason: 'ko', coord: 'E4' } });
  });
});

describe('resign / finishByScore / setRank', () => {
  it('resign завершает партию победой соперника', () => {
    const s = resign(fresh(), 'B');
    expect(s).toMatchObject({ status: 'finished', result: { winner: 'W', reason: 'resign' }, pendingEngineMove: false });
    expect(s.revision).toBe(1);
  });

  it('finishByScore кладёт результат и снимает pendingEngineMove', () => {
    const two = playAll(fresh(), ['pass', 'pass']);
    const s = finishByScore(two, { winner: 'W', margin: 7.5, reason: 'score' });
    expect(s.status).toBe('finished');
    expect(s.result?.margin).toBe(7.5);
    expect(s.pendingEngineMove).toBe(false);
    expect(s.revision).toBe(two.revision + 1);
  });

  it('finishByScore снимает уже поднятый pendingEngineMove', () => {
    // После двух пасов флаг и так false: чтобы проверка была не слепой,
    // счёт считается на состоянии, где движок ждёт хода.
    const pendingState = applyMove(fresh(), 'B', 'D4', T).state;
    expect(pendingState.pendingEngineMove).toBe(true);
    const s = finishByScore(pendingState, { winner: 'B', margin: 0.5, reason: 'score' });
    expect(s.pendingEngineMove).toBe(false);
    expect(s.status).toBe('finished');
  });

  it('finishByScore не считает очки в завершённой партии', () => {
    const done = resign(fresh(), 'B');
    expect(errorOf(() => finishByScore(done, { winner: 'B', margin: 0.5, reason: 'score' }))).toMatchObject({ code: 'game_finished', status: 409 });
    const scored = finishByScore(playAll(fresh(), ['pass', 'pass']), { winner: 'W', margin: 7.5, reason: 'score' });
    expect(errorOf(() => finishByScore(scored, { winner: 'B', margin: 0.5, reason: 'score' }))).toMatchObject({ code: 'game_finished', status: 409 });
    // Результат сдачи остаётся на месте: счётом его не перекрыть.
    expect(done.result).toEqual({ winner: 'W', reason: 'resign' });
  });

  it('setRank меняет ранг места и revision', () => {
    const s = setRank(fresh(), 'W', '3k');
    expect(s.seats.W.rank).toBe('3k');
    expect(s.seats.W.controller).toBe('engine');
    expect(s.seats.B).toEqual({ controller: 'human' });
    expect(s.revision).toBe(1);
  });

  it('setRank не правит места исходного состояния', () => {
    const before = fresh();
    setRank(before, 'W', '3k');
    expect(before.seats.W.rank).toBe('10k');
  });
});

describe('undo', () => {
  it('человек против движка: снимает два хода, очередь снова у человека', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6', 'G7']); // B, W, B, W; движок ответил, ход чёрных
    expect(s.pendingEngineMove).toBe(false);
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['G7', 'F6']);
    expect(state.moves).toHaveLength(2);
    expect(state.moves.map((m) => m.coord)).toEqual(['D4', 'E5']);
    expect(state.toPlay).toBe('B');
    expect(state.pendingEngineMove).toBe(false);
    expect(state.board.charAt(5 * 9 + 5)).toBe('.');
    expect(state.board.charAt(3 * 9 + 3)).toBe('B');
    expect(state.revision).toBe(s.revision + 1);
  });

  it('движок ходил первым и один ход в партии: снимается его ход, очередь снова у движка', () => {
    const s = applyMove(fresh({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } } }), 'B', 'C3', T).state;
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['C3']);
    expect(state).toMatchObject({ toPlay: 'B', pendingEngineMove: true, moves: [] });
    expect(state.board).toBe('.'.repeat(81));
  });

  it('движок ещё думает: снимает один ход человека', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6']); // после F6 pendingEngineMove = true
    expect(s.pendingEngineMove).toBe(true);
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['F6']);
    expect(state.moves).toHaveLength(2);
    expect(state.toPlay).toBe('B');
    expect(state.pendingEngineMove).toBe(false);
  });

  it('один ход человека, движок думает: снимает его', () => {
    const s = applyMove(fresh(), 'B', 'D4', T).state;
    expect(s.pendingEngineMove).toBe(true);
    const { state, removed } = undo(s);
    expect(removed).toHaveLength(1);
    expect(state.moves).toEqual([]);
    expect(state).toMatchObject({ toPlay: 'B', pendingEngineMove: false });
  });

  it('два человека, единственный ход: снимается он один', () => {
    const s = applyMove(fresh({ seats: { B: { controller: 'human' }, W: { controller: 'human' } } }), 'B', 'D4', T).state;
    expect(s.pendingEngineMove).toBe(false);
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['D4']);
    expect(state).toMatchObject({ moves: [], toPlay: 'B', board: '.'.repeat(81) });
  });

  it('нет ходов — nothing_to_undo; после сдачи — game_finished', () => {
    expect(errorOf(() => undo(fresh()))).toMatchObject({ code: 'nothing_to_undo', status: 409 });
    expect(errorOf(() => undo(resign(fresh(), 'B')))).toMatchObject({ code: 'game_finished', status: 409 });
  });

  it('не правит исходное состояние на месте', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6', 'G7']);
    const snapshot = structuredClone(s);
    undo(s);
    expect(s).toEqual(snapshot);
  });

  it('finished по счёту: снимает оба паса и возвращает playing', () => {
    const two = playAll(fresh(), ['D4', 'pass', 'pass']);
    const done = finishByScore(two, { winner: 'B', margin: 88.5, reason: 'score' });
    const { state, removed } = undo(done);
    expect(removed.map((m) => m.coord)).toEqual(['pass', 'pass']);
    expect(state).toMatchObject({ status: 'playing', consecutivePasses: 0, toPlay: 'W', pendingEngineMove: true });
    expect(state.result).toBeUndefined();
    expect(state.moves).toHaveLength(1);
  });
});

describe('rebuild', () => {
  it('переигрывает список ходов и восстанавливает захваты, очередь и пасы', () => {
    // Та же позиция со взятием и ко, что выше, плюс пас чёрных.
    const s = playAll(fresh(), ['D5', 'E5', 'D3', 'E3', 'C4', 'F4', 'E4', 'D4', 'pass']);
    const r = rebuild(fresh(), s.moves);
    expect(r.board).toBe(s.board);
    expect(r.captures).toEqual({ B: 0, W: 1 });
    expect(r.toPlay).toBe('W');
    expect(r.consecutivePasses).toBe(1);
    expect(r.ko).toBeNull(); // pass снимает ко
  });

  it('пустой список ходов возвращает пустую доску и ход чёрных', () => {
    const s = playAll(fresh(), ['D4', 'E5']);
    const r = rebuild(s, []);
    expect(r).toMatchObject({ board: '.'.repeat(81), toPlay: 'B', consecutivePasses: 0, status: 'playing' });
    expect(r.revision).toBe(s.revision + 1);
  });

  it('считает только хвост из пасов', () => {
    const s = playAll(fresh(), ['pass', 'D4', 'pass']);
    const r = rebuild(fresh(), s.moves);
    expect(r.consecutivePasses).toBe(1);
  });
});
