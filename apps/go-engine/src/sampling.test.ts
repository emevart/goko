import { describe, expect, it } from 'vitest';
import { coordToIndex } from '@goko/go-core';
import { oursToKataIndex } from './mapping.ts';
import { chooseMove, TAIL_CUTOFF } from './sampling.ts';

const SIZE = 9;
const PASS = SIZE * SIZE;
function policy(entries: Record<string, number>, pass = 0): number[] {
  const p = new Array<number>(PASS + 1).fill(0);
  // humanPolicy приходит в индексации KataGo, поэтому наш индекс переводится обратно
  for (const [coord, prob] of Object.entries(entries)) p[oursToKataIndex(coordToIndex(coord, SIZE), SIZE)] = prob;
  p[PASS] = pass;
  return p;
}

describe('chooseMove', () => {
  it('единственный кандидат выбирается всегда', () => {
    const r = chooseMove({ humanPolicy: policy({ D4: 0.9 }), size: SIZE, bestMove: 'E5', random: () => 0.99 });
    expect(r).toEqual({ move: 'D4', top: [{ coord: 'D4', prob: 0.9 }], fallback: false });
  });

  it('нелегальные (-1) и хвост ниже 0.5 % отбрасываются', () => {
    const p = policy({ D4: 0.6, E5: 0.004 });
    // -1 кладётся по индексу KataGo точки C3: наш индекс здесь пометил бы совсем другую точку
    p[oursToKataIndex(coordToIndex('C3', SIZE), SIZE)] = -1;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'C3', random: () => 0.999 });
    expect(r.move).toBe('D4');
    expect(r.top.map((c) => c.coord)).toEqual(['D4']);
  });

  it('пас отбрасывается, если лучший ход поиска — не пас', () => {
    expect(chooseMove({ humanPolicy: policy({ D4: 0.1 }, 0.9), size: SIZE, bestMove: 'D4', random: () => 0.5 }).move).toBe('D4');
    expect(chooseMove({ humanPolicy: policy({ D4: 0.1 }, 0.9), size: SIZE, bestMove: 'pass', random: () => 0.5 }).move).toBe('pass');
  });

  it('если всё обнулилось — лучший ход поиска', () => {
    expect(chooseMove({ humanPolicy: policy({}), size: SIZE, bestMove: 'E5' })).toEqual({ move: 'E5', top: [], fallback: true });
  });

  it('длина ровно с доску принимается: паса в массиве просто нет', () => {
    const p = new Array<number>(PASS).fill(0);
    p[0] = 0.7;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'pass', random: () => 0.5 });
    expect(r).toEqual({ move: 'A9', top: [{ coord: 'A9', prob: 0.7 }], fallback: false });
  });

  it('длина с местом под пас принимается', () => {
    const p = new Array<number>(PASS + 1).fill(0);
    p[PASS] = 0.7;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'pass', random: () => 0.5 });
    expect(r).toEqual({ move: 'pass', top: [{ coord: 'pass', prob: 0.7 }], fallback: false });
  });

  it('массив короче доски отвергается', () => {
    const p = new Array<number>(PASS - 1).fill(0.1);
    expect(() => chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'E5' })).toThrow(
      /invalid humanPolicy length 80: expected 81 or 82 for a 9x9 board/,
    );
  });

  it('пустой массив отвергается, а не превращается в лучший ход поиска', () => {
    expect(() => chooseMove({ humanPolicy: [], size: SIZE, bestMove: 'E5' })).toThrow(/invalid humanPolicy length 0/);
  });

  it('массив длиннее доски отвергается', () => {
    const p = policy({ D4: 0.6 });
    p.push(0.9);
    expect(() => chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'D4' })).toThrow(
      /invalid humanPolicy length 83: expected 81 or 82 for a 9x9 board/,
    );
  });

  it('пять значений на доску 9x9 не дают хода C9', () => {
    // Регресс: молчаливый дефолт -1 пропускал такой вход и возвращал ход не в ту точку
    expect(() => chooseMove({ humanPolicy: [0.1, 0.2, 0.3, 0.2, 0.2], size: SIZE, bestMove: 'D4' })).toThrow(
      /invalid humanPolicy length 5/,
    );
  });

  it('дыра внутри доски — сломанный ответ движка, а не ноль', () => {
    const p = new Array<number>(PASS + 1); // длина верная, значения не заполнены
    expect(() => chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'E5' })).toThrow(
      /invalid humanPolicy: missing value at index 0/,
    );
  });

  it('сэмплирует пропорционально вероятности при температуре 1', () => {
    const p = policy({ D4: 0.75, E5: 0.25 });
    const counts = { D4: 0, E5: 0 };
    for (let i = 0; i < 1000; i++) {
      const move = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'D4', random: () => (i + 0.5) / 1000 }).move as 'D4' | 'E5';
      counts[move]++;
    }
    expect(counts.D4).toBe(750);
    expect(counts.E5).toBe(250);
  });

  it('top — до пяти кандидатов по убыванию', () => {
    const r = chooseMove({ humanPolicy: policy({ A1: 0.1, B2: 0.2, C3: 0.3, D4: 0.05, E5: 0.15, F6: 0.2 }), size: SIZE, bestMove: 'C3', random: () => 0 });
    expect(r.top).toHaveLength(5);
    expect(r.top[0]?.coord).toBe('C3');
  });
  it('TAIL_CUTOFF — половина процента', () => {
    expect(TAIL_CUTOFF).toBe(0.005);
  });

  it('tailCutoff можно задать явно', () => {
    const r = chooseMove({ humanPolicy: policy({ D4: 0.6, E5: 0.05 }), size: SIZE, bestMove: 'D4', tailCutoff: 0.1, random: () => 0 });
    expect(r.top.map((c) => c.coord)).toEqual(['D4']);
    expect(r.move).toBe('D4');
  });

  it('граница интервала достаётся следующему кандидату', () => {
    // E5 идёт первым (индекс KataGo меньше), его интервал — [0, 0.5); ровно 0.5 уже за ним.
    const r = chooseMove({ humanPolicy: policy({ D4: 0.5, E5: 0.5 }), size: SIZE, bestMove: 'D4', random: () => 0.5 });
    expect(r.move).toBe('D4');
  });
  it('вероятность ровно на пороге остаётся кандидатом', () => {
    const r = chooseMove({ humanPolicy: policy({ D4: 0.6, E5: TAIL_CUTOFF }), size: SIZE, bestMove: 'D4', random: () => 0 });
    expect(r.top.map((c) => c.coord)).toEqual(['D4', 'E5']);
  });

  it('нули не становятся кандидатами даже при нулевом пороге', () => {
    const r = chooseMove({ humanPolicy: policy({ D4: 0.5 }), size: SIZE, bestMove: 'D4', tailCutoff: 0, random: () => 0 });
    expect(r.top).toEqual([{ coord: 'D4', prob: 0.5 }]);
  });

  it('случайное число нормируется на сумму вероятностей', () => {
    // сумма 0.8: 0.45 * 0.8 = 0.36 попадает в интервал E5 [0, 0.4)
    const r = chooseMove({ humanPolicy: policy({ D4: 0.4, E5: 0.4 }), size: SIZE, bestMove: 'D4', random: () => 0.45 });
    expect(r.move).toBe('E5');
  });

  it('кандидаты идут в порядке индексов KataGo, а не по убыванию вероятности', () => {
    // E5 (индекс 40) раньше D4 (индекс 48), поэтому интервал [0, 0.3) — за E5
    const r = chooseMove({ humanPolicy: policy({ D4: 0.7, E5: 0.3 }), size: SIZE, bestMove: 'D4', random: () => 0.2 });
    expect(r.move).toBe('E5');
  });
  it('индексы KataGo читаются как есть: 0 — A9, 80 — J1', () => {
    // вход задан литеральными индексами KataGo, без oursToKataIndex: тест не должен
    // опираться на ту же функцию, которую проверяет соседний файл
    const p = new Array<number>(PASS + 1).fill(0);
    p[0] = 0.7;
    p[80] = 0.3;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'A9', random: () => 0 });
    expect(r.move).toBe('A9');
    expect(r.top.map((c) => c.coord)).toEqual(['A9', 'J1']);
  });

  it('NaN и бесконечность не становятся кандидатами', () => {
    const p = new Array<number>(PASS + 1).fill(0);
    p[0] = Number.NaN;
    p[1] = Number.POSITIVE_INFINITY;
    p[80] = 0.5;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'A9', random: () => 0.5 });
    expect(r).toEqual({ move: 'J1', top: [{ coord: 'J1', prob: 0.5 }], fallback: false });
  });


  it('край интервала: остаётся последний кандидат, а не лучший ход поиска', () => {
    // r = 1 * (0.5 + 0.5): вычитания не уводят накопитель ниже нуля, срабатывает ветка округления.
    // Единица вне контракта Math.random() (максимум 1 - 2^-53) и подана как простая замена
    // реального триггера: ветка достижима на значениях в единицах ulp от единицы, с вероятностью
    // порядка 1e-14 на ход, поэтому воспроизводить её настоящим случайным числом бессмысленно.
    const r = chooseMove({ humanPolicy: policy({ D4: 0.5, E5: 0.5 }), size: SIZE, bestMove: 'A1', random: () => 1 });
    expect(r).toEqual({ move: 'D4', top: [{ coord: 'E5', prob: 0.5 }, { coord: 'D4', prob: 0.5 }], fallback: false });
  });
});
