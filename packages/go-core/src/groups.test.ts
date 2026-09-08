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
