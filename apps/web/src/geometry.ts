// Геометрия доски в координатах SVG (viewBox 0..VIEW по обеим осям). Пункт (col, row): col от A = 0,
// row 0 — строка «1» внизу, как в протоколе; индекс в строке board = row * size + col.
import { formatCoord, type Point } from '@goko/go-core';

export const VIEW = 1000;

export type Layout = { size: number; step: number; margin: number };

export function layout(size: number): Layout {
  const step = VIEW / (size + 1);
  return { size, step, margin: step };
}

export const x = (l: Layout, col: number): number => l.margin + col * l.step;
export const y = (l: Layout, row: number): number => l.margin + (l.size - 1 - row) * l.step;

// Ближайший пункт к точке касания. Дальше полушага от крайней линии — поля, тап не считается.
export function pointAt(l: Layout, px: number, py: number): Point | null {
  // `+ 0` убирает `-0` у левого края: Math.round(-0,45) = -0, а toEqual отличает -0 от 0.
  const col = Math.round((px - l.margin) / l.step) + 0;
  const row = l.size - 1 - Math.round((py - l.margin) / l.step) + 0;
  if (col < 0 || col >= l.size || row < 0 || row >= l.size) return null;
  return { col, row };
}

export type Box = { left: number; top: number; width: number; height: number };

// Точка экрана -> координаты viewBox. Доска занимает гибкий бокс, а SVG вписывает квадратный viewBox по центру
// (preserveAspectRatio по умолчанию — xMidYMid meet): по длинной стороне бокса остаются поля, их вычитаем.
// Бокс нулевого размера (ещё не разложен) — null, иначе деление на ноль дало бы NaN вместо «мимо».
export function toView(box: Box, clientX: number, clientY: number): { x: number; y: number } | null {
  const side = Math.min(box.width, box.height);
  if (side <= 0) return null;
  return {
    x: ((clientX - box.left - (box.width - side) / 2) * VIEW) / side,
    y: ((clientY - box.top - (box.height - side) / 2) * VIEW) / side,
  };
}

export const coordAt = (p: Point): string => formatCoord(p);

export const indexOf = (p: Point, size: number): number => p.row * size + p.col;

export function hoshi(size: number): Point[] {
  const edge = size >= 13 ? 3 : 2;
  const mid = (size - 1) / 2;
  const lines = size >= 15 ? [edge, mid, size - 1 - edge] : [edge, size - 1 - edge];
  const points: Point[] = [];
  for (const col of lines) for (const row of lines) points.push({ col, row });
  if (size < 15 && Number.isInteger(mid)) points.push({ col: mid, row: mid });
  return points;
}

export type Stone = { col: number; row: number; color: 'B' | 'W' };

export function stones(board: string, size: number): Stone[] {
  const out: Stone[] = [];
  for (let i = 0; i < board.length; i++) {
    const c = board[i];
    if (c === 'B' || c === 'W') out.push({ col: i % size, row: Math.floor(i / size), color: c });
  }
  return out;
}
