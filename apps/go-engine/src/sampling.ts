// Выбор хода на ранге (раздел 8 спеки): humanPolicy без нелегальных, без паса (если поиск не пасует),
// без хвоста < 0.5 %, сэмплирование при температуре 1; если ничего не осталось — лучший ход поиска.
import { kataIndexToCoord } from './mapping.ts';

export type Candidate = { coord: string; prob: number };

export type ChooseMoveInput = {
  humanPolicy: readonly number[]; // size*size + 1, -1 = нелегально, последний = пас
  size: number;
  bestMove: string; // moveInfos[0].move основного поиска
  tailCutoff?: number;
  random?: () => number;
};

export type ChooseMoveResult = { move: string; top: Candidate[]; fallback: boolean };

export const TAIL_CUTOFF = 0.005;

export function chooseMove(input: ChooseMoveInput): ChooseMoveResult {
  const cutoff = input.tailCutoff ?? TAIL_CUTOFF;
  const random = input.random ?? Math.random;
  const passIndex = input.size * input.size;
  const candidates: Candidate[] = [];
  for (let k = 0; k < input.humanPolicy.length; k++) {
    const prob = input.humanPolicy[k] ?? -1;
    if (prob <= 0) continue;
    if (k === passIndex && input.bestMove !== 'pass') continue;
    if (prob < cutoff) continue;
    candidates.push({ coord: kataIndexToCoord(k, input.size), prob });
  }
  const top = [...candidates].sort((a, b) => b.prob - a.prob).slice(0, 5);
  // Пустой список ловится через последнего кандидата: одна ветка вместо двух проверок одного и того же.
  const last = candidates[candidates.length - 1];
  if (last === undefined) return { move: input.bestMove, top, fallback: true };
  const total = candidates.reduce((sum, c) => sum + c.prob, 0);
  let r = random() * total;
  for (const c of candidates) {
    r -= c.prob;
    if (r < 0) return { move: c.coord, top, fallback: false };
  }
  // Ошибка округления: сумма вычтена, но r остался >= 0 — берём последнего кандидата.
  return { move: last.coord, top, fallback: false };
}
