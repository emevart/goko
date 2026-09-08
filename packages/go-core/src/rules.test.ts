import { describe, expect, it } from 'vitest';
import { type Position, allGroups, assertPosition, cellAt, emptyPosition, groupAt, neighbors } from './board.ts';
import { coordToIndex } from './coords.ts';
import { replay } from './replay.ts';
import { IllegalMoveError, play } from './rules.ts';
import { positionFromRows } from './testing.ts';

const at = (coord: string, size = 5) => coordToIndex(coord, size);

describe('board', () => {
  it('пустая позиция', () => {
    const pos = emptyPosition(5);
    expect(pos.board).toBe('.'.repeat(25));
    expect(pos.ko).toBeNull();
    expect(pos.captures).toEqual({ B: 0, W: 0 });
    expect(allGroups(pos)).toEqual([]);
  });

  it('neighbors у края и в углу', () => {
    expect(neighbors(at('A1'), 5).sort()).toEqual([at('B1'), at('A2')].sort());
    expect(neighbors(at('C1'), 5)).toHaveLength(3);
    expect(neighbors(at('C3'), 5)).toHaveLength(4);
  });

  it('neighbors у верхнего и правого края', () => {
    // Верхняя строка и правый столбец: соседей за доской быть не должно.
    expect(neighbors(at('E5'), 5).sort()).toEqual([at('D5'), at('E4')].sort());
    expect(neighbors(at('C5'), 5).sort()).toEqual([at('B5'), at('D5'), at('C4')].sort());
    expect(neighbors(at('E3'), 5).sort()).toEqual([at('D3'), at('E2'), at('E4')].sort());
  });

  it('allGroups считает каждую группу один раз', () => {
    const pos = positionFromRows(['.....', '.....', '.XX..', '.X.OO', '.....']);
    const groups = allGroups(pos);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.stones.length).sort()).toEqual([2, 3]);
    expect(groups.map((g) => g.color).sort()).toEqual(['B', 'W']);
  });

  it('groupAt собирает камни и дыхания', () => {
    const pos = positionFromRows(['.....', '.....', '.XX..', '.X...', '.....']);
    const g = groupAt(pos, at('B2'));
    expect(g?.color).toBe('B');
    expect(g?.stones).toHaveLength(3);
    expect(g?.liberties).toHaveLength(7);
    expect(groupAt(pos, at('E5'))).toBeNull();
  });
});

describe('play: захваты', () => {
  it('одиночный камень в центре', () => {
    const pos = positionFromRows(['.....', '..X..', '.XOX.', '.....', '.....']);
    const { position, captured } = play(pos, 'B', 'C2');
    expect(captured).toBe(1);
    expect(cellAt(position, at('C3'))).toBe('.');
    expect(position.captures).toEqual({ B: 1, W: 0 });
  });

  it('группа у края', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'XX...', 'OO...']);
    const { position, captured } = play(pos, 'B', 'C1');
    expect(captured).toBe(2);
    expect(cellAt(position, at('A1'))).toBe('.');
    expect(cellAt(position, at('B1'))).toBe('.');
  });

  it('камень в углу', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'X....', 'O....']);
    expect(play(pos, 'B', 'B1').captured).toBe(1);
  });

  it('ход без своих дыханий легален, если снимает камни соперника', () => {
    // Белые A3, B2; чёрные A2, B1. Белые ставят A1: дыханий нет, но A2 снимается.
    const pos = positionFromRows(['.....', '.....', 'O....', 'XO...', '.X...']);
    const { position, captured } = play(pos, 'W', 'A1');
    expect(captured).toBe(1);
    expect(cellAt(position, at('A2'))).toBe('.');
    expect(groupAt(position, at('A1'))?.liberties).toEqual([at('A2')]);
  });
});

describe('play: запреты', () => {
  it('занятая точка', () => {
    const pos = positionFromRows(['.....', '.....', '..X..', '.....', '.....']);
    expect(() => play(pos, 'W', 'C3')).toThrow(IllegalMoveError);
    try {
      play(pos, 'W', 'C3');
    } catch (e) {
      expect((e as IllegalMoveError).reason).toBe('occupied');
    }
  });

  it('самоубийство без захвата', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'O....', '.O...']);
    expect(() => play(pos, 'B', 'A1')).toThrow(/suicide/);
  });

  it('ко: сразу забрать нельзя, после хода в другом месте можно', () => {
    // Чёрные: B2, C1, C3, D2. Белые: A2, B1, B3. Белые ставят C2 и снимают B2.
    const pos = positionFromRows(['.....', '.....', '.OX..', 'OX.X.', '.OX..']);
    const afterWhite = play(pos, 'W', 'C2');
    expect(afterWhite.captured).toBe(1);
    expect(afterWhite.position.ko).toBe(at('B2'));
    expect(() => play(afterWhite.position, 'B', 'B2')).toThrow(/ko/);

    const elsewhere = play(afterWhite.position, 'B', 'E5').position;
    expect(elsewhere.ko).toBeNull();
    const whiteElsewhere = play(elsewhere, 'W', 'E4').position;
    const retake = play(whiteElsewhere, 'B', 'B2');
    expect(retake.captured).toBe(1);
    expect(cellAt(retake.position, at('C2'))).toBe('.');
  });

  it('пас сбрасывает ко и ничего не меняет на доске', () => {
    const pos = positionFromRows(['.....', '.....', '.OX..', 'OX.X.', '.OX..']);
    const afterWhite = play(pos, 'W', 'C2').position;
    const passed = play(afterWhite, 'B', 'pass');
    expect(passed.captured).toBe(0);
    expect(passed.position.ko).toBeNull();
    expect(passed.position.board).toBe(afterWhite.board);
  });

  it('захват многих камней не создаёт ко', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'XX...', 'OO...']);
    expect(play(pos, 'B', 'C1').position.ko).toBeNull();
  });

  it('ко нет, когда одинокий камень снял двоих', () => {
    // Белые A2, A3, B1; чёрные B2, B3, A4. Чёрные A1 снимают A2 и A3
    // и остаются с одним дыханием — но повторить позицию нельзя, ко нет.
    const pos = positionFromRows(['.....', 'X....', 'OX...', 'OX...', '.O...']);
    const { position, captured } = play(pos, 'B', 'A1');
    expect(captured).toBe(2);
    expect(groupAt(position, at('A1'))?.liberties).toEqual([at('A2')]);
    expect(position.ko).toBeNull();
  });

  it('ко нет, когда одного снял не одинокий камень', () => {
    // Чёрные C1, A2; белые A1, B2, C2, D1. Чёрные B1 снимают A1,
    // группа B1+C1 остаётся с одним дыханием, но это снэпбэк, а не ко.
    const pos = positionFromRows(['.....', '.....', '.....', 'XOO..', 'O.XO.']);
    const { position, captured } = play(pos, 'B', 'B1');
    expect(captured).toBe(1);
    expect(groupAt(position, at('B1'))?.stones).toHaveLength(2);
    expect(groupAt(position, at('B1'))?.liberties).toEqual([at('A1')]);
    expect(position.ko).toBeNull();
  });
});

describe('replay', () => {
  it('позиция — функция от списка ходов', () => {
    const pos = replay(5, [
      { color: 'B', coord: 'C3' },
      { color: 'W', coord: 'C4' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'B3' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'D3' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'C2' },
    ]);
    expect(cellAt(pos, at('C3'))).toBe('.');
    expect(pos.captures).toEqual({ B: 0, W: 1 });
    expect(allGroups(pos)).toHaveLength(4);
    expect(pos.ko).toBeNull(); // у C2 четыре дыхания, ко нет
  });

  it('нелегальный ход в списке — ошибка', () => {
    expect(() => replay(5, [{ color: 'B', coord: 'C3' }, { color: 'W', coord: 'C3' }])).toThrow(IllegalMoveError);
  });
});

describe('play не меняет входную позицию', () => {
  it('обычный ход', () => {
    const pos = positionFromRows(['.....', '.....', '..X..', '.....', '.....']);
    const before = JSON.stringify(pos);
    play(pos, 'W', 'D3');
    expect(JSON.stringify(pos)).toBe(before);
  });

  it('ход со взятием: не меняются ни board, ни captures, ни ko', () => {
    // Позиция ко: белые ставят C2, снимают B2 и открывают ко.
    const pos = positionFromRows(['.....', '.....', '.OX..', 'OX.X.', '.OX..']);
    const before = JSON.stringify(pos);
    const { position } = play(pos, 'W', 'C2');
    expect(position.captures).toEqual({ B: 0, W: 1 });
    expect(position.ko).not.toBeNull();
    expect(JSON.stringify(pos)).toBe(before);
  });
});

describe('positionFromRows', () => {
  it('бросает на символе вне .XO', () => {
    expect(() => positionFromRows(['...', '.B.', '...'])).toThrow(/line 2/);
    expect(() => positionFromRows(['...', '.B.', '...'])).toThrow(/B/);
  });

  it('бросает на строке неверной длины', () => {
    expect(() => positionFromRows(['...', '..', '...'])).toThrow(/line 2/);
  });

  // Доска 4x4 и ошибка в крайних строках: на симметричной тройке номер строки
  // сверху вниз и снизу вверх совпадает, и направление нумерации не проверяется.
  it('номер строки считается сверху вниз, как её написал человек', () => {
    expect(() => positionFromRows(['.B..', '....', '....', '....'])).toThrow(/line 1/);
    expect(() => positionFromRows(['....', '....', '....', '..B.'])).toThrow(/line 4/);
    expect(() => positionFromRows(['...', '....', '....', '....'])).toThrow(/line 1/);
  });
});

describe('assertPosition', () => {
  // Позиция приходит извне структурным типом: ни длину доски, ни её алфавит,
  // ни осмысленный размер тип не гарантирует.
  const valid = (): Position => emptyPosition(9);
  const sized = (size: number, board: string): Position =>
    ({ size, board, ko: null, captures: { B: 0, W: 0 } });

  it('валидная позиция проходит', () => {
    expect(() => assertPosition(valid())).not.toThrow();
    expect(() => assertPosition(positionFromRows(new Array<string>(9).fill('.........'))))
      .not.toThrow();
  });

  // Правила го работают на любом размере, а какие доски играет продукт —
  // вопрос протокола и сервера. Маленькие доски нужны фикстурам и эталонным
  // прогонам правил, поэтому инвариант их пропускает.
  it('маленькие доски легальны', () => {
    expect(() => assertPosition(sized(3, '.'.repeat(9)))).not.toThrow();
    expect(() => assertPosition(sized(5, '.'.repeat(24) + 'B'))).not.toThrow();
    expect(() => assertPosition(sized(7, '.'.repeat(48) + 'W'))).not.toThrow();
  });

  it('нулевой размер — ошибка', () => {
    expect(() => assertPosition(sized(0, ''))).toThrow(/0/);
    expect(() => assertPosition(sized(0, ''))).toThrow(/positive integer/);
  });

  it('отрицательный размер — ошибка', () => {
    expect(() => assertPosition(sized(-3, '.'.repeat(9)))).toThrow(/-3/);
    expect(() => assertPosition(sized(-3, '.'.repeat(9)))).toThrow(/positive integer/);
  });

  it('дробный размер — ошибка', () => {
    expect(() => assertPosition(sized(2.5, '.'.repeat(6)))).toThrow(/2\.5/);
    expect(() => assertPosition(sized(2.5, '.'.repeat(6)))).toThrow(/positive integer/);
  });

  it('укороченная доска — ошибка с обеими длинами', () => {
    const pos = { ...valid(), board: '.'.repeat(80) };
    expect(() => assertPosition(pos)).toThrow(/80/);
    expect(() => assertPosition(pos)).toThrow(/81/);
  });

  it('удлинённая доска — ошибка с обеими длинами', () => {
    const pos = { ...valid(), board: '.'.repeat(81) + 'W' };
    expect(() => assertPosition(pos)).toThrow(/82/);
    expect(() => assertPosition(pos)).toThrow(/81/);
  });

  it('чужой символ на доске — ошибка с символом и индексом', () => {
    const pos = { ...valid(), board: '.'.repeat(7) + 'X' + '.'.repeat(73) };
    expect(() => assertPosition(pos)).toThrow(/"X"/);
    expect(() => assertPosition(pos)).toThrow(/index 7/);
  });

  // Длина и алфавит проверяются и на маленькой доске: она легальна, но
  // согласованной остаётся быть обязана.
  it('на маленькой доске длина и алфавит по-прежнему проверяются', () => {
    expect(() => assertPosition(sized(5, '.'.repeat(24)))).toThrow(/24/);
    expect(() => assertPosition(sized(5, '.'.repeat(24)))).toThrow(/25/);
    expect(() => assertPosition(sized(5, '.'.repeat(24) + 'X'))).toThrow(/"X"/);
  });
});
