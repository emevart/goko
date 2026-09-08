// Группы с оценкой владения от движка: safe / unsettled / dead.
import { type Color, type Position, allGroups, assertPosition } from './board.ts';
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
  // Позиция приходит вместе с массивом владения и собрана не нами: без проверки
  // сломанная доска даёт индексы камней вне доски, мимо проверки массива ниже.
  assertPosition(pos);
  // Массив владения приходит от движка: короткий или длинный массив — рассинхрон,
  // а не мелочь, молча он сделал бы живые группы мёртвыми.
  const total = pos.size * pos.size;
  if (ownership.length !== total) {
    throw new Error(`ownership has ${ownership.length} values, expected ${total} for the ${pos.size}x${pos.size} board`);
  }
  // Значения тоже приходят от движка, и массив мог приехать разобранным JSON'ом:
  // null или дырка раньше молча становились нулём, то есть живая группа
  // объявлялась мёртвой при подсчёте. Каждое значение обязано быть конечным числом.
  const valueAt = (i: number): number => {
    const value = ownership[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`ownership[${i}] is ${String(value)} (${typeof value}), expected a finite number`);
    }
    return value;
  };
  // Проверяем весь массив, а не только пункты с камнями: мусор на пустом пункте —
  // такой же сломанный ответ движка.
  for (let i = 0; i < total; i++) valueAt(i);
  return allGroups(pos).map((g) => {
    // Индексация здесь уже наша: снизу вверх. KataGo отдаёт владение сверху вниз,
    // разворот делается на границе с движком (go-engine), сюда массив приходит развёрнутым.
    const avg = g.stones.reduce((sum, i) => sum + valueAt(i), 0) / g.stones.length;
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
