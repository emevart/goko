// Помощник для тестов: позиция из строк сверху вниз. 'X' чёрные, 'O' белые, '.' пусто.
import type { Position } from './board.ts';

export function positionFromRows(rows: string[]): Position {
  const size = rows.length;
  const cells: string[] = [];
  // rows[0] — верхняя строка доски (row = size - 1); во внутренней строке первой идёт нижняя.
  for (let r = size - 1; r >= 0; r--) {
    const line = (rows[r] ?? '').replace(/\s+/g, '');
    if (line.length !== size) throw new Error(`row ${r} has ${line.length} cells, expected ${size}`);
    for (const ch of line) cells.push(ch === 'X' ? 'B' : ch === 'O' ? 'W' : '.');
  }
  return { size, board: cells.join(''), ko: null, captures: { B: 0, W: 0 } };
}
