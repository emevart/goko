// Позиция всегда переигрывается из списка ходов: undo и correct в правилах не нужны.
import { type Color, type Position, emptyPosition } from './board.ts';
import { play } from './rules.ts';

export type MoveInput = { color: Color; coord: string };

export function replay(size: number, moves: readonly MoveInput[]): Position {
  let pos = emptyPosition(size);
  for (const m of moves) pos = play(pos, m.color, m.coord).position;
  return pos;
}
