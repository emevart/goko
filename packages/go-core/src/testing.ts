// Помощник для тестов: позиция из строк сверху вниз. 'X' чёрные, 'O' белые, '.' пусто.
// Импорт — по подпути @goko/go-core/testing, а не из index.ts.
import type { Position } from './board.ts';

export function positionFromRows(rows: string[]): Position {
  const size = rows.length;
  const cells: string[] = [];
  // rows[0] — верхняя строка доски (row = size - 1); во внутренней строке первой идёт нижняя.
  for (let r = size - 1; r >= 0; r--) {
    const line = (rows[r] ?? '').replace(/\s+/g, '');
    // Номер строки в ошибках — как её написал человек, сверху вниз и с единицы.
    const lineNo = r + 1;
    if (line.length !== size) throw new Error(`line ${lineNo} has ${line.length} cells, expected ${size}`);
    for (const ch of line) {
      // Алфавит помощника — '.XO'. Внутри доски цвета пишутся 'B'/'W', и молчаливая
      // подмена чужого символа на '.' дала бы другую позицию и зелёный тест по неверной причине.
      if (ch !== '.' && ch !== 'X' && ch !== 'O') {
        throw new Error(`line ${lineNo} has unexpected char "${ch}", expected one of ".XO"`);
      }
      cells.push(ch === 'X' ? 'B' : ch === 'O' ? 'W' : '.');
    }
  }
  return { size, board: cells.join(''), ko: null, captures: { B: 0, W: 0 } };
}
