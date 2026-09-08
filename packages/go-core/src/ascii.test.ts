import { describe, expect, it } from 'vitest';
import { toAscii } from './ascii.ts';
import { positionFromRows } from './testing.ts';

describe('toAscii', () => {
  it('рисует строки сверху вниз, буквы снизу, последний ход в скобках', () => {
    const pos = positionFromRows(['...', 'XO.', '...']);
    const text = toAscii(pos, { lastMove: 'B2' });
    expect(text.split('\n')).toEqual([
      ' 3  .  .  . ',
      ' 2  X (O) . ',
      ' 1  .  .  . ',
      '    A  B  C ',
      'X чёрные, O белые, () последний ход; пленные: X 0, O 0',
    ]);
  });

  it('без последнего хода и при пасе скобок нет', () => {
    const pos = positionFromRows(['...', 'XO.', '...']);
    expect(toAscii(pos)).toBe(toAscii(pos, { lastMove: 'pass' }));
    expect(toAscii(pos).split('\n')[1]).toBe(' 2  X  O  . ');
  });

  it('пас словом скобок не ставит', () => {
    const pos = positionFromRows(['...', 'XO.', '...']);
    expect(toAscii(pos, { lastMove: 'пас' })).toBe(toAscii(pos));
    expect(toAscii(pos, { lastMove: 'pass' })).toBe(toAscii(pos));
  });

  it('буквы шапки стоят ровно под столбцами', () => {
    const pos = positionFromRows(['X.O', '...', 'X.O']);
    const lines = toAscii(pos).split('\n');
    const header = lines[3] ?? '';
    const top = lines[0] ?? '';
    const bottom = lines[2] ?? '';
    expect(header.indexOf('A')).toBe(top.indexOf('X'));
    expect(header.indexOf('C')).toBe(top.indexOf('O'));
    expect(header.indexOf('A')).toBe(bottom.indexOf('X'));
  });

  it('печатает пленных из позиции', () => {
    const pos = { ...positionFromRows(['...', '...', '...']), captures: { B: 3, W: 4 } };
    expect(toAscii(pos)).toContain('пленные: X 3, O 4');
  });
});
