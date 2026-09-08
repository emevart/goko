import { describe, expect, it } from 'vitest';
import { areaScore, resultFromArea } from './score.ts';
import { positionFromRows } from './testing.ts';

// Доска 9x9: чёрная стена по столбцу B, белая по столбцу D, чёрный камень E5.
// Столбец A достаётся чёрным, столбец C ничей, восток спорный из-за E5.
const wall = '.X.O.....';
const wallWithStone = '.X.OX....';
const board = (): string[] => Array.from({ length: 9 }, (_, r) => (9 - r === 5 ? wallWithStone : wall));
const empty9 = (): string[] => new Array<string>(9).fill('.........');

describe('areaScore', () => {
  const pos = positionFromRows(board());

  it('считает камни и окружённые пустые точки, столбец C ничей', () => {
    const s = areaScore(pos, [], 7.5);
    expect(s.areaB).toBe(19); // 9 стена + 9 столбец A + E5
    expect(s.areaW).toBe(9); // восток спорный из-за E5
  });

  it('мёртвый камень отдаёт свою точку сопернику', () => {
    const s = areaScore(pos, ['E5'], 7.5);
    expect(s.areaB).toBe(18);
    expect(s.areaW).toBe(54);
    expect(s.dead).toEqual(['E5']);
  });

  it('пустая доска — ничья по площади, белые выигрывают коми', () => {
    const s = areaScore(positionFromRows(empty9()), [], 7.5);
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
    const pos = positionFromRows(board());
    const dead = ['E5'];
    const s = areaScore(pos, dead, 7.5);
    dead.push('B1');
    expect(s.dead).toEqual(['E5']);
  });
});

// Позицию для счёта собирает вызывающий (game-server из ответа движка): доска
// короче размера молча дала бы пустые точки и неверный счёт.
describe('areaScore проверяет позицию', () => {
  const pos = positionFromRows(empty9());

  it('укороченная доска — ошибка про доску', () => {
    const broken = { ...pos, board: pos.board.slice(0, 80) };
    expect(() => areaScore(broken, [], 7.5)).toThrow(/board has 80 cells/);
  });

  it('чужой символ на доске — ошибка про символ', () => {
    const broken = { ...pos, board: 'X' + pos.board.slice(1) };
    expect(() => areaScore(broken, [], 7.5)).toThrow(/"X"/);
  });
});
