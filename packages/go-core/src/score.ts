// Счёт по площади (китайские правила): камни на доске + окружённые только своим цветом пустые точки.
import { type Cell, type Color, type Position, cellAt, neighbors } from './board.ts';
import { coordToIndex } from './coords.ts';

export type AreaScore = { areaB: number; areaW: number; komi: number; dead: string[] };

export function areaScore(pos: Position, dead: string[], komi: number): AreaScore {
  const deadIndex = new Set(dead.map((c) => coordToIndex(c, pos.size)));
  // Мёртвый камень для счёта — пустая точка: она достаётся тому, кто её окружает.
  const cell = (i: number): Cell => (deadIndex.has(i) ? '.' : cellAt(pos, i));
  const total = pos.size * pos.size;
  let areaB = 0;
  let areaW = 0;
  const seen = new Set<number>();
  for (let i = 0; i < total; i++) {
    const c = cell(i);
    if (c === 'B') {
      areaB++;
      continue;
    }
    if (c === 'W') {
      areaW++;
      continue;
    }
    if (seen.has(i)) continue;
    // Пустая область целиком: кому принадлежит её граница.
    // Очередь обходится по индексу: pop() дал бы number | undefined.
    const queue = [i];
    seen.add(i);
    let touchesB = false;
    let touchesW = false;
    for (let head = 0; head < queue.length; head++) {
      const j = queue[head] ?? i;
      for (const k of neighbors(j, pos.size)) {
        const ck = cell(k);
        if (ck === 'B') touchesB = true;
        else if (ck === 'W') touchesW = true;
        else if (!seen.has(k)) {
          seen.add(k);
          queue.push(k);
        }
      }
    }
    if (touchesB && !touchesW) areaB += queue.length;
    else if (touchesW && !touchesB) areaW += queue.length;
  }
  return { areaB, areaW, komi, dead };
}

export function resultFromArea(a: AreaScore): { winner: Color; margin: number } {
  const diff = a.areaB - a.areaW - a.komi;
  return { winner: diff > 0 ? 'B' : 'W', margin: Math.abs(diff) };
}
