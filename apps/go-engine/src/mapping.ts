// KataGo отдаёт policy/ownership строками сверху вниз (A13..N13, ..., A1..N1); наша индексация — снизу.
import { indexToCoord } from '@goko/go-core';

export function kataIndexToOurs(kataIndex: number, size: number): number {
  const rowFromTop = Math.floor(kataIndex / size);
  const col = kataIndex % size;
  return (size - 1 - rowFromTop) * size + col;
}

export function oursToKataIndex(index: number, size: number): number {
  const row = Math.floor(index / size);
  const col = index % size;
  return (size - 1 - row) * size + col;
}

export function kataIndexToCoord(kataIndex: number, size: number): string {
  if (kataIndex === size * size) return 'pass';
  return indexToCoord(kataIndexToOurs(kataIndex, size), size);
}

export function reorderFromKata(values: readonly number[], size: number): number[] {
  const out = new Array<number>(size * size).fill(0);
  for (let k = 0; k < size * size; k++) out[kataIndexToOurs(k, size)] = values[k] ?? 0;
  return out;
}

export function rankToProfile(rank: string): string {
  return `rank_${rank}`;
}
