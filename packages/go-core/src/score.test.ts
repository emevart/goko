import { describe, expect, it } from 'vitest';
import { areaScore, resultFromArea } from './score.ts';
import { positionFromRows } from './testing.ts';

describe('areaScore', () => {
  // Чёрная стена B1..B5, белая стена D1..D5, чёрный камень E3.
  const pos = positionFromRows(['.X.O.', '.X.O.', '.X.OX', '.X.O.', '.X.O.']);

  it('считает камни и окружённые пустые точки, столбец C ничей', () => {
    const s = areaScore(pos, [], 7.5);
    expect(s.areaB).toBe(11); // 5 стена + 5 столбец A + E3
    expect(s.areaW).toBe(5); // столбец E спорный из-за E3
  });

  it('мёртвый камень отдаёт свою точку сопернику', () => {
    const s = areaScore(pos, ['E3'], 7.5);
    expect(s.areaB).toBe(10);
    expect(s.areaW).toBe(10);
    expect(s.dead).toEqual(['E3']);
  });

  it('пустая доска — ничья по площади, белые выигрывают коми', () => {
    const s = areaScore(positionFromRows(['...', '...', '...']), [], 7.5);
    expect(s).toMatchObject({ areaB: 0, areaW: 0 });
    expect(resultFromArea(s)).toEqual({ winner: 'W', margin: 7.5 });
  });
});

describe('resultFromArea', () => {
  it('чёрные впереди на разницу минус коми', () => {
    expect(resultFromArea({ areaB: 91, areaW: 78, komi: 7.5, dead: [] })).toEqual({ winner: 'B', margin: 5.5 });
    expect(resultFromArea({ areaB: 80, areaW: 80, komi: 7.5, dead: [] })).toEqual({ winner: 'W', margin: 7.5 });
  });

  it('ровный счёт при целом коми записывается на белых', () => {
    expect(resultFromArea({ areaB: 80, areaW: 73, komi: 7, dead: [] })).toEqual({ winner: 'W', margin: 0 });
  });
});

describe('areaScore не делит массив dead с вызывающим', () => {
  it('изменение исходного массива после вызова не меняет результат', () => {
    const pos = positionFromRows(['.X.O.', '.X.O.', '.X.OX', '.X.O.', '.X.O.']);
    const dead = ['E3'];
    const s = areaScore(pos, dead, 7.5);
    dead.push('B1');
    expect(s.dead).toEqual(['E3']);
  });
});
