// Доска как строка из '.', 'B', 'W'. Индекс row * size + col, row 0 — нижняя строка.

export type Color = 'B' | 'W';
export type Cell = '.' | 'B' | 'W';

export type Position = {
  size: number;
  board: string;
  ko: number | null; // пункт, запрещённый для ближайшего хода (простое ко)
  captures: { B: number; W: number }; // сколько камней снял каждый цвет
};

export type Group = { color: Color; stones: number[]; liberties: number[] };

export function emptyPosition(size: number): Position {
  return { size, board: '.'.repeat(size * size), ko: null, captures: { B: 0, W: 0 } };
}

export function opposite(color: Color): Color {
  return color === 'B' ? 'W' : 'B';
}

export function cellAt(pos: Position, index: number): Cell {
  return pos.board.charAt(index) as Cell;
}

export function withCells(board: string, changes: Array<[number, Cell]>): string {
  const cells = board.split('');
  for (const [index, cell] of changes) cells[index] = cell;
  return cells.join('');
}

export function neighbors(index: number, size: number): number[] {
  const col = index % size;
  const row = Math.floor(index / size);
  const out: number[] = [];
  if (col > 0) out.push(index - 1);
  if (col < size - 1) out.push(index + 1);
  if (row > 0) out.push(index - size);
  if (row < size - 1) out.push(index + size);
  return out;
}

export function groupAt(pos: Position, index: number): Group | null {
  const color = cellAt(pos, index);
  if (color !== 'B' && color !== 'W') return null;
  const stones: number[] = [];
  const liberties = new Set<number>();
  const seen = new Set<number>([index]);
  // Очередь обходится по индексу: pop() дал бы number | undefined.
  const queue = [index];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] ?? index;
    stones.push(i);
    for (const n of neighbors(i, pos.size)) {
      const c = cellAt(pos, n);
      if (c === '.') liberties.add(n);
      else if (c === color && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return {
    color,
    stones: stones.sort((a, b) => a - b),
    liberties: [...liberties].sort((a, b) => a - b),
  };
}

export function allGroups(pos: Position): Group[] {
  const seen = new Set<number>();
  const out: Group[] = [];
  for (let i = 0; i < pos.board.length; i++) {
    if (seen.has(i) || cellAt(pos, i) === '.') continue;
    const g = groupAt(pos, i);
    if (g === null) continue;
    for (const s of g.stones) seen.add(s);
    out.push(g);
  }
  return out;
}
