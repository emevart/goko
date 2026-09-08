// Текстовая доска для агентов из CLI и для инструмента get_position.
import { type Position, cellAt } from './board.ts';
import { COLUMN_LETTERS, coordToIndex, parseCoord } from './coords.ts';

export function toAscii(pos: Position, opts: { lastMove?: string | null } = {}): string {
  // Пас разбирается тем же parseCoord, что и везде: слово "пас" тоже пас.
  const last = opts.lastMove && parseCoord(opts.lastMove, pos.size) !== 'pass' ? coordToIndex(opts.lastMove, pos.size) : -1;
  const lines: string[] = [];
  // Печатаем сверху вниз: строка size — первая, строка 1 — последняя.
  for (let row = pos.size - 1; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < pos.size; col++) {
      const i = row * pos.size + col;
      const c = cellAt(pos, i);
      const sym = c === 'B' ? 'X' : c === 'W' ? 'O' : '.';
      cells.push(i === last ? `(${sym})` : ` ${sym} `);
    }
    lines.push(`${String(row + 1).padStart(2)} ${cells.join('')}`);
  }
  // Номер строки с ведущим пробелом занимает три символа, символ камня стоит
  // в середине своей клетки: три пробела ставят букву ровно над столбцом.
  lines.push(`   ${[...COLUMN_LETTERS.slice(0, pos.size)].map((l) => ` ${l} `).join('')}`);
  lines.push(`X чёрные, O белые, () последний ход; пленные: X ${pos.captures.B}, O ${pos.captures.W}`);
  return lines.join('\n');
}
