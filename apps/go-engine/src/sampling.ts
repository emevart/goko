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
  // Длина проверяется так же, как в reorderFromKata: policy приходит с местом под пас,
  // массив ровно на доску тоже допустим. Всё прочее — рассогласование size и ответа
  // движка; молча принятый короткий массив дал бы ход не в ту точку, а не ошибку.
  if (input.humanPolicy.length !== passIndex && input.humanPolicy.length !== passIndex + 1) {
    throw new Error(
      `invalid humanPolicy length ${input.humanPolicy.length}: expected ${passIndex} or ${passIndex + 1} for a ${input.size}x${input.size} board`,
    );
  }
  const candidates: Candidate[] = [];
  // Цикл идёт по доске, а не по длине чужого массива: хвост за пасом — рассогласование
  // size и ответа движка, из него получались бы отрицательные индексы координат.
  for (let k = 0; k <= passIndex; k++) {
    const value = input.humanPolicy[k];
    // Асимметрия намеренная: дыра внутри доски — сломанный ответ движка, а не ноль,
    // а пустое место на индексе паса — это нормальный массив длиной ровно с доску
    // (пас в нём просто не передан). Отличить его от разреженного массива с дырой
    // на последнем месте нельзя, да и незачем: пас всё равно отбрасывается ниже,
    // когда поиск не пасует, а когда пасует — есть bestMove.
    if (value === undefined) {
      if (k === passIndex) continue;
      throw new Error(`invalid humanPolicy: missing value at index ${k}`);
    }
    const prob = value;
    // NaN проходит оба сравнения ниже (NaN <= 0 и NaN < cutoff одинаково ложны), отравляет
    // сумму и молча уводит выбор в ветку округления, поэтому отсекается явно.
    if (!Number.isFinite(prob) || prob <= 0) continue;
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
