// Правила хода: захваты, простое ко, запрет самоубийства. Чистая функция над Position.
import { type Cell, type Color, type Position, cellAt, groupAt, neighbors, opposite, withCells } from './board.ts';
import { formatCoord, parseCoord, toIndex } from './coords.ts';

export type IllegalReason = 'occupied' | 'ko' | 'suicide';

export class IllegalMoveError extends Error {
  readonly reason: IllegalReason;
  readonly coord: string;

  constructor(reason: IllegalReason, coord: string) {
    super(`illegal move ${coord}: ${reason}`);
    this.name = 'IllegalMoveError';
    this.reason = reason;
    this.coord = coord;
  }
}

export type PlayResult = { position: Position; captured: number };

export function play(pos: Position, color: Color, coord: string): PlayResult {
  const point = parseCoord(coord, pos.size);
  // Пас ничего не меняет на доске, но снимает запрет ко.
  if (point === 'pass') return { position: { ...pos, ko: null }, captured: 0 };
  const index = toIndex(point, pos.size);
  const normalized = formatCoord(point);
  if (cellAt(pos, index) !== '.') throw new IllegalMoveError('occupied', normalized);
  if (pos.ko === index) throw new IllegalMoveError('ko', normalized);

  const enemy = opposite(color);
  let board = withCells(pos.board, [[index, color]]);
  const placed: Position = { ...pos, board };

  // Снять группы соперника, оставшиеся без дыханий.
  const removed: number[] = [];
  const checked = new Set<number>();
  for (const n of neighbors(index, pos.size)) {
    if (cellAt(placed, n) !== enemy || checked.has(n)) continue;
    const g = groupAt(placed, n);
    if (g === null) continue;
    for (const s of g.stones) checked.add(s);
    if (g.liberties.length === 0) removed.push(...g.stones);
  }
  if (removed.length > 0) board = withCells(board, removed.map((i) => [i, '.'] as [number, Cell]));

  const captures = { ...pos.captures };
  captures[color] = captures[color] + removed.length;
  const after: Position = { ...pos, board, ko: null, captures };

  // Свои дыхания считаются уже после снятия: ход без дыханий легален, если что-то снял.
  const own = groupAt(after, index);
  if (own === null || own.liberties.length === 0) throw new IllegalMoveError('suicide', normalized);

  // Простое ко: одиночный камень снял ровно один камень и сам имеет одно дыхание.
  if (removed.length === 1 && own.stones.length === 1 && own.liberties.length === 1) {
    after.ko = removed[0] ?? null;
  }
  return { position: after, captured: removed.length };
}
