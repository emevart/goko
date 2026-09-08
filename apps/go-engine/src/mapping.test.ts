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

  it('reorderFromKata принимает массив с местом под пас и не переносит пас на доску', () => {
    const kata = new Array<number>(170).fill(0);
    kata[0] = 1; // A13
    kata[169] = 0.5; // пас
    const ours = reorderFromKata(kata, 13);
    expect(ours).toHaveLength(169);
    expect(ours[coordToIndex('A13', 13)]).toBe(1);
  });

  it('reorderFromKata бросает на массиве не по доске', () => {
    expect(() => reorderFromKata([1, 2, 3], 13)).toThrow(/168|169|170/);
    expect(() => reorderFromKata(new Array<number>(168).fill(0), 13)).toThrow(/168/);
    expect(() => reorderFromKata(new Array<number>(171).fill(0), 13)).toThrow(/171/);
  });

  it('reorderFromKata бросает на дырке в массиве', () => {
    const sparse = new Array<number>(169);
    sparse[0] = 1;
    expect(() => reorderFromKata(sparse, 13)).toThrow(/missing/);
  });

  it('kataIndexToCoord бросает вне контракта', () => {
    expect(() => kataIndexToCoord(-1, 13)).toThrow(/-1/);
    expect(() => kataIndexToCoord(170, 13)).toThrow(/170/);
    expect(() => kataIndexToCoord(1.5, 13)).toThrow(/1\.5/);
    expect(() => kataIndexToCoord(Number.NaN, 13)).toThrow(/NaN/);
  });

  it('rankToProfile', () => {
    expect(rankToProfile('10k')).toBe('rank_10k');
    expect(rankToProfile('3d')).toBe('rank_3d');
    expect(rankToProfile('20k')).toBe('rank_20k');
    expect(rankToProfile('1k')).toBe('rank_1k');
    expect(rankToProfile('9d')).toBe('rank_9d');
  });

  it('rankToProfile бросает на непонятном разряде', () => {
    for (const bad of ['', 'bogus', '0k', '21k', '0d', '10d', '10K', 'k10', '1 k', '01k']) {
      expect(() => rankToProfile(bad), bad).toThrow(/rank/);
    }
  });
});
