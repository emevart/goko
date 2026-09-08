import { describe, expect, it } from 'vitest';
import { coordToIndex } from './coords.ts';
import { deadStones, groupsWithOwnership } from './groups.ts';
import { positionFromRows } from './testing.ts';

// Доска 9x9: размеры доски в проекте только 9, 13, 19, и позиция с любым другим
// размером отвергается проверкой инварианта.
const rows9 = (filled: Record<number, string>): string[] =>
  // Ключ — номер строки доски, снизу вверх и с единицы; строки пишутся сверху вниз.
  Array.from({ length: 9 }, (_, r) => filled[9 - r] ?? '.........');

const TOTAL = 81;

describe('groupsWithOwnership', () => {
  const pos = positionFromRows(rows9({ 4: '.XX......', 2: '...O.....' }));
  const ownership = new Array<number>(TOTAL).fill(0);
  ownership[coordToIndex('B4', 9)] = 0.9;
  ownership[coordToIndex('C4', 9)] = 0.8;
  ownership[coordToIndex('D2', 9)] = 0.7; // белый камень, но владение чёрное: мёртв

  it('статусы по владению против своего цвета', () => {
    const groups = groupsWithOwnership(pos, ownership);
    const black = groups.find((g) => g.color === 'B');
    const white = groups.find((g) => g.color === 'W');
    expect(black).toMatchObject({ stones: ['B4', 'C4'], liberties: 6, status: 'safe' });
    expect(black?.ownershipAvg).toBeCloseTo(0.85);
    expect(white).toMatchObject({ stones: ['D2'], status: 'dead' });
  });

  it('unsettled при слабом владении, deadStones возвращает только мёртвые', () => {
    const weak = [...ownership];
    weak[coordToIndex('D2', 9)] = -0.1;
    expect(groupsWithOwnership(pos, weak).find((g) => g.color === 'W')?.status).toBe('unsettled');
    expect(deadStones(pos, ownership)).toEqual(['D2']);
    expect(deadStones(pos, weak)).toEqual([]);
  });

  it('чужое владение слабее порога 0.6 — группа ещё жива', () => {
    const lone = positionFromRows(rows9({ 2: '...O.....' }));
    const own = new Array<number>(TOTAL).fill(0);
    own[coordToIndex('D2', 9)] = 0.4; // владение чёрное, но до порога не дотягивает
    const white = groupsWithOwnership(lone, own).find((g) => g.color === 'W');
    expect(white).toMatchObject({ stones: ['D2'], status: 'safe' });
    expect(deadStones(lone, own)).toEqual([]);
  });
});

describe('пороги владения', () => {
  const lone = positionFromRows(rows9({ 2: '...O.....' }));
  // Владение чужого цвета для белого камня — положительное число (в пользу чёрных).
  const statusAt = (value: number): string | undefined => {
    const own = new Array<number>(TOTAL).fill(0);
    own[coordToIndex('D2', 9)] = value;
    return groupsWithOwnership(lone, own).find((g) => g.color === 'W')?.status;
  };

  it('порог 0.6: 0.55 ещё жива, 0.65 уже мертва', () => {
    expect(statusAt(0.55)).toBe('safe');
    expect(statusAt(0.65)).toBe('dead');
  });

  it('порог 0.3: 0.25 unsettled, 0.35 safe', () => {
    expect(statusAt(0.25)).toBe('unsettled');
    expect(statusAt(0.35)).toBe('safe');
  });

  it('на самой границе сравнения строгие: ровно 0.6 и ровно 0.3 — safe', () => {
    expect(statusAt(0.6)).toBe('safe');
    expect(statusAt(0.3)).toBe('safe');
  });
});

describe('длина массива владения', () => {
  const pos = positionFromRows(rows9({ 2: '...O.....' }));

  it('короткий массив — ошибка', () => {
    expect(() => groupsWithOwnership(pos, new Array<number>(TOTAL - 1).fill(0))).toThrow(/80/);
  });

  it('длинный массив — ошибка', () => {
    expect(() => groupsWithOwnership(pos, new Array<number>(TOTAL + 1).fill(0))).toThrow(/82/);
  });
});

describe('значения массива владения', () => {
  const pos = positionFromRows(rows9({ 2: '...O.....' }));

  it('null внутри массива (путь из JSON) — ошибка с индексом', () => {
    const own = JSON.parse('[' + new Array<string>(TOTAL).fill('null').join(',') + ']') as number[];
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[0\]/);
  });

  it('разреженный массив — ошибка с индексом первой дырки', () => {
    const own = new Array<number>(TOTAL);
    own[0] = 0;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[1\]/);
  });

  it('NaN — ошибка', () => {
    const own = new Array<number>(TOTAL).fill(0);
    own[7] = NaN;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[7\]/);
  });

  it('Infinity — ошибка', () => {
    const own = new Array<number>(TOTAL).fill(0);
    own[8] = Infinity;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[8\]/);
  });

  it('мусор на последнем пункте доски тоже ошибка', () => {
    const own = new Array<number>(TOTAL).fill(0);
    own[TOTAL - 1] = NaN;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[80\]/);
  });

  it('строка вместо числа — ошибка', () => {
    const own = JSON.parse('[' + new Array<string>(TOTAL).fill('"0"').join(',') + ']') as number[];
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[0\]/);
  });

  it('одинокий белый камень при нулевом владении остаётся unsettled', () => {
    const own = new Array<number>(TOTAL).fill(0);
    expect(groupsWithOwnership(pos, own).find((g) => g.color === 'W')?.status).toBe('unsettled');
  });
});

// Позиция приходит от движка вместе с массивом владения: сломанная доска дала бы
// индексы вне доски и ошибку из другого модуля, про координату, а не про доску.
describe('groupsWithOwnership проверяет позицию', () => {
  const pos = positionFromRows(rows9({ 2: '...O.....' }));
  const own = new Array<number>(TOTAL).fill(0);

  it('удлинённая доска — ошибка про доску', () => {
    const broken = { ...pos, board: pos.board + 'W' };
    expect(() => groupsWithOwnership(broken, own)).toThrow(/board has 82 cells/);
  });

  it('бессмысленный размер — ошибка про размер', () => {
    const broken = { ...pos, size: 0, board: '' };
    expect(() => groupsWithOwnership(broken, [])).toThrow(/positive integer/);
  });
});
