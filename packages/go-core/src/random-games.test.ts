// Случайные легальные партии: после каждого хода ни у одной группы нет нуля дыханий.
import { describe, expect, it } from 'vitest';
import { allGroups, emptyPosition, type Position } from './board.ts';
import { indexToCoord } from './coords.ts';
import { IllegalMoveError, play } from './rules.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGame(seed: number, size: number, maxMoves: number): Position {
  const rnd = mulberry32(seed);
  let pos = emptyPosition(size);
  let color: 'B' | 'W' = 'B';
  for (let n = 0; n < maxMoves; n++) {
    let played = false;
    for (let attempt = 0; attempt < 10 && !played; attempt++) {
      const index = Math.floor(rnd() * size * size);
      try {
        pos = play(pos, color, indexToCoord(index, size)).position;
        played = true;
      } catch (e) {
        if (!(e instanceof IllegalMoveError)) throw e;
      }
    }
    if (!played) pos = play(pos, color, 'pass').position;
    for (const g of allGroups(pos)) {
      expect(g.liberties.length, `seed ${seed} move ${n}: group without liberties`).toBeGreaterThan(0);
    }
    color = color === 'B' ? 'W' : 'B';
  }
  return pos;
}

describe('случайные партии', () => {
  it('30 партий на 9x9 по 150 ходов без групп без дыханий', () => {
    for (let seed = 1; seed <= 30; seed++) randomGame(seed, 9, 150);
  });

  it('пленные не отрицательны и не больше числа ходов, длина доски сохраняется', () => {
    const pos = randomGame(42, 13, 200);
    expect(pos.board).toHaveLength(13 * 13);
    expect(pos.captures.B).toBeGreaterThanOrEqual(0);
    expect(pos.captures.W).toBeGreaterThanOrEqual(0);
    expect(pos.captures.B + pos.captures.W).toBeLessThanOrEqual(200);
  });
});
