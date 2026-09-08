// Группы с оценкой владения от движка: safe / unsettled / dead.
import { type Color, type Position, allGroups } from './board.ts';
import { indexToCoord } from './coords.ts';

export type GroupStatus = 'safe' | 'unsettled' | 'dead';
export type GroupInfo = {
  color: Color;
  stones: string[];
  liberties: number;
  ownershipAvg: number; // -1 белые .. +1 чёрные, среднее по камням группы
  status: GroupStatus;
};

export const DEAD_THRESHOLD = 0.6;
export const UNSETTLED_THRESHOLD = 0.3;

export function groupsWithOwnership(pos: Position, ownership: readonly number[]): GroupInfo[] {
  return allGroups(pos).map((g) => {
    const avg = g.stones.reduce((sum, i) => sum + (ownership[i] ?? 0), 0) / g.stones.length;
    const own = g.color === 'B' ? avg : -avg; // владение в пользу своего цвета
    const status: GroupStatus = own < -DEAD_THRESHOLD ? 'dead' : Math.abs(own) < UNSETTLED_THRESHOLD ? 'unsettled' : 'safe';
    return {
      color: g.color,
      stones: g.stones.map((i) => indexToCoord(i, pos.size)),
      liberties: g.liberties.length,
      ownershipAvg: avg,
      status,
    };
  });
}

export function deadStones(pos: Position, ownership: readonly number[]): string[] {
  return groupsWithOwnership(pos, ownership)
    .filter((g) => g.status === 'dead')
    .flatMap((g) => g.stones);
}
