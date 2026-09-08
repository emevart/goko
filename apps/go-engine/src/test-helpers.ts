// Общая позиция для тестов обёртки: чёрная стена на строке blackRow, белая — на whiteRow.
// Ходы чередуются и все легальны, так что последовательность годится и для настоящего KataGo.
import { COLUMN_LETTERS } from '@goko/go-core';

export function walls(blackRow: number, whiteRow: number): [string, string][] {
  const moves: [string, string][] = [];
  for (let c = 0; c < 13; c++) {
    moves.push(['B', `${COLUMN_LETTERS.charAt(c)}${blackRow}`]);
    moves.push(['W', `${COLUMN_LETTERS.charAt(c)}${whiteRow}`]);
  }
  return moves;
}
