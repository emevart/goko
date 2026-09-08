import { describe, expect, it } from 'vitest';
import { toAscii } from './ascii.ts';
import { positionFromRows } from './testing.ts';

// Доска 9x9: чёрный A2, белый B2. Строки пишутся сверху вниз.
const rows9 = (filled: Record<number, string>): string[] =>
  Array.from({ length: 9 }, (_, r) => filled[9 - r] ?? '.........');

const EMPTY_LINE = '  .  .  .  .  .  .  .  .  . ';

describe('toAscii', () => {
  it('рисует строки сверху вниз, буквы снизу, последний ход в скобках', () => {
    const pos = positionFromRows(rows9({ 2: 'XO.......' }));
    const text = toAscii(pos, { lastMove: 'B2' });
    expect(text.split('\n')).toEqual([
      ` 9${EMPTY_LINE}`,
      ` 8${EMPTY_LINE}`,
      ` 7${EMPTY_LINE}`,
      ` 6${EMPTY_LINE}`,
      ` 5${EMPTY_LINE}`,
      ` 4${EMPTY_LINE}`,
      ` 3${EMPTY_LINE}`,
      ' 2  X (O) .  .  .  .  .  .  . ',
      ` 1${EMPTY_LINE}`,
      '    A  B  C  D  E  F  G  H  J ',
      'X чёрные, O белые, () последний ход; пленные: X 0, O 0',
    ]);
  });

  it('без последнего хода и при пасе скобок нет', () => {
    const pos = positionFromRows(rows9({ 2: 'XO.......' }));
    expect(toAscii(pos)).toBe(toAscii(pos, { lastMove: 'pass' }));
    expect(toAscii(pos).split('\n')[7]).toBe(' 2  X  O  .  .  .  .  .  .  . ');
  });

  it('пас словом скобок не ставит', () => {
    const pos = positionFromRows(rows9({ 2: 'XO.......' }));
    expect(toAscii(pos, { lastMove: 'пас' })).toBe(toAscii(pos));
    expect(toAscii(pos, { lastMove: 'pass' })).toBe(toAscii(pos));
  });

  it('буквы шапки стоят ровно под столбцами', () => {
    const pos = positionFromRows(rows9({ 9: 'X.......O', 1: 'X.......O' }));
    const lines = toAscii(pos).split('\n');
    const header = lines[9] ?? '';
    const top = lines[0] ?? '';
    const bottom = lines[8] ?? '';
    expect(header.indexOf('A')).toBe(top.indexOf('X'));
    expect(header.indexOf('J')).toBe(top.indexOf('O'));
    expect(header.indexOf('A')).toBe(bottom.indexOf('X'));
  });

  it('печатает пленных из позиции', () => {
    const pos = { ...positionFromRows(rows9({})), captures: { B: 3, W: 4 } };
    expect(toAscii(pos)).toContain('пленные: X 3, O 4');
  });
});

// Доска рисуется человеку рядом с настоящей: короткая строка молча дала бы
// пустые пункты там, где на доске камни.
describe('toAscii проверяет позицию', () => {
  const pos = positionFromRows(rows9({}));

  it('укороченная доска — ошибка про доску', () => {
    expect(() => toAscii({ ...pos, board: pos.board.slice(0, 80) })).toThrow(/board has 80 cells/);
  });

  it('бессмысленный размер — ошибка про размер', () => {
    expect(() => toAscii({ ...pos, size: 0, board: '' })).toThrow(/positive integer/);
  });
});
