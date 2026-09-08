import { describe, expect, it } from 'vitest';
import { coordToIndex } from '@goko/go-core';
import { kataIndexToCoord, kataIndexToOurs, oursToKataIndex, rankToProfile, reorderFromKata } from './mapping.ts';

describe('mapping', () => {
  it('KataGo идёт строками сверху: индекс 0 — A13, индекс 168 — N1', () => {
    expect(kataIndexToCoord(0, 13)).toBe('A13');
    expect(kataIndexToCoord(12, 13)).toBe('N13');
    expect(kataIndexToCoord(156, 13)).toBe('A1');
    expect(kataIndexToCoord(168, 13)).toBe('N1');
    expect(kataIndexToCoord(169, 13)).toBe('pass');
    expect(kataIndexToOurs(0, 13)).toBe(coordToIndex('A13', 13));
  });

  it('oursToKataIndex обратен kataIndexToOurs', () => {
    for (const k of [0, 12, 42, 156, 168]) expect(oursToKataIndex(kataIndexToOurs(k, 13), 13)).toBe(k);
  });

  it('reorderFromKata перекладывает массив в нашу индексацию', () => {
    const kata = new Array<number>(169).fill(0);
    kata[0] = 1; // A13
    kata[168] = -1; // N1
    const ours = reorderFromKata(kata, 13);
    expect(ours[coordToIndex('A13', 13)]).toBe(1);
    expect(ours[coordToIndex('N1', 13)]).toBe(-1);
    expect(ours[coordToIndex('A1', 13)]).toBe(0);
    expect(ours).toHaveLength(169);
  });

  it('rankToProfile', () => {
    expect(rankToProfile('10k')).toBe('rank_10k');
    expect(rankToProfile('3d')).toBe('rank_3d');
  });
});
