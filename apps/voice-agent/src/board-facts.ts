import { indexToCoord } from '@goko/go-core';
import type { GameState } from '@goko/protocol';

// Явный список занятых пунктов нужен модели как источник истины. ASCII удобен
// человеку, но модель легко сдвигает строку или путает X/O при пересказе позиции.
export type BoardStones = { black: string[]; white: string[] };

export function boardStones(g: Pick<GameState, 'board' | 'settings'>): BoardStones {
  const black: string[] = [];
  const white: string[] = [];
  const size = g.settings.boardSize;
  const limit = Math.min(g.board.length, size ** 2);
  // Тот же порядок, что у ASCII ниже: верхняя строка первой, внутри строки
  // слева направо. Так список легко сверить глазами с доской.
  for (let row = size - 1; row >= 0; row -= 1) {
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      if (index >= limit) continue;
      const coord = indexToCoord(index, size);
      const cell = g.board.charAt(index);
      if (cell === 'B') black.push(coord);
      if (cell === 'W') white.push(coord);
    }
  }
  return { black, white };
}
