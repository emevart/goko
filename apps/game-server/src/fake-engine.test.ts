import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Color, replay } from '@goko/go-core';
import { createFakeEngine } from './fake-engine.ts';

const base = { boardSize: 9, rules: 'chinese' as const, komi: 7.5 };

// Время управляемое: delayMs — обычный setTimeout, ждать его по-настоящему незачем.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// Наблюдение за промисом без ожидания: «уже осел или ещё нет».
function track<T>(p: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

describe('createFakeEngine', () => {
  it('сценарий отдаёт ходы по порядку, потом случайные легальные', async () => {
    const engine = createFakeEngine({ script: ['E5', 'pass'] });
    expect((await engine.genmove({ ...base, moves: [['B', 'D4']], rank: '10k' })).move).toBe('E5');
    expect((await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'C3']], rank: '10k' })).move).toBe('pass');
    const third = await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'C3'], ['W', 'pass'], ['B', 'C4']], rank: '10k' });
    expect(third.move).not.toBe('pass');
    expect(() => replay(9, [{ color: 'B', coord: 'D4' }, { color: 'W', coord: 'E5' }, { color: 'B', coord: 'C3' }, { color: 'W', coord: 'pass' }, { color: 'B', coord: 'C4' }, { color: 'W', coord: third.move }])).not.toThrow();
    expect(engine.calls.genmove).toBe(3);
  });

  it('первый ход на пустой доске — чёрные; ход второго цвета берётся из последнего хода', async () => {
    const engine = createFakeEngine();
    // На пустой доске ходят чёрные: белого камня после этого хода на доске быть не должно.
    const first = await engine.genmove({ ...base, moves: [], rank: '10k' });
    expect(() => replay(9, [{ color: 'B', coord: first.move }])).not.toThrow();
    expect(first.move).not.toBe('pass');
  });

  it('после паса соперника пасует сам (passAfterPass)', async () => {
    const engine = createFakeEngine();
    expect((await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'pass']], rank: '10k' })).move).toBe('pass');
    const stubborn = createFakeEngine({ passAfterPass: false });
    expect((await stubborn.genmove({ ...base, moves: [['B', 'pass']], rank: '10k' })).move).not.toBe('pass');
  });

  it('сценарий вызывающего не расходуется движком: список копируется', async () => {
    const script = ['E5', 'F6'];
    const engine = createFakeEngine({ script });
    expect((await engine.genmove({ ...base, moves: [], rank: '10k' })).move).toBe('E5');
    // Тот же список отдан второму движку: первый не вправе был его опустошить.
    expect(script).toEqual(['E5', 'F6']);
    const other = createFakeEngine({ script });
    expect((await other.genmove({ ...base, moves: [], rank: '10k' })).move).toBe('E5');
  });

  it('сценарий сильнее паса соперника', async () => {
    const engine = createFakeEngine({ script: ['E5'] });
    expect((await engine.genmove({ ...base, moves: [['B', 'pass']], rank: '10k' })).move).toBe('E5');
  });

  it('random выбирает из легальных: с нулём берётся первый кандидат', async () => {
    const engine = createFakeEngine({ random: () => 0 });
    // A1 — индекс 0 и первый кандидат на пустой доске.
    expect((await engine.genmove({ ...base, moves: [], rank: '10k' })).move).toBe('A1');
    const last = createFakeEngine({ random: () => 0.999999 });
    // J9 — последняя точка доски 9x9.
    expect((await last.genmove({ ...base, moves: [], rank: '10k' })).move).toBe('J9');
  });

  it('свой глаз не заполняется: с random 0 берётся не A1, а следующий кандидат', async () => {
    // Доска 3x3: белые на B1 и A2, поэтому A1 — их собственный глаз и в кандидаты не идёт,
    // хотя по индексу он первый и random 0 указывал бы именно на него.
    const engine = createFakeEngine({ random: () => 0 });
    const moves: [Color, string][] = [['W', 'B1'], ['W', 'A2'], ['B', 'C3']];
    const res = await engine.genmove({ boardSize: 3, rules: 'chinese', komi: 7.5, moves, rank: '10k' });
    expect(res.move).toBe('C1');
  });

  it('без легальных ходов остаётся пас даже при passAfterPass false', async () => {
    // Все точки, кроме A1, заняты белыми: ход белых в A1 — самоубийство, кандидатов нет.
    const moves: [Color, string][] = [
      ['W', 'B1'], ['W', 'C1'], ['W', 'A2'], ['W', 'B2'],
      ['W', 'C2'], ['W', 'A3'], ['W', 'B3'], ['W', 'C3'],
      ['B', 'pass'],
    ];
    const engine = createFakeEngine({ passAfterPass: false });
    const res = await engine.genmove({ boardSize: 3, rules: 'chinese', komi: 7.5, moves, rank: '10k' });
    expect(res.move).toBe('pass');
  });

  it('random вне диапазона [0, 1) не ломает движок: пас', async () => {
    const engine = createFakeEngine({ random: () => 1.5 });
    expect((await engine.genmove({ ...base, moves: [], rank: '10k' })).move).toBe('pass');
  });

  it('score считает площадь по наивному владению: камни +-1, пустые точки по флуд-филлу go-core', async () => {
    const engine = createFakeEngine();
    const moves: [Color, string][] = [];
    for (const c of 'ABCDEFGHJ') moves.push(['B', `${c}4`], ['W', `${c}5`]);
    const r = await engine.score({ ...base, moves });
    expect(r).toMatchObject({ areaB: 36, areaW: 45, winner: 'W', margin: 16.5, dead: [] });
    expect(r.scoreLeadB).toBe(-16.5);
    expect(r.ownership).toHaveLength(81);
    // Камень чёрных на D4 и камень белых на D5: владение противоположных знаков.
    expect(r.ownership[3 * 9 + 3]).toBe(1);
    expect(r.ownership[4 * 9 + 3]).toBe(-1);
    expect(engine.calls.score).toBe(1);
  });

  it('delayMs задерживает и genmove: ответа нет до истечения задержки', async () => {
    const engine = createFakeEngine({ script: ['E5'], delayMs: 30 });
    const p = engine.genmove({ ...base, moves: [], rank: '10k' });
    const state = track(p);
    await vi.advanceTimersByTimeAsync(29);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).move).toBe('E5');
  });

  it('analyze возвращает winrate 0.5 и ownership по камням; delayMs задерживает ответ', async () => {
    const engine = createFakeEngine({ delayMs: 30 });
    const p = engine.analyze({ ...base, moves: [['B', 'D4'], ['W', 'F6']] });
    const state = track(p);
    await vi.advanceTimersByTimeAsync(29);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const a = await p;
    expect(a.winrateB).toBe(0.5);
    // Знак владения: свой камень чёрных +1, свой камень белых -1, пустая точка 0.
    // Этим владением кормится groupsWithOwnership в service.analyze, поэтому знак важен.
    expect(a.ownership?.[3 * 9 + 3]).toBe(1);
    expect(a.ownership?.[5 * 9 + 5]).toBe(-1);
    expect(a.ownership?.[4 * 9 + 4]).toBe(0);
    expect(a.moveInfos.length).toBeGreaterThan(0);
    expect(a.visits).toBe(50);
    expect(engine.calls.analyze).toBe(1);
  });

  it('ответ genmove ровный: winrate 0.5, перевес 0, в humanPolicyTop сам ход', async () => {
    // Ровные числа — договор фейка: на них опирается проверка сдачи в сервисе,
    // и партия против фейкового движка не должна кончаться сдачей сама собой.
    const engine = createFakeEngine({ script: ['E5'] });
    const r = await engine.genmove({ ...base, moves: [['B', 'D4']], rank: '10k' });
    expect(r.winrateB).toBe(0.5);
    expect(r.scoreLeadB).toBe(0);
    expect(r.humanPolicyTop).toEqual([{ coord: 'E5', prob: 1 }]);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('лучший ход analyze берётся из легальных, а не выдумывается', async () => {
    // random 0 указывает на первого кандидата: на пустой доске это A1.
    const engine = createFakeEngine({ random: () => 0 });
    const a = await engine.analyze({ ...base, moves: [] });
    expect(a.moveInfos[0]?.coord).toBe('A1');
    expect(a.moveInfos[0]).toMatchObject({ winrateB: 0.5, scoreLeadB: 0, visits: 1, order: 0 });
  });

  it('analyze без владения по includeOwnership: false; maxVisits попадает в ответ', async () => {
    const engine = createFakeEngine();
    const a = await engine.analyze({ ...base, moves: [], includeOwnership: false, maxVisits: 7 });
    expect(a.ownership).toBeUndefined();
    expect(a.visits).toBe(7);
  });
});
