import { describe, expect, it } from 'vitest';
import { VIEW, coordAt, hoshi, indexOf, layout, pointAt, stones, toView, x, y } from './geometry.ts';

describe('toView: экранная точка -> viewBox с полями вписанного квадрата', () => {
  const l = layout(13);
  it('квадратный бокс: масштаб без полей', () => {
    const box = { left: 8, top: 100, width: 500, height: 500 };
    expect(toView(box, 8 + 250, 100 + 250)).toEqual({ x: VIEW / 2, y: VIEW / 2 });
  });
  it('широкий бокс: поля слева и справа вычитаются, D4 попадает в D4', () => {
    const box = { left: 10, top: 20, width: 700, height: 500 }; // квадрат 500, поля по 100
    const s = 500 / VIEW;
    const v = toView(box, 10 + 100 + x(l, 3) * s, 20 + y(l, 3) * s);
    expect(v && pointAt(l, v.x, v.y)).toEqual({ col: 3, row: 3 });
    const inMargin = toView(box, 10 + 50, 20 + 250); // касание в левом поле за доской
    expect(inMargin && pointAt(l, inMargin.x, inMargin.y)).toBeNull();
  });
  it('высокий бокс: поля сверху и снизу вычитаются, N13 попадает в N13', () => {
    const box = { left: 0, top: 0, width: 300, height: 500 }; // квадрат 300, поля по 100
    const s = 300 / VIEW;
    const v = toView(box, x(l, 12) * s, 100 + y(l, 12) * s);
    expect(v && pointAt(l, v.x, v.y)).toEqual({ col: 12, row: 12 });
    const below = toView(box, 150, 450); // нижнее поле
    expect(below && pointAt(l, below.x, below.y)).toBeNull();
  });
  it('бокс нулевого размера (доска ещё не разложена) — мимо', () => {
    expect(toView({ left: 0, top: 0, width: 0, height: 400 }, 0, 10)).toBeNull();
  });
});

describe('geometry 13x13', () => {
  const l = layout(13);
  it('каждый пункт попадает сам в себя', () => {
    for (let col = 0; col < 13; col++) {
      for (let row = 0; row < 13; row++) {
        expect(pointAt(l, x(l, col), y(l, row))).toEqual({ col, row });
      }
    }
  });
  it('тап рядом с пунктом (0,45 шага) прилипает к нему, в том числе на краях и в углах', () => {
    const d = l.step * 0.45;
    expect(pointAt(l, x(l, 0) - d, y(l, 0) + d)).toEqual({ col: 0, row: 0 }); // A1: левее и ниже
    expect(pointAt(l, x(l, 12) + d, y(l, 12) - d)).toEqual({ col: 12, row: 12 }); // N13: правее и выше
    expect(pointAt(l, x(l, 3) + d, y(l, 3) - d)).toEqual({ col: 3, row: 3 });
  });
  it('тап в полях за полшага от крайней линии — мимо', () => {
    expect(pointAt(l, 0, 0)).toBeNull();
    expect(pointAt(l, l.margin * 0.4, y(l, 0))).toBeNull();
    expect(pointAt(l, x(l, 12) + l.step * 0.6, y(l, 0))).toBeNull();
    expect(pointAt(l, x(l, 0), y(l, 0) + l.step * 0.6)).toBeNull();
  });
  it('координаты и индексы совпадают с протоколом', () => {
    expect(coordAt({ col: 3, row: 3 })).toBe('D4');
    expect(coordAt({ col: 12, row: 12 })).toBe('N13');
    expect(coordAt({ col: 0, row: 0 })).toBe('A1');
    expect(indexOf({ col: 3, row: 3 }, 13)).toBe(42);
  });
  it('хоси', () => {
    expect(hoshi(13)).toHaveLength(5);
    expect(hoshi(13)).toContainEqual({ col: 6, row: 6 });
    expect(hoshi(13)).toContainEqual({ col: 3, row: 3 }); // D4, а не C3
    expect(hoshi(9)).toContainEqual({ col: 2, row: 2 });
    expect(hoshi(9)).toHaveLength(5);
    expect(hoshi(19)).toHaveLength(9);
  });
  it('камни из строки board', () => {
    const board = '.B.W' + '.'.repeat(13 * 13 - 4);
    expect(stones(board, 13)).toEqual([
      { col: 1, row: 0, color: 'B' },
      { col: 3, row: 0, color: 'W' },
    ]);
  });
});
