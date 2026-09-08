import { describe, expect, it } from 'vitest';
import { coordToIndex } from './coords.ts';
import { deadStones, groupsWithOwnership } from './groups.ts';
import { positionFromRows } from './testing.ts';

describe('groupsWithOwnership', () => {
  const pos = positionFromRows(['.....', '.XX..', '.....', '...O.', '.....']);
  const ownership = new Array<number>(25).fill(0);
  ownership[coordToIndex('B4', 5)] = 0.9;
  ownership[coordToIndex('C4', 5)] = 0.8;
  ownership[coordToIndex('D2', 5)] = 0.7; // белый камень, но владение чёрное: мёртв

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
    weak[coordToIndex('D2', 5)] = -0.1;
    expect(groupsWithOwnership(pos, weak).find((g) => g.color === 'W')?.status).toBe('unsettled');
    expect(deadStones(pos, ownership)).toEqual(['D2']);
    expect(deadStones(pos, weak)).toEqual([]);
  });

  it('чужое владение слабее порога 0.6 — группа ещё жива', () => {
    const lone = positionFromRows(['.....', '.....', '.....', '...O.', '.....']);
    const own = new Array<number>(25).fill(0);
    own[coordToIndex('D2', 5)] = 0.4; // владение чёрное, но до порога не дотягивает
    const white = groupsWithOwnership(lone, own).find((g) => g.color === 'W');
    expect(white).toMatchObject({ stones: ['D2'], status: 'safe' });
    expect(deadStones(lone, own)).toEqual([]);
  });
});

describe('пороги владения', () => {
  const lone = positionFromRows(['.....', '.....', '.....', '...O.', '.....']);
  // Владение чужого цвета для белого камня — положительное число (в пользу чёрных).
  const statusAt = (value: number): string | undefined => {
    const own = new Array<number>(25).fill(0);
    own[coordToIndex('D2', 5)] = value;
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
  const pos = positionFromRows(['.....', '.....', '.....', '...O.', '.....']);

  it('короткий массив — ошибка', () => {
    expect(() => groupsWithOwnership(pos, new Array<number>(24).fill(0))).toThrow(/24/);
  });

  it('длинный массив — ошибка', () => {
    expect(() => groupsWithOwnership(pos, new Array<number>(26).fill(0))).toThrow(/26/);
  });
});

describe('значения массива владения', () => {
  const pos = positionFromRows(['.....', '.....', '.....', '...O.', '.....']);

  it('null внутри массива (путь из JSON) — ошибка с индексом', () => {
    const own = JSON.parse('[' + new Array<string>(25).fill('null').join(',') + ']') as number[];
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[0\]/);
  });

  it('разреженный массив — ошибка с индексом первой дырки', () => {
    const own = new Array<number>(25);
    own[0] = 0;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[1\]/);
  });

  it('NaN — ошибка', () => {
    const own = new Array<number>(25).fill(0);
    own[7] = NaN;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[7\]/);
  });

  it('Infinity — ошибка', () => {
    const own = new Array<number>(25).fill(0);
    own[8] = Infinity;
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[8\]/);
  });

  it('строка вместо числа — ошибка', () => {
    const own = JSON.parse('[' + new Array<string>(25).fill('"0"').join(',') + ']') as number[];
    expect(() => groupsWithOwnership(pos, own)).toThrow(/ownership\[0\]/);
  });

  it('одинокий белый камень при нулевом владении остаётся unsettled', () => {
    const own = new Array<number>(25).fill(0);
    expect(groupsWithOwnership(pos, own).find((g) => g.color === 'W')?.status).toBe('unsettled');
  });
});
