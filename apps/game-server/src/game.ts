// Чистые переходы состояния партии (раздел 4 спеки). Позиция — функция от moves (go-core.replay).
// [!] Переходы, кроме rebuild, делят со старым состоянием вложенные объекты (settings, seats, ходы):
// копируется только то, что меняется. Состояние править на месте нельзя — ни старое, ни новое.
import {
  IllegalMoveError,
  InvalidCoordError,
  type Position,
  formatCoord,
  indexToCoord,
  opposite,
  parseCoord,
  play,
  replay,
} from '@goko/go-core';
import { ApiError, type Color, type GameSettings, type GameState, type Move, type Rank, type Result, type Seat } from '@goko/protocol';

export type NewGameParams = { id: string; createdAt: string; settings: GameSettings; seats: { B: Seat; W: Seat } };

function pending(state: Pick<GameState, 'status' | 'consecutivePasses' | 'seats' | 'toPlay'>): boolean {
  return state.status === 'playing' && state.consecutivePasses < 2 && state.seats[state.toPlay].controller === 'engine';
}

export function newGame(input: NewGameParams): GameState {
  const base = {
    id: input.id,
    createdAt: input.createdAt,
    revision: 0,
    settings: input.settings,
    seats: input.seats,
    status: 'playing' as const,
    toPlay: 'B' as const,
    moves: [],
    board: '.'.repeat(input.settings.boardSize * input.settings.boardSize),
    captures: { B: 0, W: 0 },
    ko: null,
    consecutivePasses: 0,
    canRedo: false,
  };
  return { ...base, pendingEngineMove: pending(base) };
}

export function positionOf(state: GameState): Position {
  return replay(state.settings.boardSize, state.moves);
}

function normalizeCoord(coord: string, size: number): string {
  try {
    const p = parseCoord(coord, size);
    return p === 'pass' ? 'pass' : formatCoord(p);
  } catch (e) {
    if (e instanceof InvalidCoordError) throw new ApiError('invalid_coord', `unknown coordinate "${coord}"`, { coord });
    throw e;
  }
}

export function applyMove(state: GameState, color: Color, coord: string, at: string): { state: GameState; move: Move } {
  if (state.status !== 'playing') throw new ApiError('game_finished', 'game is over');
  if (state.toPlay !== color) throw new ApiError('not_your_turn', `it is ${state.toPlay === 'B' ? 'black' : 'white'} to play`, { toPlay: state.toPlay });
  const size = state.settings.boardSize;
  const normalized = normalizeCoord(coord, size);
  let played: ReturnType<typeof play>;
  try {
    played = play(positionOf(state), color, normalized);
  } catch (e) {
    // Текст для человека клиент строит по reason (humanText в протоколе), message — для разработчика.
    if (e instanceof IllegalMoveError) throw new ApiError('illegal_move', `illegal move ${e.coord}: ${e.reason}`, { reason: e.reason, coord: e.coord });
    throw e;
  }
  const move: Move = { n: state.moves.length + 1, color, coord: normalized, captured: played.captured, at };
  const next: GameState = {
    ...state,
    revision: state.revision + 1,
    toPlay: opposite(color),
    moves: [...state.moves, move],
    board: played.position.board,
    captures: { ...played.position.captures },
    ko: played.position.ko === null ? null : indexToCoord(played.position.ko, size),
    consecutivePasses: normalized === 'pass' ? state.consecutivePasses + 1 : 0,
    pendingEngineMove: false,
    canRedo: state.canRedo,
  };
  next.pendingEngineMove = pending(next);
  return { state: next, move };
}

export function resign(state: GameState, color: Color): GameState {
  if (state.status !== 'playing') throw new ApiError('game_finished', 'game is over');
  return { ...state, revision: state.revision + 1, status: 'finished', pendingEngineMove: false, result: { winner: opposite(color), reason: 'resign' } };
}

export function finishByScore(state: GameState, result: Result): GameState {
  // Завершённую партию не пересчитываем: иначе счёт перекрыл бы результат сдачи
  // и снова открыл откат.
  if (state.status !== 'playing') throw new ApiError('game_finished', 'game is over');
  return { ...state, revision: state.revision + 1, status: 'finished', pendingEngineMove: false, result };
}

export function setRank(state: GameState, color: Color, rank: Rank): GameState {
  return { ...state, revision: state.revision + 1, seats: { ...state.seats, [color]: { ...state.seats[color], rank } } };
}

// Переигрывает список ходов; статус всегда playing (вызывающий решает, что делать с result).
// Результат не делит со входом ни список ходов, ни сами ходы, ни настройки, ни места: правка
// одного состояния на месте не должна менять другое.
export function rebuild(state: GameState, moves: Move[]): GameState {
  const size = state.settings.boardSize;
  const pos = replay(size, moves);
  const last = moves.at(-1);
  let passes = 0;
  for (let i = moves.length - 1; i >= 0 && moves[i]?.coord === 'pass'; i--) passes++;
  const rest: GameState = { ...state };
  delete rest.result;
  const next: GameState = {
    ...rest,
    settings: { ...state.settings },
    seats: { B: { ...state.seats.B }, W: { ...state.seats.W } },
    revision: state.revision + 1,
    status: 'playing',
    toPlay: last ? opposite(last.color) : 'B',
    moves: moves.map((m) => ({ ...m })),
    board: pos.board,
    captures: { ...pos.captures },
    ko: pos.ko === null ? null : indexToCoord(pos.ko, size),
    consecutivePasses: passes,
    pendingEngineMove: false,
  };
  next.pendingEngineMove = pending(next);
  return next;
}

// Откат до предыдущего хода того же места (раздел 5 спеки):
// finished по счёту — два паса; движок думает — один ход человека; иначе два хода (или один, если он единственный).
export function undo(state: GameState): { state: GameState; removed: Move[] } {
  if (state.status === 'finished' && state.result?.reason === 'resign') throw new ApiError('game_finished', 'undo is not possible after a resignation');
  if (state.moves.length === 0) throw new ApiError('nothing_to_undo', 'there are no moves yet');
  const count = state.status === 'finished' ? 2 : state.pendingEngineMove ? 1 : Math.min(2, state.moves.length);
  // `removed` может оказаться длиной 1 при единственном ходе: срез с отрицательным
  // началом клампится, поэтому Math.min в ветке finished не нужен.
  const kept = state.moves.slice(0, state.moves.length - count);
  const removed = state.moves.slice(state.moves.length - count).reverse();
  return { state: rebuild(state, kept), removed };
}
